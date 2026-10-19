/**
 * cover-import: 将外站封面图下载后导入本应用 covers 存储桶
 *
 * 背景：站点片库（盘链 / 不太灵等）返回的封面是外站绝对地址，例如
 *   https://pic.youkupic.com/upload/vod/...
 * 这类地址有两类问题：
 *   1. 相当一部分不返回 CORS 头，浏览器端无法 fetch 下载；
 *   2. 即使 <img> 能显示，绘制到 canvas 合成分享卡片时会被污染，导出失败。
 * 本函数在服务端（无同源限制）抓取图片并写入 covers 桶，返回本应用公开 URL，
 * 之后封面即为本应用自有的地址，不依赖外站可用性。
 */
import { createClient } from "npm:@supabase/supabase-js@2";

// 本 App Supabase（平台自动注入）
const APP_URL = Deno.env.get("SUPABASE_URL")!;
const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_BYTES = 5 * 1024 * 1024; // 与 covers 桶 file_size_limit 保持一致
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const res = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function extOf(contentType: string): string {
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/png") return "png";
  if (contentType === "image/gif") return "gif";
  if (contentType === "image/avif") return "avif";
  return "jpg";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const appClient = createClient(APP_URL, SVC_KEY);
    const appToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!appToken) return res({ success: false, message: "请先登录本应用" }, 401);

    const { data: { user }, error: userErr } = await appClient.auth.getUser(appToken);
    if (userErr || !user) return res({ success: false, message: "登录态无效，请重新登录" }, 401);

    const body = await req.json().catch(() => ({}));
    const url: string = typeof body?.url === "string" ? body.url.trim() : "";
    const resourceId: string = typeof body?.resourceId === "string" ? body.resourceId : "";
    if (!url || !resourceId) {
      return res({ success: false, message: "缺少 url 或 resourceId" }, 400);
    }
    if (!/^https?:\/\//i.test(url)) {
      return res({ success: false, message: "封面地址必须是 http(s) 链接" }, 400);
    }

    // 已在自有桶内则直接返回，避免重复导入
    if (url.includes("/storage/v1/object/public/covers/")) {
      return res({ success: true, url, skipped: true });
    }

    // 服务端抓取外站封面：带 Referer 与 UA，规避部分图床的空 Referer 拦截
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch {
      /* ignore */
    }
    const imgRes = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        ...(origin ? { Referer: `${origin}/` } : {}),
      },
    });

    if (!imgRes.ok) {
      return res({ success: false, message: `抓取封面失败（HTTP ${imgRes.status}）` }, 502);
    }

    const contentType = (imgRes.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED.includes(contentType)) {
      return res({ success: false, message: `不支持的图片类型：${contentType || "未知"}` }, 415);
    }

    const blob = await imgRes.blob();
    if (blob.size === 0) {
      return res({ success: false, message: "抓取到的封面为空" }, 502);
    }
    if (blob.size > MAX_BYTES) {
      return res({ success: false, message: "封面图超过 5MB 上限" }, 413);
    }

    // mode=proxy：只做服务端中转，不落存储。
    // 供前端合成分享卡片时使用 —— 外站图床大多不带 CORS 头，浏览器无法直取，
    // 而本响应带 CORS 头，可被 fetch 后安全绘制到 canvas。
    if (body?.mode === "proxy") {
      return new Response(blob, {
        headers: {
          ...CORS,
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // 写入 covers 桶：路径与前端 uploadCover 保持一致（uid/resourceId_时间戳.ext）
    const path = `${user.id}/${resourceId}_${Date.now()}.${extOf(contentType)}`;
    const { error: upErr } = await appClient.storage
      .from("covers")
      .upload(path, blob, { contentType, upsert: true });
    if (upErr) throw upErr;

    const { data: pub } = appClient.storage.from("covers").getPublicUrl(path);
    return res({ success: true, url: pub.publicUrl });
  } catch (e: any) {
    return res({ success: false, message: e?.message || "导入封面失败" }, 500);
  }
});

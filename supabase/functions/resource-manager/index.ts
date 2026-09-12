/**
 * resource-manager: 鸭影臻藏站点资源管理 Edge Function
 *
 * 鉴权链路（按照鸭影臻藏官方提供的「update-resource」中转模式，双重鉴权）：
 *   1. 本 App 用户携带 Authorization: Bearer <app_token> 验证身份
 *   2. 服务端从 ya_sessions 读取该用户绑定的鸭影臻藏凭证（access_token）
 *   3. 以 Authorization: Bearer <ya_token> + 服务端注入的 p_api_key 调用鸭影臻藏 RPC，
 *      鸭影后端校验「登录态有效 + 密钥有效」双通过才执行
 *
 * 支持的 action（POST JSON）：
 *   bindToken      - 绑定鸭影臻藏凭证（miaoda-auth 完整 JSON 或裸 access_token）
 *   searchVideos   - 搜索片源（api_search_videos）
 *   updateResource - 修改本人资源（api_update_resource）
 *   accountStatus  - 查看账号状态（api_get_account_status）
 */
import { createClient } from "npm:@supabase/supabase-js@2";

// 本 App Supabase（平台自动注入）
const APP_URL = Deno.env.get("SUPABASE_URL")!;
const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// 鸭影臻藏的 Supabase 实例（GUANGYA_* 为官方部署指南命名，兼容旧 YA_* secrets）
const YA_URL =
  Deno.env.get("GUANGYA_SUPABASE_URL") ?? Deno.env.get("YA_SUPABASE_URL") ??
  "https://houhvngggkkcqcjmzafx.supabase.co";
const YA_ANON = Deno.env.get("GUANGYA_ANON_KEY") ?? Deno.env.get("YA_ANON_KEY") ?? "";
const SCRIPT_KEY = Deno.env.get("GUANGYA_P_API_KEY") ?? Deno.env.get("SCRIPT_API_KEY") ?? "";

const YA_REST = `${YA_URL}/rest/v1/rpc`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const res = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** 调用鸭影臻藏业务 RPC（双重鉴权：Bearer ya_token + p_api_key） */
async function yaRpc(token: string, rpc: string, body: Record<string, unknown>) {
  const r = await fetch(`${YA_REST}/${rpc}`, {
    method: "POST",
    headers: { apikey: YA_ANON, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, p_api_key: SCRIPT_KEY }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.message || d?.error_description || `${rpc} 失败 (HTTP ${r.status})`);
  return d;
}

/** 用 refresh_token 静默续签鸭影臻藏 token */
async function refreshYaToken(rt: string) {
  const r = await fetch(`${YA_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: YA_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("token 已过期，请重新绑定账号");
  return { access_token: d.access_token as string, refresh_token: d.refresh_token as string };
}

/** 用户名 → 邮箱 → 密码登录，返回 tokens */
async function loginYa(username: string, password: string) {
  const er = await fetch(`${YA_REST}/lookup_email_by_username`, {
    method: "POST",
    headers: { apikey: YA_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ p_username: username }),
  });
  const email = await er.json();
  if (!er.ok || !email) throw new Error("账号不存在或用户名错误");

  const ar = await fetch(`${YA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: YA_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const auth = await ar.json();
  if (!ar.ok) throw new Error(auth.error_description || auth.msg || "密码错误，请检查账号密码");
  return {
    access_token: auth.access_token as string,
    refresh_token: auth.refresh_token as string,
    expires_in: auth.expires_in as number,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const appClient = createClient(APP_URL, SVC_KEY);
    const appToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!appToken) return res({ success: false, error: "请先登录本应用" }, 401);

    const { data: { user } } = await appClient.auth.getUser(appToken);
    if (!user?.id) return res({ success: false, error: "登录态无效，请重新登录" }, 401);
    const uid = user.id;

    const body = await req.json();
    const { action, ...p } = body;

    // ── login：账号密码登录，校验并存储鸭影臻藏 token ──────────────────────
    if (action === "login") {
      if (!p.username || !p.password) return res({ success: false, error: "缺少账号或密码" }, 400);
      const tokens = await loginYa(p.username, p.password);
      const { error: upErr } = await appClient.from("ya_sessions").upsert({
        user_id: uid,
        username: p.username,
        password: p.password,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        remark: typeof p.remark === "string" ? p.remark : "",
        status: "active",
        last_check_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (upErr) return res({ success: false, error: `保存绑定信息失败：${upErr.message}` }, 500);
      return res({ success: true, data: { bound: true } });
    }

    // ── 其余 action：读取存储的鸭影臻藏 token ──────────────────────────────
    const { data: session } = await appClient
      .from("ya_sessions").select("access_token, refresh_token").eq("user_id", uid).maybeSingle();
    if (!session?.access_token) return res({ success: false, error: "未绑定鸭影臻藏账号，请先绑定" }, 400);

    let yaToken = session.access_token;

    // 带自动续签的 RPC 包装
    const call = async (rpc: string, rpcBody: Record<string, unknown>) => {
      try {
        return await yaRpc(yaToken, rpc, rpcBody);
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (session.refresh_token && (msg.includes("JWT") || msg.includes("expired") || msg.includes("401"))) {
          const fresh = await refreshYaToken(session.refresh_token);
          yaToken = fresh.access_token;
          await appClient.from("ya_sessions").update({
            access_token: fresh.access_token,
            refresh_token: fresh.refresh_token,
            status: "active",
          }).eq("user_id", uid);
          return await yaRpc(yaToken, rpc, rpcBody);
        }
        throw e;
      }
    };

    let result: unknown;
    switch (action) {
      case "searchVideos": {
        // 归一化关键词：压缩连续空格（含全角）+ trim，空则报错
        const norm = (s: string) => s.replace(/[\s\u3000]+/g, " ").trim().toLowerCase();
        const kw = String(p.title ?? "").replace(/[\s\u3000]+/g, " ").trim();
        if (!kw) return res({ success: false, error: "缺少 title" }, 400);

        // 包含匹配：直接查鸭影 REST（videos 标题 ilike 命中即返回）
        // ilike 忽略大小写；精确匹配结果由下方排序置顶
        // 关键词含多空格时 ilike 可能不命中，先原样查，未命中再用去空格版本兜底重查
        const likeEsc = (s: string) => s.replace(/([%_\\])/g, "\\$1");
        const compact = (s: string) => s.replace(/[\s\u3000]/g, "");

        // 解析 yaToken JWT 取鸭影平台 user_id（即 resource_links.submitter_id）
        const decodeJwtSub = (token: string): string | null => {
          try {
            const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
            const decoded = JSON.parse(atob(payload));
            return typeof decoded.sub === "string" ? decoded.sub : null;
          } catch { return null; }
        };
        const yaSubmitterId = decodeJwtSub(yaToken);

        const fetchVideos = async (kwLike: string): Promise<unknown[]> => {
          const q = new URLSearchParams();
          // 使用正确的 PostgREST 嵌套资源语法，过滤条件通过 query params 传递
          q.set("select", "id,title,category,resource_links(id,url,name,drive_type,extract_code,created_at)");
          q.set("title", `ilike.*${likeEsc(kwLike)}*`);
          q.set("limit", "20");
          // 只返回有效链接
          q.set("resource_links.is_valid", "is.true");
          // 关键：只返回当前绑定账号自己发布的链接（submitter_id 过滤）
          if (yaSubmitterId) q.set("resource_links.submitter_id", `eq.${yaSubmitterId}`);
          const vr = await fetch(`${YA_URL}/rest/v1/videos?${q.toString()}`, {
            headers: { apikey: YA_ANON, Authorization: `Bearer ${yaToken}` },
          });
          const vd = await vr.json().catch(() => []);
          if (!vr.ok) {
            const msg = Array.isArray(vd)
              ? `search_videos 失败 (HTTP ${vr.status})`
              : (vd as { message?: string })?.message;
            throw new Error(msg || `search_videos 失败 (HTTP ${vr.status})`);
          }
          return Array.isArray(vd) ? vd : [];
        };

        let videos = await fetchVideos(kw);
        const kwCompact = compact(kw);
        if (videos.length === 0 && kwCompact !== kw) {
          // 兜底：多空格输入（如「凡人 修仙传」）与标题空格不一致时，用去空格关键词重查
          videos = await fetchVideos(kwCompact);
        }
        // 本地二次过滤：归一化（去空格+小写）后的标题必须包含归一化关键词（容错全半角空格差异）
        if (kwCompact && videos.length > 0) {
          videos = videos.filter(
            (v: { title?: string }) => compact(v.title ?? "").toLowerCase().includes(kwCompact.toLowerCase())
          );
        }

        // 过滤无有效链接的片源（排除纯磁力链）；精确匹配（忽略大小写/去全部空格后相等）置顶
        const isCloud = (l: { drive_type?: string }) => l.drive_type !== "magnet";
        const withLinks = videos.filter(
          (v: { resource_links?: unknown[] }) =>
            Array.isArray(v.resource_links) &&
            (v.resource_links as { drive_type?: string }[]).some(isCloud)
        );
        const isExact = (v: { title?: string }) => norm(v.title ?? "") === norm(kw) ||
          compact(v.title ?? "").toLowerCase() === kwCompact.toLowerCase();
        const ordered = [
          ...withLinks.filter((v: { title?: string }) => isExact(v)),
          ...withLinks.filter((v: { title?: string }) => !isExact(v)),
        ];
        result = {
          found: ordered.length > 0,
          videos: ordered.map(
            (v: { id: number; title: string; category: string | null; resource_links: unknown[] }) => ({
              video: { id: v.id, title: v.title, category: v.category },
              // 只返回云盘链接，过滤磁力链
              links: (v.resource_links as { drive_type?: string }[]).filter(isCloud),
            })
          ),
        };
        break;
      }

      case "addResource": {
        if (!p.title || !p.name || !p.url) return res({ success: false, error: "缺少必要参数(title/name/url)" }, 400);
        result = await call("api_add_resource", {
          p_title: p.title,
          p_category: p.category ?? "anime",
          p_name: p.name,
          p_url: p.url,
          ...(p.extractCode ? { p_extract_code: p.extractCode } : {}),
        });
        break;
      }

      case "updateResource": {
        if (!p.linkId) return res({ success: false, error: "未找到鸭影片源 ID，请重新在「绑定站点」中绑定鸭影资源" }, 400);
        const ub: Record<string, unknown> = { p_link_id: p.linkId };
        if (p.name !== undefined) ub.p_name = p.name;
        if (p.url !== undefined) ub.p_url = p.url;
        if (p.extractCode !== undefined) ub.p_extract_code = p.extractCode;
        result = await call("api_update_resource", ub);
        break;
      }

      case "accountStatus":
        result = await call("api_get_account_status", {});
        break;

      default:
        return res({ success: false, error: `未知 action: ${action}` }, 400);
    }

    await appClient.from("ya_sessions")
      .update({ last_check_at: new Date().toISOString(), status: "active" }).eq("user_id", uid);

    return res({ success: true, data: result });
  } catch (e) {
    return res({ success: false, error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

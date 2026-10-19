// ============================================================
// Supabase Edge Function: go —— 中转短链跳转 + 点击打点
//
// 用途：分享出去的是本系统生成的短链；
//   访问 https://<项目>.supabase.co/functions/v1/go/<短码>[?c=渠道]
//   → 记录一次点击（渠道 / UA / Referer / IP 加盐哈希）
//   → 302 跳转到真实网盘链接（带提取码时先给一个提示页）
//
// 要点：
//   · 匿名可访问 → config.toml 里必须 verify_jwt = false
//   · 计数与明细全部走 public.short_link_hit()（security definer，原子自增）
//   · IP 只存加盐 sha256 前 32 位，不存明文
//   · 识别明显爬虫：仍记明细但标 is_bot，且不计入总点击
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
/** 站点前台地址（404 页上的「返回首页」用），没配就不显示 */
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").trim();
/** IP 哈希盐：换盐后历史访客判定会重置（同一 IP 会被当成新访客） */
const SALT = Deno.env.get("SHORTLINK_SALT") ?? "shortlink-default-salt-v1";

const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** 明显的爬虫 / 预览抓取 UA（这类请求不计入点击量） */
const BOT_RE =
  /(bot|crawler|spider|crawl|curl|wget|python|java\/|go-http|okhttp|headless|phantom|slurp|baiduspider|yandex|sogou|bytespider|facebookexternalhit|telegrambot|whatsapp|discord|preview|scrapy|node-fetch|axios)/i;

function html(title: string, body: string, status = 200): Response {
  const doc = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
         background:#0b0f14; color:#e6edf3; padding:24px; }
  .card { width:100%; max-width:420px; background:#151b23; border:1px solid #263039;
          border-radius:14px; padding:22px; }
  .t { font-size:16px; font-weight:600; margin:0 0 6px; line-height:1.4; word-break:break-all; }
  .d { font-size:12px; color:#8b949e; margin:0 0 16px; line-height:1.6; }
  .code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size:22px; letter-spacing:2px;
          background:#0d1117; border:1px dashed #3d4754; border-radius:10px; padding:12px;
          text-align:center; margin:0 0 14px; user-select:all; }
  a.btn { display:block; text-align:center; text-decoration:none; background:#2f81f7; color:#fff;
          padding:11px 14px; border-radius:10px; font-size:14px; font-weight:600; }
  a.btn.ghost { background:transparent; color:#8b949e; font-weight:400; margin-top:10px; font-size:12px; }
</style></head>
<body><div class="card">${body}</div></body></html>`;
  return new Response(doc, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function redirect(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Referrer-Policy": "no-referrer-when-downgrade",
    },
  });
}

/** 客户端 IP：优先 CDN/代理头里的第一个 */
function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  return (req.headers.get("x-real-ip") ?? "").trim();
}

async function hashIp(ip: string): Promise<string> {
  if (!ip) return "";
  const data = new TextEncoder().encode(`${SALT}|${ip}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/**
 * 限流：调用 rate_limit_hit（数据库原子计数）。
 * 限流设施本身出问题时**放行** —— 不能因为限流故障把正常用户的跳转也挡掉。
 */
async function rateHit(bucket: string, windowSeconds: number, limit: number): Promise<boolean> {
  try {
    const { data, error } = await svc.rpc("rate_limit_hit", {
      p_bucket: bucket,
      p_window_seconds: windowSeconds,
      p_limit: limit,
    });
    if (error) return true;
    return data !== false;
  } catch {
    return true;
  }
}

/** 进程内 IP 限流（零成本第一层）：同一 isolate 内按来源记窗口，冷启动即清空 */
const ipWindow = new Map<string, { start: number; hits: number }>();
function ipAllowed(ipKey: string, windowSeconds: number, limit: number): boolean {
  if (!ipKey) return true;
  const now = Date.now();
  const w = ipWindow.get(ipKey);
  if (!w || now - w.start > windowSeconds * 1000) {
    if (ipWindow.size > 5000) ipWindow.clear(); // 防内存膨胀
    ipWindow.set(ipKey, { start: now, hits: 1 });
    return true;
  }
  w.hits += 1;
  return w.hits <= limit;
}

/** JSON 模式返回（自带 CORS，供自有域名上的前端兜底页面调用） */
function jsonRes(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Cache-Control": "no-store",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      },
    });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return html("不支持的请求", `<p class="t">不支持的请求方式</p><p class="d">请直接用浏览器打开短链。</p>`, 405);
  }

  const url = new URL(req.url);
  // 短码来源：路径段优先（/go/<code>），也兼容 /go?code=<code>。
  // 短码支持「多段路径」形态：形如 gy/s/1956421372229992464_aeZIFqDoqz15G-J_
  // —— 这就是「在原链接基础上做短链」：分享出去只有域名不同，路径与原链接一致。
  // 注意 `c` 是「渠道」而不是短码，别把两者混用。
  const segs = url.pathname.split("/").filter(Boolean);
  const goIdx = segs.lastIndexOf("go");
  const tailSegs = goIdx >= 0 ? segs.slice(goIdx + 1) : segs;
  const pathCode = tailSegs.join("/");
  const lastSeg = tailSegs.length ? tailSegs[tailSegs.length - 1] : "";
  const code = pathCode || (url.searchParams.get("code") ?? "").trim();

  if (!code) {
    return html("短链无效", `<p class="t">短链缺少短码</p><p class="d">请确认链接完整，例如 …/functions/v1/go/abc123</p>`, 404);
  }

  const channel = (url.searchParams.get("c") ?? url.searchParams.get("ch") ?? url.searchParams.get("channel") ?? url.searchParams.get("src") ?? "").trim();
  /** JSON 模式：自有域名上的前端兜底页用它拿跳转地址（默认仍是服务端 302） */
  const wantsJson = url.searchParams.get("json") === "1" ||
    (req.headers.get("accept") ?? "").includes("application/json");
  const ua = req.headers.get("user-agent") ?? "";
  const referer = req.headers.get("referer") ?? "";
  const isBot = BOT_RE.test(ua);
  const ipHash = await hashIp(clientIp(req));

  type HitRow = {
    found: boolean;
    enabled: boolean;
    expired: boolean;
    target_url: string | null;
    extract_code: string | null;
    title: string | null;
    is_unique: boolean;
    link_id: string | null;
  };

  /** 打点一次（不存在的短码不会写入任何明细，安全） */
  const hit = async (codeStr: string): Promise<HitRow | null> => {
    const { data, error } = await svc.rpc("short_link_hit", {
      p_code: codeStr,
      p_ip_hash: ipHash,
      p_ua: ua,
      p_referer: referer,
      p_channel: channel,
      p_is_bot: isBot,
    });
    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data[0] : data) as HitRow | null;
  };

  /** 不记账的查表（被限流时用）：只取目标与状态，不写点击明细 */
  const lookupOnly = async (codeStr: string): Promise<HitRow | null> => {
    const { data } = await svc
      .from("short_links")
      .select("id, target_url, extract_code, title, enabled, expires_at")
      .eq("code", codeStr)
      .maybeSingle();
    if (!data) return null;
    const row2 = data as {
      id: string; target_url: string | null; extract_code: string | null;
      title: string | null; enabled: boolean | null; expires_at: string | null;
    };
    const expired = row2.expires_at ? new Date(row2.expires_at).getTime() < Date.now() : false;
    return {
      found: true,
      enabled: row2.enabled !== false && !expired,
      expired,
      target_url: row2.target_url,
      extract_code: row2.extract_code,
      title: row2.title,
      is_unique: false,
      link_id: row2.id,
    };
  };

  try {
    // ── 防滥用（三层）──
    // ① 全局：整站每分钟最多 N 次 → 被刷爆时直接 429，最省资源（护住数据库与函数调用配额）
    // ② 单短码：某个码被狂刷 → 只停止「记账」，正常用户跳转照旧
    // ③ 单 IP：同一来源高频 → 同上（进程内计数，零数据库开销）
    const globalOk = await rateHit("global", 60, 6000);
    if (!globalOk) {
      if (wantsJson) return jsonRes({ ok: false, reason: "rate_limited" }, 429);
      return html("访问过于频繁", `<p class="t">访问过于频繁</p><p class="d">请稍后再试。</p>`, 429);
    }
    const codeOk = await rateHit(`code:${code}`, 60, 120);
    const ipOk = ipAllowed(ipHash || "anon", 60, 60);
    /** 是否记账本次点击：被限流时不记账 —— 跳转照常，攻击拿不到任何效果 */
    const countThisHit = codeOk && ipOk;

    let row = countThisHit ? await hit(code) : await lookupOnly(code);
    // 多段路径短码没命中时，再按最后一段兜一次（兼容只存短码的旧链接）
    if ((!row || !row.found) && lastSeg && lastSeg !== code) {
      const alt = countThisHit ? await hit(lastSeg) : await lookupOnly(lastSeg);
      if (alt?.found) row = alt;
    }

    if (!row || !row.found) {
      if (wantsJson) return jsonRes({ ok: false, reason: "not_found" }, 404);
      return html("短链不存在", `<p class="t">短链不存在或已被删除</p><p class="d">请向分享者确认链接是否正确。</p>`, 404);
    }
    if (!row.enabled) {
      const reason = row.expired ? "expired" : "disabled";
      if (wantsJson) return jsonRes({ ok: false, reason }, 410);
      const why = row.expired ? "该分享链接已过期" : "该分享链接已被分享者停用";
      return html("链接不可用", `<p class="t">${why}</p><p class="d">请联系分享者重新获取链接。</p>`, 410);
    }

    const target = String(row.target_url ?? "");
    if (!target) {
      if (wantsJson) return jsonRes({ ok: false, reason: "no_target" }, 410);
      return html("链接不可用", `<p class="t">短链没有配置目标地址</p>`, 410);
    }

    if (wantsJson) {
      return jsonRes({
        ok: true,
        target_url: target,
        extract_code: row.extract_code,
        title: row.title,
        counted: !isBot,
      });
    }

    // 带提取码：先给提示页（用户需要看到码），点击量同样已计入
    if (row.extract_code) {
      const escapedCode = String(row.extract_code).replace(/[<>&"]/g, "");
      const safeTarget = target.replace(/"/g, "&quot;");
      return html(
        "提取码",
        `<p class="t">${(row.title ?? "").replace(/[<>&]/g, "") || "资源提取"}</p>
         <p class="d">提取码（已复制可直接粘贴）：</p>
         <div class="code">${escapedCode}</div>
         <a class="btn" href="${safeTarget}" rel="nofollow noopener">前往网盘并粘贴提取码</a>
         ${SITE_URL ? `<a class="btn ghost" href="${SITE_URL}">返回首页</a>` : ""}`
      );
    }

    return redirect(target);
  } catch (e) {
    console.error("[go] 短链跳转失败：", (e as Error).message, { code });
    // 统计失败不能挡住用户拿链接：退化为直接查目标地址
    try {
      let { data } = await svc.from("short_links").select("target_url, extract_code, enabled, expires_at").eq("code", code).maybeSingle();
      if (!data && lastSeg && lastSeg !== code) {
        ({ data } = await svc.from("short_links").select("target_url, extract_code, enabled, expires_at").eq("code", lastSeg).maybeSingle());
      }
      const link = data as { target_url?: string; enabled?: boolean; expires_at?: string | null } | null;
      if (link?.target_url) {
        const expired = link.expires_at ? new Date(link.expires_at).getTime() < Date.now() : false;
        if (link.enabled !== false && !expired) {
          if (wantsJson) return jsonRes({ ok: true, target_url: link.target_url, counted: false });
          return redirect(link.target_url);
        }
      }
    } catch { /* 兜底也失败 → 走下面的错误页 */ }
    if (wantsJson) return jsonRes({ ok: false, reason: "error" }, 500);
    return html("暂时无法访问", `<p class="t">短链服务暂时不可用</p><p class="d">请稍后重试。</p>`, 500);
  }
});

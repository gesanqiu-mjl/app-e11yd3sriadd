/**
 * batch-post：批量发帖专用入口（服务端权限校验）
 *
 * 为什么单独做一个函数：
 *   批量发帖与「单条快捷绑定 / 资源同步」调用的是同一批站点创建接口（xnshare-proxy
 *   action=add、xnshare-proxy action=add、jying-proxy action=add ...）。若直接在这些
 *   代理函数上加权限校验，会把用户正常的单条绑定 / 同步一起锁掉。
 *   因此批量发帖统一走本函数：先校验调用方的「批量发帖权限」（管理员在后台开通，
 *   可设 1/3/6/12 个月有效期，到期即失效），通过后再把请求原样转发给对应站点代理
 *   （Authorization token 原样透传，站点会话 / Cookie 等逻辑保持不变）。
 *
 * 请求体：
 *   { site: 'xnsite' | 'ya' | 'framehdr' | 'mukaku' | 'jying',
 *     payload: { ...该站点代理要求的原始字段... },
 *     useShortLink?: boolean }
 *
 * 关于 useShortLink（短链开关，可选）：
 *   · true  = 本次发帖正文里的网盘链接替换成该链接自己的短链（光鸭短码带前缀 g、夸克带 q，便于区分）；
 *   · false = 完全按原样推送原始网盘链接（历史行为）；
 *   · 不传   = 用账号默认：管理员默认开、其它账号默认关。
 *   替换只发生在「发给站点的正文」，本应用资源库与站点绑定关系仍保存原始网盘链接，
 *   保证后续增量同步可用；短链生成失败时自动回退原链，绝不影响发帖成败。
 * 响应：
 *   原样返回上游代理的响应体与状态码（含站点错误码，便于前端给出具体原因）；
 *   无权限时 403 + code = BATCH_POST_FORBIDDEN。
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// 本 App Supabase（平台自动注入）
const APP_URL = Deno.env.get("SUPABASE_URL")!;
const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/**
 * 站点 → 上游代理调用规格（白名单，避免本函数被当成通用代理滥用）。
 * actionInBody：resource-manager 是唯一把 action 放进请求体的代理，其余用 query。
 */
const SITES: Record<
  string,
  { fn: string; action: string; actionInBody: boolean; timeoutMs: number }
> = {
  xnsite: { fn: "xnshare-proxy", action: "add", actionInBody: false, timeoutMs: 20000 },
  ya: { fn: "resource-manager", action: "addResource", actionInBody: true, timeoutMs: 20000 },
  framehdr: { fn: "framehdr-proxy", action: "add", actionInBody: false, timeoutMs: 20000 },
  mukaku: { fn: "mukaku-proxy", action: "add", actionInBody: false, timeoutMs: 20000 },
  jying: { fn: "jying-proxy", action: "add", actionInBody: false, timeoutMs: 45000 },
};

// ── 短链：把正文里的网盘链接换成「该链接自己的短链」 ──
/** 短码字符集：去掉 0/o/1/l/i 等易混字符（与前端保持一致） */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** 短链对外域名（可选）：未配置时退回本项目的函数地址 */
const SHORTLINK_BASE = (Deno.env.get("SHORTLINK_BASE") ?? "").trim().replace(/\/+$/, "");

function randomShortCode(prefix = ""): string {
  const n = Math.max(1, 6 - prefix.length);
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return prefix + Array.from(bytes).map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** 网盘前缀：光鸭 g / 夸克 q / 其它 x —— 让不同网盘的短链一眼可区分 */
function panPrefixOf(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("guangya")) return "g";
  if (u.includes("quark")) return "q";
  return "x";
}

/** 网盘分享域名允许清单（按 hostname 精确判断，避免把己方域名误当网盘链接） */
const PAN_HOST_RE =
  /(^|\.)(guangyapan\.com|quark\.cn|aliyundrive\.com|alipan\.com|pan\.baidu\.com|pan\.xunlei\.com|123pan\.com|123pan\.cn|123684\.com|uc\.cn)$/;

/** 己方域名（短链域名 / 站点域名 / 后端域名）：已是短链的正文不能再「短链化」，否则自指 */
function selfHosts(): string[] {
  const out = new Set<string>();
  for (const raw of [SHORTLINK_BASE, APP_URL, Deno.env.get("SITE_URL") ?? ""]) {
    try {
      if (raw) out.add(new URL(raw).hostname.toLowerCase());
    } catch { /* 配置项不是合法 URL → 忽略 */ }
  }
  return [...out];
}

/** 只替换真正的网盘分享链接（且不是己方域名），避免误伤站点链接与已有短链 */
function isPanLink(url: string): boolean {
  try {
    const h = new URL(url.trim()).hostname.toLowerCase();
    if (selfHosts().some((s) => h === s || h.endsWith(`.${s}`))) return false;
    return PAN_HOST_RE.test(h);
  } catch {
    return false;
  }
}

/** 拼对外短链：有自有域名用域名，否则退回函数地址（两条前端/函数都能解析） */
function shortUrlOf(code: string): string {
  return SHORTLINK_BASE ? `${SHORTLINK_BASE}/go/${code}` : `${APP_URL}/functions/v1/go/${code}`;
}

/** 取（或新建）这条链接的短链；失败返回 null（调用方保留原链） */
async function shortUrlFor(
  appClient: SupabaseClient,
  targetUrl: string,
  userId: string
): Promise<string | null> {
  // 同账号 + 同目标已有短链 → 直接复用，避免同一链接生成多条（按账号隔离，不跨用户复用）
  const { data: existing } = await appClient
    .from("short_links")
    .select("code")
    .eq("user_id", userId)
    .eq("target_url", targetUrl)
    .limit(1)
    .maybeSingle<{ code: string }>();
  if (existing?.code) return shortUrlOf(existing.code);

  const prefix = panPrefixOf(targetUrl);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomShortCode(prefix);
    const { error } = await appClient.from("short_links").insert({
      user_id: userId,
      code,
      title: targetUrl,
      target_url: targetUrl,
    });
    if (!error) return shortUrlOf(code);
    // 23505 = 短码撞车 → 换一个再试
    if ((error as { code?: string }).code !== "23505") return null;
  }
  return null;
}

/**
 * 把 payload 里的网盘链接换成短链（仅当开关为真时调用）。
 * 任何异常都保留原链接 —— 短链绝不能影响发帖成败。
 */
async function replaceLinksWithShort(
  appClient: SupabaseClient,
  payload: Record<string, unknown>,
  userId: string
): Promise<{ payload: Record<string, unknown>; replaced: number }> {
  const out: Record<string, unknown> = { ...payload };
  let replaced = 0;
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "string" || !/^https?:\/\//i.test(v) || !isPanLink(v)) continue;
    try {
      const short = await shortUrlFor(appClient, v, userId);
      if (short) {
        out[k] = short;
        replaced += 1;
      }
    } catch { /* 单条失败 → 保留原链 */ }
  }
  return { payload: out, replaced };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ success: false, message: "请先登录" }, 401);

    const body = (await req.json().catch(() => null)) as
      | {
          site?: string;
          payload?: Record<string, unknown>;
          /** 短链开关：true/false 显式指定；不传 = 账号默认（管理员开、其它关） */
          useShortLink?: boolean;
          shortLink?: boolean;
          use_short_link?: boolean;
        }
      | null;
    const site = typeof body?.site === "string" ? body.site : "";
    const payload = body?.payload;
    const spec = SITES[site];
    if (!spec) return json({ success: false, message: `不支持的站点：${site || "（空）"}` }, 400);
    if (!payload || typeof payload !== "object") {
      return json({ success: false, message: "缺少 payload" }, 400);
    }

    const appClient = createClient(APP_URL, SVC_KEY);

    // ① 校验本应用登录态
    const {
      data: { user },
      error: userErr,
    } = await appClient.auth.getUser(token);
    if (userErr || !user) return json({ success: false, message: "登录态无效，请重新登录" }, 401);

    // ② 服务端校验批量发帖权限（前端无法绕过）
    const { data: profile, error: profileErr } = await appClient
      .from("profiles")
      .select("role, status, batch_post_expires_at")
      .eq("id", user.id)
      .maybeSingle();
    if (profileErr) throw profileErr;

    if (profile?.status === "disabled") {
      return json({ success: false, message: "账号已被禁用，请联系管理员" }, 403);
    }

    const expires = (profile?.batch_post_expires_at ?? null) as string | null;
    const allowed = profile?.role === "admin" || (!!expires && new Date(expires).getTime() > Date.now());
    if (!allowed) {
      return json(
        {
          success: false,
          code: "BATCH_POST_FORBIDDEN",
          message: expires
            ? `批量发帖权限已于 ${new Date(expires).toLocaleString("zh-CN")} 到期，请联系管理员续期`
            : "批量发帖权限未开通，请联系管理员开通",
        },
        403
      );
    }

    // ③ 短链开关：调用方显式指定优先；未指定时管理员默认开启、其它账号默认关闭。
    //    脚本/第三方直接调用时传 useShortLink: true / false 即可自行选择。
    const explicitShort = [body?.useShortLink, body?.shortLink, body?.use_short_link]
      .find((v) => typeof v === "boolean") as boolean | undefined;
    const useShortLink = explicitShort ?? profile?.role === "admin";
    let forwardPayload = payload;
    if (useShortLink) {
      const r = await replaceLinksWithShort(appClient, payload, user.id);
      forwardPayload = r.payload;
    }

    // ④ 转发给站点代理（原样透传 token，站点侧会话/Cookie 逻辑不变）
    const url = spec.actionInBody
      ? `${APP_URL}/functions/v1/${spec.fn}`
      : `${APP_URL}/functions/v1/${spec.fn}?action=${encodeURIComponent(spec.action)}`;
    const upstreamBody = spec.actionInBody ? { action: spec.action, ...forwardPayload } : forwardPayload;

    const upstream = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(spec.timeoutMs),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        ...CORS,
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e) {
    const err = e as Error;
    const isTimeout = err?.name === "TimeoutError" || /abort|timeout/i.test(err?.message ?? "");
    return json(
      { success: false, message: isTimeout ? "站点响应超时，请稍后重试" : err?.message || "批量发帖失败" },
      isTimeout ? 504 : 500
    );
  }
});

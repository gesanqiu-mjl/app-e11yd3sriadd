// ============================================================
// Supabase Edge Function: hdhaven-proxy
// 栖影 HDHaven（hdhaven.com）网盘分享代理
//
// 依据《栖影 HDHaven API 接口对接文档》实现：站点鉴权走「同源 httpOnly 会话 Cookie」，
// 不使用 Authorization / Token 头，凭据（Cookie）只存服务端，不下发前端。
//
// 部署：supabase functions deploy hdhaven-proxy
// 环境变量：SITE_URL（可选，CORS 白名单，默认 *）
//
// 调用：GET|POST /hdhaven-proxy?action=<action>
//   Authorization: Bearer <access_token>   （本站 Supabase 登录态）
//
// ── 账号 ────────────────────────────────────────────────────
//   login           POST /api/auth/login                       账号密码登录（可选 totp_code；成功实测 201）
//   logout          POST /api/auth/logout + 清空本地会话
//   status          GET  /api/auth/me                          校验会话（返回 points / level / pan_prefs 等）
//   prefs           POST /api/users/me/prefs                    网盘偏好 {pan_prefs:["guangya","115"]}
// ── 我的分享 ────────────────────────────────────────────────
//   my_shares       GET  /api/users/me/shares                   我的分享记录（全量、无分页/筛选）
//   detail          GET  /api/users/me/shares/{slug}            单条详情（含 url / access_code / file_preview）
//   inspect         POST /api/account/inspect-link              解析新分享链接（识别 pan_type / size）
//   update          POST /api/users/me/shares/{slug}/update     更新分享（站点为「全量字段回写」语义）
//   delete_share    POST /api/users/me/shares/{slug}/delete     删除分享
//   create_share    POST /api/resources                         新建分享（投稿；文档未收录，自站点前端确认）
// ── 片源查询 ────────────────────────────────────────────────
//   search_tmdb     GET  /api/tmdb/search/{category}?query=      片源检索（TMDB，中文可直接搜）
//   tmdb_detail     GET  /api/tmdb/{type}/{id}                   影视详情
//   trending        GET  /api/tmdb/trending/now                  热门推荐
//   home            GET  /api/tmdb/home/{type}/{mode}            首页栏目（如 movie/popular）
//   rankings        GET  /api/rankings/{type}/{period}           榜单
//   calendar        GET  /api/calendar/upcoming                  上映日历
//   resources       GET  /api/resources/{media_type}/{tmdb_id}   按 TMDB ID 查询站内资源
//   catalog         GET  /api/catalog/resources                  全站资源目录（data.items）
// ── 风控 ────────────────────────────────────────────────────
//   challenge       POST /api/security/challenge                取图形验证码 → data:{id,image}（5 位字符）
//   verify          POST /api/security/verify                   提交验证码 {id,answer}，通过后由前端重放原请求
//
// 鉴权：站点为同源 httpOnly 会话 Cookie；本站为 Supabase Bearer（service role 读写会话表）。
// 失败：HTTP 4xx/5xx + {"statusCode":401,"message":"..."}；401 视为会话失效。
// 风控：请求过频返回 {"code":"SCRAPE_CHALLENGE_REQUIRED"}，本代理按「限速 + 退避重试一次」处理，
//       仍命中则返回 code=HDHAVEN_CHALLENGE_REQUIRED（429），由前端走 challenge / verify 闭环。
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveCallerId } from "../_shared/internalAuth.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "*";
const BASE = "https://hdhaven.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_URL,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const EXPIRED_BODY = { error: "栖影登录已过期，请重新登录", code: "HDHAVEN_COOKIE_EXPIRED" };
/** 会话失效响应：带上站点原文，便于前端与日志定位真实原因 */
const expired = (siteMessage?: string) =>
  json(siteMessage ? { ...EXPIRED_BODY, error: `栖影：${siteMessage}` } : EXPIRED_BODY, 401);

const NOT_BOUND_BODY = { error: "未绑定栖影账号，请先登录", code: "HDHAVEN_NOT_BOUND" };

/** 命中站点风控图形验证码门，需前端取图人工识别后重放原请求 */
const CHALLENGE_BODY = {
  error: "栖影要求完成图形验证码校验（请求过频），请在弹出的验证码中填写图片字符后重试",
  code: "HDHAVEN_CHALLENGE_REQUIRED",
};

/** update 为「全量字段回写」：音乐类资源的附加字段需原样回写，否则会被清空 */
const MUSIC_FIELDS = ["music_artist", "music_album", "music_year", "music_metadata"] as const;

/** 支持的 action 列表（default 分支返回，便于排查调用错误） */
const ACTIONS = [
  "login",
  "bindCookie",
  "logout",
  "status",
  "prefs",
  "my_shares",
  "detail",
  "inspect",
  "update",
  "delete_share",
  "create_share",
  "search_tmdb",
  "tmdb_detail",
  "trending",
  "home",
  "rankings",
  "calendar",
  "resources",
  "catalog",
  "challenge",
  "verify",
];

// ---------- 工具 ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getSetCookies(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  return h.getSetCookie?.() ?? [];
}

/** 极简 Cookie jar：维护站点下发的会话 Cookie */
function createJar(initial = "") {
  const store = new Map<string, string>();
  for (const part of initial.split(";")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf("=");
    if (i > 0) store.set(s.slice(0, i).trim(), s.slice(i + 1).trim());
  }
  return {
    set(raw: string) {
      const pair = raw.split(";")[0];
      const i = pair.indexOf("=");
      if (i <= 0) return;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!name) return;
      if (/max-age=0/i.test(raw)) store.delete(name);
      else store.set(name, value);
    },
    setAll(cookies: string[]) {
      for (const c of cookies) this.set(c);
    },
    get(name: string) {
      return store.get(name) ?? "";
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

type Jar = ReturnType<typeof createJar>;

function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const text = await req.text().catch(() => "");
  if (!text) return {};
  const parsed = parseJsonSafe<Record<string, unknown>>(text);
  if (parsed && typeof parsed === "object") return parsed;
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

/** 取站点响应里的可展示错误文案（栖影失败体为 {statusCode, message}） */
function siteMessageOf(text: string): string {
  const j = parseJsonSafe<{ message?: string; detail?: string; error?: string }>(text);
  return String(j?.message ?? j?.detail ?? j?.error ?? "").trim();
}

/** 站点侧「未登录 / 会话失效」判定：401 或站点明确的失效文案 */
function isAuthFailure(res: Response, text: string): boolean {
  if (res.status === 401) return true;
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  const j = parseJsonSafe<{ statusCode?: number; message?: string; detail?: string }>(t);
  if (j?.statusCode === 401) return true;
  const msg = `${j?.message ?? ""} ${j?.detail ?? ""}`.trim();
  if (!msg) return false;
  return /未登录|请先登录|登录已失效|登录已过期|登录状态已失效|请重新登录|会话已过期/.test(msg);
}

/** 是否命中风控图形验证码门 */
function isChallenge(text: string): boolean {
  return text.includes("SCRAPE_CHALLENGE_REQUIRED");
}

/**
 * 限速：站点对请求频率敏感（命中后需人工过验证码），
 * 文档建议 ≤1 req/s + 退避，因此串行请求之间保持最小间隔。
 */
const MIN_GAP_MS = 600;
let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/** 带会话 Cookie 的站点请求（自动回写站点下发的 Cookie 变更、限速） */
async function siteFetch(
  path: string,
  opts: {
    jar: Jar;
    method?: string;
    body?: unknown;
    /** 命中风控验证码门时是否退避重试一次 */
    retryOnChallenge?: boolean;
  }
): Promise<{ res: Response; text: string; challenge: boolean }> {
  const method = opts.method ?? "GET";
  const attempt = async () => {
    await throttle();
    const headers: Record<string, string> = {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: `${BASE}/`,
      Origin: BASE,
      Cookie: opts.jar.header(),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
    });
    opts.jar.setAll(getSetCookies(res));
    const text = await res.text();
    return { res, text, challenge: isChallenge(text) };
  };

  let r = await attempt();
  if (r.challenge && opts.retryOnChallenge !== false) {
    // 风控门：退避后重试一次，仍失败则由前端走验证码闭环
    await sleep(2000);
    r = await attempt();
  }
  return r;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * 验证码图片统一内联成 data URL。
 * 站点返回的 image 可能是 data URL / 绝对地址 / 相对路径；相对路径时由服务端带会话取回，
 * 避免前端 <img> 直连站点因缺少 httpOnly 会话而取不到图。取回失败则退回绝对地址。
 */
async function inlineImage(jar: Jar, src: string): Promise<string> {
  if (/^data:/i.test(src)) return src;
  const abs = /^https?:/i.test(src) ? src : `${BASE}${src.startsWith("/") ? "" : "/"}${src}`;
  if (!abs.startsWith(BASE)) return abs;
  try {
    const res = await fetch(abs, {
      headers: { "User-Agent": UA, Referer: `${BASE}/`, Cookie: jar.header() },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return abs;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get("Content-Type") ?? "image/png";
    return `data:${type};base64,${toBase64(bytes)}`;
  } catch {
    return abs;
  }
}

/** 账号密码登录：会话经 Set-Cookie 下发，登录成功实测返回 201 */
async function loginSite(username: string, password: string, totpCode?: string) {
  const jar = createJar();
  const body: Record<string, unknown> = { username, password };
  if (totpCode) body.totp_code = totpCode;

  const res = await siteFetch("/api/auth/login", { jar, method: "POST", body });

  const data = parseJsonSafe<{
    success?: boolean;
    data?: { user?: { id?: string; user_number?: number; nickname?: string } };
    statusCode?: number;
    message?: string;
    code?: string;
  }>(res.text);

  // 两步验证：站点返回 428，需补 6 位动态码
  if (res.res.status === 428 || data?.code === "TOTP_REQUIRED") {
    const err = new Error(data?.message || "该账号开启了两步验证，请输入 6 位动态码") as Error & {
      code?: string;
    };
    err.code = "HDHAVEN_TOTP_REQUIRED";
    throw err;
  }
  if (data?.code === "SCRAPE_CHALLENGE_REQUIRED") {
    const err = new Error("栖影要求完成图形验证码校验，请先完成验证后重试") as Error & {
      code?: string;
    };
    err.code = "HDHAVEN_CHALLENGE_REQUIRED";
    throw err;
  }
  // 登录成功实测返回 201，判成功不能写死 200
  if (res.res.status !== 200 && res.res.status !== 201) {
    throw new Error(data?.message || `登录失败（HTTP ${res.res.status}）`);
  }
  if (!data?.success) {
    throw new Error(data?.message || "登录失败，请检查账号密码");
  }
  return { jar, user: data.data?.user ?? null };
}

// ---------- 主处理 ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. 验证本站登录态（service role 客户端，绕过 RLS 读写 sessions）
    const appClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    // 鉴权：用户 JWT，或服务端 worker/定时任务的内部通道
    //（x-internal-secret + x-user-id，见 _shared/internalAuth.ts；未配置密钥时该通道关闭）
    // getUser 期望纯 JWT（不含 "Bearer " 前缀），前缀由 resolveCallerId 处理
    const callerId = await resolveCallerId(req, async (t) => {
      const { data, error } = await appClient.auth.getUser(t);
      return error ? null : (data?.user?.id ?? null);
    });
    if (!callerId) return json({ error: "登录态无效或已过期" }, 401);
    const me = { id: callerId };

    // 2. 读取栖影会话
    const { data: sessionRow } = await appClient
      .from("hdhaven_sessions")
      .select("cookie,status,username,user_number,updated_at")
      .eq("user_id", me.id)
      .maybeSingle();
    const session = sessionRow ?? null;

    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "";
    const body = await readBody(req);

    const markExpired = async () => {
      await appClient
        .from("hdhaven_sessions")
        .update({ status: "expired", last_check_at: new Date().toISOString() })
        .eq("user_id", me.id);
    };
    const touchActive = async () => {
      await appClient
        .from("hdhaven_sessions")
        .update({ status: "active", last_check_at: new Date().toISOString() })
        .eq("user_id", me.id);
    };
    const persistSession = async (jar: Jar, username: string, userNumber: number | null) => {
      const now = new Date().toISOString();
      await appClient.from("hdhaven_sessions").upsert(
        {
          user_id: me.id,
          username,
          user_number: userNumber,
          cookie: jar.header(),
          status: "active",
          last_check_at: now,
          updated_at: now,
        },
        { onConflict: "user_id" }
      );
    };

    // ---------- action: challenge / verify（风控验证码） ----------
    // 登录与未绑定场景同样可能命中风控门，因此这两个 action 早于「需已绑定」校验。
    if (action === "challenge" || action === "verify") {
      const jar = createJar(session?.cookie ?? "");

      // 站点可能在任意请求中轮换会话 Cookie，变化时立即回写，避免凭据逐渐失效
      const syncJarCookie = async () => {
        if (!session?.cookie) return;
        const after = jar.header();
        if (after && after !== session.cookie) {
          await appClient
            .from("hdhaven_sessions")
            .update({ cookie: after, updated_at: new Date().toISOString() })
            .eq("user_id", me.id);
        }
      };

      if (action === "challenge") {
        const r = await siteFetch("/api/security/challenge", {
          jar,
          method: "POST",
          body: {},
          retryOnChallenge: false,
        });
        await syncJarCookie();
        const data = parseJsonSafe<{ data?: { id?: string; image?: string } }>(r.text)?.data;
        if (!data?.id || !data?.image) {
          return json(
            { error: siteMessageOf(r.text) || `获取验证码失败（HTTP ${r.res.status}）` },
            400
          );
        }
        return json({
          success: true,
          data: { id: data.id, image: await inlineImage(jar, data.image) },
        });
      }

      const id = String(body.id ?? "").trim();
      const answer = String(body.answer ?? "").trim();
      if (!id || !answer) return json({ error: "缺少验证码 id 或答案" }, 400);
      const r = await siteFetch("/api/security/verify", {
        jar,
        method: "POST",
        body: { id, answer },
        retryOnChallenge: false,
      });
      await syncJarCookie();
      const data = parseJsonSafe<{ success?: boolean; message?: string }>(r.text);
      if (r.res.status >= 400 || data?.success === false) {
        return json(
          { error: data?.message || siteMessageOf(r.text) || "验证码校验未通过，请重新识别" },
          400
        );
      }
      return json({ success: true, message: "验证通过，正在重试原操作" });
    }

    // ---------- action: login（无需已有会话） ----------
    if (action === "login") {
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      const totpCode = String(body.totp_code ?? "").trim();
      if (!username || !password) return json({ error: "请输入栖影账号和密码" }, 400);

      try {
        const { jar, user } = await loginSite(username, password, totpCode || undefined);

        // 文档流程：登录后立即 GET /api/auth/me 校验登录态，避免存下无效会话
        const probe = await siteFetch("/api/auth/me", { jar });
        if (isAuthFailure(probe.res, probe.text)) {
          return json({ error: "栖影登录未通过校验，请检查账号或密码" }, 401);
        }
        const meData = parseJsonSafe<{
          data?: { id?: string; user_number?: number; nickname?: string };
        }>(probe.text)?.data;

        const nickname = String(
          meData?.nickname ?? user?.nickname ?? user?.id ?? meData?.id ?? username
        );
        const userNumber = meData?.user_number ?? user?.user_number ?? null;
        await persistSession(jar, nickname, userNumber);
        return json({
          success: true,
          message: "登录成功，会话已保存",
          data: { username: nickname, user_number: userNumber },
        });
      } catch (e) {
        const err = e as Error & { code?: string };
        return json(
          { error: err.message || "栖影登录失败", code: err.code ?? "HDHAVEN_LOGIN_FAILED" },
          err.code === "HDHAVEN_TOTP_REQUIRED" ? 400 : 401
        );
      }
    }

    // ---------- action: bindCookie（站点登录加了人机验证，改为粘贴浏览器会话 Cookie） ----------
    // 栖影 2026-10 起在登录接口加了 Cloudflare Turnstile 人机验证：实测 POST /api/auth/login
    // 不带验证直接返回 400「请先完成人机验证」，服务端模拟登录已不可行（Turnstile 也不能程序解）。
    // 但其余接口不校验人机验证、只认会话 Cookie（实测 GET /api/auth/me 未带会话返回 401「请先登录」），
    // 因此支持把浏览器登录后的 Cookie 粘进来：校验通过即存库，之后所有请求仍走本代理（境外出口）。
    if (action === "bindCookie") {
      const raw = String(body.cookie ?? "").trim();
      if (!raw) return json({ error: "请粘贴栖影的 Cookie" }, 400);
      // 允许直接粘贴 DevTools 里「Cookie: xxx」整行，或 Application 面板里的 name=value 串
      const cookie = raw.replace(/^\s*cookie\s*:\s*/i, "").replace(/\s+/g, " ").trim();
      if (!/=/.test(cookie)) {
        return json({ error: "Cookie 格式不对：应形如 name=value; name2=value2" }, 400);
      }

      const jar = createJar(cookie);
      try {
        const probe = await siteFetch("/api/auth/me", { jar });
        if (probe.res.status >= 400 || isAuthFailure(probe.res, probe.text)) {
          const siteMsg = siteMessageOf(probe.text);
          return json(
            {
              error:
                `Cookie 无效或已过期（站点返回：${siteMsg || probe.res.status}）：` +
                "请在浏览器里登录栖影后重新复制「Request Headers → Cookie」整串（Application → Cookies 亦可）",
            },
            401
          );
        }
        const meData = parseJsonSafe<{
          data?: { id?: string; user_number?: number; nickname?: string };
        }>(probe.text)?.data;
        const nickname = String(meData?.nickname ?? meData?.id ?? "栖影账号");
        const userNumber = meData?.user_number ?? null;
        // persistSession 存 jar.header()：若这次校验里站点轮换了 Cookie，存下来的也是最新的
        await persistSession(jar, nickname, userNumber);
        return json({
          success: true,
          message: "Cookie 校验通过，会话已保存",
          data: { username: nickname, user_number: userNumber },
        });
      } catch (e) {
        return json(
          { error: (e as Error).message || "Cookie 校验失败，请稍后重试", code: "HDHAVEN_BIND_FAILED" },
          400
        );
      }
    }

    // ---------- action: logout ----------
    if (action === "logout") {
      // 站点侧登出失败不阻塞本地解绑
      if (session?.cookie) {
        try {
          await siteFetch("/api/auth/logout", {
            jar: createJar(session.cookie),
            method: "POST",
            body: {},
            retryOnChallenge: false,
          });
        } catch (e) {
          console.error("hdhaven logout failed", e);
        }
      }
      await appClient.from("hdhaven_sessions").delete().eq("user_id", me.id);
      return json({ success: true });
    }

    // 其余 action 需已绑定
    if (!session?.cookie) return json(NOT_BOUND_BODY, 400);

    const jar = createJar(session?.cookie ?? "");

    /** 转发请求并统一处理「Cookie 刷新」「风控门」「会话失效」 */
    const forward = async (
      path: string,
      opts: { method?: string; body?: unknown } = {}
    ): Promise<
      | { expired: true; siteMessage: string }
      | { challenge: true }
      | { ok: true; status: number; text: string }
    > => {
      const cookieBefore = jar.header();
      const r = await siteFetch(path, { jar, method: opts.method, body: opts.body });

      // 站点下发的 Cookie 变化必须回写：否则本地凭据会逐渐失效
      const cookieAfter = jar.header();
      if (cookieAfter && cookieAfter !== cookieBefore && cookieAfter !== (session?.cookie ?? "")) {
        await appClient
          .from("hdhaven_sessions")
          .update({ cookie: cookieAfter, updated_at: new Date().toISOString() })
          .eq("user_id", me.id);
      }

      if (r.challenge) {
        console.error("hdhaven challenge required", path, r.res.status);
        return { challenge: true };
      }
      if (isAuthFailure(r.res, r.text)) {
        console.error("hdhaven auth failure", path, r.res.status, r.text.slice(0, 300));
        await markExpired();
        return { expired: true, siteMessage: siteMessageOf(r.text) };
      }
      if (r.res.status >= 400) {
        console.error("hdhaven request failed", path, r.res.status, r.text.slice(0, 300));
      }
      return { ok: true, status: r.res.status, text: r.text };
    };

    /** 统一错误响应：风控门 / 会话失效 */
    const failWith = (r: { challenge: true } | { expired: true; siteMessage: string }) => {
      if ("challenge" in r) return json(CHALLENGE_BODY, 429);
      return expired(r.siteMessage);
    };

    switch (action) {
      // 校验会话是否有效（同时可拿到 points / level / pan_prefs 等）
      case "status": {
        const r = await forward("/api/auth/me");
        if (!("ok" in r)) return failWith(r);
        await touchActive();
        return json({ success: true, data: parseJsonSafe(r.text)?.data ?? null });
      }

      // 网盘偏好：POST /api/users/me/prefs  body {pan_prefs:["guangya","115"]}
      case "prefs": {
        const prefs = Array.isArray(body.pan_prefs) ? (body.pan_prefs as unknown[]).map(String) : [];
        const r = await forward("/api/users/me/prefs", {
          method: "POST",
          body: { pan_prefs: prefs },
        });
        if (!("ok" in r)) return failWith(r);
        const data = parseJsonSafe<{ success?: boolean; message?: string }>(r.text);
        if (r.status >= 400 || data?.success === false) {
          return json({ error: data?.message || `保存网盘偏好失败（HTTP ${r.status}）` }, 400);
        }
        await touchActive();
        return json({ success: true, message: "网盘偏好已保存", data: prefs });
      }

      // 我的分享记录（全量，站点无分页）
      case "my_shares": {
        const r = await forward("/api/users/me/shares");
        if (!("ok" in r)) return failWith(r);
        await touchActive();
        const data = parseJsonSafe<{ data?: unknown }>(r.text);
        return json({ success: true, data: data?.data ?? [] });
      }

      // 单条分享详情（取当前 url / pan_type / file_preview 等原值）
      case "detail": {
        const slug = String(body.slug ?? url.searchParams.get("slug") ?? "").trim();
        if (!slug) return json({ error: "缺少 slug" }, 400);
        const r = await forward(`/api/users/me/shares/${encodeURIComponent(slug)}`);
        if (!("ok" in r)) return failWith(r);
        await touchActive();
        const data = parseJsonSafe<{ data?: unknown }>(r.text);
        return json({ success: true, data: data?.data ?? null });
      }

      // 解析新分享链接（识别 pan_type / size，update 前的可选步骤）
      case "inspect": {
        const linkUrl = String(body.url ?? url.searchParams.get("url") ?? "").trim();
        if (!linkUrl) return json({ error: "缺少 url" }, 400);
        const accessCode = String(body.access_code ?? "").trim();
        const r = await forward("/api/account/inspect-link", {
          method: "POST",
          body: { url: linkUrl, ...(accessCode ? { access_code: accessCode } : {}) },
        });
        if (!("ok" in r)) return failWith(r);
        const data = parseJsonSafe<{ data?: unknown }>(r.text);
        return json({ success: true, data: data?.data ?? null });
      }

      // 更新分享链接：站点为「全量字段回写」，必须先用 detail 取原值再合并，
      // 否则未提交的字段会被清空（详见接口文档 3.3 / 6.5）
      case "update": {
        const slug = String(body.slug ?? "").trim();
        const newUrl = String(body.url ?? "").trim();
        if (!slug) return json({ error: "缺少 slug" }, 400);
        if (!newUrl) return json({ error: "缺少分享链接 url" }, 400);

        const detailR = await forward(`/api/users/me/shares/${encodeURIComponent(slug)}`);
        if (!("ok" in detailR)) return failWith(detailR);
        const detail = parseJsonSafe<{ data?: Record<string, unknown> }>(detailR.text)?.data;
        if (!detail) return json({ error: "未能读取该分享的原始字段，请稍后重试" }, 400);

        // 新链接的网盘类型/提取码：优先用调用方传入，其次用 inspect-link 识别，最后沿用原值
        let panType = String(body.pan_type ?? "").trim();
        let accessCode = String(body.access_code ?? "").trim();
        let shareSize = detail.share_size as string | null;
        if (!panType) {
          const insR = await forward("/api/account/inspect-link", {
            method: "POST",
            body: { url: newUrl, ...(accessCode ? { access_code: accessCode } : {}) },
          });
          if ("ok" in insR) {
            const ins = parseJsonSafe<{
              data?: { website?: string; access_code?: string; size?: string | null };
            }>(insR.text)?.data;
            if (ins?.website) panType = ins.website;
            if (!accessCode && ins?.access_code) accessCode = ins.access_code;
            if (ins?.size) shareSize = ins.size;
          }
        }
        if (!panType) panType = String(detail.pan_type ?? "");
        if (!accessCode) accessCode = String(detail.access_code ?? "");

        // 标题：客户端传了就用它（本地资源名 / 已更新标题），没传则沿用站点现值，避免清空
        const newTitle = String(body.title ?? "").trim() || String(detail.title ?? "");
        const payload: Record<string, unknown> = {
          title: newTitle,
          url: newUrl,
          pan_type: panType,
          access_code: accessCode,
          share_size: shareSize ?? null,
          episode_range: detail.episode_range ?? "",
          video_resolution: detail.video_resolution ?? [],
          source: detail.source ?? [],
          subtitle_language: detail.subtitle_language ?? [],
          subtitle_type: detail.subtitle_type ?? [],
          remark: detail.remark ?? "",
          hide_link: detail.hide_link ?? true,
          unlock_points: detail.unlock_points ?? 0,
          file_preview: detail.file_preview ?? [],
          file_count: detail.file_count ?? 0,
        };
        // 客户端按「资源名称」解析出的属性：非空才覆盖，避免把站点已填的属性清空
        // （见 src/lib/hdhavenMeta.ts，与投稿 create_share 同一套口径）
        if (Array.isArray(body.video_resolution) && body.video_resolution.length > 0) {
          payload.video_resolution = body.video_resolution;
        }
        if (Array.isArray(body.source) && body.source.length > 0) {
          payload.source = body.source;
        }
        if (Array.isArray(body.subtitle_language) && body.subtitle_language.length > 0) {
          payload.subtitle_language = body.subtitle_language;
        }
        if (Array.isArray(body.subtitle_type) && body.subtitle_type.length > 0) {
          payload.subtitle_type = body.subtitle_type;
        }
        const nameEpisodeRange = String(body.episode_range ?? "").trim();
        if (nameEpisodeRange) payload.episode_range = nameEpisodeRange;

        // 音乐类资源的附加字段（站点仅对音乐类校验，非音乐类为空时不提交）
        for (const key of MUSIC_FIELDS) {
          const v = body[key] ?? detail[key];
          if (v !== undefined && v !== null && v !== "") payload[key] = v;
        }

        const r = await forward(`/api/users/me/shares/${encodeURIComponent(slug)}/update`, {
          method: "POST",
          body: payload,
        });
        if (!("ok" in r)) return failWith(r);

        const data = parseJsonSafe<{ success?: boolean; message?: string; data?: unknown }>(r.text);
        // 站点成功返回 201（不是 200），这里只判 4xx/5xx 与 success
        if (r.status >= 400 || !data?.success) {
          return json({ error: data?.message || `栖影更新失败（HTTP ${r.status}）` }, 400);
        }
        await touchActive();
        return json({
          success: true,
          // 普通用户改动后资源会重新进入审核，这里把站点的提示一并向用户说明
          message: "分享链接已更新（栖影会重新审核该资源）",
          data: data.data ?? null,
        });
      }

      // 删除分享：POST /api/users/me/shares/{slug}/delete（body 为空）
      case "delete_share": {
        const slug = String(body.slug ?? url.searchParams.get("slug") ?? "").trim();
        if (!slug) return json({ error: "缺少 slug" }, 400);
        const r = await forward(`/api/users/me/shares/${encodeURIComponent(slug)}/delete`, {
          method: "POST",
          body: {},
        });
        if (!("ok" in r)) return failWith(r);
        const data = parseJsonSafe<{ success?: boolean; message?: string }>(r.text);
        if (r.status >= 400 || data?.success === false) {
          return json({ error: data?.message || `删除失败（HTTP ${r.status}）` }, 400);
        }
        await touchActive();
        return json({ success: true, message: data?.message || "分享已删除" });
      }

      // 新建分享（投稿）：POST /api/resources
      // 该接口未收录在接口文档中，自站点影视详情页「我来分享」前端代码确认；
      // 服务端会校验 media_type / pan_type，成功后条目进入审核（普通用户 review_status=pending）
      case "create_share": {
        const tmdbId = String(body.tmdb_id ?? "").trim();
        const mediaType = String(body.media_type ?? "").trim();
        const shareUrl = String(body.url ?? "").trim();
        if (!tmdbId) return json({ error: "缺少 tmdb_id" }, 400);
        if (mediaType !== "movie" && mediaType !== "tv") {
          return json({ error: "media_type 只能是 movie 或 tv" }, 400);
        }
        if (!shareUrl) return json({ error: "缺少分享链接 url" }, 400);

        // 站点要求 pan_type：未指定时先用 inspect-link 识别，并顺带补齐体积/名称/画质等字段
        let panType = String(body.pan_type ?? "").trim();
        let accessCode = String(body.access_code ?? "").trim();
        let shareSize = String(body.share_size ?? "").trim();
        let title = String(body.title ?? "").trim();
        let remark = String(body.remark ?? "").trim();
        let episodeRange = String(body.episode_range ?? "").trim();
        let videoResolution: unknown[] = [];
        let source: unknown[] = [];
        let subtitleLanguage: unknown[] = [];
        let subtitleType: unknown[] = [];
        let filePreview: unknown[] = [];
        let fileCount = 0;

        // 客户端按「资源名称」解析出的投稿属性（见 src/lib/hdhavenMeta.ts），
        // 非空时优先于 inspect-link 的识别结果——站点也是按名称填报这套属性的口径
        const nameResolution = Array.isArray(body.video_resolution)
          ? (body.video_resolution as unknown[])
          : [];
        const nameSource = Array.isArray(body.source) ? (body.source as unknown[]) : [];
        const nameSubtitleLang = Array.isArray(body.subtitle_language)
          ? (body.subtitle_language as unknown[])
          : [];
        const nameSubtitleType = Array.isArray(body.subtitle_type)
          ? (body.subtitle_type as unknown[])
          : [];

        if (!panType) {
          const insR = await forward("/api/account/inspect-link", {
            method: "POST",
            body: { url: shareUrl, ...(accessCode ? { access_code: accessCode } : {}) },
          });
          if (!("ok" in insR)) return failWith(insR);
          const ins = parseJsonSafe<{ data?: Record<string, unknown> }>(insR.text)?.data;
          if (!ins) return json({ error: "未能解析分享链接，请检查链接是否正确" }, 400);
          panType = String(ins.website ?? "").trim();
          if (!accessCode) accessCode = String(ins.access_code ?? "").trim();
          if (!shareSize && ins.size) shareSize = String(ins.size);
          if (!title && ins.title) title = String(ins.title);
          if (!remark && ins.suggested_remark) remark = String(ins.suggested_remark);
          if (!episodeRange && ins.episode_range) episodeRange = String(ins.episode_range);
          videoResolution = Array.isArray(ins.resolution) ? ins.resolution : [];
          source = Array.isArray(ins.source) ? ins.source : [];
          subtitleLanguage = Array.isArray(ins.subtitle_language) ? ins.subtitle_language : [];
          subtitleType = Array.isArray(ins.subtitle_type) ? ins.subtitle_type : [];
          filePreview = Array.isArray(ins.files) ? ins.files : [];
          fileCount = Number(ins.file_count ?? 0) || filePreview.length;
        }

        // 名称解析结果优先；inspect-link 只用于补「体积 / 文件清单」与兜底
        if (nameResolution.length) videoResolution = nameResolution;
        if (nameSource.length) source = nameSource;
        if (nameSubtitleLang.length) subtitleLanguage = nameSubtitleLang;
        if (nameSubtitleType.length) subtitleType = nameSubtitleType;

        if (!panType) return json({ error: "未能识别链接所属网盘，请检查分享链接" }, 400);

        const payload: Record<string, unknown> = {
          tmdb_id: tmdbId,
          media_type: mediaType,
          title: title || `${tmdbId} 分享`,
          url: shareUrl,
          pan_type: panType,
          unlock_points: Number(body.unlock_points ?? 0) || 0,
          video_resolution: videoResolution,
          source,
          subtitle_language: subtitleLanguage,
          subtitle_type: subtitleType,
          file_preview: filePreview,
          file_count: fileCount,
          hide_link: body.hide_link ?? true,
        };
        if (accessCode) payload.access_code = accessCode;
        if (shareSize) payload.share_size = shareSize;
        if (episodeRange) payload.episode_range = episodeRange;
        if (remark) payload.remark = remark;

        const r = await forward("/api/resources", { method: "POST", body: payload });
        if (!("ok" in r)) return failWith(r);
        const data = parseJsonSafe<{
          success?: boolean;
          message?: string;
          data?: Record<string, unknown>;
        }>(r.text);
        if (r.status >= 400 || data?.success === false) {
          return json({ error: data?.message || `栖影发布失败（HTTP ${r.status}）` }, 400);
        }

        // 站点响应未必带 slug：回查「我的分享」按 tmdb_id + 标题兜底定位新建条目
        let slug = typeof data?.data?.slug === "string" ? String(data.data.slug) : "";
        if (!slug) {
          const listR = await forward("/api/users/me/shares");
          if ("ok" in listR) {
            const list = parseJsonSafe<{ data?: Array<Record<string, unknown>> }>(listR.text)?.data ?? [];
            const hit = list.find(
              (s) => String(s.tmdb_id ?? "") === tmdbId && String(s.title ?? "") === title
            );
            if (hit?.slug) slug = String(hit.slug);
          }
        }
        await touchActive();
        return json({
          success: true,
          // 站点原文为「投稿已提交，可在个人中心查看审核状态」
          message: data?.message || "投稿已提交，栖影会进行审核",
          data: { ...(data?.data ?? {}), slug, title, url: shareUrl, pan_type: panType },
        });
      }

      // 片源检索（TMDB 原生结构，中文可直接搜）
      case "search_tmdb": {
        const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
        const category = (
          url.searchParams.get("media_type") ??
          url.searchParams.get("category") ??
          "multi"
        ).trim();
        if (!q.trim()) return json({ success: true, data: [] });
        const qs = new URLSearchParams({ query: q });
        const r = await forward(`/api/tmdb/search/${encodeURIComponent(category)}?${qs}`);
        if (!("ok" in r)) return failWith(r);
        const parsed = parseJsonSafe<{ results?: unknown[]; data?: { results?: unknown[] } }>(r.text);
        const results = parsed?.results ?? parsed?.data?.results ?? [];
        return json({ success: true, data: results });
      }

      // 影视详情：GET /api/tmdb/{type}/{id}
      case "tmdb_detail": {
        const type = String(url.searchParams.get("media_type") ?? body.media_type ?? "movie").trim();
        const id = String(url.searchParams.get("tmdb_id") ?? body.tmdb_id ?? "").trim();
        if (!id) return json({ error: "缺少 tmdb_id" }, 400);
        if (type !== "movie" && type !== "tv") {
          return json({ error: "media_type 只能是 movie 或 tv" }, 400);
        }
        const r = await forward(`/api/tmdb/${type}/${encodeURIComponent(id)}`);
        if (!("ok" in r)) return failWith(r);
        const data = parseJsonSafe<{ data?: unknown }>(r.text);
        return json({ success: true, data: data?.data ?? data ?? null });
      }

      // 热门推荐：GET /api/tmdb/trending/now
      case "trending": {
        const r = await forward("/api/tmdb/trending/now");
        if (!("ok" in r)) return failWith(r);
        const parsed = parseJsonSafe<{ results?: unknown[]; data?: { results?: unknown[] } }>(r.text);
        return json({ success: true, data: parsed?.data?.results ?? parsed?.results ?? [] });
      }

      // 首页栏目：GET /api/tmdb/home/{type}/{mode}（如 movie/popular）
      case "home": {
        const type = String(url.searchParams.get("media_type") ?? body.media_type ?? "movie").trim();
        const mode = String(url.searchParams.get("mode") ?? body.mode ?? "popular").trim();
        const r = await forward(
          `/api/tmdb/home/${encodeURIComponent(type)}/${encodeURIComponent(mode)}`
        );
        if (!("ok" in r)) return failWith(r);
        const parsed = parseJsonSafe<{ results?: unknown[]; data?: { results?: unknown[] } }>(r.text);
        return json({ success: true, data: parsed?.data?.results ?? parsed?.results ?? [] });
      }

      // 榜单：GET /api/rankings/{type}/{period}
      case "rankings": {
        const type = String(url.searchParams.get("media_type") ?? body.media_type ?? "movie").trim();
        const period = String(url.searchParams.get("period") ?? body.period ?? "week").trim();
        const r = await forward(
          `/api/rankings/${encodeURIComponent(type)}/${encodeURIComponent(period)}`
        );
        if (!("ok" in r)) return failWith(r);
        const parsed = parseJsonSafe<{ data?: unknown; results?: unknown[] }>(r.text);
        return json({ success: true, data: parsed?.data ?? parsed?.results ?? [] });
      }

      // 上映日历：GET /api/calendar/upcoming
      case "calendar": {
        const r = await forward("/api/calendar/upcoming");
        if (!("ok" in r)) return failWith(r);
        const parsed = parseJsonSafe<{ data?: unknown; results?: unknown[] }>(r.text);
        return json({ success: true, data: parsed?.data ?? parsed?.results ?? [] });
      }

      // 按 TMDB ID 查询站内资源（片源查询）
      case "resources": {
        const tmdbId = String(url.searchParams.get("tmdb_id") ?? body.tmdb_id ?? "").trim();
        const mediaType = String(url.searchParams.get("media_type") ?? body.media_type ?? "movie").trim();
        if (!tmdbId) return json({ error: "缺少 tmdb_id" }, 400);
        if (mediaType !== "movie" && mediaType !== "tv") {
          return json({ error: "media_type 只能是 movie 或 tv" }, 400);
        }
        const r = await forward(`/api/resources/${mediaType}/${encodeURIComponent(tmdbId)}`);
        if (!("ok" in r)) return failWith(r);
        const data = parseJsonSafe<{ data?: unknown }>(r.text);
        return json({ success: true, data: data?.data ?? [] });
      }

      // 全站资源目录：GET /api/catalog/resources → data.items
      case "catalog": {
        const r = await forward("/api/catalog/resources");
        if (!("ok" in r)) return failWith(r);
        const parsed = parseJsonSafe<{ data?: { items?: unknown[] } | unknown[] }>(r.text);
        const items = Array.isArray(parsed?.data)
          ? parsed.data
          : ((parsed?.data as { items?: unknown[] } | undefined)?.items ?? []);
        return json({ success: true, data: items });
      }

      default:
        return json({ error: `不支持的 action: ${action}`, actions: ACTIONS }, 400);
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

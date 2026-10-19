// ============================================================
// Supabase Edge Function: hdhaven-proxy
// 栖影 HDHaven（hdhaven.com）官方 OpenAPI 代理
//
// ── 为什么重写（2026-10）────────────────────────────────────
// 旧实现基于站点网页版的「同源 httpOnly 会话 Cookie」：
//   * 站点登录接口加了 Cloudflare Turnstile 人机验证 → 账号密码无法自动登录，
//     只能让用户人工从浏览器粘贴 Cookie，会话过期还要人工再粘一次；
//   * 请求过频会返回 SCRAPE_CHALLENGE_REQUIRED，需要弹图形验证码人工识别；
//   * Cookie 在 hdhaven_sessions 表里是明文存储。
// 站点现已开放官方 OpenAPI（OAuth 授权码 + PKCE），access_token 长期有效，
// 因此整套 Cookie / 验证码 / 限速对抗逻辑全部废弃，改为：
//
//   授权：GET  https://hdhaven.com/oauth/authorize（用户在浏览器确认）
//   换 token：POST https://hdhaven.com/api/openapi/oauth/token
//   调用：Authorization: Bearer <access_token>
//        X-HDHaven-App-Key: <应用凭证>
//
// 凭据：access_token 用 pgcrypto 加密后存 hdhaven_sessions.access_token_enc，
//       密钥 SITE_CRED_KEY 只在环境变量，数据库只存密文。
// 额度：账号每日调用次数按等级/会员（Lv.1 200 次 … 永久不限），每分钟 60 次；
//       签到与 GET /me 不计入每日次数。本代理做进程内轻量限速并透传 429，
//       避免把用户自己打到限流（批量发布请走 batch-post 队列）。
//
// 部署：supabase functions deploy hdhaven-proxy
// 环境变量：
//   SITE_URL            可选，CORS 白名单，默认 *
//   HDHAVEN_CLIENT_ID   可选，默认用下方内置的应用编号
//   HDHAVEN_CLIENT_SECRET 可选，公开客户端（纯 PKCE）可不配
//   HDHAVEN_APP_KEY     可选，X-HDHaven-App-Key，默认同 CLIENT_ID
//   HDHAVEN_REDIRECT_URI 可选，OAuth 回调地址，默认本站「站点同步」页
//   HDHAVEN_SCOPE       可选，留空表示站点已批准的全部权限
//   SITE_CRED_KEY       必填，access_token 加密密钥（与其他站点同一套）
//
// 调用：GET|POST /hdhaven-proxy?action=<action>
//   Authorization: Bearer <本站 access_token>
//
// ── action 契约 ────────────────────────────────────────────
//   oauth_start    生成授权地址（含 state + PKCE），无需已绑定
//   oauth_callback 用授权码换 token 并落库，无需已绑定
//   logout         解绑（清除本地 token；站点侧撤销授权需用户自行在 OPENAPI 页面操作）
//   status         GET  /me            账户信息（不计入每日次数）
//   quota          GET  /quota         账号额度余量
//   checkin        POST /check-in      每日签到（不计入每日次数）
//   prefs          POST /prefs         网盘偏好 {pan_prefs:[...]}
//   my_shares      GET  /shares        我的分享（自动翻页聚合，meta.truncated 表示已截断）
//   detail         GET  /shares/{slug}
//   inspect        POST /inspect-link  解析分享链接
//   update         POST /shares/{slug} 更新分享（站点为「全量字段回写」语义）
//   delete_share   DELETE /shares/{slug}
//   create_share   POST /shares        新建分享（投稿）
//   search_tmdb / tmdb_detail / trending / home / rankings / calendar / resources / catalog
//
// 已移除（Cookie 时代遗留，不再支持）：
//   login、bindCookie、challenge、verify
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveCallerId } from "../_shared/internalAuth.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "*";

const HDHAVEN_BASE = "https://hdhaven.com";
const AUTH_URL = `${HDHAVEN_BASE}/oauth/authorize`;
const TOKEN_URL = `${HDHAVEN_BASE}/api/openapi/oauth/token`;
const API_BASE = `${HDHAVEN_BASE}/api/openapi/v1`;

/** 应用编号（client_id）。文档说明「应用凭证有效 365 天」，此处为默认值，可用环境变量覆盖。 */
const CLIENT_ID = Deno.env.get("HDHAVEN_CLIENT_ID") ?? "531dc481-a9bc-4a3e-a187-70d5bc1a04d9";
/** 公开客户端（纯 PKCE）不配也不影响；配置后换 token 会附带 client_secret。 */
const CLIENT_SECRET = Deno.env.get("HDHAVEN_CLIENT_SECRET") ?? "";
/** X-HDHaven-App-Key：文档中称为「应用凭证」，默认与应用编号相同。 */
const APP_KEY = Deno.env.get("HDHAVEN_APP_KEY") ?? CLIENT_ID;
/** 回调地址必须与站点侧登记一致（未登记时站点会弹窗让用户确认地址）。 */
const REDIRECT_URI = Deno.env.get("HDHAVEN_REDIRECT_URI") ?? "https://guangya.xyz.hr/sync";
/** 留空 = 站点已批准的全部权限。 */
const SCOPE = Deno.env.get("HDHAVEN_SCOPE") ?? "";
/** access_token 加密密钥；与其他站点凭据同一套，仅存在于环境变量。 */
const CRED_KEY = Deno.env.get("SITE_CRED_KEY") ?? "";

/**
 * OpenAPI 端点映射表（路径相对 API_BASE）。
 *
 * ⚠️ 站点目前公开的文档只写明了 OAuth 流程、请求认证方式、响应包裹格式与额度规则，
 *    **未公开业务接口清单**。下面这些路径是按站点网页版同名接口的语义推定的，
 *    标注「待核对」的项尤其需要拿正式接口文档确认。
 *    好消息是所有调用都只经过这张表：将来核对出真实路径，只改这里即可，
 *    授权、加密、分页、错误映射等逻辑都不用动。
 */
const EP = {
  me: "/me", //  文档明确：GET /me 读取账户信息（不计入每日次数）
  quota: "/quota", //  「查看额度一览」入口，具体路径待核对
  checkIn: "/check-in", //  签到（文档提到「签到不计入每日次数」但未给路径，待核对）
  prefs: "/prefs", //    网盘偏好，是否在 OpenAPI 开放待核对
  shares: "/shares",
  share: (slug: string) => `/shares/${encodeURIComponent(slug)}`,
  inspectLink: "/inspect-link", // 待核对：网页版为 /api/account/inspect-link
  createShare: "/shares", //  待核对：网页版为 POST /api/resources
  searchTmdb: (category: string) => `/tmdb/search/${encodeURIComponent(category)}`,
  tmdbDetail: (type: string, id: string) => `/tmdb/${type}/${encodeURIComponent(id)}`,
  trending: "/tmdb/trending/now",
  home: (type: string, mode: string) => `/tmdb/home/${type}/${mode}`,
  rankings: (type: string, period: string) => `/rankings/${type}/${period}`,
  calendar: "/calendar/upcoming",
  resources: (type: string, id: string) => `/resources/${type}/${encodeURIComponent(id)}`,
  catalog: "/catalog/resources",
} as const;

/** 列表默认每页 50 条（文档说明可选 1–50）。 */
const PAGE_SIZE = 50;
/** my_shares 聚合的最大页数：超过就不再翻，避免单次把账号日额度烧光。 */
const MAX_PAGES = 10;

/** 账号额度为每分钟 60 次，进程内按 ~1.1s 一次做轻量整形，避免自己打到限流。 */
const MIN_GAP_MS = 1100;

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

/** access_token 失效：用户在 OPENAPI 撤销授权、重新授权或账号不可用后才会发生，需重新走授权。 */
const EXPIRED_BODY = {
  error: "栖影授权已失效，请重新授权",
  code: "HDHAVEN_TOKEN_EXPIRED",
};
const expired = (siteMessage?: string) =>
  json(siteMessage ? { ...EXPIRED_BODY, error: `栖影：${siteMessage}` } : EXPIRED_BODY, 401);

/** 命中额度/限流：把站点原文与可能存在的 meta 一并回传，前端可提示剩余额度与重试时间。 */
const limited = (siteMessage: string, meta?: unknown) =>
  json({ error: `栖影调用受限：${siteMessage}`, code: "HDHAVEN_RATE_LIMITED", meta: meta ?? null }, 429);

const NOT_BOUND_BODY = { error: "未绑定栖影账号，请先授权", code: "HDHAVEN_NOT_BOUND" };

/** update 为「全量字段回写」：音乐类资源的附加字段需原样回写，否则会被清空 */
const MUSIC_FIELDS = ["music_artist", "music_album", "music_year", "music_metadata"] as const;

const ACTIONS = [
  "oauth_start",
  "oauth_callback",
  "logout",
  "status",
  "quota",
  "checkin",
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
];

// ---------- 基础工具 ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** 站点响应统一包裹为 {success, data, meta}；取其中的 data（失败体用 message） */
function unwrap(text: string): { data: unknown; meta: unknown } {
  const j = parseJsonSafe<{ success?: boolean; data?: unknown; meta?: unknown }>(text);
  return { data: j?.data ?? null, meta: j?.meta ?? null };
}

function siteMessageOf(text: string): string {
  const j = parseJsonSafe<{
    message?: string;
    detail?: string;
    error?: string;
    errors?: Array<{ message?: string }>;
  }>(text);
  const first = Array.isArray(j?.errors) ? (j?.errors?.[0]?.message ?? "") : "";
  return String(j?.message ?? j?.detail ?? j?.error ?? first ?? "").trim();
}

// ---------- PKCE / 随机串 ----------

function base64url(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 密码学安全随机串：state 用 32 字符，code_verifier 用 64 字符（PKCE 要求 43–128） */
function randomToken(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** PKCE S256：code_challenge = BASE64URL(SHA256(code_verifier)) */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ---------- 站点请求 ----------

let lastRequestAt = 0;
async function pace(): Promise<void> {
  const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

type ApiResult =
  | { ok: true; status: number; text: string; data: unknown; meta: unknown }
  | { expired: true; siteMessage: string }
  | { limited: true; siteMessage: string; meta: unknown }
  | { failed: true; status: number; siteMessage: string };

/**
 * 调用官方 OpenAPI：Bearer token + X-HDHaven-App-Key。
 * 认证失效（401）与限流（429）单独归类，便于上层决定「重新授权」还是「稍后重试」。
 */
async function apiFetch(
  path: string,
  opts: { token: string; method?: string; body?: unknown; query?: Record<string, string | number> }
): Promise<ApiResult> {
  await pace();
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));

  const method = opts.method ?? "GET";
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "X-HDHaven-App-Key": APP_KEY,
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();

  const { data, meta } = unwrap(text);

  if (res.status === 401) {
    console.error("hdhaven unauthorized", path, text.slice(0, 300));
    return { expired: true, siteMessage: siteMessageOf(text) };
  }
  if (res.status === 429) {
    console.error("hdhaven rate limited", path, text.slice(0, 300));
    return { limited: true, siteMessage: siteMessageOf(text) || "请求过于频繁或额度已用尽", meta };
  }
  if (res.status >= 400) {
    console.error("hdhaven request failed", path, res.status, text.slice(0, 300));
    return { failed: true, status: res.status, siteMessage: siteMessageOf(text) };
  }
  return { ok: true, status: res.status, text, data, meta };
}

/** 统一失败响应 */
function failWith(r: Exclude<ApiResult, { ok: true }>): Response {
  if ("expired" in r) return expired(r.siteMessage);
  if ("limited" in r) return limited(r.siteMessage, r.meta);
  return json({ error: r.siteMessage || `栖影接口调用失败（HTTP ${r.status}）` }, 400);
}

// ---------- token 存取 ----------

async function loadAccessToken(
  appClient: ReturnType<typeof createClient>,
  userId: string
): Promise<string | null> {
  if (!CRED_KEY) {
    throw new Error("服务端未配置 SITE_CRED_KEY，无法解密栖影授权（联系管理员）");
  }
  const { data } = await appClient
    .from("hdhaven_sessions")
    .select("access_token_enc")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data?.access_token_enc) return null;
  const { data: plain, error } = await appClient.rpc("site_secret_decrypt", {
    p_enc: data.access_token_enc,
    p_key: CRED_KEY,
  });
  if (error || !plain) {
    console.error("hdhaven token decrypt failed", error);
    return null;
  }
  return String(plain);
}

async function saveAccessToken(
  appClient: ReturnType<typeof createClient>,
  args: { userId: string; token: string; scope?: string; userNumber?: number | null; username?: string }
): Promise<void> {
  const { data: enc, error } = await appClient.rpc("site_secret_encrypt", {
    p_plain: args.token,
    p_key: CRED_KEY,
  });
  if (error || !enc) throw new Error("加密栖影授权失败，请稍后重试");

  const now = new Date().toISOString();
  await appClient.from("hdhaven_sessions").upsert(
    {
      user_id: args.userId,
      // cookie 列为已废弃字段，这里保持空串；token 只走 access_token_enc
      cookie: "",
      access_token_enc: String(enc),
      token_type: "Bearer",
      scope: args.scope ?? null,
      user_number: args.userNumber ?? null,
      username: args.username ?? "",
      status: "active",
      authorized_at: now,
      last_check_at: now,
      updated_at: now,
    },
    { onConflict: "user_id" }
  );
}

/** 我的分享：按页聚合（每页 50），超过 MAX_PAGES 则截断，避免一次烧掉大量日额度 */
async function collectShares(
  token: string
): Promise<{ items: unknown[]; truncated: boolean }> {
  const all: unknown[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await apiFetch(EP.shares, { token, query: { page, per_page: PAGE_SIZE } });
    if (!("ok" in r)) throw Object.assign(new Error(r.siteMessage || "获取分享列表失败"), {
      kind: "expired" in r ? "expired" : "limited" in r ? "limited" : "failed",
    });

    const list = Array.isArray(r.data)
      ? r.data
      : ((r.data as { items?: unknown[] } | null)?.items ?? []);
    all.push(...list);

    const meta = (r.meta ?? {}) as { total?: number; page?: number; per_page?: number };
    const total = Number(meta.total ?? 0);
    if (list.length === 0) break;
    if (list.length < PAGE_SIZE) break;
    if (total > 0 && all.length >= total) break;
    if (page === MAX_PAGES) truncated = true;
  }
  return { items: all, truncated };
}

// ---------- 主处理 ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. 验证本站登录态（service role 客户端，绕过 RLS 读写会话表）
    const appClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    // 鉴权：用户 JWT，或服务端 worker/定时任务的内部通道
    //（x-internal-secret + x-user-id，见 _shared/internalAuth.ts）
    const callerId = await resolveCallerId(req, async (t) => {
      const { data, error } = await appClient.auth.getUser(t);
      return error ? null : (data?.user?.id ?? null);
    });
    if (!callerId) return json({ error: "登录态无效或已过期" }, 401);
    const me = { id: callerId };

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

    // ---------- action: oauth_start（生成授权地址，无需已绑定） ----------
    if (action === "oauth_start") {
      if (!CRED_KEY) return json({ error: "服务端未配置 SITE_CRED_KEY（联系管理员）" }, 500);

      const state = randomToken(32);
      const codeVerifier = randomToken(64);
      const redirectUri = String(body.redirect_uri ?? REDIRECT_URI).trim() || REDIRECT_URI;

      const { error } = await appClient.from("hdhaven_oauth_states").insert({
        state,
        user_id: me.id,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      });
      if (error) return json({ error: "发起授权失败，请稍后重试" }, 500);

      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        state,
        code_challenge: await s256(codeVerifier),
        code_challenge_method: "S256",
      });
      // scope 可省略：省略即为站点已批准的全部权限
      if (SCOPE) params.set("scope", SCOPE);

      return json({ success: true, data: { authorize_url: `${AUTH_URL}?${params}`, state } });
    }

    // ---------- action: oauth_callback（授权码换 token，无需已绑定） ----------
    if (action === "oauth_callback") {
      const code = String(body.code ?? url.searchParams.get("code") ?? "").trim();
      const state = String(body.state ?? url.searchParams.get("state") ?? "").trim();
      if (!code || !state) return json({ error: "缺少授权码或 state" }, 400);

      const { data: st, error: stErr } = await appClient
        .from("hdhaven_oauth_states")
        .select("state,user_id,code_verifier,redirect_uri,created_at,used_at")
        .eq("state", state)
        .maybeSingle();
      if (stErr || !st) return json({ error: "授权状态无效，请重新发起授权" }, 400);
      if (st.used_at) return json({ error: "该授权已被使用，请重新发起授权" }, 400);
      if (st.user_id !== me.id) return json({ error: "授权状态与当前登录账号不匹配" }, 400);
      // 授权码 10 分钟有效，这里放宽到 15 分钟仅作兜底
      if (Date.now() - new Date(st.created_at).getTime() > 15 * 60 * 1000) {
        return json({ error: "授权已超时，请重新发起授权" }, 400);
      }

      // 先占位标记已消费：授权码只能用一次，抢占后再去换 token
      await appClient
        .from("hdhaven_oauth_states")
        .update({ used_at: new Date().toISOString() })
        .eq("state", state)
        .is("used_at", null);

      // OAuth 规范：换 token 用表单编码
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: st.redirect_uri,
        code_verifier: st.code_verifier,
      });
      if (CLIENT_SECRET) {
        form.set("client_id", CLIENT_ID);
        form.set("client_secret", CLIENT_SECRET);
      }

      const tokenRes = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          // 部分实现要求把应用编号放在头部，同时带表单体
          "X-HDHaven-App-Key": APP_KEY,
        },
        body: form.toString(),
        signal: AbortSignal.timeout(20000),
      });
      const tokenText = await tokenRes.text();

      // 兼容两种返回形态：{access_token,...} 或 {success,data:{access_token,...}}
      const tj = parseJsonSafe<{
        access_token?: string;
        scope?: string;
        user_number?: number;
        error?: string;
        error_description?: string;
        message?: string;
        data?: { access_token?: string; scope?: string; user_number?: number };
      }>(tokenText);
      const accessToken = tj?.access_token ?? tj?.data?.access_token ?? "";
      if (!tokenRes.ok || !accessToken) {
        return json(
          {
            error:
              tj?.error_description ??
              tj?.error ??
              tj?.message ??
              `换取授权失败（HTTP ${tokenRes.status}）`,
            code: "HDHAVEN_OAUTH_FAILED",
          },
          400
        );
      }

      const scope = String(tj?.scope ?? tj?.data?.scope ?? SCOPE ?? "");
      const userNumber = tj?.user_number ?? tj?.data?.user_number ?? null;

      // 先校验再落库：拿到 token 后立刻 GET /me 确认可用，避免存下无效授权
      const probe = await apiFetch(EP.me, { token: accessToken });
      if (!("ok" in probe)) {
        return json({ error: "授权未通过站点校验，请重新发起授权", code: "HDHAVEN_OAUTH_FAILED" }, 400);
      }
      const meData = probe.data as Record<string, unknown> | null;
      const nickname = String(
        meData?.nickname ?? meData?.username ?? `栖影 ${userNumber ?? ""}`.trim()
      );

      await saveAccessToken(appClient, {
        userId: me.id,
        token: accessToken,
        scope,
        userNumber,
        username: nickname,
      });

      // 顺手清掉本次及更早的授权中间态
      await appClient.from("hdhaven_oauth_states").delete().eq("user_id", me.id);

      return json({
        success: true,
        message: "授权成功",
        data: { username: nickname, user_number: userNumber, scope },
      });
    }

    // ---------- action: logout（解绑） ----------
    if (action === "logout") {
      // 站点侧撤销授权需用户在 OPENAPI 页面自行操作；这里只清本地凭据，不阻塞解绑
      await appClient.from("hdhaven_sessions").delete().eq("user_id", me.id);
      await appClient.from("hdhaven_oauth_states").delete().eq("user_id", me.id);
      return json({ success: true });
    }

    // ---------- 其余 action 需要已完成 OAuth 授权 ----------
    const token = await loadAccessToken(appClient, me.id);
    if (!token) return json(NOT_BOUND_BODY, 400);

    /** 转发请求并统一处理「授权失效」「限流」「普通失败」 */
    const forward = async (
      path: string,
      opts: { method?: string; body?: unknown; query?: Record<string, string | number> } = {}
    ): Promise<ApiResult> => {
      const r = await apiFetch(path, { token, method: opts.method, body: opts.body, query: opts.query });
      if ("expired" in r) await markExpired();
      return r;
    };

    switch (action) {
      // 账户信息（文档：GET /me 不计入每日次数）
      case "status": {
        const r = await forward(EP.me);
        if (!("ok" in r)) return failWith(r);
        await touchActive();
        return json({ success: true, data: r.data ?? null, meta: r.meta ?? null });
      }

      // 账号额度余量（每分钟 60 次；每日按等级/会员，北京时间零点重置）
      case "quota": {
        const r = await forward(EP.quota);
        if (!("ok" in r)) return failWith(r);
        return json({ success: true, data: r.data ?? null, meta: r.meta ?? null });
      }

      // 每日签到（文档：签到不计入每日次数）
      case "checkin": {
        const r = await forward(EP.checkIn, { method: "POST", body: {} });
        if (!("ok" in r)) return failWith(r);
        await touchActive();
        return json({ success: true, message: "签到已提交", data: r.data ?? null });
      }

      // 网盘偏好：POST /prefs  body {pan_prefs:["guangya","115"]}
      case "prefs": {
        const prefs = Array.isArray(body.pan_prefs) ? (body.pan_prefs as unknown[]).map(String) : [];
        const r = await forward(EP.prefs, { method: "POST", body: { pan_prefs: prefs } });
        if (!("ok" in r)) return failWith(r);
        await touchActive();
        return json({ success: true, message: "网盘偏好已保存", data: prefs });
      }

      // 我的分享：自动翻页聚合
      case "my_shares": {
        try {
          const { items, truncated } = await collectShares(token);
          await touchActive();
          return json({
            success: true,
            data: items,
            meta: { truncated, pages_capped_at: MAX_PAGES },
          });
        } catch (e) {
          const err = e as Error & { kind?: string };
          if (err.kind === "expired") {
            await markExpired();
            return expired(err.message);
          }
          if (err.kind === "limited") return limited(err.message || "额度已用尽");
          return json({ error: err.message || "获取分享列表失败" }, 400);
        }
      }

      // 单条分享详情
      case "detail": {
        const slug = String(body.slug ?? url.searchParams.get("slug") ?? "").trim();
        if (!slug) return json({ error: "缺少 slug" }, 400);
        const r = await forward(EP.share(slug));
        if (!("ok" in r)) return failWith(r);
        await touchActive();
        return json({ success: true, data: r.data ?? null });
      }

      // 解析新分享链接（识别 pan_type / size）
      case "inspect": {
        const linkUrl = String(body.url ?? url.searchParams.get("url") ?? "").trim();
        if (!linkUrl) return json({ error: "缺少 url" }, 400);
        const accessCode = String(body.access_code ?? "").trim();
        const r = await forward(EP.inspectLink, {
          method: "POST",
          body: { url: linkUrl, ...(accessCode ? { access_code: accessCode } : {}) },
        });
        if (!("ok" in r)) return failWith(r);
        return json({ success: true, data: r.data ?? null });
      }

      // 更新分享链接：站点为「全量字段回写」，必须先用 detail 取原值再合并，
      // 否则未提交的字段会被清空
      case "update": {
        const slug = String(body.slug ?? "").trim();
        const newUrl = String(body.url ?? "").trim();
        if (!slug) return json({ error: "缺少 slug" }, 400);
        if (!newUrl) return json({ error: "缺少分享链接 url" }, 400);

        const detailR = await forward(EP.share(slug));
        if (!("ok" in detailR)) return failWith(detailR);
        const detail = (detailR.data ?? null) as Record<string, unknown> | null;
        if (!detail) return json({ error: "未能读取该分享的原始字段，请稍后重试" }, 400);

        // 新链接的网盘类型/提取码：优先用调用方传入，其次用 inspect 识别，最后沿用原值
        let panType = String(body.pan_type ?? "").trim();
        let accessCode = String(body.access_code ?? "").trim();
        let shareSize = detail.share_size as string | null;
        if (!panType) {
          const insR = await forward(EP.inspectLink, {
            method: "POST",
            body: { url: newUrl, ...(accessCode ? { access_code: accessCode } : {}) },
          });
          if ("ok" in insR) {
            const ins = insR.data as
              | { website?: string; access_code?: string; size?: string | null }
              | null;
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

        const r = await forward(EP.share(slug), { method: "POST", body: payload });
        if (!("ok" in r)) return failWith(r);
        await touchActive();
        return json({
          success: true,
          // 普通用户改动后资源会重新进入审核
          message: "分享链接已更新（栖影会重新审核该资源）",
          data: r.data ?? null,
        });
      }

      // 删除分享
      case "delete_share": {
        const slug = String(body.slug ?? url.searchParams.get("slug") ?? "").trim();
        if (!slug) return json({ error: "缺少 slug" }, 400);
        const r = await forward(EP.share(slug), { method: "DELETE" });
        if (!("ok" in r)) return failWith(r);
        await touchActive();
        return json({ success: true, message: "分享已删除" });
      }

      // 新建分享（投稿）：服务端校验 media_type / pan_type，成功后条目进入审核
      case "create_share": {
        const tmdbId = String(body.tmdb_id ?? "").trim();
        const mediaType = String(body.media_type ?? "").trim();
        const shareUrl = String(body.url ?? "").trim();
        if (!tmdbId) return json({ error: "缺少 tmdb_id" }, 400);
        if (mediaType !== "movie" && mediaType !== "tv") {
          return json({ error: "media_type 只能是 movie 或 tv" }, 400);
        }
        if (!shareUrl) return json({ error: "缺少分享链接 url" }, 400);

        // 站点要求 pan_type：未指定时先用 inspect 识别，并顺带补齐体积/名称/画质等字段
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
        // 非空时优先于 inspect 的识别结果
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
          const insR = await forward(EP.inspectLink, {
            method: "POST",
            body: { url: shareUrl, ...(accessCode ? { access_code: accessCode } : {}) },
          });
          if (!("ok" in insR)) return failWith(insR);
          const ins = insR.data as Record<string, unknown> | null;
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

        // 名称解析结果优先；inspect 只用于补「体积 / 文件清单」与兜底
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

        const r = await forward(EP.createShare, { method: "POST", body: payload });
        if (!("ok" in r)) return failWith(r);

        // 响应未必带 slug：回查「我的分享」按 tmdb_id + 标题兜底定位新建条目
        let slug = typeof (r.data as { slug?: unknown } | null)?.slug === "string"
          ? String((r.data as { slug: string }).slug)
          : "";
        if (!slug) {
          try {
            const { items } = await collectShares(token);
            const hit = (items as Array<Record<string, unknown>>).find(
              (s) => String(s.tmdb_id ?? "") === tmdbId && String(s.title ?? "") === title
            );
            if (hit?.slug) slug = String(hit.slug);
          } catch {
            // 回查失败不致命：slug 缺失由上层按标题兜底
          }
        }
        await touchActive();
        return json({
          success: true,
          message: "投稿已提交，栖影会进行审核",
          data: { ...(r.data as Record<string, unknown> | null), slug, title, url: shareUrl, pan_type: panType },
        });
      }

      // 片源检索
      case "search_tmdb": {
        const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
        const category = (
          url.searchParams.get("media_type") ??
          url.searchParams.get("category") ??
          "multi"
        ).trim();
        if (!q.trim()) return json({ success: true, data: [] });
        const r = await forward(EP.searchTmdb(category), { query: { query: q } });
        if (!("ok" in r)) return failWith(r);
        const list = Array.isArray(r.data)
          ? r.data
          : ((r.data as { results?: unknown[] } | null)?.results ?? []);
        return json({ success: true, data: list });
      }

      // 影视详情
      case "tmdb_detail": {
        const type = String(url.searchParams.get("media_type") ?? body.media_type ?? "movie").trim();
        const id = String(url.searchParams.get("tmdb_id") ?? body.tmdb_id ?? "").trim();
        if (!id) return json({ error: "缺少 tmdb_id" }, 400);
        if (type !== "movie" && type !== "tv") {
          return json({ error: "media_type 只能是 movie 或 tv" }, 400);
        }
        const r = await forward(EP.tmdbDetail(type, id));
        if (!("ok" in r)) return failWith(r);
        return json({ success: true, data: r.data ?? null });
      }

      // 热门推荐
      case "trending": {
        const r = await forward(EP.trending);
        if (!("ok" in r)) return failWith(r);
        const list = Array.isArray(r.data)
          ? r.data
          : ((r.data as { results?: unknown[] } | null)?.results ?? []);
        return json({ success: true, data: list });
      }

      // 首页栏目
      case "home": {
        const type = String(url.searchParams.get("media_type") ?? body.media_type ?? "movie").trim();
        const mode = String(url.searchParams.get("mode") ?? body.mode ?? "popular").trim();
        const r = await forward(EP.home(type, mode));
        if (!("ok" in r)) return failWith(r);
        const list = Array.isArray(r.data)
          ? r.data
          : ((r.data as { results?: unknown[] } | null)?.results ?? []);
        return json({ success: true, data: list });
      }

      // 榜单
      case "rankings": {
        const type = String(url.searchParams.get("media_type") ?? body.media_type ?? "movie").trim();
        const period = String(url.searchParams.get("period") ?? body.period ?? "week").trim();
        const r = await forward(EP.rankings(type, period));
        if (!("ok" in r)) return failWith(r);
        const list = Array.isArray(r.data)
          ? r.data
          : ((r.data as { results?: unknown[] } | null)?.results ?? []);
        return json({ success: true, data: list });
      }

      // 上映日历
      case "calendar": {
        const r = await forward(EP.calendar);
        if (!("ok" in r)) return failWith(r);
        const list = Array.isArray(r.data)
          ? r.data
          : ((r.data as { results?: unknown[] } | null)?.results ?? []);
        return json({ success: true, data: list });
      }

      // 按 TMDB ID 查询站内资源
      case "resources": {
        const tmdbId = String(url.searchParams.get("tmdb_id") ?? body.tmdb_id ?? "").trim();
        const mediaType = String(url.searchParams.get("media_type") ?? body.media_type ?? "movie").trim();
        if (!tmdbId) return json({ error: "缺少 tmdb_id" }, 400);
        if (mediaType !== "movie" && mediaType !== "tv") {
          return json({ error: "media_type 只能是 movie 或 tv" }, 400);
        }
        const r = await forward(EP.resources(mediaType, tmdbId));
        if (!("ok" in r)) return failWith(r);
        return json({ success: true, data: r.data ?? [] });
      }

      // 全站资源目录
      case "catalog": {
        const r = await forward(EP.catalog);
        if (!("ok" in r)) return failWith(r);
        const items = Array.isArray(r.data)
          ? r.data
          : ((r.data as { items?: unknown[] } | null)?.items ?? []);
        return json({ success: true, data: items });
      }

      default:
        return json({ error: `不支持的 action: ${action}`, actions: ACTIONS }, 400);
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
// ============================================================
// Supabase Edge Function: st1-proxy
// 「1号站点」开放 API 代理
//
// 站点接口：基地址 <站点>/api/open，鉴权 Authorization: Bearer pat_…
//   GET  /            服务信息与接口清单
//   GET  /profile     当前令牌对应的用户信息
//   GET  /categories  分类列表
//   GET  /pt-tags     PT 规格标签
//   GET  /resources   片源分页列表（page / pageSize / category / tag / keyword）
//   GET  /resources/:id  片源详情
//   POST /resources   发布片源
//   PATCH /resources/:id  局部编辑（仅本人或管理员）
//
// 与其它站点不同：本站点不需要账密登录，用户在站点「开放API」标签里生成令牌后粘贴到这里。
// 每用户一份令牌（冲突时站点侧重新生成，旧令牌立即失效 → 这里需重新绑定）。
//
// actions:
//   bind       { baseUrl?, token, defaultCategoryId? }  绑定/更新（先 GET /profile 校验）
//   status                                              探测令牌是否有效（巡检用）
//   categories / pt_tags                                元数据
//   search     { keyword?, page?, pageSize?, category? } 站点片源列表
//   detail     { id }
//   publish    { resourceId?, title, panUrl, panCode?, content?, categoryId?, tags?, ptTagIds? }
//   update     { resourceId?, remoteId?, title?, panUrl?, panCode?, content?, categoryId?, tags?, ptTagIds? }
//   unbind
// ============================================================

import { resolveCallerId } from "../_shared/internalAuth.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "*";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/** 站点基地址：服务端配了就以它为准（更安全，用户不用填） */
const ENV_BASE = (Deno.env.get("ST1_BASE_URL") ?? "").trim();

/**
 * 内置站点地址（兜底）：正常情况下由环境变量 ST1_BASE_URL 提供，
 * 用户完全不需要填写；这里再兜一层，避免环境变量漏配时整站不可用。
 */
const BUILTIN_BASE = "http://zy.beida.pw";

/** 站点 API 路径（基地址统一不含这一段，调用时再拼） */
const API_PATH = "/api/open";
const TIMEOUT_MS = 20000;

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

/**
 * 规范化站点基地址：
 *   · 允许用户只填域名（自动补 https）、也允许直接粘贴带 /api/open 的地址；
 *   · 拒绝内网/回环地址 —— 地址可由用户填写，必须防 SSRF。
 */
function normalizeBase(raw: string): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, "").replace(/\/api\/open$/i, "");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes(":");
  if (blocked) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

interface ApiResult {
  status: number;
  ok: boolean;
  data: unknown;
  text: string;
}

/** 调一次站点开放 API */
async function callApi(base: string, token: string, path: string, init: RequestInit = {}): Promise<ApiResult> {
  const url = `${base}${API_PATH}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  try {
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, data, text };
  } catch (e) {
    return { status: 0, ok: false, data: null, text: `请求站点失败：${(e as Error).message}` };
  }
}

/** 站点错误 → 本系统错误码（与前端 SITE_EXPIRED_CODES 保持一致） */
function mapError(r: ApiResult): { error: string; code?: string } {
  if (r.status === 0) return { error: r.text, code: "ST1_UNREACHABLE" };
  const body = (r.data ?? {}) as Record<string, unknown>;
  const siteCode = String(body.code ?? body.error ?? "").toUpperCase();
  const msg = String(body.message ?? body.msg ?? body.error ?? r.text ?? "").slice(0, 300);
  if (r.status === 401) {
    return {
      error: siteCode === "MISSING_TOKEN"
        ? "没有携带令牌，请重新绑定 1号站点的开放 API 令牌"
        : "令牌错误或账号已被禁用：请到站点「开放API」页确认后重新绑定",
      code: "ST1_TOKEN_EXPIRED",
    };
  }
  if (r.status === 403) return { error: msg || "无权限（站点拒绝）", code: siteCode || "ST1_FORBIDDEN" };
  if (r.status === 404) return { error: msg || "资源或接口不存在", code: "ST1_NOT_FOUND" };
  if (r.status === 422) return { error: msg || "参数校验失败", code: "ST1_VALIDATION_FAILED" };
  if (r.status === 429) return { error: msg || "调用频率超限，请稍后重试", code: "ST1_RATE_LIMITED" };
  return { error: msg || `站点返回 HTTP ${r.status}`, code: siteCode || "ST1_ERROR" };
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function parseSetCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
}

/** 合并 Cookie 串（同名以后者为准） */
function mergeCookie(old: string, setCookies: string[]): string {
  const map = new Map<string, string>();
  for (const part of old.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const sc of setCookies) {
    const i = sc.indexOf("=");
    if (i <= 0) continue;
    map.set(sc.slice(0, i).trim(), sc.slice(i + 1).split(";")[0].trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * 把站点返回的列表取出来（不同实现可能包成 data / items / list / data.items / 裸数组）。
 * 站点接口文档没写响应结构，这里全部兼容，避免结构一变就整页空白。
 */
function extractList(raw: unknown): Array<Record<string, unknown>> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const inner = (r.data ?? {}) as Record<string, unknown>;
  const cand: unknown = Array.isArray(raw)
    ? raw
    : Array.isArray(r.data)
      ? r.data
      : Array.isArray(r.items)
        ? r.items
        : Array.isArray(r.list)
          ? r.list
          : Array.isArray(inner.items)
            ? inner.items
            : Array.isArray(inner.list)
              ? inner.list
              : Array.isArray(inner.data)
                ? inner.data
                : [];
  return (cand as unknown[]).filter((x) => !!x && typeof x === "object") as Array<Record<string, unknown>>;
}

/** 从 /profile 响应里取「我是谁」（id / username / nickname） */
function extractIdentity(raw: unknown): { id?: string; username?: string; nickname?: string } {
  const d = (raw ?? {}) as Record<string, unknown>;
  const inner = (d.data ?? {}) as Record<string, unknown>;
  const u = ((inner.user ?? d.user ?? inner ?? d) ?? {}) as Record<string, unknown>;
  return {
    id: u.id != null ? String(u.id) : undefined,
    username: u.username != null ? String(u.username) : undefined,
    nickname: u.nickname != null ? String(u.nickname) : undefined,
  };
}

/**
 * 从片源列表里挑出「我发布的」（站点没提供 mine 过滤，只能按作者字段尽力匹配）。
 * 匹配不到时返回 null，由调用方决定怎么展示（避免把全站片源误当成自己的）。
 */
function filterMine(
  list: Array<Record<string, unknown>>,
  me: { id?: string; username?: string; nickname?: string }
): Array<Record<string, unknown>> | null {
  const nameFields = ["author", "author_name", "username", "user_name", "uploader", "nickname"];
  const idFields = ["user_id", "author_id", "uid", "userid"];
  const names = new Set([me.username, me.nickname].filter((x): x is string => !!x));
  const hit = (o: Record<string, unknown>): boolean => {
    for (const f of nameFields) {
      const v = o[f];
      if (typeof v === "string" && names.has(v)) return true;
      if (v && typeof v === "object") {
        const n = (v as Record<string, unknown>).username ?? (v as Record<string, unknown>).nickname;
        if (typeof n === "string" && names.has(n)) return true;
      }
    }
    if (me.id) {
      for (const f of idFields) {
        const v = o[f];
        if (v != null && String(v) === me.id) return true;
      }
    }
    return false;
  };
  const mine = list.filter(hit);
  return mine.length > 0 ? mine : null;
}

/** 从站点返回里取片源 id / url（不同实现可能把结果包在 data / resource 里） */
function pickRemote(data: unknown): { id: string | null; url: string | null } {
  const d = (data ?? {}) as Record<string, unknown>;
  const inner = (d.data ?? d.resource ?? d.res ?? d) as Record<string, unknown>;
  const raw = inner.id ?? inner.resource_id ?? inner.rid;
  const id = raw === undefined || raw === null ? null : String(raw);
  const url = (inner.url ?? inner.link ?? null) as string | null;
  return { id, url: typeof url === "string" ? url : null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? `Bearer ${SERVICE_KEY}`;
    const callerId = await resolveCallerId(req, async (t) => {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${t}` },
      });
      if (!r.ok) return null;
      const u = (await r.json().catch(() => null)) as { id?: string } | null;
      return u?.id ?? null;
    });
    if (!callerId) return json({ error: "登录态无效或已过期" }, 401);
    const url = new URL(req.url);
    const action = (url.searchParams.get("action") ?? "").trim();
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      /* 允许空 body */
    }

    const restHeaders = {
      apikey: ANON_KEY,
      Authorization: authHeader,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };

    // ── 会话读取（status / unbind 之外的动作都要求已绑定）──
    const sRes = await fetch(
      `${SUPABASE_URL}/rest/v1/st1_sessions?select=*&user_id=eq.${callerId}`,
      { headers: { apikey: ANON_KEY, Authorization: authHeader } }
    );
    const sessions = await sRes.json();
    const session = (Array.isArray(sessions) ? sessions[0] : null) as {
      base_url?: string | null;
      api_token?: string | null;
      username?: string | null;
      default_category_id?: string | null;
      status?: string | null;
      /** 站点 Web 会话 Cookie（账号密码登录得到） */
      cookie?: string | null;
      /** 取验证码时的临时会话 Cookie（验证码与该会话绑定） */
      captcha_cookie?: string | null;
    } | null;

    // 站点地址优先级：服务端环境变量 > 用户历史绑定值 > 请求带的地址 > 内置兜底（用户不需要填）
    const base = normalizeBase(
      ENV_BASE || session?.base_url || String(body.baseUrl ?? "") || BUILTIN_BASE
    ) ?? normalizeBase(BUILTIN_BASE);
    const token = String(session?.api_token ?? body.token ?? "").trim();

    if (action === "unbind") {
      await fetch(`${SUPABASE_URL}/rest/v1/st1_sessions?user_id=eq.${callerId}`, {
        method: "DELETE",
        headers: { ...restHeaders, Prefer: "return=minimal" },
      });
      return json({ success: true, data: { unbound: true } });
    }

    // 站点信息：地址由服务端内置，用户不需要填（前端据此展示）
    if (action === "site") {
      return json({
        success: true,
        data: {
          baseUrl: base,
          apiPath: API_PATH,
          builtin: !!ENV_BASE || base === normalizeBase(BUILTIN_BASE),
        },
      });
    }

    if (action === "bind") {
      const rawBase = String(body.baseUrl ?? "").trim();
      if (!base) return json({ error: "站点地址不正确（请填域名，如 https://example.com）", code: "ST1_BAD_BASE" }, 400);
      if (!token) return json({ error: "请填写站点开放 API 令牌（pat_…）", code: "ST1_NO_TOKEN" }, 400);
      // 先校验令牌：GET /profile
      const probe = await callApi(base, token, "/profile");
      if (!probe.ok) return json(mapError(probe), probe.status === 401 ? 401 : 400);
      const prof = (probe.data ?? {}) as Record<string, unknown>;
      const uname = String(
        (prof.data as Record<string, unknown> | undefined)?.username ?? prof.username ?? prof.name ?? ""
      ) || null;
      const patch = {
        user_id: callerId,
        base_url: ENV_BASE || rawBase || null,
        api_token: token,
        username: uname,
        default_category_id: body.defaultCategoryId ? String(body.defaultCategoryId) : session?.default_category_id ?? null,
        status: "active",
        last_error: null,
        last_check_at: new Date().toISOString(),
      };
      const up = await fetch(`${SUPABASE_URL}/rest/v1/st1_sessions?on_conflict=user_id`, {
        method: "POST",
        headers: { ...restHeaders, Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(patch),
      });
      if (!up.ok) return json({ error: `保存绑定失败：${await up.text()}` }, 500);
      return json({ success: true, data: { username: uname, baseUrl: base, profile: probe.data } });
    }

    // ── 站点账号密码登录（图形验证码），不需要开放 API 令牌 ──
    // 站点：GET /api/captcha 取 SVG 验证码（与当前会话绑定）→ POST /api/login（JSON，明文）
    // 会话是 HttpOnly Cookie，所以验证码那一步建立的 Cookie 先暂存到会话行，登录时复用。
    if (action === "captcha") {
      if (!base) return json({ error: "站点地址不正确（例如 http://zy.beida.pw）", code: "ST1_BAD_BASE" }, 400);
      const r = await fetch(`${base}/api/captcha?t=${Date.now()}`, {
        headers: { "User-Agent": UA, Accept: "image/svg+xml,*/*", Referer: `${base}/login` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => null);
      if (!r || !r.ok) {
        return json({ error: "获取图形验证码失败（请确认站点地址可访问）", code: "ST1_CAPTCHA_FAILED" }, 400);
      }
      const svg = await r.text();
      const jar = mergeCookie("", parseSetCookies(r));
      await fetch(`${SUPABASE_URL}/rest/v1/st1_sessions?on_conflict=user_id`, {
        method: "POST",
        headers: { ...restHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          user_id: callerId,
          base_url: ENV_BASE || session?.base_url || base,
          captcha_cookie: jar || null,
        }),
      });
      return json({ success: true, data: { svg, bound_cookie: !!jar } });
    }

    if (action === "login") {
      if (!base) return json({ error: "站点地址不正确（例如 http://zy.beida.pw）", code: "ST1_BAD_BASE" }, 400);
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      const captchaCode = String(body.captcha ?? "").trim();
      if (!username || !password) return json({ error: "请输入站点账号与密码" }, 400);
      if (!captchaCode) return json({ error: "请输入图形验证码", code: "ST1_CAPTCHA_ERROR" }, 400);

      const jar0 = session?.captcha_cookie ?? "";
      const r = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Referer: `${base}/login`,
          Origin: base,
          ...(jar0 ? { Cookie: jar0 } : {}),
        },
        body: JSON.stringify({ username, password, captcha: captchaCode }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => null);
      if (!r) {
        return json({ error: "请求站点失败（站点是 HTTP 明文地址，请确认地址可访问）", code: "ST1_UNREACHABLE" }, 400);
      }
      const rawText = await r.text();
      let data: {
        user?: { username?: string; nickname?: string; role?: string };
        error?: string;
        errors?: Record<string, string>;
      } | null = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }
      if (!r.ok || !data?.user) {
        const errs = data?.errors ?? {};
        const msg = errs.captcha ?? errs.username ?? errs.password ?? data?.error ?? `登录失败（HTTP ${r.status}）`;
        const captchaErr = !!errs.captcha || /验证码/.test(String(msg));
        return json(
          { error: String(msg), code: captchaErr ? "ST1_CAPTCHA_ERROR" : "ST1_LOGIN_FAILED" },
          400
        );
      }
      const cookie = mergeCookie(jar0, parseSetCookies(r));
      const uname = String(data.user.username ?? username);
      await fetch(`${SUPABASE_URL}/rest/v1/st1_sessions?on_conflict=user_id`, {
        method: "POST",
        headers: { ...restHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          user_id: callerId,
          base_url: ENV_BASE || session?.base_url || base,
          cookie,
          captcha_cookie: null,
          username: uname,
          status: "active",
          last_error: null,
          last_check_at: new Date().toISOString(),
          cookie_at: new Date().toISOString(),
        }),
      });
      return json({ success: true, data: { username: uname, user: data.user } });
    }

    // 站点登录态自检（GET /api/me）：用于「已登录 / 会话已失效」展示
    if (action === "me") {
      if (!session?.cookie) return json({ error: "尚未用站点账号登录", code: "ST1_NOT_LOGGED_IN" }, 400);
      const r = await fetch(`${base}/api/me`, {
        headers: { "User-Agent": UA, Accept: "application/json", Cookie: session.cookie, Referer: `${base}/` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => null);
      if (!r || !r.ok) return json({ error: "读取站点登录态失败", code: "ST1_COOKIE_EXPIRED" }, 400);
      const d = (await r.json().catch(() => null)) as { logged_in?: boolean; user?: { username?: string } } | null;
      if (!d?.logged_in) {
        await fetch(`${SUPABASE_URL}/rest/v1/st1_sessions?user_id=eq.${callerId}`, {
          method: "PATCH",
          headers: { ...restHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ status: "expired", last_error: "站点会话已失效，请重新用账号登录" }),
        });
        return json({ error: "站点会话已失效，请重新用账号登录", code: "ST1_COOKIE_EXPIRED" }, 400);
      }
      return json({ success: true, data: { username: d.user?.username ?? session.username ?? null, user: d.user } });
    }

    // 以下动作都需要已绑定的令牌
    if (!session?.api_token) {
      return json({ error: "尚未绑定 1号站点的开放 API 令牌", code: "ST1_NOT_BOUND" }, 400);
    }
    if (!base) return json({ error: "站点地址无效或未配置", code: "ST1_BAD_BASE" }, 400);

    /** 令牌失效时标记状态，便于「站点同步」页显示「已失效」 */
    const markExpired = async (msg: string) => {
      await fetch(`${SUPABASE_URL}/rest/v1/st1_sessions?user_id=eq.${callerId}`, {
        method: "PATCH",
        headers: { ...restHeaders, Prefer: "return=minimal" },
        body: JSON.stringify({ status: "expired", last_error: msg.slice(0, 500), last_check_at: new Date().toISOString() }),
      });
    };

    switch (action) {
      // 巡检：令牌是否还有效（顺带刷新用户名与状态）
      case "status": {
        const r = await callApi(base, session.api_token, "/profile");
        if (!r.ok) {
          const err = mapError(r);
          if (r.status === 401) await markExpired(err.error);
          return json(err, r.status === 401 ? 401 : 400);
        }
        const prof = (r.data ?? {}) as Record<string, unknown>;
        const uname = String(
          (prof.data as Record<string, unknown> | undefined)?.username ?? prof.username ?? ""
        ) || session.username || null;
        await fetch(`${SUPABASE_URL}/rest/v1/st1_sessions?user_id=eq.${callerId}`, {
          method: "PATCH",
          headers: { ...restHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ status: "active", last_error: null, username: uname, last_check_at: new Date().toISOString() }),
        });
        return json({ success: true, data: { username: uname, profile: r.data } });
      }

      case "categories": {
        const r = await callApi(base, session.api_token, "/categories");
        if (!r.ok) return json(mapError(r), 400);
        return json({ success: true, data: r.data });
      }

      case "pt_tags": {
        const r = await callApi(base, session.api_token, "/pt-tags");
        if (!r.ok) return json(mapError(r), 400);
        return json({ success: true, data: r.data });
      }

      case "search": {
        const qs = new URLSearchParams();
        if (body.keyword) qs.set("keyword", String(body.keyword));
        if (body.page) qs.set("page", String(body.page));
        if (body.pageSize) qs.set("pageSize", String(body.pageSize));
        if (body.category) qs.set("category", String(body.category));
        const r = await callApi(base, session.api_token, `/resources${qs.toString() ? `?${qs}` : ""}`);
        if (!r.ok) return json(mapError(r), 400);
        return json({ success: true, data: r.data });
      }

      // 「我的已发布片源」：站点接口没有 mine 过滤，先拿 /profile 得到身份，再在列表里挑属于自己的
      case "list_mine": {
        const prof = await callApi(base, session.api_token, "/profile");
        if (!prof.ok) {
          const err = mapError(prof);
          if (prof.status === 401) await markExpired(err.error);
          return json(err, 400);
        }
        const me = extractIdentity(prof.data);
        const qs = new URLSearchParams({
          page: "1",
          pageSize: String(Math.min(100, Math.max(1, Number(body.pageSize) || 50))),
        });
        if (body.keyword) qs.set("keyword", String(body.keyword));
        const r = await callApi(base, session.api_token, `/resources?${qs.toString()}`);
        if (!r.ok) return json(mapError(r), 400);
        const all = extractList(r.data);
        const mine = filterMine(all, me);
        return json({
          success: true,
          data: {
            me,
            items: mine ?? all,
            scanned: all.length,
            /** true = 已按作者/用户 ID 过滤出自己的；false = 站点列表里没有作者字段，展示的是原始列表 */
            filtered: !!mine,
            /** 站点返回的字段名（便于排查结构差异） */
            sample_keys: all[0] ? Object.keys(all[0]) : [],
          },
        });
      }

      case "detail": {
        const id = String(body.id ?? "").trim();
        if (!id) return json({ error: "缺少 id" }, 400);
        const r = await callApi(base, session.api_token, `/resources/${encodeURIComponent(id)}`);
        if (!r.ok) return json(mapError(r), 400);
        return json({ success: true, data: r.data });
      }

      // 发布片源；带上 resourceId 时回写「资源 ↔ 片源」绑定，之后资源变更可自动 PATCH
      case "publish": {
        const title = String(body.title ?? "").trim();
        const panUrl = String(body.panUrl ?? "").trim();
        if (!title) return json({ error: "缺少标题" }, 400);
        if (!/^https?:\/\//i.test(panUrl)) return json({ error: "云盘地址需以 http(s) 开头" }, 400);
        const payload: Record<string, unknown> = {
          title: title.slice(0, 100),
          pan_url: panUrl,
          pan_code: body.panCode ? String(body.panCode) : "",
        };
        if (body.content) payload.content = String(body.content);
        const categoryId = body.categoryId ?? session.default_category_id;
        if (categoryId) payload.category_id = String(categoryId);
        if (body.thumbnail) payload.thumbnail = String(body.thumbnail);
        if (Array.isArray(body.tags)) payload.tags = body.tags;
        if (Array.isArray(body.ptTagIds)) payload.pt_tag_ids = body.ptTagIds;

        const r = await callApi(base, session.api_token, "/resources", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const err = mapError(r);
          if (r.status === 401) await markExpired(err.error);
          return json(err, 400);
        }
        const remote = pickRemote(r.data);
        const resourceId = body.resourceId ? String(body.resourceId) : "";
        if (resourceId && remote.id) {
          await fetch(`${SUPABASE_URL}/rest/v1/st1_resource_bindings?on_conflict=resource_id`, {
            method: "POST",
            headers: { ...restHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              resource_id: resourceId,
              user_id: callerId,
              remote_id: remote.id,
              remote_url: remote.url,
              title,
            }),
          });
        }
        return json({ success: true, data: { ...(r.data as object), remote_id: remote.id } });
      }

      // PATCH 局部更新（只提交变化的字段）
      case "update": {
        let remoteId = body.remoteId ? String(body.remoteId) : "";
        const resourceId = body.resourceId ? String(body.resourceId) : "";
        if (!remoteId && resourceId) {
          const bRes = await fetch(
            `${SUPABASE_URL}/rest/v1/st1_resource_bindings?select=remote_id&resource_id=eq.${resourceId}`,
            { headers: { apikey: ANON_KEY, Authorization: authHeader } }
          );
          const rows = await bRes.json();
          remoteId = String((Array.isArray(rows) ? rows[0]?.remote_id : "") ?? "");
        }
        if (!remoteId) return json({ error: "缺少片源 id（该资源还没在 1号站点发布过）", code: "ST1_NOT_BOUND" }, 400);

        const payload: Record<string, unknown> = {};
        if (body.title) payload.title = String(body.title).slice(0, 100);
        if (body.panUrl) payload.pan_url = String(body.panUrl);
        if (body.panCode !== undefined) payload.pan_code = String(body.panCode);
        if (body.content !== undefined) payload.content = String(body.content);
        if (body.categoryId) payload.category_id = String(body.categoryId);
        if (body.thumbnail !== undefined) payload.thumbnail = body.thumbnail ? String(body.thumbnail) : null;
        if (Array.isArray(body.tags)) payload.tags = body.tags;
        if (Array.isArray(body.ptTagIds)) payload.pt_tag_ids = body.ptTagIds;
        if (Object.keys(payload).length === 0) return json({ error: "没有需要更新的字段" }, 400);

        const r = await callApi(base, session.api_token, `/resources/${encodeURIComponent(remoteId)}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const err = mapError(r);
          if (r.status === 401) await markExpired(err.error);
          return json(err, 400);
        }
        if (resourceId) {
          await fetch(`${SUPABASE_URL}/rest/v1/st1_resource_bindings?resource_id=eq.${resourceId}`, {
            method: "PATCH",
            headers: { ...restHeaders, Prefer: "return=minimal" },
            body: JSON.stringify({ title: payload.title ? String(payload.title) : undefined }),
          });
        }
        return json({ success: true, data: r.data });
      }

      default:
        return json({ error: `未知 action：${action || "(空)"}` }, 400);
    }
  } catch (e) {
    return json({ error: `1号站点代理异常：${(e as Error).message}` }, 500);
  }
});

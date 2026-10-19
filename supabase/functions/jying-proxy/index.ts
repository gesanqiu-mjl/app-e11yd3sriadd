// ============================================================
// Supabase Edge Function: jying-proxy
// www.jying.top（聚影）网盘分享代理
//
// 作用：在 Supabase 登录态下，读取用户绑定的聚影账号会话，
//       代理「片源检索 / 我的分享记录查询 / 分享链接修改」，
//       凭据（Cookie、token）不返前端，规避 CORS。
//
// 部署：supabase functions deploy jying-proxy
// 环境变量：SITE_URL（可选，CORS 白名单，默认 *）
//
// 调用：POST /jying-proxy?action=<action>
//   Authorization: Bearer <access_token>   （本站 Supabase 登录态）
//
// actions:
//   login          POST /api/app/login/                      账号密码登录
//   logout         清空本地会话
//   status         校验会话是否仍有效
//   my_movies      GET  /api/app/my-resource-movies/         我的分享（影片维度）
//   my_resources   GET  /api/app/my-resource-movies/{id}/resources/
//   my_shares      my_movies + my_resources 扁平化           我的分享（资源条目维度）
//   search_movies  GET  /api/app/movies/                     全站片库检索
//   detail         GET  /api/app/resource/{id}/edit-detail/
//   update         POST /api/app/resource/{id}/update/       仅提交 share_link
//   add            POST /api/app/movie/{id}/resource/add/     新增分享（type 自动识别）
//
// 鉴权：Django 双通道 —— Cookie(csrftoken/sessionid) + X-App-User-Token，
//       写操作额外需要 X-CSRFToken 头。
// 失效检测：HTTP 401/403 或 {"status":"error","message":"未登录..."}
//           → status=expired，返回 code=JYING_COOKIE_EXPIRED。
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveCallerId } from "../_shared/internalAuth.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "*";
const BASE = "https://www.jying.top";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

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

const EXPIRED_BODY = { error: "聚影登录已过期，请重新登录", code: "JYING_COOKIE_EXPIRED" };
/** 会话失效响应：带上站点原文，便于前端与日志定位真实原因 */
const expired = (siteMessage?: string) =>
  json(siteMessage ? { ...EXPIRED_BODY, error: `聚影：${siteMessage}` } : EXPIRED_BODY, 401);

/** 站点会话失效：由 forward 抛出、外层统一转成 401 响应 */
class JyingExpiredError extends Error {
  readonly siteMessage: string;
  constructor(siteMessage: string) {
    super(siteMessage || EXPIRED_BODY.error);
    this.name = "JyingExpiredError";
    this.siteMessage = siteMessage;
  }
}

// ---------- 工具 ----------

function getSetCookies(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  return h.getSetCookie?.() ?? [];
}

/** 极简 Cookie jar：维护站点下发的 csrftoken / sessionid */
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

/**
 * 站点侧「未登录 / 会话失效」判定。
 *
 * 只认 401 与站点明确的失效文案：403 还可能是「无权限 / 禁止发布 / 风控」等
 * 业务拒绝，若一并判为失效，会把账号误标成「登录已过期」，
 * 用户重新登录后再操作照样复现（表现为「一发就掉登录」）。
 */
function isAuthFailure(res: Response, text: string): boolean {
  if (res.status === 401) return true;
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  const j = parseJsonSafe<{ message?: string; detail?: string }>(t);
  const msg = `${j?.message ?? ""} ${j?.detail ?? ""}`.trim();
  if (!msg) return false;
  if (/未登录|请先登录|登录已失效|登录已过期|登录状态已失效|请重新登录/.test(msg)) return true;
  // 明确的令牌失效文案；排除「缺少 token / token 参数错误」这类调用方问题
  if (/token/i.test(msg) && /(失效|过期|无效|非法|错误)/i.test(msg)) return true;
  return false;
}

/** 带 cookie / token / csrf 的站点请求，并回写站点下发的 cookie 变更 */
async function siteFetch(
  path: string,
  opts: {
    jar: Jar;
    token?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }
): Promise<{ res: Response; text: string; refreshedToken: string | null }> {
  const csrf = opts.jar.get("csrftoken");
  const headers: Record<string, string> = {
    "User-Agent": UA,
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${BASE}/`,
    Cookie: opts.jar.header(),
    ...(csrf ? { "X-CSRFToken": csrf } : {}),
    ...(opts.token ? { "X-App-User-Token": opts.token } : {}),
    ...(opts.headers ?? {}),
  };

  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers.Origin = BASE;
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body,
    redirect: "follow",
  });
  opts.jar.setAll(getSetCookies(res));
  const refreshedToken = res.headers.get("x-refreshed-token");
  const text = await res.text();
  return { res, text, refreshedToken };
}

/** 账号密码登录：先取 csrftoken，再提交登录，返回已建立会话的 jar 与 token */
async function loginSite(username: string, password: string) {
  const jar = createJar();
  const common = {
    "User-Agent": UA,
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${BASE}/login`,
  };

  // 1) 建立 CSRF cookie
  const csrfRes = await fetch(`${BASE}/api/csrf/`, { headers: common, redirect: "follow" });
  jar.setAll(getSetCookies(csrfRes));

  // 2) 账号密码登录（JSON + X-CSRFToken）
  const csrf = jar.get("csrftoken");
  const loginRes = await fetch(`${BASE}/api/app/login/`, {
    method: "POST",
    headers: {
      ...common,
      "Content-Type": "application/json",
      Origin: BASE,
      Cookie: jar.header(),
      ...(csrf ? { "X-CSRFToken": csrf } : {}),
    },
    body: JSON.stringify({ username, password }),
    redirect: "follow",
  });
  jar.setAll(getSetCookies(loginRes));

  const data = parseJsonSafe<{ token?: string; message?: string }>(await loginRes.text());
  if (!loginRes.ok || !data?.token) {
    const msg =
      data?.message ||
      (loginRes.status === 401 || loginRes.status === 403
        ? "账号或密码错误"
        : `登录失败（HTTP ${loginRes.status}）`);
    throw new Error(msg);
  }
  return { jar, token: data.token };
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

    // 2. 读取聚影会话
    const { data: sessionRow } = await appClient
      .from("jying_sessions")
      .select("cookie,token,status,username,updated_at")
      .eq("user_id", me.id)
      .maybeSingle();
    const session = sessionRow ?? null;

    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "";
    const body = await readBody(req);

    const markExpired = async () => {
      await appClient
        .from("jying_sessions")
        .update({ status: "expired", last_check_at: new Date().toISOString() })
        .eq("user_id", me.id);
    };
    const touchActive = async () => {
      await appClient
        .from("jying_sessions")
        .update({ status: "active", last_check_at: new Date().toISOString() })
        .eq("user_id", me.id);
    };
    const persistSession = async (jar: Jar, token: string, username: string) => {
      const now = new Date().toISOString();
      await appClient.from("jying_sessions").upsert(
        {
          user_id: me.id,
          username,
          cookie: jar.header(),
          token,
          status: "active",
          last_check_at: now,
          updated_at: now,
        },
        { onConflict: "user_id" }
      );
    };

    // ---------- action: login（无需已有会话） ----------
    if (action === "login") {
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      if (!username || !password) return json({ error: "请输入聚影账号和密码" }, 400);

      try {
        const { jar, token } = await loginSite(username, password);

        // 登录后立即验证：能否读到「我的分享记录」，避免存下无效会话
        const probe = await siteFetch("/api/app/my-resource-movies/?page=1&page_size=1", {
          jar,
          token,
        });
        if (isAuthFailure(probe.res, probe.text)) {
          return json({ error: "聚影登录未通过校验，请检查账号或密码" }, 401);
        }

        await persistSession(jar, token, username);
        return json({ success: true, message: "登录成功，会话已保存" });
      } catch (e) {
        return json(
          { error: `聚影登录失败：${e instanceof Error ? e.message : String(e)}` },
          401
        );
      }
    }

    // ---------- action: logout ----------
    if (action === "logout") {
      await appClient.from("jying_sessions").delete().eq("user_id", me.id);
      return json({ success: true });
    }

    // 其余 action 需已绑定
    if (!session?.cookie && !session?.token) {
      return json({ error: "未绑定聚影账号，请先登录", code: "JYING_NOT_BOUND" }, 400);
    }

    const jar = createJar(session?.cookie ?? "");
    // 站点刷新令牌后，同一次调用里的后续请求必须改用新令牌
    let currentToken = session?.token ?? "";

    /** 取站点响应里的可展示错误文案 */
    const siteMessageOf = (text: string): string => {
      const j = parseJsonSafe<{ message?: string; detail?: string; error?: string }>(text);
      return String(j?.message ?? j?.detail ?? j?.error ?? "").trim();
    };

    /**
     * 转发请求并统一处理「token / cookie 刷新」与「会话失效」。
     * 会话失效时抛 JyingExpiredError，由外层 switch 统一转成 401。
     */
    const forward = async (
      path: string,
      opts: { method?: string; body?: unknown } = {}
    ): Promise<{ status: number; text: string }> => {
      const cookieBefore = jar.header();
      const r = await siteFetch(path, { jar, token: currentToken, ...opts });

      // 站点下发的令牌 / cookie 变化必须回写：否则本地凭据会逐渐失效，
      // 后续写操作（发布 / 改链接）将莫名失败
      const patch: Record<string, unknown> = {};
      if (r.refreshedToken && r.refreshedToken !== currentToken) {
        currentToken = r.refreshedToken;
        patch.token = r.refreshedToken;
      }
      const cookieAfter = jar.header();
      if (cookieAfter && cookieAfter !== cookieBefore && cookieAfter !== (session?.cookie ?? "")) {
        patch.cookie = cookieAfter;
      }
      if (Object.keys(patch).length > 0) {
        await appClient
          .from("jying_sessions")
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq("user_id", me.id);
      }

      if (isAuthFailure(r.res, r.text)) {
        // 落一条边缘函数日志，便于回查真实原因（状态码 + 站点原文）
        console.error("jying auth failure", path, r.res.status, r.text.slice(0, 300));
        await markExpired();
        throw new JyingExpiredError(siteMessageOf(r.text));
      }
      if (r.res.status >= 400) {
        console.error("jying request failed", path, r.res.status, r.text.slice(0, 300));
      }
      return { status: r.res.status, text: r.text };
    };

    switch (action) {
      // 校验会话是否有效
      case "status": {
        const r = await forward("/api/app/my-resource-movies/?page=1&page_size=1");
        await touchActive();
        return json({ success: true, data: parseJsonSafe(r.text) });
      }

      // 我的分享记录（影片维度）：支持 q 关键字、分页、排序
      case "my_movies": {
        const qs = new URLSearchParams({
          page: url.searchParams.get("page") ?? "1",
          page_size: url.searchParams.get("page_size") ?? "20",
        });
        const q = url.searchParams.get("q") ?? url.searchParams.get("search") ?? "";
        const sort = url.searchParams.get("sort") ?? "";
        if (q) qs.set("q", q);
        if (sort) qs.set("sort", sort);

        const r = await forward(`/api/app/my-resource-movies/?${qs}`);
        await touchActive();
        return json({ success: true, data: parseJsonSafe(r.text) });
      }

      // 某影片下「我发布的」资源条目
      case "my_resources": {
        const movieId = String(
          url.searchParams.get("movie_id") ?? url.searchParams.get("movieId") ?? body.movie_id ?? ""
        );
        if (!movieId) return json({ error: "缺少 movie_id" }, 400);
        const qs = new URLSearchParams({
          page: url.searchParams.get("page") ?? "1",
          page_size: url.searchParams.get("page_size") ?? "50",
        });
        const r = await forward(
          `/api/app/my-resource-movies/${encodeURIComponent(movieId)}/resources/?${qs}`
        );
        await touchActive();
        return json({ success: true, data: parseJsonSafe(r.text) });
      }

      // 我的分享记录（扁平化）：影片维度列表 → 逐个取资源条目，合并成一行一条
      // 站点按「影片 → 资源条目」两级组织，前端绑定需要的是资源条目维度
      case "my_shares": {
        const q = url.searchParams.get("q") ?? url.searchParams.get("search") ?? "";
        const listQs = new URLSearchParams({
          page: url.searchParams.get("page") ?? "1",
          page_size: url.searchParams.get("page_size") ?? "20",
        });
        if (q) listQs.set("q", q);

        const listR = await forward(`/api/app/my-resource-movies/?${listQs}`);
        const listJson = parseJsonSafe<{
          total_count?: number;
          results?: Array<{
            id: number;
            title?: string;
            cover?: string;
            release_year?: number;
            movie_type_display?: string;
          }>;
        }>(listR.text);
        const movies = listJson?.results ?? [];
        // 无关键字时限制扫描影片数，避免一次打太多站点请求
        const targets = movies.slice(0, q ? 20 : 5);

        const flat: Array<Record<string, unknown>> = [];
        for (const m of targets) {
          const rr = await forward(
            `/api/app/my-resource-movies/${m.id}/resources/?page=1&page_size=50`
          );
          const rj = parseJsonSafe<{ results?: Array<Record<string, unknown>> }>(rr.text);
          for (const it of rj?.results ?? []) {
            flat.push({
              id: it.id,
              movie_id: m.id,
              movie_title: m.title ?? null,
              movie_cover: m.cover ?? null,
              release_year: m.release_year ?? null,
              movie_type: m.movie_type_display ?? null,
              title: it.title ?? null,
              share_link: it.share_link ?? null,
              link_hidden_reason: it.link_hidden_reason ?? null,
              resource_type: it.resource_type ?? null,
              resource_type_display: it.resource_type_display ?? null,
              can_edit: it.can_edit ?? false,
            });
          }
        }
        await touchActive();
        return json({
          success: true,
          data: { total_movies: listJson?.total_count ?? movies.length, list: flat },
        });
      }

      // 全站片库检索（匿名接口，但走统一转发以便复用 cookie）
      case "search_movies": {
        const qs = new URLSearchParams({
          page: url.searchParams.get("page") ?? "1",
          page_size: url.searchParams.get("page_size") ?? "20",
        });
        const q = url.searchParams.get("q") ?? url.searchParams.get("search") ?? "";
        if (q) qs.set("q", q);
        const r = await forward(`/api/app/movies/?${qs}`);
        return json({ success: true, data: parseJsonSafe(r.text) });
      }

      // 读取单条资源当前字段（做 diff 参考）
      case "detail": {
        const linkId = String(url.searchParams.get("link_id") ?? body.link_id ?? "");
        if (!linkId) return json({ error: "缺少 link_id" }, 400);
        const r = await forward(`/api/app/resource/${encodeURIComponent(linkId)}/edit-detail/`);
        await touchActive();
        return json({ success: true, data: parseJsonSafe(r.text) });
      }

      // 在指定影片下新增分享记录
      // 聚影支持「粘贴链接自动识别网盘类型」：resource_type 可省略，
      // 传了则作为显式指定（实测只传 share_link 即可成功）
      case "add": {
        const movieId = String(body.movie_id ?? url.searchParams.get("movie_id") ?? "");
        const shareLink = String(body.share_link ?? body.link_url ?? body.url ?? "").trim();
        if (!movieId) return json({ error: "缺少 movie_id" }, 400);
        if (!shareLink) return json({ error: "缺少 share_link" }, 400);

        const payload: Record<string, unknown> = { share_link: shareLink };
        const resourceType = String(body.resource_type ?? "").trim();
        if (resourceType) payload.resource_type = resourceType;
        const desc = String(body.description ?? "").trim();
        if (desc) payload.resource_description = desc;
        const code = String(body.extraction_code ?? "").trim();
        if (code) payload.extraction_code = code;

        const r = await forward(
          `/api/app/movie/${encodeURIComponent(movieId)}/resource/add/`,
          { method: "POST", body: { resources: [payload] } }
        );

        const data = parseJsonSafe<{
          status?: string;
          message?: string;
          resource?: Record<string, unknown>;
        }>(r.text);
        if (r.status >= 400 || !data?.resource) {
          return json(
            { error: data?.message || `聚影新增分享失败（HTTP ${r.status}）` },
            400
          );
        }
        await touchActive();
        return json({ success: true, data: { resource: data.resource } });
      }

      // 修改分享链接（差量：仅提交 share_link）
      case "update": {
        const linkId = String(body.link_id ?? url.searchParams.get("link_id") ?? "");
        const shareLink = String(body.share_link ?? body.link_url ?? body.url ?? "").trim();
        if (!linkId) return json({ error: "缺少 link_id" }, 400);
        if (!shareLink) return json({ error: "缺少 share_link" }, 400);

        const r = await forward(`/api/app/resource/${encodeURIComponent(linkId)}/update/`, {
          method: "POST",
          body: { share_link: shareLink },
        });

        const data = parseJsonSafe<{ message?: string; resource?: unknown }>(r.text);
        if (r.status >= 400 || (data && !data.resource)) {
          return json(
            {
              error:
                data?.message ||
                `聚影站点更新失败（HTTP ${r.status}），请确认该分享记录仍存在`,
            },
            400
          );
        }
        await touchActive();
        return json({ success: true, data });
      }

      default:
        return json(
          {
            error: `不支持的 action: ${action}`,
            actions: [
              "login",
              "logout",
              "status",
              "my_movies",
              "my_resources",
              "my_shares",
              "search_movies",
              "detail",
              "update",
              "add",
            ],
          },
          400
        );
    }
  } catch (e) {
    // forward 判定会话失效时抛出：统一转成带站点原文的 401
    if (e instanceof JyingExpiredError) return expired(e.siteMessage);
    return json({ error: String(e) }, 500);
  }
});

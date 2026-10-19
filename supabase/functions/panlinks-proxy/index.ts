// ============================================================
// Supabase Edge Function: panlinks-proxy
// pinglian.lol（盘链）服务端代理 —— 对齐 2026-09-13 实测接口契约
//
// 部署：supabase functions deploy panlinks-proxy --use-api
// 环境变量：SITE_URL（CORS 白名单，可留空默认 *）
//
// ── 站点契约（Base: https://pinglian.lol，所有接口前缀 /api）──
//  · 认证：Cookie 会话（fetch credentials=include），无 Bearer/Token 头
//  · JSON 体：Content-Type: application/json
//  · 登录特例：POST /api/auth/login 用 application/x-www-form-urlencoded
//  · 统一响应包裹：{ success, data, message, error_type, timestamp }
//  · 会话失效：HTTP 401 + error_type=ADMIN_AUTH_REQUIRED
//  · 免登录白名单（文档声明）：/auth/*、/public/*、/videos/link-ticket、
//    /videos/link-check、/videos/link-open/、/videos/link-quota、/member/quota-config
//    ⚠ 实测修正（2026-09-13）：匿名直连仅 /api/auth/* 返回 200，其余一律
//      401 + error_type=ADMIN_AUTH_REQUIRED → 本代理除 status 外一律要求绑定账号
//
// ── 片源接口（文档称无需登录，实测需登录态）──
//  · GET  /api/videos?search&sort&page&page_size&group&type&year&area&lang
//  · GET  /api/videos/:id          → data:{...片源..., links:[...]}（links 不含 url）
//  · GET  /api/videos/types        → data:[分类...]
//  · GET  /api/videos/filters      → data:{groups:[{key,name,types[]}]}
//  · GET  /api/home?limit=N        → data:{banners,watching,latest_links,recommends}
//
// ── 我的分享链接（写操作需登录态）──
//  · GET    /api/videos/links?page&page_size&search&type   → data:{list:[...],total}
//  · GET    /api/videos/links/:id                          → data:{link:{...}}
//  · POST   /api/videos/:id/links   {title,url,password,pan_type}
//  · PUT    /api/videos/links/:id   {title,url,password,pan_type,note}
//  · DELETE /api/videos/links/:id   —— 无 Body
//
// ── 播放链路 ──
//  · POST /api/videos/link-ticket  {link_id}          → data:{ticket}
//  · GET  /api/videos/link-open/:id?t=<ticket>        → data:{url}
//  · POST /api/videos/link-infer   {url,password}     → data:{ok,title,pan_type,...}
//  · GET  /api/videos/link-quota                      → data:{limit,remaining,unlimited,used}
//
// 注：/api/videos/link-check 未在本轮文档中给出参数/返回契约，故未纳入代理。
//
// ── 安全模型 ──
//  1. 入站请求必须携带 Supabase 登录用户 access_token（Authorization: Bearer）
//  2. action=login 服务端模拟登录站点，成功后 Cookie 写入 pinglian_sessions；
//     账号明文存 username，密码不落库
//  3. 其余 action 用 service role 读取该用户 Cookie；Cookie 永不返回前端
//  4. 仅 status 允许未绑定站点账号时调用（站点匿名可达接口）
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveCallerId } from "../_shared/internalAuth.ts";

const PINGLIAN_BASE = "https://pinglian.lol";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 站点允许的 pan_type 合法值（文档 §3.3） */
const PAN_TYPES = new Set([
  "123",
  "aliyun",
  "mobile",
  "tianyi",
  "baidu",
  "quark",
  "115",
  "guangya",
  "uc",
  "xunlei",
  "weiyun",
  "lanzou",
  "jianguoyun",
  "pikpak",
  "others",
]);

/** 中文/别名 → 站点枚举。调用方（前端 detectPanName）传的是中文显示名，站点只认枚举 */
const PAN_TYPE_ALIASES: Record<string, string> = {
  "夸克": "quark", "夸克云盘": "quark", "夸克网盘": "quark",
  "阿里": "aliyun", "阿里云盘": "aliyun", "阿里云": "aliyun",
  "百度": "baidu", "百度云盘": "baidu", "百度网盘": "baidu", "百度云": "baidu",
  "123云盘": "123", "123网盘": "123",
  "移动": "mobile", "移动云盘": "mobile", "和彩云": "mobile",
  "天翼": "tianyi", "天翼云盘": "tianyi", "电信云盘": "tianyi",
  "115网盘": "115", "115云盘": "115",
  "uc网盘": "uc", "uc云盘": "uc",
  "迅雷": "xunlei", "迅雷云盘": "xunlei", "迅雷网盘": "xunlei",
  "微云": "weiyun", "腾讯微云": "weiyun",
  "蓝奏": "lanzou", "蓝奏云": "lanzou",
  "坚果": "jianguoyun", "坚果云": "jianguoyun",
  "pikpak": "pikpak",
  "光鸭": "guangya", "光鸭云盘": "guangya", "光鸭网盘": "guangya",
  "光雅": "guangya", "光雅云盘": "guangya",
  "其他": "others", "其它": "others",
};

/** URL 域名 → 站点枚举（pan_type 缺失或无法识别时的兜底） */
const PAN_URL_RULES: Array<{ type: string; patterns: RegExp[] }> = [
  { type: "xunlei", patterns: [/pan\.xunlei\.com/i] },
  { type: "baidu", patterns: [/pan\.baidu\.com/i, /yun\.baidu\.com/i] },
  { type: "quark", patterns: [/pan\.quark\.cn/i] },
  { type: "123", patterns: [/123pan\.(?:cn|com)/i, /123684\.com/i, /123912\.com/i] },
  { type: "uc", patterns: [/drive\.uc\.cn/i] },
  { type: "aliyun", patterns: [/alipan\.com/i, /aliyundrive\.com/i] },
  { type: "guangya", patterns: [/guangyapan\.com/i, /guangya\.com/i] },
  { type: "tianyi", patterns: [/cloud\.189\.cn/i] },
  { type: "mobile", patterns: [/yun\.139\.com/i] },
  { type: "115", patterns: [/115\.com/i, /115cdn\.com/i] },
  { type: "weiyun", patterns: [/weiyun\.com/i] },
  { type: "jianguoyun", patterns: [/jianguoyun\.com/i] },
  { type: "lanzou", patterns: [/lanzou[a-z]*\.com/i, /lanzn\.com/i] },
  { type: "pikpak", patterns: [/pikpak\.com/i] },
];

/**
 * 归一化 pan_type 为站点枚举，四步兜底：
 *  1) 已是合法枚举（如 guangya）→ 原样使用
 *  2) 命中中文/别名表（如「光鸭云盘」）→ 映射为枚举
 *  3) 仍未知 → 按分享链接域名推断（如 guangyapan.com → guangya）
 *  4) 最终兜底 others
 *
 * 必要性：站点 pan_type 只接受枚举值。历史上前端直接把中文显示名
 * （detectPanName 返回「光鸭云盘」）当 pan_type 提交，站点无法归类，
 * 会把该链接显示成「磁力链接」之类的错误网盘类型。
 */
function normalizePanType(raw: unknown, url?: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (PAN_TYPES.has(s)) return s;
  const alias = PAN_TYPE_ALIASES[s];
  if (alias && PAN_TYPES.has(alias)) return alias;
  const u = String(url ?? "");
  if (u) {
    for (const rule of PAN_URL_RULES) {
      if (rule.patterns.some((p) => p.test(u))) return rule.type;
    }
  }
  return "others";
}

/**
 * 实测修正（2026-09-13 匿名直连站点复测，与文档 §0 白名单不符）：
 * 文档称 /public/*、/videos/link-ticket、/videos/link-quota 等属免登录白名单，
 * 但匿名直连实测仅 /api/auth/* 返回 200；其余（含 /api/videos、/api/videos/types、
 * /api/home、/api/videos/link-ticket、/api/videos/link-quota）一律
 * 401 + error_type=ADMIN_AUTH_REQUIRED。
 * 因此除 status 外，所有站点数据接口均要求已绑定站点账号 Cookie。
 */
const ANON_SITE_ACTIONS = new Set(["status"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// 把对象转成站点期望的 form-urlencoded 字符串
function toForm(body: Record<string, string | number>): string {
  return new URLSearchParams(
    Object.entries(body).map(([k, v]) => [k, String(v)])
  ).toString();
}

// ---------- Cookie 处理 ----------

// Edge Runtime 中 set-cookie 为受限头，须用 getSetCookie()
function parseSetCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    try {
      return h.getSetCookie();
    } catch {
      /* fallthrough */
    }
  }
  const raw = h.get("set-cookie");
  return raw ? [raw] : [];
}

// 合并新下发的 Set-Cookie（同名以新值为准，忽略 path/expires 等属性）
function mergeCookie(jar: string, setCookies: string[]): string {
  const map = new Map<string, string>();
  if (jar) {
    for (const part of jar.split(";")) {
      const i = part.indexOf("=");
      if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  for (const sc of setCookies) {
    const kv = sc.split(";")[0].trim();
    const i = kv.indexOf("=");
    if (i > 0) map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// ---------- 账号密码登录 / 退出 ----------

/**
 * 获取站点图形验证码（GET /api/auth/captcha）。
 * 站点 2026-09-27 起登录前置该接口：返回 id（32 位 hex）+ base64 PNG + ttl（默认 300s，一次性使用）。
 */
async function fetchSiteCaptcha(): Promise<{
  ok: boolean;
  id?: string;
  image?: string;
  ttl?: number;
  message?: string;
}> {
  try {
    const res = await fetch(`${PINGLIAN_BASE}/api/auth/captcha`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: `${PINGLIAN_BASE}/`,
        Origin: PINGLIAN_BASE,
      },
    });
    const data = await res.json().catch(() => null);
    const id = data?.data?.id;
    const image = data?.data?.image;
    if (data?.success !== true || !id || !image) {
      return { ok: false, message: data?.message || "获取图形验证码失败，请重试" };
    }
    return {
      ok: true,
      id: String(id),
      image: String(image),
      ttl: Number(data?.data?.ttl ?? 300) || 300,
    };
  } catch {
    return { ok: false, message: "获取图形验证码失败，请重试" };
  }
}

// 用账号密码 + 图形验证码模拟登录站点，返回登录后的 Cookie 串。
// 流程：GET 首页建立初始会话 → POST /api/auth/login（form-urlencoded，remember=1，
//       带 captcha_id/captcha_code）→ 合并 Set-Cookie
async function loginWithPassword(
  username: string,
  password: string,
  captchaId: string,
  captchaCode: string
): Promise<{ ok: boolean; cookie?: string; message?: string; captchaError?: boolean }> {
  let jar = "";

  // 1) 打开首页，建立初始会话
  const page = await fetch(`${PINGLIAN_BASE}/`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  jar = mergeCookie(jar, parseSetCookies(page));

  // 2) 提交账号密码 + 图形验证码（form-urlencoded，站点唯一使用表单体的接口）
  const loginRes = await fetch(`${PINGLIAN_BASE}/api/auth/login`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${PINGLIAN_BASE}/`,
      Origin: PINGLIAN_BASE,
      ...(jar ? { Cookie: jar } : {}),
    },
    body: toForm({
      username,
      password,
      remember: 1,
      captcha_id: captchaId,
      captcha_code: captchaCode,
    }),
  });

  const raw = await loginRes.text();
  let data: {
    success?: boolean;
    message?: string;
    details?: { captcha_error?: boolean };
  };
  try {
    data = JSON.parse(raw);
  } catch {
    data = { success: false, message: "pinglian.lol 登录接口返回异常" };
  }

  if (data.success !== true) {
    // 验证码错误/过期：HTTP 400 + error_type=VALIDATION + details.captcha_error
    const captchaError =
      data?.details?.captcha_error === true || /验证码/.test(String(data.message ?? ""));
    return {
      ok: false,
      message: data.message || "登录失败，请检查账号密码",
      captchaError,
    };
  }

  // 3) 合并登录后的 Set-Cookie（会话可能被重新签发）
  jar = mergeCookie(jar, parseSetCookies(loginRes));
  return { ok: true, cookie: jar };
}

// 退出站点会话（POST /api/auth/logout）。失败不阻断本地解绑。
async function logoutSite(cookie: string): Promise<void> {
  try {
    await fetch(`${PINGLIAN_BASE}/api/auth/logout`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Cookie: cookie,
        Referer: `${PINGLIAN_BASE}/`,
        Origin: PINGLIAN_BASE,
      },
    });
  } catch {
    /* 站点不可达时忽略，本地仍解绑 */
  }
}

// ---------- 会话失效检测 ----------

const AUTH_REQUIRED = "ADMIN_AUTH_REQUIRED";

/**
 * 判定站点响应是否表示会话已失效。
 * 依据（按文档 §0）：
 *  1. HTTP 401（站点统一用 401 表达未登录）
 *  2. JSON 中 error_type === 'ADMIN_AUTH_REQUIRED'（最确凿信号）
 *  3. JSON success=false 且 message 含登录语义关键词（兼容旧版无 error_type）
 *  4. 200 + text/html 且为登录页
 * 说明：5xx/429、空 body、非登录页 HTML 一律视为站点繁忙/异常，不判定过期。
 */
async function isSessionExpired(res: Response): Promise<boolean> {
  if (res.status === 401) return true;

  const ct = res.headers.get("content-type") ?? "";
  const text = await res.clone().text();
  const trimmed = text.trim();

  if (ct.includes("text/html")) {
    return /login|请先登录|账号登录/i.test(text.slice(0, 3000));
  }

  if (!trimmed) return false;

  try {
    const data = JSON.parse(trimmed);
    if (!data) return false;
    if (data.error_type === AUTH_REQUIRED) return true;
    if (
      data.success === false &&
      /登录|未登录|请先登录|login|auth/i.test(String(data.message ?? ""))
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// ---------- 统一转发 ----------

type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * 对站点发起请求并返回原始 Response（不吞 body）。
 * cookie 为空串时不带 Cookie 头（仅匿名可达接口如 status 会出现该情况）。
 */
async function proxy(
  method: Method,
  path: string,
  cookie: string,
  payload?: { form?: string; json?: string }
): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Referer: `${PINGLIAN_BASE}/`,
  };
  if (cookie) headers.Cookie = cookie;
  if (payload?.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (payload?.json) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${PINGLIAN_BASE}${path}`, {
    method,
    headers,
    body: payload?.form || payload?.json || undefined,
    redirect: "follow",
  });

  if (!res.ok) {
    // 400/401/404 交由调用方按业务语义处理（会话过期 / 无变化修改 / 旧 ID 失效）
    if (res.status === 400 || res.status === 401 || res.status === 404) return res;
    throw new Error(
      res.status >= 500 || res.status === 429
        ? `盘链站点繁忙（HTTP ${res.status}），请稍后重试`
        : `盘链站点返回异常（HTTP ${res.status}）`
    );
  }
  return res;
}

// 站点对「无任何变化」的修改返回 400 VALIDATION（「…均未修改，无需保存」）。
// 语义上等同保存成功（幂等），必须归一化为成功，否则用户保存未影响站点字段
// 的内容时会被误报「盘链站点返回异常（HTTP 400）」。
async function isNoopUpdate(res: Response): Promise<boolean> {
  if (res.status !== 400) return false;
  const d = await res.clone().json().catch(() => null);
  return !!(d && d.success === false && /未修改|无需保存/.test(String(d.message ?? "")));
}

// ---------- 旧 link_id 自动迁移 ----------

// 站点升级后旧系统时期的 link_id 在新接口全部 404；新数据保留了
// source_link_id（= 旧系统 link_id）。按 source_link_id 在用户自己的发布列表
// 中查找旧 ID 对应的新 ID：
//  1) 先用当前标题做服务端搜索（资源未改名时站点标题与我们一致，通常 1 次命中）
//  2) 未命中再全量翻页扫描（page_size=200，最多 40 页；列表非严格 id 排序，
//     不能假设旧数据集中在某几页）
async function findLinkBySourceId(
  cookie: string,
  oldId: number,
  currentTitle?: string
): Promise<number | null> {
  if (currentTitle && currentTitle.trim()) {
    try {
      const sr = await proxy(
        "GET",
        `/api/videos/links?search=${encodeURIComponent(currentTitle.trim())}&page=1&page_size=200`,
        cookie
      );
      if (sr.ok) {
        const sd = await sr.json().catch(() => null);
        const hit = (sd?.data?.list ?? []).find(
          (l: Record<string, unknown>) =>
            String(l.source_link_id ?? "") === String(oldId)
        );
        if (hit) return Number(hit.id);
      }
    } catch {
      /* 搜索失败则继续全量扫描 */
    }
  }
  let page = 1;
  const maxPages = 40;
  let seen = 0;
  let total = Number.POSITIVE_INFINITY;
  while (page <= maxPages && seen < total) {
    const r = await proxy(
      "GET",
      `/api/videos/links?page=${page}&page_size=200`,
      cookie
    );
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    const list: Record<string, unknown>[] = d?.data?.list ?? [];
    if (!Array.isArray(list) || list.length === 0) return null;
    const hit = list.find(
      (l) => String(l.source_link_id ?? "") === String(oldId)
    );
    if (hit) return Number(hit.id);
    const ps = Number(d?.data?.page_size) || 200;
    total = Number(d?.data?.total) || 0;
    seen += list.length;
    if (list.length < ps) return null; // 已到最后一页
    page += 1;
  }
  return null;
}

/**
 * 换取链接真实地址：link-ticket 领票 → link-open 解出 url。
 * 站点对「他人链接」不在响应里直出 url，必须走这条链路。
 */
async function resolveRealUrl(
  cookie: string,
  linkId: number
): Promise<{ ok: boolean; url?: string; message?: string; status: number }> {
  const tr = await proxy("POST", "/api/videos/link-ticket", cookie, {
    json: JSON.stringify({ link_id: linkId }),
  });

  if (await isSessionExpired(tr)) return { ok: false, status: 401, message: "会话已过期" };

  const td = await tr.json().catch(() => null);
  if (!tr.ok || td?.success === false) {
    return {
      ok: false,
      status: tr.status,
      message: String(td?.message ?? `领取打开票失败（HTTP ${tr.status}）`),
    };
  }

  const ticket = String(td?.data?.ticket ?? "");
  if (!ticket) return { ok: false, status: 502, message: "站点未返回打开票" };

  const or = await proxy(
    "GET",
    `/api/videos/link-open/${linkId}?t=${encodeURIComponent(ticket)}`,
    cookie
  );

  if (await isSessionExpired(or)) return { ok: false, status: 401, message: "会话已过期" };

  const od = await or.json().catch(() => null);
  if (!or.ok || od?.success === false) {
    return {
      ok: false,
      status: or.status,
      message: String(od?.message ?? `解出真实地址失败（HTTP ${or.status}）`),
    };
  }

  const realUrl = String(od?.data?.url ?? "");
  if (!realUrl) return { ok: false, status: 502, message: "站点未返回真实地址" };
  return { ok: true, url: realUrl, status: 200 };
}

// ---------- 主入口 ----------

Deno.serve(async (req) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---------- 1. 验证 Supabase 登录态 ----------
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // 鉴权：用户 JWT，或服务端 worker/定时任务的内部通道
    //（x-internal-secret + x-user-id，见 _shared/internalAuth.ts；未配置密钥时该通道关闭）
    const callerId = await resolveCallerId(req, async (t) => {
      const { data, error } = await supabase.auth.getUser(t);
      return error ? null : (data?.user?.id ?? null);
    });
    if (!callerId) {
      return json({ error: "登录态无效" }, 401);
    }
    const user = { id: callerId };

    const url = new URL(req.url);
    const action = (url.searchParams.get("action") ?? "").trim();
    const now = new Date().toISOString();

    // ---------- 2. action=captcha：获取站点图形验证码（登录前置） ----------
    // 站点 2026-09-27 起登录新增图形验证码：先取 id + 图片，识别后连同账号密码一并提交。
    if (action === "captcha") {
      if (req.method !== "GET" && req.method !== "POST") {
        return json({ error: "captcha 需要 GET 或 POST 请求" }, 405);
      }
      const captcha = await fetchSiteCaptcha();
      if (!captcha.ok) {
        return json(
          { success: false, message: captcha.message || "获取图形验证码失败" },
          502
        );
      }
      return json({
        success: true,
        data: { id: captcha.id, image: captcha.image, ttl: captcha.ttl },
      });
    }

    // ---------- 3. action=login：账号密码 + 图形验证码登录并绑定 ----------
    if (action === "login") {
      if (req.method !== "POST") {
        return json({ error: "login 需要 POST 请求" }, 405);
      }
      const { username, password, captcha_id, captcha_code } = await req
        .json()
        .catch(() => ({}));
      if (!username || !password) {
        return json({ error: "请输入 pinglian.lol 的账号和密码" }, 400);
      }
      if (!captcha_id || !captcha_code) {
        return json(
          {
            success: false,
            code: "PINGLIAN_CAPTCHA_ERROR",
            message: "请输入图形验证码后重试",
          },
          400
        );
      }

      const result = await loginWithPassword(
        String(username).trim(),
        String(password),
        String(captcha_id),
        String(captcha_code).trim()
      );
      if (!result.ok || !result.cookie) {
        return json(
          {
            success: false,
            // 验证码错误/过期时返回专用 code，前端据此自动换一张
            ...(result.captchaError ? { code: "PINGLIAN_CAPTCHA_ERROR" } : {}),
            message: result.message || "登录失败，请检查账号密码",
          },
          result.captchaError ? 400 : 401
        );
      }

      await supabase.from("pinglian_sessions").upsert(
        {
          user_id: user.id,
          username: String(username).trim(),
          cookie: result.cookie,
          remark: String(username).trim(),
          status: "active",
          last_check_at: now,
          updated_at: now,
        },
        { onConflict: "user_id" }
      );

      return json({ success: true, message: "盘链账号登录成功" });
    }

    // ---------- 3. 读取该用户绑定的站点 Cookie ----------
    const { data: session } = await supabase
      .from("pinglian_sessions")
      .select("cookie, status")
      .eq("user_id", user.id)
      .maybeSingle();

    const cookie: string = session?.cookie ?? "";
    const isAnonAction = ANON_SITE_ACTIONS.has(action);

    // ---------- 4. action=logout：退出站点会话并解绑 ----------
    if (action === "logout") {
      if (cookie) await logoutSite(cookie);
      await supabase.from("pinglian_sessions").delete().eq("user_id", user.id);
      return json({ success: true, message: "已解绑盘链账号" });
    }

    // 先校验 action 合法性，避免「非法 action」被后面的绑定检查误报为「未绑定账号」
    const KNOWN_ACTIONS = new Set([
      "login", "logout", "status",
      "list", "search", "detail", "add", "update", "delete",
      "quota", "ticket", "open", "resolve", "infer",
      "videos", "video", "types", "filters", "home",
      // 群组（「同时发送到群组」用）
      "share-targets", "group-send",
    ]);
    if (!KNOWN_ACTIONS.has(action)) {
      return json({ error: `不支持的 action: ${action}` }, 400);
    }

    // 除站点匿名可达的 action 外，必须已绑定站点账号
    if (!isAnonAction && !cookie) {
      return json(
        { error: "未绑定 pinglian.lol 账号，请先在设置页登录绑定盘链账号" },
        400
      );
    }

    // ---------- 5. 路由解析 ----------
    // 仅 POST/PUT 读取 JSON body（GET/DELETE 不读，避免站点对 DELETE 携带 body 报错）
    const body: Record<string, unknown> =
      req.method === "POST" || req.method === "PUT"
        ? await req.json().catch(() => ({}))
        : {};

    const qp = (k: string, fallback = "") => url.searchParams.get(k) ?? fallback;

    let targetPath: string | null = null;
    let method: Method = "GET";
    let payload: { form?: string; json?: string } | undefined;
    // update 专用：记录旧 link_id 与完整 payload，供 404 自动迁移重试使用
    let updateCtx: {
      oldId: number;
      title: string;
      payload: { json: string };
    } | null = null;

    switch (action) {
      // ---- 会话状态 ----
      case "status":
        targetPath = "/api/auth/status";
        break;

      // ---- 群组（对接文档 §二）----
      case "share-targets": {
        // 可同步群组列表：data:{ groups:[{id,name,is_official,selectable,hint}], official }
        targetPath = "/api/chat-groups/share-targets";
        break;
      }
      case "group-send": {
        // 群组内发链接：POST /api/chat-groups/{groupId}/messages/link { link_id }
        const gid = String(body.group_id ?? qp("group_id") ?? "").trim();
        const gLinkId = Number(body.link_id ?? 0);
        if (!gid) return json({ error: "发送群组需要 group_id" }, 400);
        if (!gLinkId) return json({ error: "发送群组需要有效的 link_id" }, 400);
        targetPath = `/api/chat-groups/${encodeURIComponent(gid)}/messages/link`;
        method = "POST";
        payload = { json: JSON.stringify({ link_id: gLinkId }) };
        break;
      }

      // ---- 我的链接（读）----
      case "list": {
        // 支持分页 / 搜索 / pan_type 过滤（文档 §3.1）
        const page = qp("page", "1");
        const pageSize = qp("page_size", "200");
        const kw = qp("search") || qp("keyword");
        const type = qp("type");
        const qs = new URLSearchParams({ page, page_size: pageSize });
        if (kw) qs.set("search", kw);
        if (type) qs.set("type", type);
        targetPath = `/api/videos/links?${qs.toString()}`;
        break;
      }
      case "search": {
        // 服务端搜索：突破 list 单页 200 条上限（发布量大的用户首屏不全）
        const kw = qp("search") || qp("keyword");
        targetPath = kw
          ? `/api/videos/links?search=${encodeURIComponent(kw)}&page=1&page_size=200`
          : "/api/videos/links?page=1&page_size=200";
        break;
      }
      case "detail": {
        const linkId = Number(qp("link_id") || String(body.link_id ?? ""));
        if (!linkId) {
          return json({ error: "查询盘链详情需要有效的 link_id" }, 400);
        }
        targetPath = `/api/videos/links/${linkId}`;
        break;
      }

      // ---- 我的链接（写）----
      case "add": {
        const videoId = Number(body.vod_id ?? 0);
        if (!videoId) {
          return json({ error: "新增盘链需要有效的 vod_id（站点视频 ID）" }, 400);
        }
        const addJson: Record<string, string> = {
          url: String(body.link_url ?? ""),
          title: String(body.link_title ?? ""),
          pan_type: normalizePanType(body.pan_type, body.link_url),
          password: String(body.link_password ?? ""),
        };
        // note 非文档必填字段，仅在非空时提交，避免覆盖站点默认值
        const addNote = typeof body.note === "string" ? body.note.trim() : "";
        if (addNote) addJson.note = addNote;
        targetPath = `/api/videos/${videoId}/links`;
        method = "POST";
        payload = { json: JSON.stringify(addJson) };
        break;
      }
      case "update": {
        const linkId = Number(body.link_id ?? 0);
        if (!linkId) {
          return json({ error: "修改盘链需要有效的 link_id" }, 400);
        }
        const updateJson: Record<string, string> = {
          url: String(body.link_url ?? ""),
          title: String(body.link_title ?? ""),
          pan_type: normalizePanType(body.pan_type, body.link_url),
          password: String(body.link_password ?? ""),
        };
        // 空 note 会清空站点备注，故仅在非空时提交
        const note = typeof body.note === "string" ? body.note.trim() : "";
        if (note) updateJson.note = note;
        targetPath = `/api/videos/links/${linkId}`;
        method = "PUT";
        payload = { json: JSON.stringify(updateJson) };
        updateCtx = {
          oldId: linkId,
          title: String(body.link_title ?? ""),
          payload: { json: JSON.stringify(updateJson) },
        };
        break;
      }
      case "delete": {
        const linkId = Number(qp("link_id") || String(body.link_id ?? ""));
        if (!linkId) {
          return json({ error: "删除盘链需要有效的 link_id" }, 400);
        }
        // 文档 §3.5：DELETE 无 Body
        targetPath = `/api/videos/links/${linkId}`;
        method = "DELETE";
        payload = undefined;
        break;
      }

      // ---- 配额 ----
      case "quota":
        targetPath = "/api/videos/link-quota";
        break;

      // ---- 播放链路 ----
      case "ticket": {
        const linkId = Number(String(body.link_id ?? "") || qp("link_id"));
        if (!linkId) {
          return json({ error: "领取打开票需要有效的 link_id" }, 400);
        }
        targetPath = "/api/videos/link-ticket";
        method = "POST";
        payload = { json: JSON.stringify({ link_id: linkId }) };
        break;
      }
      case "open": {
        const linkId = Number(qp("link_id") || String(body.link_id ?? ""));
        const ticket = qp("ticket") || qp("t") || String(body.ticket ?? "");
        if (!linkId || !ticket) {
          return json({ error: "解出真实地址需要 link_id 与 ticket" }, 400);
        }
        targetPath = `/api/videos/link-open/${linkId}?t=${encodeURIComponent(ticket)}`;
        break;
      }
      case "resolve": {
        // 一步到位：领票 + 解地址（站点对他人链接不直出 url）
        const linkId = Number(qp("link_id") || String(body.link_id ?? ""));
        if (!linkId) {
          return json({ error: "换取真实地址需要有效的 link_id" }, 400);
        }
        const r = await resolveRealUrl(cookie, linkId);
        if (r.status === 401) {
          await supabase
            .from("pinglian_sessions")
            .update({ status: "expired", last_check_at: now })
            .eq("user_id", user.id);
          return json(
            {
              success: false,
              code: "PINGLIAN_COOKIE_EXPIRED",
              message: "盘链登录已过期，请在设置页重新登录盘链账号",
            },
            401
          );
        }
        if (!r.ok) {
          return json({ success: false, message: r.message }, r.status);
        }
        await supabase
          .from("pinglian_sessions")
          .update({ status: "active", last_check_at: now })
          .eq("user_id", user.id);
        return json({ success: true, data: { url: r.url } });
      }
      case "infer": {
        const inferUrl = String(body.url ?? "");
        if (!inferUrl) {
          return json({ error: "自动识别需要提供 url" }, 400);
        }
        targetPath = "/api/videos/link-infer";
        method = "POST";
        payload = {
          json: JSON.stringify({
            url: inferUrl,
            password: String(body.password ?? body.link_password ?? ""),
          }),
        };
        break;
      }

      // ---- 片源 ----
      case "videos": {
        // 透传白名单查询参数
        const allow = ["search", "sort", "page", "page_size", "group", "type", "year", "area", "lang"];
        const qs = new URLSearchParams();
        for (const k of allow) {
          const v = url.searchParams.get(k);
          if (v) qs.set(k, v);
        }
        targetPath = `/api/videos${qs.toString() ? `?${qs.toString()}` : ""}`;
        break;
      }
      case "video": {
        const id = Number(qp("id") || qp("video_id") || 0);
        if (!id) return json({ error: "查询片源详情需要有效的 id" }, 400);
        targetPath = `/api/videos/${id}`;
        break;
      }
      case "types":
        targetPath = "/api/videos/types";
        break;
      case "filters":
        targetPath = "/api/videos/filters";
        break;
      case "home": {
        const limit = qp("limit", "12");
        targetPath = `/api/home?limit=${encodeURIComponent(limit)}`;
        break;
      }

      default:
        return json({ error: `不支持的 action: ${action}` }, 400);
    }

    // ---------- 6. 转发 ----------
    const res = await proxy(method, targetPath, cookie, payload);

    // ---------- 7. 会话失效检测 ----------
    const expired = await isSessionExpired(res);

    if (expired) {
      await supabase
        .from("pinglian_sessions")
        .update({ status: "expired", last_check_at: now })
        .eq("user_id", user.id);

      return json(
        {
          success: false,
          code: "PINGLIAN_COOKIE_EXPIRED",
          message: "盘链登录已过期，请在设置页重新登录盘链账号",
        },
        401
      );
    }

    // ---------- 8. update 语义处理 ----------
    if (updateCtx) {
      // 8a. 无变化的修改返回 400「…未修改，无需保存」→ 归一化为成功（幂等）
      if (await isNoopUpdate(res)) {
        await supabase
          .from("pinglian_sessions")
          .update({ status: "active", last_check_at: now })
          .eq("user_id", user.id);
        return json({ success: true, data: { id: updateCtx.oldId }, noop: true });
      }

      // 8b. 404：站点改版导致旧系统 link_id 失效 → 按 source_link_id 自动迁移
      if (res.status === 404) {
        // 仅自动迁移改版日（2026-09-10）前创建的绑定，避免误改新绑定
        const { data: legacyRows } = await supabase
          .from("resource_bindings")
          .select("id")
          .eq("link_id", updateCtx.oldId)
          .lt("created_at", "2026-09-10T00:00:00Z")
          .limit(1);

        if (legacyRows && legacyRows.length > 0) {
          const newId = await findLinkBySourceId(
            cookie,
            updateCtx.oldId,
            updateCtx.title
          );
          if (newId) {
            const retry = await proxy(
              "PUT",
              `/api/videos/links/${newId}`,
              cookie,
              updateCtx.payload
            );
            if (await isSessionExpired(retry)) {
              await supabase
                .from("pinglian_sessions")
                .update({ status: "expired", last_check_at: now })
                .eq("user_id", user.id);
              return json(
                {
                  success: false,
                  code: "PINGLIAN_COOKIE_EXPIRED",
                  message: "盘链登录已过期，请在设置页重新登录盘链账号",
                },
                401
              );
            }
            if (retry.ok || (await isNoopUpdate(retry))) {
              await supabase
                .from("pinglian_sessions")
                .update({ status: "active", last_check_at: now })
                .eq("user_id", user.id);
              // 服务端把本地绑定迁移到新 ID（仅限改版前的旧绑定），下次同步直接命中
              await supabase
                .from("resource_bindings")
                .update({ link_id: newId })
                .eq("link_id", updateCtx.oldId)
                .lt("created_at", "2026-09-10T00:00:00Z");
              const d = await retry.json().catch(() => null);
              return json(d ?? { success: true, data: { id: newId } });
            }
            if (retry.status === 400) {
              // 迁移后的 ID 提交仍 400（非无变化）：透传站点校验信息
              const bd = await retry.json().catch(() => null);
              return json(
                bd ?? { success: false, message: "盘链站点返回异常（HTTP 400）" }
              );
            }
            // 迁移后又被删除等场景：按绑定失效处理
          }
        }
        return json(
          {
            success: false,
            code: "PINGLIAN_LINK_NOT_FOUND",
            message: "该盘链绑定在站点已失效（站点已升级改版），请解绑后重新绑定",
          },
          404
        );
      }
    }

    // ---------- 9. 有效：刷新状态 + 回传站点 JSON ----------
    if (cookie) {
      await supabase
        .from("pinglian_sessions")
        .update({ status: "active", last_check_at: now })
        .eq("user_id", user.id);
    }

    const data = await res.json();

    // ---------- 10. 分享到站点后「同时发送到群组」（对接文档 §二 / §四）----------
    // 选择存在 pinglian_sessions.sync_group_ids；只对 add / update 生效；
    // body.send_groups === false 可单次关闭（前端「只发站点不发群」的场景）。
    let groupResults: Array<Record<string, unknown>> | null = null;
    if ((action === "add" || action === "update") && cookie && body.send_groups !== false) {
      const { data: sess } = await supabase
        .from("pinglian_sessions")
        .select("sync_group_enabled, sync_group_ids")
        .eq("user_id", user.id)
        .maybeSingle();
      const gids = sess?.sync_group_enabled
        ? ((sess.sync_group_ids ?? []) as string[]).map(String).filter(Boolean)
        : [];
      if (gids.length > 0) {
        // 从站点响应里取新建/更新后的 link_id（兼容 data.id / data.link.id 等包裹）
        const pickLinkId = (v: unknown, depth = 0): number => {
          if (!v || typeof v !== "object" || depth > 3) return 0;
          const o = v as Record<string, unknown>;
          for (const k of ["id", "link_id"]) {
            const n = Number(o[k]);
            if (Number.isFinite(n) && n > 0) return n;
          }
          for (const k of ["data", "link", "result"]) {
            const n = pickLinkId(o[k], depth + 1);
            if (n) return n;
          }
          return 0;
        };
        const linkId = pickLinkId(data) || Number(body.link_id ?? 0);
        groupResults = [];
        if (!linkId) {
          groupResults.push({ group_id: "", ok: false, message: "未取到 link_id，未发送群组" });
        } else {
          for (const gid of gids) {
            try {
              const gr = await proxy(
                "POST",
                `/api/chat-groups/${encodeURIComponent(gid)}/messages/link`,
                cookie,
                { json: JSON.stringify({ link_id: linkId }) }
              );
              const gb = (await gr.json().catch(() => null)) as { message?: string } | null;
              groupResults.push({
                group_id: gid,
                ok: gr.ok,
                message: gb?.message ?? (gr.ok ? "已发送" : `HTTP ${gr.status}`),
              });
            } catch (e) {
              groupResults.push({
                group_id: gid,
                ok: false,
                message: e instanceof Error ? e.message : String(e),
              });
            }
          }
          if (groupResults.some((r) => r.ok)) {
            const okCount = groupResults.filter((r) => r.ok).length;
            console.log(`[pinglian] 已同步到群组 ${okCount}/${groupResults.length}`);
          }
        }
      }
    }

    return json(
      groupResults ? { ...(data as Record<string, unknown>), group_results: groupResults } : data
    );
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : String(e) },
      500
    );
  }
});

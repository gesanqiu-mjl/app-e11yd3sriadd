/**
 * shortlink-api: 短链开放接口（API Key 鉴权，调用方无需登录本应用）
 *
 * 为什么单独做一个函数：
 *   短链生成此前只能走「批量发帖」（batch-post，需要账号登录态 JWT + 批量发帖权限）。
 *   插件 / 脚本只想把网盘链接换成短链时，不必也不应该拿到发帖能力 —— 这里只做短链，
 *   鉴权用 API Key（X-API-Key: rk_xxx），与「API 管理」里创建的密钥一一对应；
 *   短链按密钥归属账号隔离（同账号同链接复用，不跨账号）。
 *
 * 鉴权（二选一）：
 *   1) API Key：请求头 X-API-Key: rk_xxx（也支持 ?key=rk_xxx，便于浏览器直接打开）。
 *      密钥由「管理后台 → API 管理」创建并绑定归属账号，停用 / 过期立即失效。
 *   2) 用户登录态：Authorization: Bearer <access_token>（与 resource-api 一致，等价于「仅归属账号」）。
 *
 * 路由：
 *   POST /shortlink-api            生成 / 复用短链（等价 /create、/shortlinks）
 *   GET|POST /shortlink-api/resource  按「资源」查询并补齐短链（新增资源已由数据库触发器
 *                                     自动生成，归属资源所有者；这里返回的是**调用方账号**名下的短链，
 *                                     缺失即生成 —— 谁调用，点击就算谁的）
 *   GET  /shortlink-api            （等价 /me）自检：密钥、归属账号、短链数量
 *   GET  /shortlink-api/me         自检
 *   GET  /shortlink-api/list       本账号短链列表（keyword / resource_id / only_resource / since / limit / offset）
 *
 * POST 请求体（字段都可选，但 url / urls / text 至少要有一个）：
 *   url            单条网盘链接
 *   urls           多条链接数组
 *   text           一段正文：自动把里面的网盘链接换成短链，原样返回替换后的正文
 *   mode           path（默认）= 沿用原链接路径（分享出去只有域名不同）；short = 随机短码
 *   prefix         自定义短码前缀（1~4 位小写字母 / 数字，默认按网盘自动取 g / q / x）
 *   title          标题（单条时用；缺省为原链接）
 *   channel        渠道标记：只写进短链行（点击统计照样按渠道区分），**不拼到 URL 上**，
 *                  分享出去的短链因此是最短形态；需要临时换渠道时在 URL 上加 ?c= 即可（以 URL 为准）
 *   channel_in_url true 时才把 channel 拼成 ?c=<渠道>（默认 false，避免中文渠道名被 URL 编码后极长）
 *   resource_id    关联资源 ID（可选）
 *   extract_code   提取码（可选，访问时先显示提取码页）
 *   pan_name       网盘名称（可选）
 *   expires_at     到期时间：2026-12-31 / 2026-12-31T00:00:00Z / 7d / 12h / 30m（可选）
 *   reuse          默认 true：同账号同目标已有短链直接复用；显式 false = 每次都新建一条
 *
 * 响应统一为 { code, message, data }（code=0 成功，否则等于 HTTP 状态码）。
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const APP_URL = Deno.env.get("SUPABASE_URL")!;
const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
/** 短链对外域名（可选）：未配置时退回本项目函数地址 */
const SHORTLINK_BASE = (Deno.env.get("SHORTLINK_BASE") ?? "").trim().replace(/\/+$/, "");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

/** 短码字符集：去掉 0/o/1/l/i 等易混字符（与前端、batch-post 保持一致） */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function sendJson(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

const ok = (data: unknown) => sendJson({ code: 0, message: "ok", data });
const fail = (status: number, message: string) => sendJson({ code: status, message }, status);

// ── 短码生成 ──────────────────────────────────────────────

/** 随机短码：总长度 6，前缀占用几位，随机部分相应少几位 */
function randomCode(prefix = "", len = 6): string {
  const n = Math.max(1, len - prefix.length);
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

/** 己方域名（短链域名 / 站点域名 / 后端域名）：出现在正文里绝不能再「短链化」，否则自指 */
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

/** 网盘域名 → 短码标签（同路径短码撞车时用，兜底保证不同网盘互不覆盖） */
function hostTag(u: URL): string {
  const h = u.hostname.toLowerCase();
  if (h.includes("guangyapan")) return "gy";
  if (h.includes("quark")) return "qk";
  if (h.includes("xunlei")) return "xl";
  if (h.includes("baidu")) return "bd";
  if (h.includes("aliyundrive") || h.includes("alipan")) return "ali";
  if (h.includes("123pan")) return "123";
  if (h.includes("uc.cn")) return "uc";
  return (h.split(".").filter((x) => x && x !== "www")[0] ?? "pan").slice(0, 4);
}

/** 由目标链接推导「原链接路径」短码（分享出去只有域名不同、路径与原链接一致） */
function derivePathCode(targetUrl: string): string | null {
  try {
    const u = new URL(targetUrl.trim());
    const path = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    return path || null;
  } catch {
    return null;
  }
}

/** 带网盘标识的同路径短码（gy/s/…）：仅当纯路径短码已被别的目标占用时才用 */
function deriveTaggedPathCode(targetUrl: string): string | null {
  try {
    const u = new URL(targetUrl.trim());
    const path = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!path) return null;
    return `${hostTag(u)}/${path}`;
  } catch {
    return null;
  }
}

/**
 * 拼对外短链：有自有域名用域名，否则退回函数地址（两条前端/函数都能解析）。
 * 默认**不带渠道参数** —— 渠道存在短链行上，跳转打点会自动带上，URL 越短越好分享；
 * 只有显式 channel_in_url=true 时才拼 ?c=<渠道>（中文渠道名会被 URL 编码，变得很长）。
 */
function shortUrlOf(code: string, channel?: string | null, channelInUrl = false): string {
  const base = SHORTLINK_BASE || `${APP_URL}/functions/v1/go`;
  const path = code.includes("/") || base.endsWith("/go") ? `/${code}` : `/go/${code}`;
  const ch = channelInUrl ? (channel ?? "").trim() : "";
  return `${base}${path}${ch ? `?c=${encodeURIComponent(ch)}` : ""}`;
}

/** 解析 expires_at：支持 7d / 12h / 30m、YYYY-MM-DD、完整 ISO；无法解析返回 error */
function parseExpires(raw: unknown): { iso: string | null; error?: string } {
  if (raw === undefined || raw === null || raw === "") return { iso: null };
  if (typeof raw !== "string") return { iso: null, error: "expires_at 需要是字符串" };
  const v = raw.trim();
  const rel = /^(\d+)([dhm])$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === "d" ? n * 86400000 : unit === "h" ? n * 3600000 : n * 60000;
    return { iso: new Date(Date.now() + ms).toISOString() };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { iso: new Date(`${v}T23:59:59+08:00`).toISOString() };
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    return { iso: null, error: `expires_at 无法解析：${raw}（示例：2026-12-31 / 7d / 12h）` };
  }
  return { iso: d.toISOString() };
}

/** 正文里的链接提取：去掉中英文标点收尾，避免把句号/括号带进链接 */
const URL_RE = /https?:\/\/[^\s"'<>）】》]+/g;
function trimUrlPunct(s: string): string {
  return s.replace(/[),.;:!?，。；：！？、）》】"'」』]+$/u, "");
}

// ── 短链写入 ──────────────────────────────────────────────

interface CreateResult {
  id: string;
  code: string;
  target_url: string;
  short_url: string;
  reused: boolean;
}

type CreateOptions = {
  mode: "path" | "short";
  prefix?: string;
  title?: string;
  channel?: string | null;
  resourceId?: string | null;
  extractCode?: string | null;
  panName?: string | null;
  expiresAt?: string | null;
  reuse: boolean;
  /** 是否把 channel 拼成 ?c=（默认 false：渠道只在库里，短链保持最短） */
  channelInUrl?: boolean;
};

/** 取（或新建）短链；同账号 + 同目标已有则复用（reuse=true 时） */
async function createOne(
  svc: SupabaseClient,
  userId: string,
  targetUrl: string,
  opt: CreateOptions
): Promise<CreateResult> {
  const target = targetUrl.trim();
  if (!/^https?:\/\//i.test(target)) throw new Error(`目标链接需要以 http(s):// 开头：${target}`);

  if (opt.reuse) {
    const { data: existing } = await svc
      .from("short_links")
      .select("id, code, target_url, channel")
      .eq("user_id", userId)
      .eq("target_url", target)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; code: string; target_url: string; channel: string | null }>();
    if (existing?.code) {
      return {
        id: existing.id,
        code: existing.code,
        target_url: existing.target_url,
        short_url: shortUrlOf(existing.code, existing.channel ?? opt.channel, opt.channelInUrl),
        reused: true,
      };
    }
  }

  const customPrefix = /^[a-z0-9]{1,4}$/.test(opt.prefix ?? "") ? (opt.prefix as string) : "";
  const prefix = customPrefix || panPrefixOf(target);
  const pathCode = opt.mode === "path" ? derivePathCode(target) : null;
  const taggedCode = opt.mode === "path" ? deriveTaggedPathCode(target) : null;

  const row = {
    user_id: userId,
    title: (opt.title ?? "").trim() || target,
    target_url: target,
    extract_code: opt.extractCode?.trim() || null,
    pan_name: opt.panName?.trim() || null,
    resource_id: opt.resourceId || null,
    channel: opt.channel?.trim() || null,
    expires_at: opt.expiresAt || null,
  };

  // 首次「原链接路径」→ 撞车则带网盘标识的同路径 → 再撞车退化为随机短码
  for (let attempt = 0; attempt < 4; attempt++) {
    const code =
      attempt === 0 ? (customPrefix ? randomCode(customPrefix) : pathCode ?? randomCode(prefix))
      : attempt === 1 ? (customPrefix ? randomCode(customPrefix) : taggedCode ?? randomCode(prefix))
      : attempt === 2 ? randomCode(prefix)
      : randomCode(prefix, 8);

    const { data, error } = await svc
      .from("short_links")
      .insert({ ...row, code })
      .select("id, code, target_url, channel")
      .single<{ id: string; code: string; target_url: string; channel: string | null }>();

    if (!error && data) {
      return {
        id: data.id,
        code: data.code,
        target_url: data.target_url,
        short_url: shortUrlOf(data.code, data.channel, opt.channelInUrl),
        reused: false,
      };
    }
    // 23505 = 短码已存在 → 换一个再试
    if ((error as { code?: string } | null)?.code !== "23505") {
      throw new Error(error?.message ?? "短链写入失败");
    }
  }
  throw new Error("短码生成失败，请重试");
}

// ── 资源相关（新增资源自动有短链 + 按资源查询）────────────────

/** 资源链接的网盘类型：夸克 / 光鸭（与内置订阅源 RPC 的判断保持一致） */
function panOfLink(url: string, panName?: string | null): "quark" | "guangya" {
  const n = (panName ?? "").trim();
  const u = url.toLowerCase();
  if (n.includes("夸克") || /(pan\.quark\.cn|drive\.uc\.cn)/.test(u)) return "quark";
  if (n.includes("光鸭") || u.includes("guangyapan.com")) return "guangya";
  return "guangya";
}

interface ShortLinkRow {
  id: string;
  code: string;
  target_url?: string;
  channel?: string | null;
}

/**
 * 确保「某账号 + 某个目标链接」存在短链（存在即复用，否则新建）。
 * 与数据库触发器（00071 ensure_short_links_for_resource 归属资源所有者）的区别：
 * 这里归属**调用方账号** —— 谁调接口，点击就算谁的。
 */
async function ensureSimpleShortLink(
  svc: SupabaseClient,
  userId: string,
  target: string,
  meta: { title?: string; panName?: string | null; resourceId?: string | null; channel?: string | null; channelInUrl?: boolean }
): Promise<ShortLinkRow & { reused: boolean }> {
  const t = target.trim();
  if (!/^https?:\/\//i.test(t)) throw new Error(`目标链接需要以 http(s):// 开头：${t}`);

  const { data: exist } = await svc
    .from("short_links")
    .select("id, code, target_url, channel")
    .eq("user_id", userId)
    .eq("target_url", t)
    .order("created_at", { ascending: false })
    .limit(1);
  const hit = (exist ?? [])[0] as ShortLinkRow | undefined;
  if (hit?.code) return { ...hit, reused: true };

  for (let attempt = 0; attempt < 4; attempt++) {
    const code = randomCode(panPrefixOf(t));
    const { data, error } = await svc
      .from("short_links")
      .insert({
        user_id: userId,
        code,
        title: (meta.title ?? "").trim() || t,
        target_url: t,
        pan_name: meta.panName?.trim() || null,
        resource_id: meta.resourceId ?? null,
        channel: meta.channel?.trim() || null,
      })
      .select("id, code, target_url, channel")
      .single<ShortLinkRow>();
    if (!error && data) return { ...data, reused: false };
    if ((error as { code?: string } | null)?.code !== "23505") {
      throw new Error(error?.message ?? "短链写入失败");
    }
  }
  throw new Error("短码生成失败，请重试");
}

// ── 入口 ──────────────────────────────────────────────────

type ApiKeyRow = {
  id: string | null;
  name: string;
  is_active: boolean;
  expires_at: string | null;
  call_count: number;
  created_at: string;
  owner_id: string;
  scope?: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET" && req.method !== "POST") return fail(405, "仅支持 GET / POST 请求");

  const url = new URL(req.url);
  const svc = createClient(APP_URL, SVC_KEY, { auth: { persistSession: false } });

  // ── 1. 路由 ──
  const seg = (url.pathname.replace(/\/+$/, "").split("/").pop() ?? "").toLowerCase();
  const KNOWN = ["shortlink-api", "shortlink", "shortlinks", "create", "me", "list", "resource", "resources"];
  if (!KNOWN.includes(seg)) {
    return fail(
      404,
      `未知接口 /${seg}，可用：POST /shortlink-api（生成短链）、GET|POST /shortlink-api/resource（按资源查询/补齐）、` +
        `GET /shortlink-api/me（自检）、GET /shortlink-api/list（列表）`
    );
  }
  const isList = seg === "list";
  const isResource = seg === "resource" || seg === "resources";
  const isCreate = req.method === "POST" && !isResource;
  if (isList && req.method !== "GET") return fail(405, "/list 仅支持 GET");

  // ── 2. 鉴权：API Key（第三方程序）或 用户登录态 Bearer Token ──
  const rawKey = (
    req.headers.get("x-api-key") ??
    url.searchParams.get("key") ??
    url.searchParams.get("api_key") ??
    ""
  ).trim();
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

  let authMode: "api_key" | "user" = "api_key";
  let keyRow: ApiKeyRow | null = null;

  if (rawKey) {
    if (!/^rk_[A-Za-z0-9]{16,}$/.test(rawKey)) {
      return fail(401, "API Key 格式不正确（应为 rk_ 开头的密钥）");
    }
    const { data, error: keyErr } = await svc
      .from("api_keys")
      .select("id, name, is_active, expires_at, call_count, created_at, owner_id, scope")
      .eq("api_key", rawKey)
      .maybeSingle<ApiKeyRow>();
    if (keyErr) return fail(500, `鉴权服务异常：${keyErr.message}`);
    if (!data) return fail(401, "API Key 无效");
    if (!data.is_active) return fail(403, "API Key 已停用，请联系管理员");
    if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
      return fail(403, `API Key 已于 ${data.expires_at} 过期，请联系管理员`);
    }
    if (!data.owner_id) return fail(403, "该密钥未绑定归属账号，请联系管理员重新创建");
    keyRow = data;
  } else if (bearer) {
    const { data: userData, error: userErr } = await svc.auth.getUser(bearer);
    if (userErr || !userData?.user?.id) {
      return fail(401, "登录态无效或已过期，请重新登录后再试");
    }
    authMode = "user";
    keyRow = {
      id: null,
      name: "用户登录态",
      is_active: true,
      expires_at: null,
      call_count: 0,
      created_at: new Date().toISOString(),
      owner_id: userData.user.id,
      scope: "owner",
    };
  } else {
    return fail(
      401,
      "缺少凭据：请带请求头 X-API-Key: rk_xxx（或 ?key=rk_xxx），或在「API 管理」创建密钥"
    );
  }
  if (!keyRow) return fail(401, "鉴权失败");

  // ── 3. 限流（公开接口，被刷时保护数据库与函数配额；限流故障时放行）──
  try {
    const { data: globalOk } = await svc.rpc("rate_limit_hit", {
      p_bucket: "shortlink-api:global", p_window_seconds: 60, p_limit: 3000,
    });
    if (globalOk === false) return fail(429, "请求过于频繁，请稍后再试");
    const { data: keyOk } = await svc.rpc("rate_limit_hit", {
      p_bucket: `shortlink-api:${keyRow.owner_id}`, p_window_seconds: 60, p_limit: 600,
    });
    if (keyOk === false) return fail(429, "该密钥请求过于频繁（上限 600 次/分钟），请稍后再试");
  } catch { /* 限流设施异常 → 放行 */ }

  // 调用计数与来源 IP（仅 API Key 计数）
  if (authMode === "api_key" && keyRow.id) {
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
    try {
      await svc.rpc("touch_api_key", { p_id: keyRow.id, p_ip: ip });
    } catch { /* 计数失败忽略 */ }
  }

  // ── 4. 归属账号与其权限（短链只有开通「短链管理」的账号可用）──
  const { data: accountRow } = await svc
    .from("profiles")
    .select("id, username, email, status, can_shortlink, subscription_only")
    .eq("id", keyRow.owner_id)
    .maybeSingle<{
      id: string; username: string | null; email: string | null; status: string | null;
      can_shortlink: boolean | null; subscription_only: boolean | null;
    }>();
  if (!accountRow) return fail(403, "密钥归属账号不存在，请联系管理员重新创建密钥");
  if (accountRow.status === "disabled") return fail(403, "归属账号已被禁用，请联系管理员");
  if (accountRow.subscription_only === true || accountRow.can_shortlink === false) {
    return fail(403, "归属账号未开通「短链管理」功能，请联系管理员在后台开通");
  }
  const ownerId: string = keyRow.owner_id;
  const accountName = accountRow.username ?? accountRow.email ?? null;

  // ── 5. 自检（GET /shortlink-api 或 /me；/resource 与 /list 各有专门分支）──
  if (!isCreate && !isList && !isResource) {
    const { count } = await svc
      .from("short_links")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId);
    return ok({
      auth: authMode,
      name: keyRow.name,
      key: authMode === "api_key" ? `${rawKey.slice(0, 8)}…${rawKey.slice(-4)}` : null,
      is_active: keyRow.is_active,
      expires_at: keyRow.expires_at,
      call_count: keyRow.call_count,
      account: { id: ownerId, name: accountName, can_shortlink: accountRow.can_shortlink !== false },
      shortlink_base: SHORTLINK_BASE || `${APP_URL}/functions/v1/go`,
      short_links_total: count ?? 0,
      server_time: new Date().toISOString(),
    });
  }

  // ── 6. 列表（GET /list）──
  if (isList) {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    const keyword = (url.searchParams.get("keyword") ?? "").replace(/[,()]/g, " ").trim();
    const listResourceId = (url.searchParams.get("resource_id") ?? "").trim();
    const onlyResource = ["1", "true", "yes"].includes((url.searchParams.get("only_resource") ?? "").toLowerCase());
    const since = (url.searchParams.get("since") ?? "").trim();
    let q = svc
      .from("short_links")
      .select("id, code, title, target_url, resource_id, extract_code, channel, enabled, expires_at, click_count, unique_count, last_click_at, created_at", { count: "exact" })
      .eq("user_id", ownerId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (keyword) q = q.or(`title.ilike.%${keyword}%,target_url.ilike.%${keyword}%,code.ilike.%${keyword}%`);
    if (listResourceId) q = q.eq("resource_id", listResourceId);
    else if (onlyResource) q = q.not("resource_id", "is", null);
    if (since && !Number.isNaN(new Date(since).getTime())) q = q.gt("created_at", new Date(since).toISOString());
    const { data, error, count } = await q;
    if (error) return fail(500, `查询失败：${error.message}`);
    return ok({
      total: count ?? (data ?? []).length,
      limit,
      offset,
      items: (data ?? []).map((r) => {
        const row = r as Record<string, unknown>;
        return { ...row, short_url: shortUrlOf(String(row.code), (row.channel as string) ?? null) };
      }),
      account: { id: ownerId, name: accountName },
    });
  }

  // ── 7. 按资源查询 / 补齐短链（GET|POST /resource）──
  if (isResource) {
    const rawBody = req.method === "POST"
      ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
      : {};
    const pick = (k: string): string => {
      const v = url.searchParams.get(k);
      if (v !== null && v !== "") return v;
      const b = rawBody[k];
      return typeof b === "string" || typeof b === "number" || typeof b === "boolean" ? String(b) : "";
    };

    const wantId = pick("id").trim();
    const wantName = pick("name").trim().replace(/[,()%]/g, " ").trim();
    const wantUrl = pick("url").trim();
    const since = pick("since").trim();
    const finished = pick("finished").toLowerCase();            // 0 / 1 / 留空=全部
    const scope = (pick("scope") || "all").toLowerCase();       // admin（资源主）/ self（本账号）/ all
    const ensure = pick("ensure").toLowerCase() !== "false" && rawBody.ensure !== false;
    const ch = pick("channel").trim();
    const chInUrl = pick("channel_in_url").toLowerCase() === "true";
    const limit = Math.min(Math.max(Number(pick("limit") || 20) || 20, 1), 200);
    const offset = Math.max(Number(pick("offset") || 0) || 0, 0);

    // 只给一个网盘链接 → 直接确保（/ 返回）它的短链
    if (wantUrl && !wantId && !wantName) {
      try {
        const r = await ensureSimpleShortLink(svc, ownerId, wantUrl, {
          channel: ch || null, channelInUrl: chInUrl,
        });
        return ok({
          account: { id: ownerId, name: accountName },
          items: [{
            url: wantUrl, pan: panOfLink(wantUrl), code: r.code,
            short_url: shortUrlOf(r.code, r.channel, chInUrl), reused: r.reused,
          }],
        });
      } catch (e) {
        return fail(400, (e as Error).message);
      }
    }

    // 可查范围：管理员（资源主）的资源 + 本账号自己的资源
    const { data: adminRows } = await svc.from("profiles").select("id").eq("role", "admin");
    const adminIds = ((adminRows ?? []) as Array<{ id: string }>).map((x) => x.id);
    const scopeIds = scope === "self"
      ? [ownerId]
      : scope === "admin"
      ? adminIds
      : Array.from(new Set([ownerId, ...adminIds]));

    let q = svc
      .from("resources")
      .select("id, name, episode_count, is_finished, link_status, updated_at, links, owner_id", { count: "exact" })
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (wantId) q = q.eq("id", wantId);
    if (wantName) q = q.ilike("name", `%${wantName}%`);
    if (finished === "0") q = q.eq("is_finished", false);
    else if (finished === "1") q = q.eq("is_finished", true);
    if (since && !Number.isNaN(new Date(since).getTime())) q = q.gt("updated_at", new Date(since).toISOString());
    q = scopeIds.length ? q.in("owner_id", scopeIds) : q.eq("owner_id", ownerId);

    const { data: resRows, error: resErr, count } = await q;
    if (resErr) return fail(500, `查询资源失败：${resErr.message}`);

    type LinkObj = { url?: string; pan_name?: string; status?: string };
    type ResRow = {
      id: string; name: string; episode_count: number; is_finished: boolean;
      link_status: string; updated_at: string; links: LinkObj[] | null;
    };
    const resources = (resRows ?? []) as ResRow[];

    // 先把这些资源的链接统一收集，再分块查出本账号已有的短链（避免超长 URL）
    const allUrls = new Set<string>();
    for (const r of resources) {
      for (const l of Array.isArray(r.links) ? r.links : []) {
        const u = (l?.url ?? "").trim();
        if (/^https?:\/\//i.test(u)) allUrls.add(u);
      }
    }
    const existing = new Map<string, { code: string; channel: string | null }>();
    const urlList = Array.from(allUrls);
    for (let i = 0; i < urlList.length; i += 100) {
      const { data: rows } = await svc
        .from("short_links")
        .select("code, target_url, channel")
        .eq("user_id", ownerId)
        .in("target_url", urlList.slice(i, i + 100));
      for (const row of (rows ?? []) as Array<{ code: string; target_url: string; channel: string | null }>) {
        if (!existing.has(row.target_url)) existing.set(row.target_url, { code: row.code, channel: row.channel });
      }
    }

    let created = 0;
    const items: Array<Record<string, unknown>> = [];
    for (const r of resources) {
      const links: Array<Record<string, unknown>> = [];
      for (const l of Array.isArray(r.links) ? r.links : []) {
        const u = (l?.url ?? "").trim();
        if (!/^https?:\/\//i.test(u)) continue;
        const base = { pan: panOfLink(u, l?.pan_name), url: u, link_status: l?.status ?? null };
        const hit = existing.get(u);
        if (hit) {
          links.push({ ...base, code: hit.code, short_url: shortUrlOf(hit.code, hit.channel, chInUrl), reused: true });
          continue;
        }
        if (!ensure) {
          links.push({ ...base, code: null, short_url: null, reused: false, note: "尚无短链（ensure=false 未生成）" });
          continue;
        }
        try {
          const made = await ensureSimpleShortLink(svc, ownerId, u, {
            title: r.name, panName: l?.pan_name ?? null, resourceId: r.id, channel: ch || null, channelInUrl: chInUrl,
          });
          existing.set(u, { code: made.code, channel: made.channel ?? null });
          if (!made.reused) created++;
          links.push({ ...base, code: made.code, short_url: shortUrlOf(made.code, made.channel, chInUrl), reused: made.reused });
        } catch (e) {
          links.push({ ...base, code: null, short_url: null, error: (e as Error).message });
        }
      }
      items.push({
        resource_id: r.id, name: r.name, episode_count: r.episode_count ?? 0,
        is_finished: !!r.is_finished, link_status: r.link_status, updated_at: r.updated_at, links,
      });
    }

    return ok({
      account: { id: ownerId, name: accountName },
      scope,
      finished: finished || "all",
      total: count ?? items.length,
      limit,
      offset,
      /** 本次新生成的短链条数（其余为复用） */
      created,
      items,
    });
  }

  // ── 8. 生成 / 复用短链（POST）──
  const body = (await req.json().catch(() => null)) as
    | {
        url?: unknown; urls?: unknown; text?: unknown;
        mode?: unknown; prefix?: unknown; title?: unknown; channel?: unknown;
        resource_id?: unknown; extract_code?: unknown; pan_name?: unknown;
        expires_at?: unknown; reuse?: unknown; channel_in_url?: unknown;
      }
    | null;
  if (!body) return fail(400, "请求体需要是 JSON");

  const single: string[] = [];
  if (typeof body.url === "string" && body.url.trim()) single.push(body.url.trim());
  if (Array.isArray(body.urls)) {
    for (const u of body.urls) if (typeof u === "string" && u.trim()) single.push(u.trim());
  }
  const text = typeof body.text === "string" ? body.text : "";
  if (!single.length && !text.trim()) {
    return fail(400, "至少需要提供 url、urls 或 text 之一");
  }
  if (single.length > 200) return fail(400, "单次最多处理 200 条链接");

  const mode = body.mode === "short" ? "short" : "path";
  const expires = parseExpires(body.expires_at);
  if (expires.error) return fail(400, expires.error);
  const opt: CreateOptions = {
    mode,
    prefix: typeof body.prefix === "string" ? body.prefix.trim().toLowerCase() : undefined,
    title: typeof body.title === "string" ? body.title : undefined,
    channel: typeof body.channel === "string" ? body.channel : null,
    resourceId: typeof body.resource_id === "string" ? body.resource_id : null,
    extractCode: typeof body.extract_code === "string" ? body.extract_code : null,
    panName: typeof body.pan_name === "string" ? body.pan_name : null,
    expiresAt: expires.iso,
    reuse: body.reuse !== false,
    channelInUrl: body.channel_in_url === true,
  };

  /** 目标链接 → 短链结果（同一次调用内去重，避免重复插入 / 重复返回） */
  const results = new Map<string, CreateResult>();
  const skipped: Array<{ url: string; reason: string }> = [];

  const handle = async (raw: string): Promise<CreateResult | null> => {
    if (!isPanLink(raw)) {
      if (!skipped.some((s) => s.url === raw)) {
        skipped.push({ url: raw, reason: "不是网盘分享链接（未替换）" });
      }
      return null;
    }
    const cached = results.get(raw);
    if (cached) return cached;
    try {
      const r = await createOne(svc, ownerId, raw, opt);
      results.set(raw, r);
      return r;
    } catch (e) {
      skipped.push({ url: raw, reason: (e as Error).message });
      return null;
    }
  };

  for (const u of single) await handle(u);

  // 正文：把里面的网盘链接原样替换成短链（其它内容一个字不动）
  let outText: string | null = null;
  let replacedInText = 0;
  if (text) {
    const found = Array.from(text.matchAll(URL_RE)).map((m) => trimUrlPunct(m[0]));
    for (const u of Array.from(new Set(found))) {
      const r = await handle(u);
      if (r) replacedInText += text.split(u).length - 1;
    }
    outText = text;
    for (const [from, r] of results) {
      // 同一个链接可能出现在正文多次，逐个替换
      outText = outText.split(from).join(r.short_url);
    }
  }

  const items = Array.from(results.values());
  return ok({
    account: { id: ownerId, name: accountName },
    mode,
    count: items.length,
    reused: items.filter((i) => i.reused).length,
    created: items.filter((i) => !i.reused).length,
    items,
    ...(outText !== null ? { text: outText, replaced: replacedInText } : {}),
    skipped,
  });
});

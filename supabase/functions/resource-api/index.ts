/**
 * resource-api: 开放接口（API Key 鉴权，调用方无需登录本应用）
 *
 * 用途：给自研工具 / 第三方程序按 API Key 读取资源数据，
 *       重点是查询「更新中（含最近更新记录）」与「已完结」的资源信息；
 *       客户端插件可用「用户登录态」读取该用户自己的订阅入库通知。
 * 鉴权（二选一）：
 *   1) API Key：请求头 X-API-Key: rk_xxx（也支持 ?key=rk_xxx，便于浏览器直接打开）。
 *      密钥由「管理后台 → API 管理」创建并绑定归属账号，停用 / 过期后立即失效。
 *   2) 用户登录态：请求头 Authorization: Bearer <access_token>（客户端插件用账号登录后拿到的令牌）。
 *      等价于「仅归属账号」范围：只能查自己的订阅入库通知，且仅 /subscriptions、/imported、/me 可用，
 *      资源类接口仍必须用 API Key。
 * 数据范围：每个密钥只能读取「归属账号自己名下」的资源，不返回其他账号的数据。
 *
 * 路由（GET，均返回 JSON；出错时 code 为 HTTP 状态码）：
 *   /resource-api            资源列表（等价 /resources）
 *   /resource-api/resources  资源列表，范围由 type 参数决定
 *   /resource-api/updated    等价 type=updated（更新中，附带最近一次更新记录）
 *   /resource-api/finished   等价 type=finished（已完结）
 *   /resource-api/stats      汇总统计（全部 / 更新中 / 已完结 数量）
 *   /resource-api/me         当前密钥与归属账号信息，用于自检
 *   /resource-api/subscriptions  订阅入库通知：本账号「订阅转存成功」的入库明细（别名 /imported）
 *
 * 列表参数：
 *   type=all|updated|finished   范围（默认 all；别名 updating/completed 亦可）
 *   keyword=剧名                 资源名称模糊搜索
 *   since=7d | 2026-09-01 | ISO  只返回 updated_at 在该时间之后的资源（支持 7d/12h/30m）
 *   include_finished=1           配合 since 做增量拉取时，把这段时间内「刚变为已完结」的资源也一并返回。
 *                                默认不带：资源一旦移入「已完结」就不再出现在 type=updated 的结果里，
 *                                只按 updated 轮询会看不到这次完结；带上它即可看到（每条带 status 字段）。
 *   link_status=valid|invalid|partial|unknown  按盘链检测状态过滤
 *   page=1 & page_size=20        分页，page_size 最大 200
 *   format=json|text             json（默认）或 text（可直接粘贴分享的纯文本清单）
 *
 * 订阅入库（/subscriptions、/imported）参数：
 *   after=游标             ⭐ 增量拉取（推荐）：原样回传上一次响应里的 next_after，
 *                          只返回「比它更新」的入库记录（按时间升序，最老的在前），
 *                          可继续拉直到 has_more=false。游标即入库时间（保留微秒）。
 *                          与 since 的时间窗不同 —— 把游标存下来，间隔多久都不会漏。
 *   since=1h | 7d | ISO    时间窗：只返回 transferred_at 在该时刻之后的入库记录
 *                          （与 after 可同用，用来限定"从某个起点之后开始关心"；
 *                           单独使用 + 轮询间隔大于窗口时，会永久漏掉窗口外的记录）
 *   limit=50               最多返回多少条入库文件（默认 50，最大 500）
 *   before=游标            翻页游标：原样回传上一次响应里的 next_before 即可取下一页（详见下方说明）
 *   subscription=剧名      按订阅名模糊过滤
 *   pan=guangya|quark      按网盘过滤
 *   format=text            直接返回可发群的通知文案（每行一条订阅：如「牧神记 更新 S01E103 已入库（…）」）
 *   hint=1                 配合 format=text：结果被截断时，在文案末尾补一行提示（默认不补，保持文案干净）
 *   download=1             配合 format=text 直接下载 .txt
 *   说明：一次调用内按订阅聚合，返回 items（每个文件一条）、groups（按订阅汇总，含集号列表）与 text。
 *
 * 关于「完结怎么推送」：订阅到达「全集数」时会判定完结（资源改名「已完结全N集」并移入已完结），
 * 但那一轮可能**一个文件都没转存**（集数是按分享目录对齐出来的），只按入库文件推送就会漏掉这次完结。
 * 因此响应里额外给出 finished（完结事件数组）与 finished_count，text 模式下同样会多出「… 已完结（全N集）」一行；
 * 每个完结事件只推送一次（推送后写 finished_notified_at），items/groups 上也带 finished / status 字段。
 *
 * 关于「会不会漏」：
 *   · **推荐姿势（after 增量拉取）**：把响应里的 next_after 存下来（本地文件 / 数据库皆可），
 *     下次带 after=<它> 再拉；has_more=true 时用返回的新 next_after 继续拉，直到 false。
 *     **无论轮询间隔是 5 分钟还是 5 天都不会漏**（这是"替代时间窗"的做法）；
 *   · 另一种（倒序翻页，适合回看历史，见下）。
 *
 * 结果按入库时间倒序取，最多 limit 条 —— 也就是说**一定有被截断的可能**
 * （比如 since=1d 时有 286 条、默认 limit=50，就只会返回最新的 50 条）。
 * 所以响应里给出三个字段，脚本据此翻页就不会漏：
 *   has_more / truncated   true = 还有更早的记录没返回
 *   next_before            下一页游标（null = 已到末尾）
 *   oldest_at / newest_at  本次返回的最早 / 最新一条入库时间
 * 翻页写法：带上 before=<上次的 next_before> 再请求一次，直到 has_more=false（游标即入库时间，保留微秒）。
 * 一次转存多个文件时 transferred_at 完全相同（实测同一时间戳多达 25 条），服务端会在
 * 「同一时间的一整批」边界处截断，所以单页条数可能略多于 limit —— 换来的是翻页一条不漏、不重复。
 * 翻页时建议 since 传**固定时间戳**（如 2026-10-04T00:00:00Z）而不是 24h 这类相对值：
 * 相对值每次请求都会重新计算，窗口下沿会随请求时间缓慢前移。
 * format=text 模式下没有 JSON 可读，同样信息放在响应头：X-Has-More / X-Next-Before / X-Oldest-At / X-Count。
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const APP_URL = Deno.env.get("SUPABASE_URL")!;
const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
  // 让浏览器里的脚本也能读到这些翻页 / 截断标记（format=text 时用响应头传递）
  "Access-Control-Expose-Headers": "X-Has-More, X-Next-Before, X-Oldest-At, X-Count",
};

type Scope = "all" | "updated" | "finished";

const SCOPE_LABEL: Record<Scope, string> = {
  all: "全部资源",
  updated: "更新中资源（已更新）",
  finished: "已完结资源",
};

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 20;

const LIST_COLUMNS =
  "id, name, episode_count, link, links, cover_url, is_finished, link_status, link_checked_at, " +
  "created_at, updated_at, owner_id, profiles!resources_owner_id_fkey(username)";

interface PanLinkRow {
  url?: string;
  pan_name?: string;
  status?: string;
  checked_at?: string;
}

interface ResourceRow {
  id: string;
  name: string;
  episode_count: number | null;
  link: string | null;
  links: PanLinkRow[] | null;
  cover_url: string | null;
  is_finished: boolean | null;
  link_status: string | null;
  link_checked_at: string | null;
  created_at: string;
  updated_at: string;
  owner_id: string;
  profiles?: { username: string | null } | null;
}

interface ApiKeyRow {
  /** 密钥 id；用户登录态调用时没有密钥行，为 null */
  id: string | null;
  name: string;
  is_active: boolean;
  expires_at: string | null;
  call_count: number;
  created_at: string;
  /** 归属账号：接口默认只返回该账号名下的资源 */
  owner_id: string;
  /** 数据范围：owner=仅归属账号（默认）；all=全部账号（订阅入库通知接口可跨账号查询） */
  scope?: string | null;
}

interface AccountRow {
  id: string;
  username: string | null;
  email: string | null;
}

function sendJson(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function sendText(text: string, status = 200) {
  return new Response(text, {
    status,
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** 成功：{ code: 0, message: 'ok', data } */
const ok = (data: unknown) => sendJson({ code: 0, message: "ok", data });

/** 失败：code 与 HTTP 状态码一致，便于脚本判断 */
const fail = (status: number, message: string) => sendJson({ code: status, message }, status);

/**
 * 规范化游标里的时间戳为「保留微秒 + Z 结尾」。
 * 两点必须做到：
 *   1) 保留微秒 —— 转成 Date 再 toISOString() 会把微秒截成毫秒，而一次转存的多个文件时间戳
 *      完全一致（含微秒），截断后 eq 匹配不上，同一批里排在游标后面的记录会被漏掉；
 *   2) 结尾必须是 Z —— URL 里的 "+" 会被解码成空格，用 +00:00 形式会解析出错。
 */
function normalizeCursorTime(raw: string): string | null {
  const s = raw.trim().replace(" ", "T");
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)(?:Z|\+00:?00?)$/.exec(s);
  if (m) return `${m[1]}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 解析 since：支持 7d / 12h / 30m、YYYY-MM-DD、完整 ISO，无法解析返回 error */
function parseSince(raw: string | null): { iso: string | null; error?: string } {
  if (!raw) return { iso: null };
  const v = raw.trim();
  const rel = /^(\d+)([dhm])$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === "d" ? n * 86400000 : unit === "h" ? n * 3600000 : n * 60000;
    return { iso: new Date(Date.now() - ms).toISOString() };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { iso: `${v}T00:00:00.000Z` };
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { iso: null, error: `since 参数无法解析：${raw}（示例：7d / 2026-09-01 / 2026-09-01T08:00:00Z）` };
  return { iso: d.toISOString() };
}

const PAN_LABEL: Record<string, string> = { guangya: "光鸭云盘", quark: "夸克云盘" };

/**
 * 从文件名里提取集号标记，用于「更新 S01E13」这种通知文案：
 *   Tales of Qin Mu S01E103 2160p….mkv → S01E103
 *   某某剧.第13集.mp4                  → 第13集
 * 取不到返回 null（调用方改用文件名）。
 */
function extractEpisode(name: string): string | null {
  const m = /S(\d{1,2})E(\d{1,4})/i.exec(name);
  if (m) return `S${m[1].padStart(2, "0")}E${m[2]}`;
  const cn = /第\s*(\d{1,4})\s*[集话]/.exec(name);
  return cn ? `第${cn[1]}集` : null;
}

/** 把集号标记解析成可比较的坐标：S01E13 → [1,13]；第13集 → [0,13]；非集号返回 null */
function episodeKey(mark: string): [number, number] | null {
  const m = /^S(\d{1,2})E(\d{1,4})$/.exec(mark);
  if (m) return [Number(m[1]), Number(m[2])];
  const cn = /^第(\d{1,4})集$/.exec(mark);
  return cn ? [0, Number(cn[1])] : null;
}

/** 集号标记排序：集号在前（按季/集升序），非集号（文件名兜底）排后面 */
function sortMarks(marks: string[]): string[] {
  return [...marks].sort((a, b) => {
    const ka = episodeKey(a);
    const kb = episodeKey(b);
    if (ka && kb) return ka[0] - kb[0] || ka[1] - kb[1];
    if (ka) return -1;
    if (kb) return 1;
    return a.localeCompare(b, "zh");
  });
}

/** MM-DD HH:mm（按服务端本地时区） */
function fmtShort(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parseScope(raw: string | null): Scope | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (["all", "全部"].includes(v)) return "all";
  if (["updated", "updating", "update", "已更新", "更新中"].includes(v)) return "updated";
  if (["finished", "completed", "complete", "done", "已完结"].includes(v)) return "finished";
  return null;
}

function toInt(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 单条资源 → 对外 JSON（不含内部字段，附带最近一次更新记录） */
function toItem(row: ResourceRow, lastChange?: { field_label: string; changed_at: string }) {
  const isFinished = !!row.is_finished;
  return {
    id: row.id,
    name: row.name,
    status: isFinished ? "已完结" : "更新中",
    is_finished: isFinished,
    episode_count: Number(row.episode_count ?? 0),
    owner_id: row.owner_id,
    owner: row.profiles?.username ?? null,
    cover_url: row.cover_url ?? null,
    link: row.link ?? "",
    links: Array.isArray(row.links) ? row.links : [],
    link_status: row.link_status ?? "unknown",
    link_checked_at: row.link_checked_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    /** 最近一次修改记录时间 / 字段（无修改记录时为 null） */
    last_changed_at: lastChange?.changed_at ?? null,
    last_changed_field: lastChange?.field_label ?? null,
  };
}

/** 纯文本清单（format=text），便于直接粘贴到群聊 / 文档 */
function toPlainText(
  scope: Scope,
  items: ReturnType<typeof toItem>[],
  pagination: { total: number; page: number; page_size: number },
  account: string | null
): string {
  const head = [
    `# ${SCOPE_LABEL[scope]}${account ? `（账号：${account}）` : ""}`,
    `共 ${pagination.total} 条 · 第 ${pagination.page} 页（每页 ${pagination.page_size} 条）`,
    `生成时间：${new Date().toLocaleString("zh-CN")}`,
    "",
  ].join("\n");

  const body = items
    .map((it, idx) => {
      const lines = [`${idx + 1}.【${it.status}】${it.name}（${it.episode_count} 集）`];
      const urls = [
        it.link,
        ...it.links.map((l) => {
          const url = l.url ?? "";
          if (!url) return "";
          return l.pan_name ? `${l.pan_name}：${url}` : url;
        }),
      ].filter((u) => !!u);
      if (urls.length) lines.push(`   链接：${urls.join(" | ")}`);
      if (it.last_changed_at) {
        lines.push(
          `   最近更新：${new Date(it.last_changed_at).toLocaleString("zh-CN")}${it.last_changed_field ? `（${it.last_changed_field}）` : ""}`
        );
      }
      return lines.join("\n");
    })
    .join("\n");

  return `${head}${body}\n`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return fail(405, "仅支持 GET 请求");

  const url = new URL(req.url);
  const svc = createClient(APP_URL, SVC_KEY, { auth: { persistSession: false } });

  // ── 1. 路由解析 ──
  const seg = (url.pathname.replace(/\/+$/, "").split("/").pop() ?? "").toLowerCase();
  const KNOWN = ["resource-api", "resources", "updated", "finished", "stats", "me", "subscriptions", "imported"];
  if (!KNOWN.includes(seg)) {
    return fail(404, `未知接口 /${seg}，可用：/resource-api、/resource-api/updated、/resource-api/finished、/resource-api/stats、/resource-api/subscriptions、/resource-api/me`);
  }

  // ── 2. 鉴权：API Key（第三方程序）或 用户登录态 Bearer Token（客户端插件）──
  const rawKey = (
    req.headers.get("x-api-key") ??
    url.searchParams.get("key") ??
    url.searchParams.get("api_key") ??
    ""
  ).trim();
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

  /** 鉴权方式：api_key=第三方程序；user=客户端插件带着用户登录态来调用（只查他本人的数据） */
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
    // 用户登录态：插件里用账号登录后带着 access_token 调用，等价于「仅归属账号」范围
    const { data: userData, error: userErr } = await svc.auth.getUser(bearer);
    if (userErr || !userData?.user?.id) {
      return fail(401, "登录态无效或已过期，请在插件里用账号重新登录后再试");
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
      "缺少凭据：第三方程序请带请求头 X-API-Key: rk_xxx（或 ?key=rk_xxx）；客户端插件请带 Authorization: Bearer <登录后的 access_token>"
    );
  }

  if (!keyRow) return fail(401, "鉴权失败，请重新登录或检查密钥"); // 兜底：上面的分支已保证非空
  /** 取出来给嵌套函数用：函数声明不会继承上面的 null 收窄（TS 会把 keyRow 判为 possibly null） */
  const ownerId: string = keyRow.owner_id;

  // ── 防滥用：按密钥 + 全局限流（公开接口，被刷时保护数据库与函数调用配额）──
  // 限流设施故障时放行：不能因为限流出问题把正常调用也挡掉。
  try {
    const { data: globalOk } = await svc.rpc("rate_limit_hit", {
      p_bucket: "api:global", p_window_seconds: 60, p_limit: 3000,
    });
    if (globalOk === false) return fail(429, "请求过于频繁，请稍后再试");
    const { data: keyOk } = await svc.rpc("rate_limit_hit", {
      p_bucket: `apikey:${ownerId}`, p_window_seconds: 60, p_limit: 600,
    });
    if (keyOk === false) return fail(429, "该密钥请求过于频繁（上限 600 次/分钟），请稍后再试");
  } catch { /* 限流设施异常 → 放行 */ }

  // 调用计数与来源 IP（仅 API Key 需要计数；失败不影响数据返回）
  if (authMode === "api_key" && keyRow.id) {
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
    try {
      await svc.rpc("touch_api_key", { p_id: keyRow.id, p_ip: ip });
    } catch { /* 计数失败忽略 */ }
  }

  // 用户登录态只开放「订阅入库通知」与自检；资源类接口请用 API Key 调用
  if (authMode === "user" && !["subscriptions", "imported", "me"].includes(seg)) {
    return fail(
      403,
      "用户登录态仅可调用 /subscriptions（订阅入库通知）与 /me；资源类接口请使用 API Key 调用"
    );
  }

  // ── 3. 归属账号：接口只返回该账号名下的资源 ──
  const { data: accountRow } = await svc
    .from("profiles")
    .select("id, username, email")
    .eq("id", keyRow.owner_id)
    .maybeSingle<AccountRow>();
  const accountName = accountRow?.username ?? accountRow?.email ?? null;

  // ── 4. 自检 ──
  if (seg === "me") {
    return ok({
      auth: authMode,
      name: keyRow.name,
      key: authMode === "api_key" ? `${rawKey.slice(0, 8)}…${rawKey.slice(-4)}` : null,
      is_active: keyRow.is_active,
      expires_at: keyRow.expires_at,
      created_at: keyRow.created_at,
      call_count: keyRow.call_count,
      account: { id: keyRow.owner_id, name: accountName },
      server_time: new Date().toISOString(),
    });
  }

  // ── 5. 公共过滤条件（stats 与列表共用；始终限定为密钥归属账号的资源） ──
  // 逗号 / 括号会破坏 PostgREST 过滤语法，统一替换为空格（模糊匹配不受影响）
  const clean = (v: string) => v.replace(/[,()]/g, " ").trim();
  const keyword = clean(url.searchParams.get("keyword") ?? "");
  const linkStatus = (url.searchParams.get("link_status") ?? "").trim();
  const sinceRaw = (url.searchParams.get("since") ?? "").trim();
  const since = parseSince(sinceRaw || null);
  if (since.error) return fail(400, since.error);

  if (linkStatus && !["valid", "invalid", "partial", "unknown"].includes(linkStatus)) {
    return fail(400, `link_status 取值无效：${linkStatus}（可用：valid / invalid / partial / unknown）`);
  }

  // ── 5.5 订阅入库通知（/subscriptions 与别名 /imported）──
  // 数据来自 subscription_transferred：订阅每次「转存成功」都会为每个进网盘的文件记一条。
  // 这里按订阅聚合后，既给出明细（items / groups），也给出可直接发群的通知文案（text）。
  if (seg === "subscriptions" || seg === "imported") {
    const limit = Math.min(
      toInt(url.searchParams.get("limit") || url.searchParams.get("page_size"), 50),
      500
    );
    const subFilter = clean(url.searchParams.get("subscription") ?? "");
    const panFilter = (url.searchParams.get("pan") ?? "").trim();
    if (panFilter && !["guangya", "quark"].includes(panFilter)) {
      return fail(400, `pan 取值无效：${panFilter}（可用：guangya / quark）`);
    }

    // 数据范围：scope='all' 的密钥（管理员为「订阅通知」创建）可跨账号查询，
    // 其它密钥只能看到归属账号自己的入库记录。
    const isGlobal = String(keyRow.scope ?? "owner") === "all";
    const accountRaw = (url.searchParams.get("account") ?? url.searchParams.get("user") ?? "").trim();
    if (accountRaw && !isGlobal) {
      return fail(
        403,
        authMode === "user"
          ? "用户登录态只能查询自己的订阅入库记录（不需要、也不允许指定 account 参数）"
          : "该密钥只能查询归属账号的入库记录；需要跨账号查询，请在「API 管理」里创建数据范围为「全部账号」的密钥"
      );
    }
    /** user_id → 账号名：给每条记录 / 每条通知文案标注账号（归属密钥即归属账号） */
    const accountNames = new Map<string, string>();
    if (accountName) accountNames.set(keyRow.owner_id, accountName);
    /** 指定 account 时收窄到该账号；null = 不限（所有账号） */
    let scopedUserId: string | null = null;
    if (isGlobal && accountRaw) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountRaw);
      const { data: acc } = await svc
        .from("profiles")
        .select("id, username, email")
        .eq(isUuid ? "id" : "username", accountRaw)
        .maybeSingle<{ id: string; username: string | null; email: string | null }>();
      if (!acc?.id) return fail(404, `找不到账号：${accountRaw}（可用用户名或用户 ID）`);
      scopedUserId = acc.id;
      accountNames.set(acc.id, acc.username || acc.email || acc.id);
    }

    // 翻页游标：把上一次响应里的 next_before 原样回传即可（就是「入库时间」，已保留微秒）。
    // 配合下面的「整批截断」策略：同一时间入库的一批文件不会被切到两页，所以这里用最朴素的
    // 「严格早于该时间」过滤即可 —— 既不漏记录，也不会卡住不前进。
    // 旧版游标形如 <时间>|<记录ID>，这里只取时间部分（向后兼容）。
    const beforeRaw = (url.searchParams.get("before") ?? "").trim();
    let beforeAt: string | null = null;
    if (beforeRaw) {
      const [rawAt = ""] = beforeRaw.split("|");
      beforeAt = rawAt ? normalizeCursorTime(rawAt) : null;
      if (!beforeAt) {
        return fail(400, `before 游标无法解析：${beforeRaw}（请原样回传上一次响应里的 next_before）`);
      }
    }

    // ── 向前增量游标（after）：「拿一次游标、下次接着拉」——与 since 的时间窗不同，
    // 只要调用方把 next_after 存下来，间隔多久都不会漏（推荐用它替代 since+轮询窗口）。
    // 游标即入库时间（保留微秒，一次转存的一批文件时间戳相同）；兼容旧格式 <时间>|<记录ID>。
    const afterRaw = (url.searchParams.get("after") ?? url.searchParams.get("after_at") ?? "").trim();
    let afterAt: string | null = null;
    if (afterRaw) {
      const [rawAt = ""] = afterRaw.split("|");
      afterAt = rawAt ? normalizeCursorTime(rawAt) : null;
      if (!afterAt) {
        return fail(400, `after 游标无法解析：${afterRaw}（请原样回传上一次响应里的 next_after）`);
      }
    }
    /** 增量模式：按时间升序返回、游标向前推进（与倒序翻页互斥） */
    const incremental = !!afterAt;

    // 多取一些再按订阅名 / 网盘二次过滤，保证过滤后仍能凑满 limit
    const candidateLimit = Math.min(limit * 4, 500);
    let q = svc
      .from("subscription_transferred")
      .select(
        "id, user_id, file_name, file_key, transferred_at, subscription_id, " +
          "subscriptions!subscription_transferred_subscription_id_fkey(name, pan, target_dir_name, total_episodes, finished_at)"
      )
      .order("transferred_at", { ascending: incremental })
      // 同一时间的多条：给个稳定次序，保证每次请求顺序一致（翻页不重不漏的前提）
      .order("id", { ascending: incremental })
      .limit(candidateLimit);
    q = isGlobal
      ? scopedUserId
        ? q.eq("user_id", scopedUserId)
        : q
      : q.eq("user_id", keyRow.owner_id);
    if (since.iso) q = q.gte("transferred_at", since.iso);
    // 增量：严格晚于游标（同一时间的一整批不会被切开，所以用严格大于即可不漏）
    if (afterAt) q = q.gt("transferred_at", afterAt);
    if (beforeAt) q = q.lt("transferred_at", beforeAt);

    const { data: rawRows, error: rowsErr } = await q;
    if (rowsErr) return fail(500, `查询订阅入库记录失败：${rowsErr.message}`);

    type SubBrief = {
      name: string | null;
      pan: string | null;
      target_dir_name: string | null;
      /** 全集数（订阅里填写的）；NULL = 不自动完结 */
      total_episodes?: number | null;
      /** 判定完结时间；非空 = 该订阅已完结（达到全集数，资源已移入「已完结」） */
      finished_at?: string | null;
    };
    /**
     * 已完结订阅的展示名：把「更新至第18集 / 更至第18集 / 更新第18集」等换成「已完结全N集」，
     * 与 subscription-run 判定完结时给资源改的名字口径一致 —— 推送文案里就直接是完结态，不会再说「更新」。
     */
    const finishedName = (name: string, total: number): string => {
      if (!total) return name;
      if (/已完结/.test(name)) return name;
      const tail = `已完结全${total}集`;
      // 与 subscription-run 的改名口径保持一致：按优先级匹配，避免把「某剧 S01E12」前的空格吃掉
      const res = [
        /(?:更新\s*[至到]?|更至)\s*(?:第?\s*\d+\s*[集话話]|S\d{1,2}\s*E\d{1,3})/i,
        /第\s*\d+\s*[集话話]/i,
        /S\d{1,2}\s*E\d{1,3}/i,
      ];
      for (const re of res) if (re.test(name)) return name.replace(re, tail);
      return `${name} ${tail}`;
    };
    type TransRow = {
      id: string;
      user_id: string;
      file_name: string | null;
      file_key: string;
      transferred_at: string;
      subscription_id: string;
      subscriptions?: SubBrief | SubBrief[] | null;
    };
    const pickSub = (v: SubBrief | SubBrief[] | null | undefined): SubBrief | null =>
      Array.isArray(v) ? v[0] ?? null : v ?? null;

    const scanned = (rawRows ?? []).length;
    const allRows = ((rawRows ?? []) as unknown as TransRow[]).map((row) => ({
      row,
      sub: pickSub(row.subscriptions),
    }));
    const matched = allRows.filter(({ sub }) => {
      if (panFilter && (sub?.pan ?? "") !== panFilter) return false;
      if (subFilter && !(sub?.name ?? "").includes(subFilter)) return false;
      return true;
    });
    const rows0 = matched.slice(0, limit);

    // 取满 limit 条；但若第 limit 条后面紧跟着「同一时间入库」的记录（转存一批文件时
    // transferred_at 完全相同，实测有一批 25 条同一时间戳），就把这一整批一起带上再截断。
    // 这样下一页用「严格早于该时间」过滤时，不会把一批切成两半而漏掉剩下的文件
    // （单页因此可能略多于 limit，但不会超过候选窗口上限）。
    let cut = rows0.length;
    if (cut > 0 && cut < matched.length) {
      const lastTs = matched[cut - 1].row.transferred_at;
      while (cut < matched.length && matched[cut].row.transferred_at === lastTs) cut++;
    }
    const rows = matched.slice(0, cut);

    // 截断判定：① 过滤后还有没返回的记录；② 候选窗口被取满（更早的位置可能还有匹配记录）
    const windowCapped = scanned >= candidateLimit;
    const hasMore = cut < matched.length || windowCapped;
    // 返回顺序：增量模式=升序（早→新），翻页模式=降序（新→早）
    const firstAt = rows.length > 0 ? rows[0].row.transferred_at : null;
    const lastAt = rows.length > 0 ? rows[rows.length - 1].row.transferred_at : null;
    const asCursor = (t: string | null) =>
      t ? normalizeCursorTime(t) ?? new Date(t).toISOString() : null;
    // 向后翻页游标：最后一条返回记录的时间；一条都没返回但窗口被取满时，取窗口里最老那条的时间 ——
    // 否则调用方拿着空结果无法推进，会一直拿到同一页。
    const cursorTime = incremental
      ? lastAt
      : rows.length > 0
        ? lastAt
        : windowCapped && allRows.length > 0
          ? allRows[allRows.length - 1].row.transferred_at
          : null;
    const nextBefore = incremental ? null : asCursor(cursorTime);
    // 向前增量游标：本次返回里最新那条的时间；一条都没返回时原样回传传入的游标（调用方不必特判）
    const newestReturnedAt = rows.length > 0 ? (incremental ? lastAt : firstAt) : null;
    const nextAfter = asCursor(newestReturnedAt) ?? (incremental ? afterRaw || null : null);
    const newestAt = newestReturnedAt;
    const oldestAt = rows.length > 0 ? (incremental ? firstAt : lastAt) : null;

    // 跨账号查询：补齐这批记录涉及的账号名（用于每条记录与每条通知文案标注账号）
    if (isGlobal && rows.length) {
      const ids = [...new Set(rows.map(({ row }) => row.user_id))];
      const { data: profs } = await svc.from("profiles").select("id, username, email").in("id", ids);
      for (const p of (profs ?? []) as Array<{ id: string; username: string | null; email: string | null }>) {
        accountNames.set(p.id, p.username || p.email || p.id);
      }
    }

    const items = rows.map(({ row, sub }) => {
      const fileName = row.file_name ?? "";
      // 完结态：订阅达到「全集数」后服务端会置 finished_at 并把资源移入「已完结」
      const finished = !!sub?.finished_at;
      const total = Number(sub?.total_episodes ?? 0) || 0;
      return {
        account_id: row.user_id,
        account: accountNames.get(row.user_id) ?? null,
        subscription_id: row.subscription_id,
        subscription: sub?.name ?? null,
        /** 订阅是否已完结（已在资源管理里移入「已完结」） */
        finished,
        /** 完结状态文案：已完结 / 更新中 */
        status: finished ? "已完结" : "更新中",
        /** 全集数（订阅里填写的）；未填写为 null */
        total_episodes: total || null,
        /** 展示用名称：已完结时为「… 已完结全N集」，否则与订阅名相同 */
        display_name: finished ? finishedName(sub?.name ?? "", total) : sub?.name ?? null,
        pan: sub?.pan ?? null,
        pan_label: PAN_LABEL[sub?.pan ?? ""] ?? sub?.pan ?? null,
        target_dir: sub?.target_dir_name ?? null,
        file_name: fileName,
        /** 集号标记（S01E13 / 第13集）；文件名里没有集号时为 null */
        episode: extractEpisode(fileName),
        transferred_at: row.transferred_at,
        file_key: row.file_key,
      };
    });

    // 按「账号 + 订阅」聚合：同一订阅在这段时间内的新增文件合成一条通知
    type Group = {
      account_id: string;
      account: string | null;
      subscription_id: string;
      subscription: string | null;
      /** 订阅是否已完结（达到全集数） */
      finished: boolean;
      /** 完结状态文案：已完结 / 更新中 */
      status: string;
      /** 全集数；未填写为 null */
      total_episodes: number | null;
      /** 展示用名称（已完结时为「… 已完结全N集」） */
      display_name: string | null;
      pan: string | null;
      pan_label: string | null;
      target_dir: string | null;
      marks: string[];
      files: string[];
      first_at: string;
      last_at: string;
    };
    const groupMap = new Map<string, Group>();
    for (const it of items) {
      // 有集号就报集号；没有集号（少数网盘内部名）就退回去掉扩展名的文件名
      const noExt = it.file_name.replace(/\.[A-Za-z0-9]{2,5}$/, "").slice(0, 40);
      const mark = it.episode ?? (noExt || "新文件");
      const key = `${it.account_id}::${it.subscription_id}`;
      const g = groupMap.get(key);
      if (g) {
        if (!g.marks.includes(mark)) g.marks.push(mark);
        g.files.push(it.file_name);
        if (it.transferred_at < g.first_at) g.first_at = it.transferred_at;
        if (it.transferred_at > g.last_at) g.last_at = it.transferred_at;
      } else {
        groupMap.set(key, {
          account_id: it.account_id,
          account: it.account,
          subscription_id: it.subscription_id,
          subscription: it.subscription,
          finished: it.finished,
          status: it.status,
          total_episodes: it.total_episodes,
          display_name: it.display_name,
          pan: it.pan,
          pan_label: it.pan_label,
          target_dir: it.target_dir,
          marks: [mark],
          files: [it.file_name],
          first_at: it.transferred_at,
          last_at: it.transferred_at,
        });
      }
    }
    const groups = [...groupMap.values()]
      .map((g) => ({ ...g, marks: sortMarks(g.marks), count: g.files.length }))
      .sort((a, b) => (a.last_at < b.last_at ? 1 : -1));

    // 跨多个账号时在文案前加账号名，避免「牧神记」这行看不出是谁的
    const multiAccount = new Set(groups.map((g) => g.account_id)).size > 1;

    // 通知文案（每行一条订阅）：牧神记 更新 S01E103 已入库（光鸭云盘 → 日-更/牧-神记） · 10-04 12:26
    const groupText = groups
      .map((g) => {
        const what =
          g.marks.length > 6
            ? `${g.marks.slice(0, 6).join("、")} 等 ${g.marks.length} 个文件`
            : g.marks.join("、");
        const where = [g.pan_label, g.target_dir].filter(Boolean).join(" → ");
        const when = g.last_at ? ` · ${fmtShort(g.last_at)}` : "";
        const who = multiAccount && g.account ? `${g.account} · ` : "";
        const name = g.subscription ?? "未命名订阅";
        // 已完结的订阅：不再说「更新 N 集」，直接用完结态名称（… 已完结全N集）
        if (g.finished) {
          const label = g.display_name ?? name;
          return `${who}${label} 已入库${where ? `（${where}）` : ""}${when}`;
        }
        return `${who}${name} 更新 ${what} 已入库${where ? `（${where}）` : ""}${when}`;
      })
      .join("\n");

    // ── 完结事件 ──
    // 订阅达到「全集数」判定完结时资源被移入「已完结」；那一轮可能一个文件都没转存
    // （集数是按分享目录对齐出来的），若只按「入库文件」推送，调用方永远收不到这次完结。
    // 所以这里独立给出完结事件：推送一次后写 finished_notified_at，同一事件不会重复推。
    type FinishedEvent = {
      account_id: string;
      account: string | null;
      subscription_id: string;
      subscription: string | null;
      /** 完结状态文案（固定「已完结」，便于脚本统一判断） */
      status: string;
      /** 完结态名称（… 已完结全N集），可直接用于推送文案 */
      display_name: string | null;
      total_episodes: number | null;
      pan: string | null;
      pan_label: string | null;
      target_dir: string | null;
      finished_at: string;
      /** 订阅自动删除时间（判定完结后 1 小时；到期会连同同名其它网盘订阅一起删） */
      delete_at: string | null;
    };
    let finishedEvents: FinishedEvent[] = [];
    {
      type FinRow = {
        id: string;
        user_id: string;
        name: string | null;
        pan: string | null;
        target_dir_name: string | null;
        total_episodes: number | null;
        finished_at: string;
        delete_after: string | null;
      };
      let fq = svc
        .from("subscriptions")
        .select("id, user_id, name, pan, target_dir_name, total_episodes, finished_at, delete_after")
        .not("finished_at", "is", null)
        .is("finished_notified_at", null)
        .order("finished_at", { ascending: false })
        .limit(100);
      fq = isGlobal
        ? scopedUserId
          ? fq.eq("user_id", scopedUserId)
          : fq
        : fq.eq("user_id", keyRow.owner_id);
      if (since.iso) fq = fq.gte("finished_at", since.iso);
      const { data: fRows } = await fq;
      const rows = (fRows ?? []) as unknown as FinRow[];
      finishedEvents = rows.map((r) => {
        const total = Number(r.total_episodes ?? 0) || 0;
        return {
          account_id: r.user_id,
          account: accountNames.get(r.user_id) ?? null,
          subscription_id: r.id,
          subscription: r.name,
          status: "已完结",
          display_name: finishedName(r.name ?? "", total),
          total_episodes: total || null,
          pan: r.pan,
          pan_label: PAN_LABEL[r.pan ?? ""] ?? r.pan,
          target_dir: r.target_dir_name,
          finished_at: r.finished_at,
          delete_at: r.delete_after,
        };
      });
      // 标记已推送，避免同一完结事件在后续每次轮询里反复出现
      if (finishedEvents.length > 0) {
        await svc
          .from("subscriptions")
          .update({ finished_notified_at: new Date().toISOString() })
          .in("id", finishedEvents.map((e) => e.subscription_id));
      }
    }
    const finishedText = finishedEvents
      .map((e) => {
        const where = [e.pan_label, e.target_dir].filter(Boolean).join(" → ");
        const when = ` · ${fmtShort(e.finished_at)}`;
        const who = isGlobal && e.account ? `${e.account} · ` : "";
        const del = e.delete_at ? `（订阅将于 ${fmtShort(e.delete_at)} 自动删除）` : "";
        return `${who}${e.display_name ?? e.subscription ?? "未命名订阅"} 已完结${where ? `（${where}）` : ""}${when}${del}`;
      })
      .join("\n");
    const text = [groupText, finishedText].filter(Boolean).join("\n");

    // format=text：直接返回文案本身（空结果返回空串，方便脚本判断「没有新入库」而不误发）。
    // 截断信息放响应头（X-Has-More / X-Next-Before / X-Oldest-At），不污染文案；
    // 需要文案里也带提示时加 hint=1。
    if ((url.searchParams.get("format") ?? "").toLowerCase() === "text") {
      const headers: Record<string, string> = {
        ...CORS,
        "Content-Type": "text/plain; charset=utf-8",
        "X-Has-More": hasMore ? "1" : "0",
        "X-Count": String(items.length),
        "X-Incremental": incremental ? "1" : "0",
      };
      if (nextBefore) headers["X-Next-Before"] = nextBefore;
      if (nextAfter) headers["X-Next-After"] = nextAfter;
      if (oldestAt) headers["X-Oldest-At"] = oldestAt;
      if (url.searchParams.get("download") === "1") {
        headers["Content-Disposition"] = `attachment; filename="subscription-imports.txt"`;
      }
      const lines: string[] = [];
      if (text) lines.push(text);
      if (hasMore && url.searchParams.get("hint") === "1") {
        lines.push(
          incremental
            ? `（本次已截断，还有更新的入库未返回；带上 after=${nextAfter ?? ""} 可继续拉取）`
            : `（本次已截断，还有更早的入库未返回；带上 before=${nextBefore ?? ""} 可继续拉取）`
        );
      }
      return new Response(lines.length > 0 ? `${lines.join("\n")}\n` : "", { status: 200, headers });
    }

    return ok({
      /** 数据范围：owner=仅归属账号；all=全部账号（管理员为「订阅通知」创建的密钥） */
      scope: isGlobal ? "all" : "owner",
      /** 密钥归属账号（scope=owner 时即数据来源） */
      account: { id: keyRow.owner_id, name: accountName },
      /** 传了 account 参数时：本次查询限定的账号 */
      account_filter: scopedUserId
        ? { id: scopedUserId, name: accountNames.get(scopedUserId) ?? null }
        : null,
      /** 本次结果涉及的账号个数（跨账号查询时便于脚本判断） */
      account_count: new Set(items.map((i) => i.account_id)).size,
      since: since.iso,
      filters: {
        subscription: subFilter || null,
        pan: panFilter || null,
        limit,
        before: beforeRaw || null,
        after: afterRaw || null,
      },
      /** true = 本次是「增量拉取」（带了 after）：结果按时间升序，游标向前推进 */
      incremental,
      count: items.length,
      subscription_count: groups.length,
      /** 本次实际扫描的候选条数（截断诊断用） */
      scanned,
      /** 本次返回中最新的 / 最早的入库时间（没有返回记录时为 null） */
      newest_at: newestAt,
      oldest_at: oldestAt,
      /** true = 还有记录没返回（增量模式=还有更新的；翻页模式=还有更早的） */
      has_more: hasMore,
      /** has_more 的同义字段：本次结果被 limit 截断 */
      truncated: hasMore,
      /** 下一页游标（翻页模式）：原样作为 before 参数再请求一次；null = 已到末尾（增量模式恒为 null） */
      next_before: hasMore ? nextBefore : null,
      /**
       * 增量游标（推荐）：把它存下来，下次请求带 after=<该值> 即可拿到「比这次更新」的入库记录，
       * 间隔多久都不会漏。没有新记录时它会原样回传，调用方不必特判。
       */
      next_after: nextAfter,
      /** 完结事件（这段时间内「达到全集数 → 已完结」的订阅）：即使那一轮没有文件入库也会给出 */
      finished: finishedEvents,
      finished_count: finishedEvents.length,
      groups,
      items,
      text,
      generated_at: new Date().toISOString(),
    });
  }

  /** 构造当前账号的资源查询（count 模式用于统计）：数据隔离靠 owner_id 等值过滤 */
  function resourceQuery(head = false) {
    let q = svc
      .from("resources")
      .select(LIST_COLUMNS, { count: "exact", head })
      .eq("owner_id", ownerId);
    if (keyword) q = q.ilike("name", `%${keyword}%`);
    if (since.iso) q = q.gte("updated_at", since.iso);
    if (linkStatus) q = q.eq("link_status", linkStatus);
    return q;
  }

  const account = { id: keyRow.owner_id, name: accountName };

  const filters = {
    keyword: keyword || null,
    since: since.iso,
    link_status: linkStatus || null,
  };

  // ── 6. 统计（仅本账号） ──
  if (seg === "stats") {
    const [all, updating, finished, latest] = await Promise.all([
      resourceQuery(true),
      resourceQuery(true).eq("is_finished", false),
      resourceQuery(true).eq("is_finished", true),
      resourceQuery().order("updated_at", { ascending: false }).limit(1),
    ]);
    const err = all.error ?? updating.error ?? finished.error ?? latest.error;
    if (err) return fail(500, `统计失败：${err.message}`);

    return ok({
      account,
      all: all.count ?? 0,
      updated: updating.count ?? 0,
      finished: finished.count ?? 0,
      latest_updated_at: (latest.data as ResourceRow[] | null)?.[0]?.updated_at ?? null,
      filters,
      generated_at: new Date().toISOString(),
    });
  }

  // ── 7. 资源列表（仅本账号） ──
  const typeParam = url.searchParams.get("type");
  const typeScope = parseScope(typeParam);
  if (typeParam && !typeScope) {
    return fail(400, `type 取值无效：${typeParam}（可用：all / updated / finished）`);
  }
  // 路径写法（/updated、/finished）优先于 type 参数，避免两者冲突时行为不易预期
  const segScope: Scope | null = seg === "updated" ? "updated" : seg === "finished" ? "finished" : null;
  const scope: Scope = segScope ?? typeScope ?? "all";

  const page = toInt(url.searchParams.get("page"), 1);
  const pageSize = Math.min(toInt(url.searchParams.get("page_size"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const format = (url.searchParams.get("format") ?? "json").trim().toLowerCase();
  if (!["json", "text"].includes(format)) return fail(400, `format 取值无效：${format}（可用：json / text）`);

  const from = (page - 1) * pageSize;
  let query = resourceQuery().order("updated_at", { ascending: false }).order("created_at", { ascending: false });
  // include_finished=1 且带 since（增量拉取）时，不再把已完结的资源排除掉：
  // 否则「刚判定完结」的资源会直接从结果里消失，调用方永远看不到那次完结（每条都有 status 字段可判断）。
  const includeFinished = ["1", "true", "yes"].includes(
    (url.searchParams.get("include_finished") ?? "").trim().toLowerCase()
  );
  const keepFinished = includeFinished && !!since.iso;
  if (scope === "updated" && !keepFinished) query = query.eq("is_finished", false);
  if (scope === "finished") query = query.eq("is_finished", true);

  const { data, count, error } = await query.range(from, from + pageSize - 1);
  if (error) return fail(500, `查询资源失败：${error.message}`);

  // 走 unknown 中转：PostgREST 的类型在「查询出错」时会退化成 GenericStringError[]，直接断言会被 TS 拒绝
  const rows = (data ?? []) as unknown as ResourceRow[];
  const total = count ?? rows.length;
  const pagination = {
    total,
    page,
    page_size: pageSize,
    total_pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    has_more: from + rows.length < total,
  };

  // 附带每个资源的最近一次更新记录（一次 RPC 批量取，DISTINCT ON 去重）
  const changeMap = new Map<string, { field_label: string; changed_at: string }>();
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    const { data: changes } = await svc.rpc("resource_last_changes", { p_ids: ids });
    for (const c of (changes ?? []) as Array<{ resource_id: string; field_label: string; changed_at: string }>) {
      if (c.resource_id) changeMap.set(c.resource_id, { field_label: c.field_label, changed_at: c.changed_at });
    }
  }

  const list = rows.map((row) => toItem(row, changeMap.get(row.id)));
  if (format === "text") {
    if (url.searchParams.get("download") === "1") {
      // 附带下载文件名，便于浏览器直接保存（?format=text&download=1）
      return new Response(toPlainText(scope, list, pagination, accountName), {
        status: 200,
        headers: {
          ...CORS,
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="resources_${scope}_${new Date().toISOString().slice(0, 10)}.txt"`,
        },
      });
    }
    return sendText(toPlainText(scope, list, pagination, accountName));
  }

  return ok({
    account,
    scope,
    scope_label: SCOPE_LABEL[scope],
    pagination,
    filters,
    generated_at: new Date().toISOString(),
    list,
  });
});

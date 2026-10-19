// Supabase Edge Function: check-links
// 剧集资源链接失效检测
// 支持两种调用:
//   1. 前端单批检测: POST { resource_ids: ["uuid", ...] }
//   2. 定时全量巡检: POST { scope: "all", days: 1, limit: 300 }
// 判定规则: 光鸭接口返回 msg==="success"、data.shareStatus===1 且 totalFileNum>0 才视为有效;
//           夸克/迅雷等通过 HEAD/GET 请求探测可达性;
//           其余情况(分享已失效/链接不存在/网络错误等)一律判定失效。
// 检测结果自动回写数据库 (link_status / link_checked_at)。
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// 光鸭分享检测需三步：摘要 → 分享令牌 → 文件列表。
// 只查摘要是识别不出「被屏蔽」的：那类分享 shareStatus / totalFileNum 全部正常，
// 只有文件列表接口不返回 list（详见 checkGuangya）。
//
// ⚠ 这些请求必须经**数据库代理（guangya_http_send / guangya_http_result）**发出，
//   不能从 Edge 直连：Edge 在境外，直连 api.guangyapan.com 会整体超时（实测每个请求都 8s 超时），
//   于是「连不上」被写成了「链接失效」——大量有效分享被误判为无效（订阅转存里同样的坑已有记录）。
const GY_HOST = "api";
const GY_SUMMARY_PATH = "/nd.bizuserres.s/v1/get_share_summary";
const GY_TOKEN_PATH = "/nd.bizuserres.s/v1/get_share_access_token";
const GY_FILES_PATH = "/nd.bizuserres.s/v1/get_share_page_files_list";
/** 与订阅转存保持一致：分享类接口为公开接口，无需登录态令牌 */
const GY_CLIENT_ID = Deno.env.get("GUANGYA_CLIENT_ID") ?? "aMe-8VSlkrbQXpUR";
/**
 * 光鸭请求出口开关：配了自建中继就走中继（Edge 直连国内服务器），否则继续走数据库代理 pg_net。
 * 中继服务与配置方式见 relay/guangya-relay.mjs；删掉环境变量即回退，无需改代码。
 */
const GY_RELAY_URL = (Deno.env.get("GUANGYA_RELAY_URL") ?? "").trim().replace(/\/+$/, "");
const GY_RELAY_SECRET = (Deno.env.get("GUANGYA_RELAY_SECRET") ?? "").trim();
const GY_RELAY_ON = GY_RELAY_URL !== "" && GY_RELAY_SECRET !== "";
/** 单次光鸭请求超时 / 代理轮询间隔与最长等待 */
const GY_REQ_TIMEOUT_MS = 12000;
const GY_PROXY_POLL_MS = 250;
const GY_PROXY_MAX_WAIT_MS = 20000;

const QUARK_TOKEN_API =
  "https://drive-h.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=";
const QUARK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TABLE = "resources";
const CONCURRENCY = Math.min(Number(Deno.env.get("CHECK_CONCURRENCY") || "5"), 10);

// CORS：与其它代理函数一致，优先使用站点正式域名（SITE_URL 未配置时退化为 *）
const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-check-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** 统一 JSON 响应（带 CORS 头） */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/**
 * SSRF 防护：可达性探测只允许公网 http(s) 地址。
 * 命中内网 / 回环 / 元数据地址时直接判定失效，不发起请求。
 */
function isBlockedHost(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "::" || host.startsWith("::ffff:")) return true;
  if (host === "0.0.0.0") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true; // 云元数据地址段
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 链接解析 ----
function extractShareId(input: string): string | null {
  const m = input.match(/guangyapan\.com\/s\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const t = input.trim();
  return /^[A-Za-z0-9_-]{8,}$/.test(t) ? t : null;
}

function extractCode(input: string): string {
  const m = input.match(/[?&]code=([A-Za-z0-9]+)/);
  return m ? m[1] : "";
}

// ---- 夸克分享检测（调用夸克后端 token 接口，伪造夸克域来源）----
async function checkQuark(link: string): Promise<boolean> {
  const m = link.match(/pan\.quark\.cn\/s\/([0-9a-zA-Z]+)/);
  if (!m) return false;
  const pwd_id = m[1];
  try {
    const resp = await fetch(QUARK_TOKEN_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": QUARK_UA,
        "Origin": "https://pan.quark.cn",
        "Referer": "https://pan.quark.cn/",
      },
      body: JSON.stringify({ pwd_id, passcode: "" }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 200) {
      const data = await resp.json();
      if (data.code !== 0) return false;
      // 补充过期时间判断：expired_type !== 0（非永久）且 expired_at 已过期 → 失效
      const d = data.data ?? {};
      if (d.expired_type !== undefined && d.expired_type !== 0) {
        const expiredAt = Number(d.expired_at);
        if (!isNaN(expiredAt) && expiredAt < Date.now()) return false;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---- 光鸭分享检测 ----

type GyResp = {
  msg?: string;
  code?: number;
  data?: {
    shareStatus?: number;
    totalFileNum?: number;
    accessToken?: string;
    list?: unknown[];
  };
} | null;

/**
 * 经数据库代理（pg_net）调用光鸭接口并解析 JSON；拿不到响应（超时/网络错误）返回 null。
 * 代理是异步的：先入队拿请求 id，再轮询结果。必须分两次 RPC ——
 * 单条 SQL 的快照看不到 pg_net 后台回填的响应行。
 */
async function gyPost(path: string, body: Record<string, unknown>): Promise<GyResp> {
  try {
    // 配了中继就直接走中继：一次请求拿到结果，不必轮询数据库代理
    if (GY_RELAY_ON) {
      const res = await fetch(`${GY_RELAY_URL}/proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-relay-secret": GY_RELAY_SECRET },
        body: JSON.stringify({
          host: GY_HOST,
          path,
          body,
          clientId: GY_CLIENT_ID,
          timeoutMs: GY_REQ_TIMEOUT_MS,
        }),
        signal: AbortSignal.timeout(GY_REQ_TIMEOUT_MS + 3000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { status?: number; body?: GyResp };
      return (j?.body ?? null) as GyResp;
    }

    const { data: reqId, error } = await supabase.rpc("guangya_http_send", {
      p_host: GY_HOST,
      p_path: path,
      p_body: body,
      p_bearer: "",
      p_client_id: GY_CLIENT_ID,
      p_timeout_ms: GY_REQ_TIMEOUT_MS,
    });
    if (error || !reqId) return null;

    const deadline = Date.now() + GY_PROXY_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(GY_PROXY_POLL_MS);
      const { data } = await supabase.rpc("guangya_http_result", { p_id: reqId });
      const r = (data ?? {}) as { done?: boolean; body?: GyResp; _proxy_error?: string };
      if (r._proxy_error) return null;
      if (r.done) return (r.body ?? null) as GyResp;
    }
    return null;
  } catch {
    return null;
  }
}

/** 光鸭业务级限流：HTTP 200 + 「操作过于频繁，请稍后重试」（并发高时会撞到） */
function isRateLimited(body: GyResp): boolean {
  const msg = String((body as { msg?: string } | null)?.msg ?? "");
  return /操作过于频繁|过于频繁|too many requests|rate ?limit/i.test(msg);
}

/**
 * 带退避重试的调用：光鸭偶发挂起、并发高时还会返回「操作过于频繁」。
 * 只试一次容易把「这一次没连上/被限流」写成「链接失效」——那是误报。
 * 最多 3 次、退避 0s / 1s / 2s；仍然失败返回 null（调用方按「拿不到结论」处理）。
 */
async function gyPostRetry(path: string, body: Record<string, unknown>): Promise<GyResp> {
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(1000 * i);
    const r = await gyPost(path, body);
    if (r && !isRateLimited(r)) return r;
  }
  return null;
}

/**
 * 光鸭分享有效性检测（三步）：
 *  ① 摘要：失效分享返回「分享已失效」(code 201) 或「分享链接错误」(code 200)
 *  ② 分享令牌：取不到说明分享不可访问
 *  ③ 文件列表：识别「被屏蔽」—— 这类分享摘要完全正常（shareStatus=1、
 *     totalFileNum 有值、页面显示「永久有效」），但列表接口只返回 {"cursor":N}，
 *     不含 list/total。页面因此显示「暂无文件」，访客无法勾选、无法转存，
 *     链接实际不可用。此前只查摘要会把这类误判为有效。
 */
async function checkGuangya(shareId: string, code: string): Promise<boolean> {
  // 三步都带退避重试：这一步只是「没连上/被限流」时不该判失效（那是误报）
  const summary = await gyPostRetry(GY_SUMMARY_PATH, { shareId });
  if (summary?.msg !== "success" || summary.data?.shareStatus !== 1) return false;

  // 分享未撤销但内容被清空时 totalFileNum 为 0
  const fileNum = summary.data?.totalFileNum;
  if (typeof fileNum === "number" && fileNum <= 0) return false;

  const tk = await gyPostRetry(GY_TOKEN_PATH, { shareId, code: code || "" });
  if (tk?.msg !== "success" || !tk.data?.accessToken) return false;

  const files = await gyPostRetry(GY_FILES_PATH, {
    shareId,
    accessToken: tk.data.accessToken,
    pageIndex: 1,
    pageSize: 5,
  });
  if (files?.msg !== "success") return false;

  // 被屏蔽的分享拿不到 list，只有 cursor
  const list = files.data?.list;
  return Array.isArray(list) && list.length > 0;
}

// ---- 单链接检测 ----
async function checkOne(link: string): Promise<boolean> {
  const shareId = extractShareId(link);
  if (shareId) {
    return checkGuangya(shareId, extractCode(link));
  }
  // 夸克：调用夸克后端 token 接口判断有效性
  if (/pan\.quark\.cn\/s\//.test(link)) {
    return checkQuark(link);
  }
  // 迅雷 / 123pan / lanzou 等：HEAD 探测可达性
  // SSRF 防护：内网 / 回环 / 云元数据地址直接判定失效，不发起请求
  if (isBlockedHost(link)) return false;
  try {
    const resp = await fetch(link, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    return resp.ok;
  } catch {
    try {
      const resp = await fetch(link, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}

// ---- 收集某资源的所有链接 ----
function collectLinks(row: {
  link: string | null;
  links: Array<{ url: string; pan_name?: string }> | null;
}): string[] {
  const set = new Set<string>();
  const push = (raw: string) => {
    const u = raw.trim();
    if (u) set.add(u);
  };
  if (row.link) push(row.link);
  if (Array.isArray(row.links)) {
    for (const l of row.links) {
      if (l?.url) push(l.url);
    }
  }
  return Array.from(set);
}

// ---- 批量检测（链接级：逐条记录状态，资源级三态 valid/partial/invalid）----
async function runChecks(
  rows: Array<{ id: string; link: string | null; links: unknown }>,
): Promise<
  Array<{
    id: string;
    valid: boolean;
    status: "valid" | "partial" | "invalid";
    checkedAt: string;
    linkResults: Array<{ url: string; valid: boolean }>;
  }>
> {
  const results: Array<{
    id: string;
    valid: boolean;
    status: "valid" | "partial" | "invalid";
    checkedAt: string;
    linkResults: Array<{ url: string; valid: boolean }>;
  }> = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const checked = await Promise.all(
      batch.map(async (row) => {
        const links = collectLinks(row as {
          link: string | null;
          links: Array<{ url: string }> | null;
        });
        const now = new Date().toISOString();
        if (links.length === 0) {
          return { id: row.id, valid: true, status: "valid" as const, checkedAt: now, linkResults: [] };
        }
        const linkResults = await Promise.all(
          links.map(async (url) => ({ url, valid: await checkOne(url) })),
        );
        const validCount = linkResults.filter((r) => r.valid).length;
        const status: "valid" | "partial" | "invalid" =
          validCount === linkResults.length ? "valid" : validCount === 0 ? "invalid" : "partial";
        return {
          id: row.id,
          valid: status === "valid",
          status,
          checkedAt: now,
          linkResults,
        };
      }),
    );
    results.push(...checked);
    if (i + CONCURRENCY < rows.length) await sleep(300);
  }
  return results;
}

// ---- 结果回写（资源级状态 + 每条链接状态）----
async function persist(
  rows: Array<{ id: string; link: string | null; links: unknown }>,
  results: Array<{ id: string; status: string; checkedAt: string; linkResults: Array<{ url: string; valid: boolean }> }>,
) {
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const row of rows) {
    const r = byId.get(row.id);
    if (!r) continue;
    // 为每条链接补写 status，回写 links 数组
    const rawLinks = Array.isArray(row.links) ? (row.links as Array<{ url: string; pan_name?: string }>) : [];
    const urlValid = new Map(r.linkResults.map((l) => [l.url, l.valid]));
    const updatedLinks = rawLinks.map((l) => ({
      ...l,
      status: urlValid.has(l.url) ? (urlValid.get(l.url) ? "valid" : "invalid") : l.status ?? "unknown",
      checked_at: r.checkedAt,
    }));
    const { error } = await supabase
      .from(TABLE)
      .update({
        link_status: r.status,
        link_checked_at: r.checkedAt,
        links: updatedLinks,
      })
      .eq("id", row.id);
    if (error) console.error("persist failed:", error.message, r.id);
  }
}

// ---- 定时巡检: 拉取待检测资源 ----
async function fetchPendingRows(days: number, limit: number) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, link, links")
    .or(`link_status.neq.valid,link_checked_at.is.null,link_checked_at.lt.${since}`)
    .limit(limit);
  if (error) throw new Error("query pending rows failed: " + error.message);
  return (data || []) as Array<{ id: string; link: string | null; links: unknown }>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // 只允许 POST：避免被匿名 GET 当作存活/外呼探测使用
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // ① 鉴权：定时巡检用 CHECK_SECRET（服务端调用）；前端调用必须带有效登录态。
  //    此前该函数不校验任何凭据（CHECK_SECRET 未配置时完全开放），可被匿名调用。
  const secret = Deno.env.get("CHECK_SECRET");
  const fromCron = !!secret && req.headers.get("x-check-secret") === secret;
  let userId = "";
  if (!fromCron) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "unauthorized" }, 401);
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token);
    if (userErr || !user) return json({ error: "unauthorized" }, 401);
    userId = user.id;
  }

  // ② 入参白名单
  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    /* 忽略 */
  }

  let rows: Array<{ id: string; link: string | null; links: unknown }> = [];

  if (Array.isArray(payload.resource_ids)) {
    const ids = (payload.resource_ids as string[]).filter(Boolean).slice(0, 200);
    if (ids.length) {
      // 仅允许检测调用者自己的资源：此前按 id 直查，可越权检测并回写他人资源状态
      let query = supabase.from(TABLE).select("id, link, links").in("id", ids).limit(500);
      if (userId) query = query.eq("owner_id", userId);
      const { data, error } = await query;
      if (error) return json({ error: error.message }, 500);
      rows = (data || []) as Array<{ id: string; link: string | null; links: unknown }>;
    }
  } else if (payload.scope === "all") {
    // 全量巡检属服务端任务，前端登录态不允许触发
    if (!fromCron) return json({ error: "forbidden" }, 403);
    const days = Number(payload.days) || 1;
    const limit = Math.min(Number(payload.limit) || 200, 500);
    rows = await fetchPendingRows(days, limit);
  }

  if (!rows.length) {
    return json({ results: [], scanned: 0, valid: 0, invalid: 0 });
  }

  const results = await runChecks(rows);
  await persist(rows, results);

  const valid = results.filter((r) => r.status === "valid").length;
  const partial = results.filter((r) => r.status === "partial").length;
  const invalid = results.filter((r) => r.status === "invalid").length;
  return json({
    results,
    scanned: results.length,
    valid,
    partial,
    invalid,
  });
});
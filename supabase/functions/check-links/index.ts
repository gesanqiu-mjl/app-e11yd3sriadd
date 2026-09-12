// Supabase Edge Function: check-links
// 剧集资源链接失效检测
// 支持两种调用:
//   1. 前端单批检测: POST { resource_ids: ["uuid", ...] }
//   2. 定时全量巡检: POST { scope: "all", days: 1, limit: 300 }
// 判定规则: 光鸭接口返回 msg==="success" 且 data.shareStatus===1 视为有效;
//           夸克/迅雷等通过 HEAD/GET 请求探测可达性;
//           其余情况(分享已失效/链接不存在/网络错误等)一律判定失效。
// 检测结果自动回写数据库 (link_status / link_checked_at)。
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GY_API = "https://api.guangyapan.com/nd.bizuserres.s/v1/get_share_summary";
const GY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const QUARK_TOKEN_API =
  "https://drive-h.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=";
const QUARK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TABLE = "resources";
const CONCURRENCY = Math.min(Number(Deno.env.get("CHECK_CONCURRENCY") || "5"), 10);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-check-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

// ---- 单链接检测 ----
async function checkOne(link: string): Promise<boolean> {
  const shareId = extractShareId(link);
  if (shareId) {
    const body: Record<string, string> = { shareId };
    const code = extractCode(link);
    if (code) body.code = code;
    try {
      const resp = await fetch(GY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": GY_UA },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json();
      return data.msg === "success" && data.data?.shareStatus === 1;
    } catch {
      return false;
    }
  }
  // 夸克：调用夸克后端 token 接口判断有效性
  if (/pan\.quark\.cn\/s\//.test(link)) {
    return checkQuark(link);
  }
  // 迅雷 / 123pan / lanzou 等：HEAD 探测可达性
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

  const secret = Deno.env.get("CHECK_SECRET");
  if (secret && req.headers.get("x-check-secret") !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: CORS,
    });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    /* 忽略 */
  }

  let rows: Array<{ id: string; link: string | null; links: unknown }> = [];

  if (Array.isArray(payload.resource_ids)) {
    const ids = (payload.resource_ids as string[]).filter(Boolean);
    if (ids.length) {
      const { data, error } = await supabase
        .from(TABLE)
        .select("id, link, links")
        .in("id", ids)
        .limit(500);
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: CORS,
        });
      }
      rows = (data || []) as Array<{ id: string; link: string | null; links: unknown }>;
    }
  } else if (payload.scope === "all") {
    const days = Number(payload.days) || 1;
    const limit = Math.min(Number(payload.limit) || 200, 500);
    rows = await fetchPendingRows(days, limit);
  }

  if (!rows.length) {
    return new Response(
      JSON.stringify({ results: [], scanned: 0, valid: 0, invalid: 0 }),
      { headers: CORS },
    );
  }

  const results = await runChecks(rows);
  await persist(rows, results);

  const valid = results.filter((r) => r.status === "valid").length;
  const partial = results.filter((r) => r.status === "partial").length;
  const invalid = results.filter((r) => r.status === "invalid").length;
  return new Response(
    JSON.stringify({
      results,
      scanned: results.length,
      valid,
      partial,
      invalid,
    }),
    { headers: CORS },
  );
});
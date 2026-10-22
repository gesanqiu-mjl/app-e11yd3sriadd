// ============================================================
// Supabase Edge Function: resource-sync-worker
// 站点补推 worker —— 订阅在服务端改了资源后，把变更推到各站点，**不需要浏览器开着页面**
//
// 背景：
//   订阅（subscription-run）在服务端完成「抓取 → 转存 → 改资源（集数/链接）」后，
//   只往 resource_sync_queue 登记一条「待推送站点」任务；原先真正推送的
//   ResourceTable.syncToSite() 只存在于前端，用户关掉页面任务就永远躺着。
//
// 本函数由 pg_cron 每分钟触发（也可由前端/脚本手动调用），流程：
//   原子抢占任务 → 读资源 + 该资源在 8 个站点的绑定 → 逐站点串行调用对应代理
//   → 命中「会话失效」时先用 site-credential 自动重登一次再重试
//   → 全部站点成功则删除任务；有失败则记录原因并递增 attempts（达到上限后
//     不再由 worker 自动重试，留待前端打开资源管理页时补推）。
//
// 鉴权：
//   1) 内部调用：x-internal-secret: <INTERNAL_SECRET>（+ 可选 x-user-id 指定只处理某用户）
//   2) 用户 JWT：只处理该用户自己的任务
//   站点代理侧同样支持这条内部通道（见 _shared/internalAuth.ts），
//   代理内部一律按目标用户过滤会话/绑定，权限范围与用户本人调用一致。
//
// 环境变量：
//   INTERNAL_SECRET  必填，与服务端其它内部调用共用（缺失时本函数直接报错）
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { hasInternalSecret } from "../_shared/internalAuth.ts";

const APP_URL = Deno.env.get("SUPABASE_URL")!;
const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_SECRET = Deno.env.get("INTERNAL_SECRET") ?? "";

/** 每个任务最多自动重试次数；达到后不再由 worker 重试（前端打开资源管理页仍会补推） */
const MAX_ATTEMPTS = 5;
/** 单次执行最多处理多少个任务（避免一次跑太久超过 Edge 函数执行上限） */
const DEFAULT_LIMIT = 8;
/** 同一站点的相邻请求间隔，避免触发站点频控 */
const SITE_GAP_MS = 400;

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret, x-user-id",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const svc = createClient(APP_URL, SVC_KEY, { auth: { persistSession: false } });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SiteKey =
  | "xn" | "ya" | "framehdr" | "panfx" | "mukaku" | "jying" | "hdhaven" | "st1";

const SITE_LABELS: Record<SiteKey, string> = {
  xn: "观影站点", ya: "鸭影臻藏", framehdr: "帧影",
  panfx: "123社区", mukaku: "不太灵", jying: "聚影", hdhaven: "栖影 HDHaven",
  st1: "1号站点",
};

/** 站点「会话失效」错误码（与各代理保持一致） */
const EXPIRED_CODES: Record<SiteKey, string[]> = {
  xn: ["COOKIE_EXPIRED"],
  ya: ["YA_EXPIRED"],
  framehdr: ["COOKIE_EXPIRED"],
  panfx: ["COOKIE_EXPIRED"],
  mukaku: ["MUKAKU_TOKEN_EXPIRED", "10103", "10104"],
  jying: ["JYING_COOKIE_EXPIRED"],
  // 栖影：改用官方 OpenAPI OAuth 后失效码为 TOKEN_EXPIRED，未授权为 NOT_BOUND
  hdhaven: ["HDHAVEN_TOKEN_EXPIRED", "HDHAVEN_NOT_BOUND"],
  // 1号站点：令牌失效/未绑定（打开 API 的 401 INVALID_TOKEN）
  st1: ["ST1_TOKEN_EXPIRED", "ST1_NOT_BOUND"],
};

// ────────────────────────────────────────────────────────────
// 云盘链接匹配（与前端 src/lib/panUtils.ts 的 matchLinkForPanType 等价）
// 绑定记录只认某一种网盘（pan_type / pan_label），必须挑出对应网盘的链接再推给站点，
// 否则会把错误的链接写进站点。
// ────────────────────────────────────────────────────────────

interface PanLink { url?: string | null; pan_name?: string | null }

const PAN_URL_RULES: { type: string; re: RegExp }[] = [
  { type: "xunlei", re: /pan\.xunlei\.com/i },
  { type: "baidu", re: /pan\.baidu\.com|yun\.baidu\.com/i },
  { type: "quark", re: /pan\.quark\.cn/i },
  { type: "123", re: /123pan\.cn|123pan\.com/i },
  { type: "uc", re: /drive\.uc\.cn|pan\.uc\.cn/i },
  { type: "aliyun", re: /alipan\.com|aliyundrive\.com/i },
  { type: "guangya", re: /guangyapan\.com|guangya[a-z]*\.com/i },
  { type: "tianyi", re: /cloud\.189\.cn/i },
  { type: "mobile", re: /yun\.139\.com/i },
  { type: "115", re: /115\.com|anxia\.com/i },
  { type: "lanzou", re: /lanzou[a-z]*\.com|lanzn\.com/i },
];

const PAN_TYPE_ALIASES: Record<string, string[]> = {
  quark: ["夸克"], aliyun: ["阿里"], baidu: ["百度"], "123": ["123"],
  mobile: ["移动"], tianyi: ["天翼"], "115": ["115"], uc: ["uc"],
  xunlei: ["迅雷"], weiyun: ["微云", "腾讯"], lanzou: ["蓝奏"],
  jianguoyun: ["坚果"], pikpak: ["pikpak"], guangya: ["光雅", "光鸭"],
};

const normPanText = (s: string) =>
  (s ?? "").toLowerCase().replace(/\s+/g, "").replace(/(云盘|网盘|盘)$/, "");

function panNameMatchesType(panName: string, panType: string): boolean {
  const name = normPanText(panName);
  if (!name) return false;
  const aliases = [panType, ...(PAN_TYPE_ALIASES[panType] ?? [])].map(normPanText).filter(Boolean);
  return aliases.some((a) => name.includes(a) || a.includes(name));
}

/** 为某网盘类型挑出链接；单链接直接返回，多链接无匹配返回 null（宁可不推，也不推错网盘） */
function pickLink(panType: string | null | undefined, links: PanLink[] | null, fallback: string | null): string | null {
  const valid = (links ?? []).filter((l) => (l?.url ?? "").trim());
  const all = valid.length > 0
    ? valid
    : (fallback ?? "").trim() ? [{ url: fallback!.trim(), pan_name: "" }] : [];
  if (all.length === 0) return null;
  if (all.length === 1) return all[0].url!.trim();
  if (panType) {
    const matched = all.find((l) => {
      const url = l.url ?? "";
      const byUrl = PAN_URL_RULES.find((r) => r.re.test(url))?.type;
      return byUrl === panType || panNameMatchesType(l.pan_name ?? "", panType);
    });
    // 与前端一致：有 panType 但无匹配时返回 null，避免把错类型链接写进其它网盘的绑定
    return matched?.url?.trim() ?? null;
  }
  const quark = all.find((l) => panNameMatchesType(l.pan_name ?? "", "quark"));
  return (quark?.url ?? fallback ?? all[0].url ?? "").trim() || null;
}

/** 资源标题：把「第 N 集」替换成当前集数（与前端 syncToSite 的标题规则一致） */
function buildTitle(name: string, episodeCount: number | null): string {
  if (!name) return "";
  return /第\s*\d+\s*集/.test(name) ? name.replace(/第\s*\d+\s*集/, `第${episodeCount ?? 0}集`) : name;
}

// ────────────────────────────────────────────────────────────
// 调用其它边缘函数（带内部通道身份）
// ────────────────────────────────────────────────────────────

interface FnResult { ok: boolean; status: number; data: Record<string, unknown> | null; text: string }

async function callFn(
  fn: string,
  action: string,
  userId: string,
  body: Record<string, unknown>,
  opts: { query?: Record<string, string>; timeoutMs?: number } = {}
): Promise<FnResult> {
  const url = new URL(`${APP_URL}/functions/v1/${fn}`);
  if (action) url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SVC_KEY}`,
      "x-internal-secret": INTERNAL_SECRET,
      "x-user-id": userId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const text = await res.text().catch(() => "");
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch { /* 非 JSON：保留原文用于报错 */ }
  return { ok: res.ok, status: res.status, data, text };
}

function isExpired(site: SiteKey, r: FnResult): boolean {
  const code = String((r.data as { code?: unknown } | null)?.code ?? "");
  if (code && EXPIRED_CODES[site].includes(code)) return true;
  if (r.status === 401) return true;
  return /COOKIE_EXPIRED|TOKEN_EXPIRED|YA_EXPIRED|NOT_BOUND/i.test(r.text);
}

/** 会话失效时调用 site-credential 自动重登（只对支持账密登录的站点有效） */
async function tryRelogin(site: SiteKey, userId: string): Promise<string | null> {
  try {
    const r = await callFn("site-credential", "ensure", userId, { site }, { timeoutMs: 45_000 });
    const status = String((r.data as { status?: unknown } | null)?.status ?? "");
    const reason = String((r.data as { reason?: unknown } | null)?.reason ?? "");
    if (status === "ok" || status === "relogged") return null;
    return reason || `${SITE_LABELS[site]}重新登录失败`;
  } catch (e) {
    return `自动重登异常：${(e as Error).message}`;
  }
}

/** 结果里明确表示业务失败（200 + success:false / code）时，取出可读原因 */
function bizError(r: FnResult): string | null {
  if (!r.ok) return `HTTP ${r.status}`;
  const d = (r.data ?? {}) as { success?: unknown; code?: unknown; error?: unknown; message?: unknown };
  if (d.success === false) {
    return String(d.message ?? d.error ?? d.code ?? "站点返回失败");
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// 各站点推送
// ────────────────────────────────────────────────────────────

interface PushCtx {
  userId: string;
  title: string;
  links: PanLink[] | null;
  link: string | null;
  episodeCount: number | null;
}

/** 单个站点的推送结果 */
interface SiteOutcome { site: SiteKey; ok: boolean; reason?: string }

/**
 * 串行推送到一个站点；内部把「会话失效 → 自动重登 → 重试一次」包好。
 * send(i) 返回该次调用的结果，i=0 为首次、1 为重登后的重试。
 */
async function pushSite(
  site: SiteKey,
  ctx: PushCtx,
  send: (attempt: number) => Promise<FnResult | { skip: string }>
): Promise<SiteOutcome> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await send(attempt);
    if ("skip" in r) return { site, ok: true, reason: r.skip };
    if (isExpired(site, r)) {
      const reloginErr = await tryRelogin(site, ctx.userId);
      last = reloginErr
        ? `会话失效，自动重登未成功：${reloginErr}`
        : "会话失效，已自动重登后仍失败";
      if (reloginErr) return { site, ok: false, reason: last };
      await sleep(SITE_GAP_MS);
      continue;
    }
    const biz = bizError(r);
    if (biz) return { site, ok: false, reason: biz };
    return { site, ok: true };
  }
  return { site, ok: false, reason: last || "推送失败" };
}

interface TaskRow {
  id: string;
  user_id: string;
  resource_id: string;
  resource_name: string;
  attempts: number;
}

/** 处理一个任务的 8 个站点推送；byName 里没绑定的站点会跳过 */
async function pushTask(row: TaskRow): Promise<{ gone: boolean; pushed: SiteKey[]; failed: { site: SiteKey; reason: string }[] }> {
  const uid = row.user_id;
  const { data: res } = await svc
    .from("resources")
    .select("id, name, episode_count, link, links")
    .eq("id", row.resource_id)
    .maybeSingle<{
      id: string; name: string | null; episode_count: number | null;
      link: string | null; links: PanLink[] | null;
    }>();

  // 资源已被删除 → 任务作废
  if (!res) return { gone: true, pushed: [], failed: [] };

  const [xn, ya, fh, pfx, muk, jy, hd, st1] = await Promise.all([
    svc.from("xn_resource_bindings").select("share_id, share_title, pan_label").eq("resource_id", row.resource_id),
    svc.from("ya_resource_bindings").select("link_id, link_title, pan_label").eq("resource_id", row.resource_id),
    svc.from("framehdr_resource_bindings").select("link_id, link_title, drive_name").eq("resource_id", row.resource_id).maybeSingle(),
    svc.from("panfx_resource_bindings").select("tid, firstpid, subject, fid").eq("resource_id", row.resource_id).maybeSingle(),
    svc.from("mukaku_resource_bindings").select("link_id, movies_id, seed_name, pan_type, share_code").eq("resource_id", row.resource_id),
    svc.from("jying_resource_bindings").select("link_id, movie_id, link_title, pan_label").eq("resource_id", row.resource_id),
    svc.from("hdhaven_resource_bindings").select("slug, media_type, pan_type, pan_label, link_title").eq("resource_id", row.resource_id),
    // 9) 1号站点：只在「该资源已发布到 1号站点」时才有绑定行（发布入口在「站点同步」页）
    svc.from("st1_resource_bindings").select("remote_id, title").eq("resource_id", row.resource_id).maybeSingle(),
  ]);

  const ctx: PushCtx = {
    userId: uid,
    title: buildTitle(res.name ?? row.resource_name ?? "", res.episode_count ?? null),
    // links 可能是 jsonb 数组，也可能是历史脏数据（字符串等）——非数组时退回只用 link 字段
    links: Array.isArray(res.links) ? res.links : null,
    link: res.link ?? null,
    episodeCount: res.episode_count ?? null,
  };

  const outcomes: SiteOutcome[] = [];

  // 1) 观影站点 xn（可多条）
  const xnRows = (xn.data ?? []) as { share_id: string | number; pan_label: string | null }[];
  if (xnRows.length) {
    const outs: SiteOutcome[] = [];
    for (const b of xnRows) {
      const url = pickLink(b.pan_label, ctx.links, ctx.link);
      if (!url) { outs.push({ site: "xn", ok: false, reason: "未找到与该网盘类型匹配的资源链接" }); continue; }
      outs.push(await pushSite("xn", ctx, () =>
        callFn("xnshare-proxy", "edit", uid, {
          id: String(b.share_id),
          title: ctx.title,
          panurl: url,
          is: 1,
        })));
      await sleep(SITE_GAP_MS);
    }
    outcomes.push(mergeSite("xn", outs));
  }

  // 3) 鸭影臻藏 ya（可多条；代理内部自带 token 静默续签）
  //
  // ⚠️ 默认停止推送：鸭影站点账号绑定 UI 已下线，按需求「保留数据但停止推送」。
  //    ya_resource_bindings 数据原样保留（这里仍会读出来，只是不推），
  //    要恢复推送把 PUSH_YA 改成 true，并把前端 ResourceTable 的 YA_PUSH_ENABLED 一起打开。
  const PUSH_YA = false;
  const yaRows = (ya.data ?? []) as { link_id: number; pan_label: string | null }[];
  if (PUSH_YA && yaRows.length) {
    const outs: SiteOutcome[] = [];
    for (const b of yaRows) {
      const url = pickLink(b.pan_label, ctx.links, ctx.link);
      if (!url) { outs.push({ site: "ya", ok: false, reason: "未找到与该网盘类型匹配的资源链接" }); continue; }
      outs.push(await pushSite("ya", ctx, () =>
        callFn("resource-manager", "", uid, {
          action: "updateResource",
          linkId: b.link_id,
          name: ctx.title,
          url,
        })));
      await sleep(SITE_GAP_MS);
    }
    outcomes.push(mergeSite("ya", outs));
  }

  // 4) 帧影（单条；代理会用编辑页现值回填未提交字段）
  const fhRow = fh.data as { link_id: string | number; drive_name: string | null } | null;
  if (fhRow) {
    const url = pickLink(null, ctx.links, ctx.link);
    if (!url) {
      outcomes.push({ site: "framehdr", ok: false, reason: "资源没有可用链接（link 为空）" });
    } else {
      outcomes.push(await pushSite("framehdr", ctx, () =>
        callFn("framehdr-proxy", "edit", uid, {
          name: fhRow.drive_name ?? "光鸭云盘",
          url,
          description: ctx.title,
        }, { query: { id: String(fhRow.link_id) } })));
    }
  }

  // 5) 123社区（单条；先取帖子详情再替换正文链接）
  const pfxRow = pfx.data as { tid: string | number; firstpid: number | null; subject: string | null; fid: string | null } | null;
  if (pfxRow) {
    const url = pickLink(null, ctx.links, ctx.link);
    if (!url) {
      outcomes.push({ site: "panfx", ok: false, reason: "资源没有可用链接（link 为空）" });
    } else {
      outcomes.push(await pushSite("panfx", ctx, async () => {
        const detail = await callFn("panfx-proxy", "detail", uid, { tid: String(pfxRow.tid) });
        if (!detail.ok) return detail;
        const d = detail.data as {
          thread?: { firstpid?: number; fid?: string | number };
          message?: string;
          drive_links?: { url?: string }[];
          data?: { thread?: { firstpid?: number; fid?: string | number }; message?: string; drive_links?: { url?: string }[] };
        } | null;
        // 代理可能把结果包在 data 里，两种形态都兼容
        const t = d?.thread ?? d?.data?.thread ?? {};
        const firstpid = t.firstpid ?? pfxRow.firstpid;
        if (!firstpid) {
          return { ok: false, status: 400, data: { message: "无法获取帖子 pid，请检查帖子是否存在" }, text: "" };
        }
        const fid = t.fid != null ? String(t.fid) : (pfxRow.fid ?? "");
        let message = d?.message ?? d?.data?.message ?? "";
        const driveLinks = d?.drive_links ?? d?.data?.drive_links ?? [];
        const oldUrl = driveLinks[0]?.url ?? "";
        if (oldUrl && message.includes(oldUrl)) {
          message = message.replace(oldUrl, url);
        } else {
          const replaced = message.replace(DRIVE_URL_RE, url);
          message = replaced !== message ? replaced : `${message}\n${url}`;
        }
        return await callFn("panfx-proxy", "edit", uid, {
          pid: String(firstpid),
          subject: ctx.title,
          message,
          fid,
        });
      }));
    }
  }

  // 6) 不太灵（可多条）
  const mukRows = (muk.data ?? []) as { link_id: string | number; movies_id: string | number; pan_type: string | null; share_code: string | null }[];
  if (mukRows.length) {
    const outs: SiteOutcome[] = [];
    for (const b of mukRows) {
      const url = pickLink(b.pan_type, ctx.links, ctx.link);
      if (!url) { outs.push({ site: "mukaku", ok: false, reason: "未找到与该网盘类型匹配的资源链接" }); continue; }
      outs.push(await pushSite("mukaku", ctx, () =>
        callFn("mukaku-proxy", "update", uid, {
          id: String(b.link_id),
          movies_id: b.movies_id,
          seed_name: ctx.title,
          link: url,
          code: b.share_code ?? "",
        })));
      await sleep(SITE_GAP_MS);
    }
    outcomes.push(mergeSite("mukaku", outs));
  }

  // 7) 聚影（可多条；只提交分享链接）
  const jyRows = (jy.data ?? []) as { link_id: string | number; pan_label: string | null }[];
  if (jyRows.length) {
    const outs: SiteOutcome[] = [];
    for (const b of jyRows) {
      const url = pickLink(b.pan_label, ctx.links, ctx.link);
      if (!url) { outs.push({ site: "jying", ok: false, reason: "未找到与该网盘类型匹配的资源链接" }); continue; }
      outs.push(await pushSite("jying", ctx, () =>
        callFn("jying-proxy", "update", uid, {
          link_id: String(b.link_id),
          share_link: url,
        }, { timeoutMs: 45_000 })));
      await sleep(SITE_GAP_MS);
    }
    outcomes.push(mergeSite("jying", outs));
  }

  // 8) 栖影（可多条；站点为「全量字段回写」，代理会用详情合并未提交字段）
  const hdRows = (hd.data ?? []) as { slug: string; pan_type: string | null; pan_label: string | null }[];
  if (hdRows.length) {
    const outs: SiteOutcome[] = [];
    for (const b of hdRows) {
      const url = pickLink(b.pan_type ?? b.pan_label, ctx.links, ctx.link);
      if (!url) { outs.push({ site: "hdhaven", ok: false, reason: "未找到与该网盘类型匹配的资源链接" }); continue; }
      outs.push(await pushSite("hdhaven", ctx, () =>
        callFn("hdhaven-proxy", "update", uid, {
          slug: b.slug,
          url,
          title: ctx.title,
          pan_type: b.pan_type ?? undefined,
        }, { timeoutMs: 120_000 })));
      await sleep(SITE_GAP_MS);
    }
    outcomes.push(mergeSite("hdhaven", outs));
  }

  // 9) 1号站点（API 令牌型；已发布的片源用 PATCH 同步标题与云盘地址）
  const st1Row = st1.data as { remote_id: string; title: string | null } | null;
  if (st1Row?.remote_id) {
    const url = pickLink(null, ctx.links, ctx.link);
    if (!url) {
      outcomes.push({ site: "st1", ok: false, reason: "资源没有可用链接（link 为空）" });
    } else {
      outcomes.push(await pushSite("st1", ctx, () =>
        callFn("st1-proxy", "update", uid, {
          resourceId: row.resource_id,
          remoteId: st1Row.remote_id,
          title: ctx.title,
          panUrl: url,
        })));
    }
  }

  const pushed: SiteKey[] = [];
  const failed: { site: SiteKey; reason: string }[] = [];
  for (const o of outcomes) {
    if (o.ok) pushed.push(o.site);
    else failed.push({ site: o.site, reason: o.reason ?? "未知原因" });
  }
  return { gone: false, pushed, failed };
}

/** 同一站点的多条绑定：全成功才算成功，失败时汇总原因 */
function mergeSite(site: SiteKey, outs: SiteOutcome[]): SiteOutcome {
  const bad = outs.filter((o) => !o.ok);
  if (bad.length === 0) return { site, ok: true };
  const reasons = [...new Set(bad.map((b) => b.reason ?? "未知原因"))];
  return { site, ok: false, reason: `${bad.length}/${outs.length} 条失败：${reasons.join("；")}` };
}

/** 正文里的旧网盘链接正则（与前端 api.ts 的 DRIVE_URL_RE 一致） */
const DRIVE_URL_RE =
  /https?:\/\/(?:www\.)?(?:[\w-]+\.)?(?:123pan(?:\.cn|\.com|fx\.com)|quark\.cn|pan\.quark\.cn|xunlei\.com|pan\.xunlei\.com|lanzou[a-z]*\.com|lanzn\.com|aliyundrive\.com|alipan\.com|uc\.cn|pan\.uc\.cn|115\.com|anxia\.com|pan\.baidu\.com|cloud\.189\.cn|guangyapan\.com|guangya[a-z]*\.com)(?:\/[^\s"'<>()）\]【】]*)?/gi;

// ────────────────────────────────────────────────────────────
// 队列 drain
// ────────────────────────────────────────────────────────────

async function drain(limit: number, onlyUserId?: string) {
  const { data: rows, error } = await svc.rpc("claim_resource_sync_tasks", {
    p_limit: limit,
    p_user_id: onlyUserId ?? null,
    p_stale_minutes: 5,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (error) throw new Error(`抢占待推送任务失败：${error.message}`);

  const results: unknown[] = [];
  for (const row of (rows ?? []) as TaskRow[]) {
    try {
      const r = await pushTask(row);
      if (r.gone || r.failed.length === 0) {
        await svc.from("resource_sync_queue").delete().eq("id", row.id);
        // 记下「已推送到站点的集数」——之后只有库内集数与它不一致（站点落后）时才重新入队补推。
        // 关键：**没有绑定站点时也要标记**。以前这种情况跳过写入，于是「闸门」每分钟都认为
        // 「站点落后」→ 反复入队、worker 每分钟空跑一遍（推不动又删不掉）。
        // 代价是新绑定的站点不会自动拿到当前集数 —— 这由「绑定即入队」的触发器补上
        // （public.resource_bindings 等 9 张绑定表上的 enqueue_sync_on_binding）。
        if (!r.gone) {
          const { data: resRow } = await svc
            .from("resources")
            .select("episode_count")
            .eq("id", row.resource_id)
            .maybeSingle();
          await svc
            .from("resources")
            .update({ synced_episode_count: (resRow as { episode_count?: number | null } | null)?.episode_count ?? null })
            .eq("id", row.resource_id);
        }
        results.push({
          id: row.id,
          resource: row.resource_name,
          status: r.gone ? "skipped" : "ok",
          message: r.gone
            ? "资源已删除，任务作废"
            : r.pushed.length
              ? `已推送：${r.pushed.map((s) => SITE_LABELS[s]).join("、")}`
              : "无绑定站点，已标记为已推送（新绑定站点时会自动补推）",
        });
      } else {
        const attempts = (row.attempts ?? 0) + 1;
        await svc.from("resource_sync_queue").update({
          attempts,
          last_attempt_at: new Date().toISOString(),
          last_error: r.failed.map((f) => `${SITE_LABELS[f.site]}：${f.reason}`).join("；"),
          claimed_at: null,
        }).eq("id", row.id);
        results.push({
          id: row.id,
          resource: row.resource_name,
          status: "partial",
          attempts,
          pushed: r.pushed.map((s) => SITE_LABELS[s]),
          failed: r.failed.map((f) => `${SITE_LABELS[f.site]}：${f.reason}`),
        });
      }
    } catch (e) {
      // 单条任务异常不能拖垮整批：释放占用并记录原因
      await svc.from("resource_sync_queue").update({
        attempts: (row.attempts ?? 0) + 1,
        last_attempt_at: new Date().toISOString(),
        last_error: `执行异常：${(e as Error).message}`,
        claimed_at: null,
      }).eq("id", row.id);
      results.push({ id: row.id, resource: row.resource_name, status: "error", message: (e as Error).message });
    }
  }
  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // 内部调用（定时任务）：密钥匹配即可，默认处理所有用户（可用 body.user_id 限定）
    const internal = hasInternalSecret(req);
    let callerUserId: string | null = null;
    if (!internal) {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ error: "请先登录本应用，或由服务端携带内部密钥调用" }, 401);
      const { data } = await svc.auth.getUser(token);
      callerUserId = data?.user?.id ?? null;
      if (!callerUserId) return json({ error: "登录态无效，请重新登录" }, 401);
    }

    if (!INTERNAL_SECRET) {
      return json({
        error: "服务端未配置 INTERNAL_SECRET，无法以内部身份调用站点代理",
        code: "NO_INTERNAL_SECRET",
      }, 500);
    }

    const url = new URL(req.url);
    const action = (url.searchParams.get("action") ?? "drain").trim();
    if (action !== "drain") return json({ error: `不支持的 action: ${action}`, actions: ["drain"] }, 400);

    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const limit = Math.min(20, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));
    // 用户自己调用只处理自己的任务；内部/定时任务默认处理所有用户（可用 user_id 限定）
    const onlyUserId = internal
      ? (typeof body.user_id === "string" && body.user_id ? body.user_id : undefined)
      : callerUserId!;

    // 定时任务（内部通道）默认「先返回、后台跑」：
    // pg_cron 是用 net.http_post 调进来的，而 pg_net 只有一个工作线程；
    // 若让这次请求挂着等补推跑完（可能几十秒），同期的订阅任务请求都会排队，
    // 出现「排队几十秒才发出去」的老问题。立刻返回即可让数据面保持畅通。
    // 需要看结果的调用方（前端 / 调试）可传 body.sync = true 强制同步执行。
    const wantsSync = body.sync === true;
    if (internal && !wantsSync) {
      const job = drain(limit, onlyUserId).catch((e) => console.error("[resource-sync-worker] 后台补推异常", e));
      const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (typeof rt?.waitUntil === "function") rt.waitUntil(job);
      else await job; // 运行时不支持 waitUntil 时退回同步执行
      return json({ accepted: true, mode: "background", limit });
    }

    const results = await drain(limit, onlyUserId);
    return json({ drained: results.length, results });
  } catch (e) {
    return json({ error: `补推失败：${(e as Error).message}` }, 500);
  }
});

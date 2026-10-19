/**
 * subscription-run: 订阅转存（RSS / 网页更新页 → 网盘转存 → 自动入库）
 *
 * 调用方式：
 *   1) 前端（带本应用登录态 Authorization: Bearer <jwt>）
 *   2) 定时任务（pg_cron）：携带 x-subscription-secret 头，服务端用 SUBSCRIPTION_SECRET 校验
 *
 * actions：
 *   saveSubscription / listSubscriptions / removeSubscription / toggleSubscription
 *   bindPan / panList / removePan / panProbe        （网盘账号：Cookie 加密存储）
 *   panBindTokens  光鸭绑定：填入 Access Token / Refresh Token / Client ID
 *   panDeviceStart / panDevicePoll  扫码授权（夸克 uop、UC CAS、百度 passport、迅雷 OAuth 设备码、123 uniID 二维码）
 *   百度绑定同 bindPan：粘贴含 BDUSS 的登录 Cookie，服务端再用它换 bdstoken 一起加密存
 *   preview   解析一个订阅源并返回候选条目（不写库，用于调源）
 *   run       { id }        立即执行某个订阅
 *   runAll    { force? }    执行全部订阅（cron 跑全站，用户只跑自己的）
 *   items     { subscriptionId?, status?, limit? }
 *   retryItem { id }        重试单条（转存 + 入库）
 *   clearItems { subscriptionId? }
 *
 * 流程：抓取 → 解析出网盘分享链接 → 按关键字过滤 → 指纹去重 →
 *       同盘转存到自己的网盘 → 写入 resources（进「已更新」）→ auto_publish 交给前端/后续阶段
 */
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * Supabase Edge 运行时扩展：把耗时任务挂在响应之后继续执行（返回后不被打断）。
 * 定时任务必须用它——原因见 runAll 里的说明（否则 pg_net 的唯一工作线程会被这次
 * 长请求独占，函数内部发往光鸭的请求要排队几十秒才发得出去）。
 */
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;

const APP_URL = Deno.env.get("SUPABASE_URL")!;
const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRED_KEY = Deno.env.get("SITE_CRED_KEY") ?? "";
const CRON_SECRET = Deno.env.get("SUBSCRIPTION_SECRET") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-subscription-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FETCH_TIMEOUT_MS = 20000;
const MAX_ITEMS_PER_RUN = 10;
/**
 * 订阅执行锁超时：定时任务每分钟触发，上一轮还在跑时不允许再次抢占同一个订阅，
 * 否则同一批文件会被转存两次（网盘里出现重复文件）。超时视为锁失效，允许重新执行，
 * 避免函数被平台中途杀掉后这个订阅永久卡住。
 * 取值需大于 Edge 函数最长执行时间：托管版 wall-clock 上限为付费 400s / 免费 150s。
 */
const RUN_LOCK_TTL_MS = 10 * 60_000;
/**
 * 定时任务「一轮」的取量上限与时间预算。
 * 背景：152 个订阅都设 1 分钟间隔、而光鸭请求要排队过数据库代理时，
 * 一轮根本跑不完；若不限量，一轮 600s 被平台杀掉后下一分钟又从同一批头部重来，
 * 尾部订阅会饿死（实测最久 30 小时没执行）。因此每轮限量 + 限时，跑不完留给下一轮。
 */
const MAX_SUBS_PER_ROUND = Math.max(1, Number(Deno.env.get("RUN_MAX_PER_ROUND") ?? 40));
const ROUND_BUDGET_MS = Math.max(30_000, Number(Deno.env.get("RUN_ROUND_BUDGET_MS") ?? 240_000));
/**
 * 单订阅看门狗：一条订阅跑这么久还没结束 → 本轮不再等它（后台那份继续跑，不取消）。
 * 目的：200+ 文件的大订阅不再把整轮拖住，也不会把整轮拖到平台墙钟被杀；
 * 它没跑完的部分留给下一轮（差集按目标目录实况算，下一轮会自然补上）。
 * 注意：超时是「让位」而不是「失败」—— 不解锁、不写 failed，否则下一轮会与后台那份重复转存。
 */
const SUB_DEADLINE_MS = Math.max(30_000, Number(Deno.env.get("RUN_SUB_DEADLINE_MS") ?? 90_000));
/** 看门狗超时用的哨兵前缀：只有它会被当成「让位」，其它异常仍按失败处理 */
const WATCHDOG_PREFIX = "__WATCHDOG__";
/** 一轮多久没心跳就视为已死（被平台杀掉）→ 允许下一轮接管 */
const ROUND_STALE_SECONDS = Math.max(30, Number(Deno.env.get("RUN_ROUND_STALE_SECONDS") ?? 120));
/** 心跳间隔（必须小于 ROUND_STALE_SECONDS） */
const ROUND_HEARTBEAT_MS = 45_000;
/**
 * 扇出模式（?mode=fanout）下，允许「抢走」别人执行锁的阈值：
 * 锁比这个还旧就认为是被平台杀掉留下的死锁残留，可以重新执行。
 * 取 2 倍心跳（90s），比轮内并发那条路径的 10 分钟 TTL 激进得多 —— 扇出的每条都是短任务，卡住基本就是异常。
 */
const SUB_LOCK_TAKEOVER_MS = Math.max(60_000, ROUND_HEARTBEAT_MS * 2);
/** pg_cron 每分钟触发的抖动余量：不留余量会因几百毫秒误差被跳过，变成隔分钟才跑一次 */
const DUE_TOLERANCE_MS = 5_000;

// ── 智能检测（自适应调度）：按每部剧的更新时段加密/放宽检查 ──
// 背景：每部剧一天通常只更新一次，固定间隔全天候轮询的命中率极低
// （实测 195 个订阅每天 37,152 次检查，只抓到 60.7 批更新 ≈ 612 次换 1 次）。
// 画像由数据库函数 refresh_subscription_profiles 每小时从入库记录里学（见 migrations/00055）。
/** 预期更新时段（±1 小时）内的检查间隔上限 */
const HOT_MAX_MINUTES = 5;
/** 一般时段：基准间隔的倍数、下限与上限（下限 1 小时：非预期时段没必要几分钟一查） */
const COLD_MULTIPLIER = 4;
const COLD_MIN_MINUTES = 60;
const COLD_MAX_MINUTES = 120;
/** 深夜（北京时间 0-7 点，实测 7 天只有 3 个文件）：基准间隔的倍数、下限与上限 */
const NIGHT_MULTIPLIER = 8;
const NIGHT_MIN_MINUTES = 30;
const NIGHT_MAX_MINUTES = 240;
/** 长期零更新：距上次抓到新增超过该天数（并按剧集自身节奏放宽）→ 每天 1 次 */
const STALE_DAYS = 7;
/** 兜底：距上次新增超过 max(36 小时, 1.5 × 平常更新间隔) → 收紧到 1 小时内，防历史规律失效漏更 */
const STALE_FALLBACK_HOURS = 36;
const STALE_FALLBACK_MINUTES = 60;
/** 北京时区偏移（分钟）：判断「深夜」与「预期更新时段」用，不依赖服务端时区 */
const BJ_OFFSET_MINUTES = 480;

// ── 全网深夜静默：北京 01:00-07:00，所有账号（含管理员）一律 2 小时检查一次 ──
/** 深夜静默起始（北京小时，含） */
const QUIET_NIGHT_START_HOUR = 1;
/** 深夜静默结束（北京小时，不含；07:00 起恢复正常节奏） */
const QUIET_NIGHT_END_HOUR = 7;
/** 深夜静默间隔（分钟）：这段时间内所有订阅固定 2 小时一次 */
const QUIET_NIGHT_MINUTES = 120;
/**
 * 是否处于「深夜静默」时段（北京 01:00-07:00）。
 * due 判定（该不该跑）与「下次检查时间」两处都必须用它，保证口径一致 ——
 * 这里优先级最高：覆盖「预期更新时段加密」「深夜降频」「严格按设置间隔」「账号级固定节奏」。
 */
function inQuietNight(nowMs: number): boolean {
  const h = bjHour(nowMs);
  return h >= QUIET_NIGHT_START_HOUR && h < QUIET_NIGHT_END_HOUR;
}

// ── 固定节奏策略（特殊码账号）：北京 07:00-24:00 每 15 分钟，00:00-07:00 每 60 分钟 ──
/** 策略：固定节奏（白天 15 分钟 / 深夜 1 小时） */
const POLICY_DAY_NIGHT = "day15_night60";
/** 白天间隔（分钟，北京 07:00-24:00） */
const POLICY_DAY_MINUTES = 15;
/** 深夜间隔（分钟，北京 00:00-07:00） */
const POLICY_NIGHT_MINUTES = 60;
/**
 * 取「固定节奏策略」在当前北京时间下该用的间隔；非该策略返回 null。
 * 调度（due 判定）与「下次检查时间」提示都用它，保证两处口径一致。
 * 注：北京 01:00-07:00 的深夜静默优先于此策略（统一 2 小时）。
 */
function policyIntervalMinutes(policy: string | null | undefined, nowMs: number): number | null {
  if (policy !== POLICY_DAY_NIGHT) return null;
  if (inQuietNight(nowMs)) return QUIET_NIGHT_MINUTES;
  const h = bjHour(nowMs);
  return h >= 0 && h < 7 ? POLICY_NIGHT_MINUTES : POLICY_DAY_MINUTES;
}

// ── 凭据失效的识别与自动停止（连续 3 次即停）──
/**
 * 凭据类失败的判定。必须排除「分享本身失效 / 目录为空」这类误报
 * （例如「这个分享里没有读到任何文件（分享可能已失效…）」不该算凭据问题），
 * 否则会把只是链接过期的订阅误停成「凭证失效」。
 */
const CRED_ISSUE_RE =
  /(登录已过期|登录已失效|登录状态|重新授权|重新扫码|续期失败|Cookie|cookie|令牌|未授权|未绑定[^，。；]{0,10}账号|凭证失效|账号失效)/;
/** 连续多少次凭据失效后停止检测 */
const CRED_FAIL_LIMIT = 3;
/** 自动停止时写进订阅消息的提示（用户按提示重新绑定后手动点「执行」即恢复） */
const CRED_PAUSE_NOTE = "凭证失效无法转存，请重新绑定凭证后手动点击「执行」激活。";

/**
 * 普通用户的订阅数量上限。
 * 特殊激活码注册的「订阅专用」账号不受它影响：那类账号的额度是注册时写进
 * profiles.max_subscriptions 的 10（见 consume_invite_code），可被管理员单独调整。
 */
const DEFAULT_MAX_SUBS = 80;

/** 消息是否属于「凭据失效」（需重新绑定） */
const isCredentialIssue = (msg: string): boolean => CRED_ISSUE_RE.test(String(msg ?? ""));

/**
 * 上游「网络类」故障（中继 502 / 光鸭接口挂起 / 连接被重置）：
 * 属于过一会儿就好的临时问题，不能当成链接失效或凭据问题处理，
 * 否则一屏订阅会在上游抖动时全被标成「失败」，用户会误以为链接坏了。
 */
const TRANSIENT_UPSTREAM_RE =
  /(光鸭中继 HTTP 5\d\d|上游超时|fetch failed|network error|NetworkError|timed? ?out|TimeoutError|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|HTTP 50[234]|Bad Gateway|Gateway Time-?out)/i;

/**
 * 凭据失效的连续计数与自动暂停（需求：检测到凭据失效后尝试 3 次，仍失败就停止检测）。
 *   · 本次成功（ok/partial）→ 计数清零
 *   · 本次失败且属凭据类 → 计数 +1；达到 3 次 → enabled=false（引擎不再检测）并写提示
 *   · 手动「执行」成功后由 runOne 负责恢复
 * 返回的字段直接并进 subscriptions.update(...)；只有需要覆盖 last_message 时才带上该键。
 */
function credentialPatch(sub: SubRow, status: string, msg: string): Record<string, unknown> {
  const okish = status === "ok" || status === "partial";
  if (okish) {
    return Number(sub.cred_fail_count ?? 0) > 0 || sub.paused_reason
      ? { cred_fail_count: 0, cred_fail_at: null, paused_reason: null }
      : {};
  }
  if (!isCredentialIssue(msg)) return {};
  const n = Number(sub.cred_fail_count ?? 0) + 1;
  if (n >= CRED_FAIL_LIMIT) {
    return {
      cred_fail_count: n,
      cred_fail_at: new Date().toISOString(),
      enabled: false,
      paused_reason: "credential",
      last_message: `${msg}。【已停止检测】${CRED_PAUSE_NOTE}`,
    };
  }
  return {
    cred_fail_count: n,
    cred_fail_at: new Date().toISOString(),
    last_message: `${msg}。（凭据疑似失效：第 ${n}/${CRED_FAIL_LIMIT} 次，再失败将自动停止检测）`,
  };
}
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ── 光鸭开放平台（令牌登录 + 转存）──
// 登录：用户填入光鸭官网本机存储的 Access/Refresh Token（不用扫码）。
// 端点与踩坑点移植自同源项目的 subscription-sync 引擎（其转存内核为成品实现）：
//   · 令牌过期返回业务码 code=112（不是 HTTP 401），需主动续期
//   · 写操作（restore_share）遇超时/网络错误不得重试，否则会转存出重复文件
//   · code=156 表示「该文件已转存过」，按成功处理
//   · 分享目录列表必须翻页取全，否则漏读会把已存在文件误判为新增
// 光鸭 API 在国内（腾讯云上海），Supabase Edge 在境外：
//   · Edge 直连光鸭【整体超时】（实测每个请求都 8s 超时，账号域与业务域都不可达）；
//   · `http` 扩展的 http_header() 实测【完全无效】，自定义请求头发不出去；
// 因此光鸭的所有请求统一由数据库代理 pg_net 发出（见 migrations/00049、00050），
// 请求头（Authorization / X-Client-Id 等）由代理函数在服务端拼好。
//
// ── 光鸭官方客户端的固定标识 ──
// 取值来自用户提供的《光鸭接入机器插件-优化版》（AstrBot 插件，main.py）：
// 该实现在服务端（无浏览器、无 Cookie）跑通搜索与创建分享，与本项目场景一致。
const GY_CLIENT_ID = Deno.env.get("GUANGYA_CLIENT_ID") ?? "aMe-8VSlkrbQXpUR";
const GY_PAGE_SIZE = 200;
// 分享/目录列举的翻页安全上限（每页 200）：50 页=1万，大分享会被截断。
// 这里给足余量（1000 页=20万文件），真正停止靠「total 取全」或「末页不满一页」。
const GY_MAX_LIST_PAGES = 1000;
// 单次 restore_share 转存的 fileIds 上限。
// 实测光鸭对单请求的 fileIds 数量上限约 50：超出时会被整体拒收并报「文件不存在」
// （吞噬星空 86 个、完美世界 198 个均失败；时光代理人 38 个成功），导致大分享同步不全。
// 取 50 留足余量，超过的文件由下方循环自动拆成多批，每批 ≤50，逐批累计并立即清洗。
const GY_TRANSFER_BATCH = 50;
/** 插件实现里 refresh 不带 client_secret；这里保留仅为兼容机密客户端 */
const GY_CLIENT_SECRET = Deno.env.get("GUANGYA_CLIENT_SECRET") ?? "";

/** 模块级 service role 客户端：供光鸭令牌回写等工具函数复用 */
const admin = createClient(APP_URL, SVC_KEY, { auth: { persistSession: false } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
const ok = (data: unknown) => json({ success: true, data });
const fail = (message: string, status = 400, code?: string) =>
  json({ success: false, code: code ?? null, message }, status);

// ───────────── 光鸭请求公共工具（统一经数据库代理 pg_net）─────────────

/** 数据库代理（pg_net）轮询间隔与最长等待 */
const GY_PROXY_POLL_MS = 250;
const GY_PROXY_MAX_WAIT_MS = 25000;

/**
 * 光鸭请求出口开关：配了自建中继就走中继（Edge 直连国内服务器），否则继续走数据库代理 pg_net。
 *
 * 为什么要中继：pg_net 只有一个后台 worker（实测 `pg_net 0.20.4 worker` 进程数 = 1），
 * 且批与批之间有屏障（一批全部完成才处理下一批），全站请求挤同一条队列，
 * 一个慢请求会拖住整批（历史上实测排队 36.6 秒）。而光鸭本身单请求只要 0.5~0.65 秒（实测），
 * 瓶颈在队列而不在光鸭 —— 换成中继后并发与超时都由我们自己控制。
 *
 * 回退：删掉这两个环境变量即恢复原路径，不需要改代码/重新部署。
 * 中继服务见 relay/guangya-relay.mjs（请求头与 guangya_http_send 完全一致）。
 */
const GY_RELAY_URL = (Deno.env.get("GUANGYA_RELAY_URL") ?? "").trim().replace(/\/+$/, "");
const GY_RELAY_SECRET = (Deno.env.get("GUANGYA_RELAY_SECRET") ?? "").trim();
const GY_RELAY_ON = GY_RELAY_URL !== "" && GY_RELAY_SECRET !== "";

/**
 * 经自建中继调用光鸭。失败按「可重试的网络类错误」抛出（name=TimeoutError），
 * 与 pg_net 路径的语义保持一致，外层 gyCall 的重试/提示逻辑不用改。
 */
async function gyHttpViaRelay(
  host: "api" | "account",
  path: string,
  body: Record<string, unknown>,
  opts: { bearer?: string; clientId?: string; action?: string },
  timeoutMs: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const res = await fetch(`${GY_RELAY_URL}/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-relay-secret": GY_RELAY_SECRET },
      body: JSON.stringify({
        host,
        path,
        body,
        bearer: opts.bearer ?? "",
        clientId: opts.clientId ?? GY_CLIENT_ID,
        action: opts.action ?? null,
        timeoutMs,
      }),
      // 略宽于上游超时：留时间给中继回包，否则错误原因会变成「两边同时超时」
      signal: AbortSignal.timeout(timeoutMs + 3000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`光鸭中继 HTTP ${res.status}${detail ? `：${detail}` : ""}`);
    }
    const j = (await res.json()) as { status?: number; body?: Record<string, unknown> };
    return { status: Number(j?.status ?? 0), body: (j?.body ?? {}) as Record<string, unknown> };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if ((e as Error)?.name === "TimeoutError" || /timed out|aborted/i.test(msg)) {
      const err = new Error(`光鸭请求超时（${Math.round(timeoutMs / 1000)}s）：中继或光鸭未在时限内响应`);
      err.name = "TimeoutError";
      throw err;
    }
    throw e;
  }
}

/**
 * 经数据库代理（pg_net）调用光鸭接口。
 *
 * 为什么不直连：Supabase Edge 在境外，直连 account / api.guangyapan.com 会整体超时
 * （实测每个请求都 8s 超时，账号域与业务域都不可达）。
 * 为什么不用 `http` 扩展：它的 http_header() 实测【完全无效】——用回显服务验证，
 * Authorization / X-Client-Id 等自定义头一个都没发出去，所以带鉴权的业务接口一律
 * 返回 401 + code=117「无效token」（不鉴权的分享接口则是 200，看起来"代理是通的"）。
 * pg_net 会正确发送自定义请求头（同样用回显服务验证过）。
 *
 * pg_net 是异步的：先入队拿 id，再轮询结果。必须分成两次 RPC —— PL/pgSQL 函数被
 * SELECT 调用时，内部所有查询共用同一条语句的快照，看不到 pg_net 后台回填的响应行。
 */
async function gyHttp(
  host: "api" | "account",
  path: string,
  body: Record<string, unknown>,
  opts: { bearer?: string; clientId?: string; action?: string; timeoutMs?: number } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs ?? 15000, 30000));
  // 配了中继就走中继（更快、并发可控）；没配则保持原样走数据库代理 pg_net
  if (GY_RELAY_ON) return await gyHttpViaRelay(host, path, body, opts, timeoutMs);

  const { data: reqId, error } = await admin.rpc("guangya_http_send", {
    p_host: host,
    p_path: path,
    p_body: body,
    p_bearer: opts.bearer ?? "",
    p_client_id: opts.clientId ?? GY_CLIENT_ID,
    p_action: opts.action ?? null,
    p_timeout_ms: timeoutMs,
  });
  if (error) throw new Error(`光鸭请求入队失败：${error.message}`);
  if (!reqId) throw new Error("光鸭请求入队失败：未返回请求 id");

  const deadline = Date.now() + GY_PROXY_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, GY_PROXY_POLL_MS));
    const { data } = await admin.rpc("guangya_http_result", { p_id: reqId });
    const r = (data ?? {}) as {
      done?: boolean;
      _status?: number;
      body?: Record<string, unknown>;
      _proxy_error?: string;
    };
    if (r._proxy_error) {
      const err = new Error(`光鸭请求失败：${r._proxy_error}`);
      err.name = "TimeoutError"; // 交给外层按「可重试的超时」处理
      throw err;
    }
    if (r.done) return { status: Number(r._status ?? 0), body: r.body ?? {} };
  }
  const err = new Error("光鸭请求超时：数据库代理未在时限内取到响应");
  err.name = "TimeoutError";
  throw err;
}

/**
 * 调用光鸭账号域接口（/v1/auth/token 换令牌等）。
 * body 用 JSON；opts.action 会作为 X-Action 头（官方插件换令牌时为 "401"）。
 */
async function gyAccountPost(
  path: string,
  body: Record<string, unknown>,
  _extraHeaders: Record<string, string> = {},
  opts: { clientId?: string; action?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await gyHttp("account", path, body, {
    clientId: opts.clientId,
    action: opts.action,
    timeoutMs: 20000,
  });
}

// ───────────────────────── 网盘识别 ─────────────────────────

const PAN_LABELS: Record<string, string> = {
  guangya: "光鸭云盘",
  quark: "夸克网盘",
  baidu: "百度网盘",
  xunlei: "迅雷云盘",
  uc: "UC网盘",
  p123: "123云盘",
};

/**
 * 迅雷云盘锁定（2026-10）：风控「四件套」与转存搬移仍在适配，先对用户关闭入口。
 * 前端网盘卡片显示「正在适配中」，服务端这里再硬拦一道（防止绕过 UI 直接调接口）。
 * 适配完成后：环境变量 XUNLEI_LOCKED=false 解锁，同时删掉前端 LOCKED_PANS 里的 xunlei。
 */
const XUNLEI_LOCKED = (Deno.env.get("XUNLEI_LOCKED") ?? "true").toLowerCase() !== "false";
const XUNLEI_LOCKED_MSG = "迅雷云盘正在适配中，暂未开放使用";

/** 锁定中的网盘 → 统一错误文案（null = 可用） */
function panLockedMsg(pan: string): string | null {
  return XUNLEI_LOCKED && pan === "xunlei" ? XUNLEI_LOCKED_MSG : null;
}

const PAN_HOSTS: Array<{ re: RegExp; pan: string }> = [
  { re: /(^|\.)guangyapan\.com$/i, pan: "guangya" },
  { re: /(^|\.)(pan\.quark\.cn|quark\.cn)$/i, pan: "quark" },
  // UC 网盘：分享域名是 drive.uc.cn（接口域名 pc-api.uc.cn 不会出现在分享链接里）
  { re: /(^|\.)(drive\.uc\.cn|pc-api\.uc\.cn)$/i, pan: "uc" },
  { re: /(^|\.)(pan\.baidu\.com|yun\.baidu\.com)$/i, pan: "baidu" },
  { re: /(^|\.)pan\.xunlei\.com$/i, pan: "xunlei" },
  // 123 云盘：分享跑在 https://<分享号>.share.123pan.cn，主站 yun.123pan.com
  { re: /(^|\.)(share\.123pan\.cn|123pan\.com|123865\.com|123684\.com|123912\.com)$/i, pan: "p123" },
];

/** 仍不支持的网盘（123 已转正，见 PAN_HOSTS） */
const OTHER_PAN_HOSTS =
  /(115\.com|anxia\.com|aliyundrive\.com|alipan\.com|cloud\.189\.cn)/i;

function detectPan(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    for (const h of PAN_HOSTS) if (h.re.test(host)) return h.pan;
  } catch { /* ignore */ }
  return null;
}

/** 归一化分享链接（去掉追踪参数，保留 pwd；用于去重指纹） */
function normalizeShareUrl(raw: string): string {
  let url = raw.trim().replace(/[)\],.;。，、]+$/, "");
  try {
    const u = new URL(url);
    u.hash = "";
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) if (/^(pwd|password|passcode|code)$/i.test(k)) keep.set(k, v);
    u.search = keep.toString();
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 提取提取码：优先看链接「紧后面」的文字（80 字符内），找不到再看链接前面 60 字符。
 * 不能只在链接前后各取 200 字符，否则同一页面里相邻条目的提取码会串（取到上一条的）。
 */
function extractPasscode(after: string, before: string): string | null {
  // 兼容 JSON 写法："pwd":"ab12"，因此允许分隔符两侧出现引号
  const re = /(?:提取码|访问码|密码|passcode|pwd)\s*["']?\s*[:：=]?\s*["']?\s*([A-Za-z0-9]{4})/i;
  const mAfter = re.exec(after.slice(0, 80));
  if (mAfter) return mAfter[1];
  // 回退窗口要短：太长会把上一条目的提取码带进来
  const mBefore = re.exec(before.slice(-25));
  return mBefore ? mBefore[1] : null;
}

/**
 * 从链接自身的查询参数里取提取码：百度 / 夸克的「复制链接」都会带 ?pwd=xxxx
 * （例：https://pan.baidu.com/s/1YnB-L5PmqdBcq9PjR9Z-Tw?pwd=8888）。
 * 这种分享不带提取码进不去（百度会报 -9 / 需要验证），所以必须优先认链接自带的这个值。
 * 兼容 #pwd=xxxx 与 &pwd=xxxx（混在其它参数里）。
 */
function passcodeFromUrl(url: string): string | null {
  if (!url) return null;
  const m = /[?&#](?:pwd|password|passcode|code)=([A-Za-z0-9]{1,16})/i.exec(url);
  return m ? m[1] : null;
}

/** 从标题解析集数：中文「更新至第N集 / 全N集」，英文 EP12 / S01E12 / 24 eps */
function parseEpisodeCount(title: string): number {
  const patterns = [
    /更新[至到]第?\s*(\d+)\s*集/,
    /全\s*(\d+)\s*集/,
    /第\s*(\d+)\s*集/,
    /共\s*(\d+)\s*集/,
    /\bS\d{1,2}\s*E0*(\d{1,3})\b/i,
    /\bE(?:P)?\s*0*(\d{1,3})\b/i,
    /(\d{1,3})\s*(?:eps?|episodes?)\b/i,
    // 兜底：文件名里常见的「xxxS01E03yyy.mp4」（前后直接连着别的字符，没有词边界）
    /[Ss]\d{1,2}\s*[Ee]0*(\d{1,3})/,
  ];
  for (const p of patterns) {
    const m = p.exec(title);
    if (m) return Number(m[1]) || 0;
  }
  return 0;
}

/**
 * 解析「第几季第几集」：明确带季号的写法才回季号，否则 season=null。
 *   明确季号：S01E30 / S1.E30 / 第2季第3集 / 第2部第3集
 *   其它一律交给 parseEpisodeCount（EP13 / 第13集 / 13集 …），season 记 null —— 不能把
 *   「第13集」当成第一季，否则一个多季分享会被误判成单季。
 */
/** 中文数字转整数（一~九十九）：第一季 / 第二部 这类季号的常见写法 */
function cnNumToInt(s: string): number {
  const t = (s ?? "").trim();
  if (/^\d+$/.test(t)) return Number(t);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const m = /^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/.exec(t);
  if (m) return (m[1] ? digits[m[1]] : 1) * 10 + (m[2] ? digits[m[2]] : 0);
  return digits[t] ?? 0;
}

function parseEpisodeWithSeason(name: string): { season: number | null; episode: number } | null {
  const s1 = /S(\d{1,2})\s*[._\-\s]?\s*E(?:P)?\s*(\d{1,3})/i.exec(name);
  if (s1) {
    const e = Number(s1[2]);
    if (e > 0) return { season: Number(s1[1]), episode: e };
  }
  // 中文季号：第一季 / 第二部 / 第2季（季号可以是中文数字），集号在季号后面找
  const s2 = /第\s*([一二两三四五六七八九十\d]{1,3})\s*(?:季|部)/.exec(name);
  if (s2) {
    const season = cnNumToInt(s2[1]);
    const rest = name.slice(s2.index + s2[0].length);
    const epHit =
      /第\s*([一二两三四五六七八九十\d]{1,4})\s*[集话話]/.exec(rest) ??
      /E(?:P)?\s*0*(\d{1,3})\b/i.exec(rest) ??
      /(\d{1,3})\s*[集话話]/.exec(rest);
    const ep = epHit ? cnNumToInt(epHit[1]) : 0;
    if (season > 0 && ep > 0) return { season, episode: ep };
  }
  const e = parseEpisodeCount(name);
  return e > 0 ? { season: null, episode: e } : null;
}

/**
 * 一批文件里的「集数」（S01E13 / EP13 / 第13集 …）。
 * 订阅更新后集数按它对齐：老 12 集、新增 S01E13/S01E14 → 14。
 *
 * **多季分享必须按「最大季」取**：分享里同时有 S01E30 与 S02E03 时，按全局最大值会算成 30，
 * 于是把资源集数改错（实际最新是第 2 季第 3 集）。规则：
 *   出现 ≥2 个不同季号 → 取「最大季」里的最大集（并把季号一起返回，用于写清备注）；
 *   只出现一个季号 / 解析不出季号（S01E30 + EP05 之类）→ 保持旧行为（全局最大集号）。
 * 完全解析不出来时返回 0，由调用方退回按文件数计算。
 */
function maxEpisodeInfoOf(files: ShareFile[]): { season: number | null; episode: number } {
  const maxInSeason = new Map<number, number>(); // 季号 → 该季最大集
  const seasons = new Set<number>();
  let overall = 0; // 不分季时的最大集（也是单季/无季号时的结果，保持旧行为）
  for (const f of files) {
    const p = parseEpisodeWithSeason(f.name);
    if (!p) continue;
    if (p.episode > overall) overall = p.episode;
    if (p.season != null) {
      seasons.add(p.season);
      if (p.episode > (maxInSeason.get(p.season) ?? 0)) maxInSeason.set(p.season, p.episode);
    }
  }
  if (seasons.size >= 2) {
    const topSeason = Math.max(...seasons);
    const ep = maxInSeason.get(topSeason) ?? 0;
    // 最大季里解析不出集号（例如只有目录名带季号）→ 退回旧的全局最大值，别把集数改小
    if (ep > 0) return { season: topSeason, episode: ep };
  }
  return { season: null, episode: overall };
}

/** 备注里的「最新第几集」文案：多季时带上季号，避免看起来像集数变小了 */
function episodeLabel(info: { season: number | null; episode: number }): string {
  if (info.episode <= 0) return "";
  return info.season ? `第 ${info.season} 季第 ${info.episode} 集` : `第 ${info.episode} 集`;
}

/**
 * 标题是否表示已完结。
 * 先剔除「完结季 / 最终季 / 最后季」这类**季名**再判断：分享方常把"最后一季"写成「XX·完结季」，
 * 但整部剧仍在更新 —— 实测「一念永恒·完结季」更新到第179集，却被判成整部完结，
 * 用户手动移回「更新中」后每次检查又被移回去（自动完结误判，反复发生）。
 * 剔除后若仍含「全集 / 全N集 / 完结 / 已完」等，才算真完结（「XX 完结季 全集」仍会正确判定）。
 */
function looksFinished(title: string): boolean {
  const t = title.replace(/(完结|最终|最后)\s*季/gi, "");
  return /(完结|全集|全\s*\d+\s*集|已完|\bEND\b|\bcomplete[d]?\b|\bfinished\b)/i.test(t);
}

/** 判定完结后延迟多久自动删除订阅（需求：1 小时） */
const FINISH_DELETE_DELAY_MS = 60 * 60_000;

/**
 * 集数段的正则（按优先级）：覆盖「更新至第18集 / 更至第18集 / 更新第18集 / 第 18 集 / 第 8 话 / S01E12」。
 * 用数组而不是一个可选前缀的大正则：后者会把「某剧 S01E12」前面的空格一起吃掉，改名后连成「某剧已完结全…」。
 */
const EPISODE_PHRASE_RES = [
  /(?:更新\s*[至到]?|更至)\s*(?:第?\s*\d+\s*[集话話]|S\d{1,2}\s*E\d{1,3})/i,
  /第\s*\d+\s*[集话話]/i,
  /S\d{1,2}\s*E\d{1,3}/i,
];

/** 把名字里的集数段替换成 tail；没有集数段时追加到末尾 */
function replaceEpisodePhrase(name: string, tail: string): string {
  for (const re of EPISODE_PHRASE_RES) if (re.test(name)) return name.replace(re, tail);
  return `${name} ${tail}`;
}

/**
 * 资源名 → 完结态名称（需求①的示例：`雷霆令 2026 更新第18集 2160P SDR` + 全集 30 →
 * `雷霆令 2026 已完结全30集 2160P SDR`）。
 * 名字里没有集数段时把「已完结全N集」追加到末尾 —— 不能什么都不改，否则推给站点的标题看不出已完结。
 */
function finishedName(name: string, total: number): string {
  if (/已完结/.test(name)) return name;
  return replaceEpisodePhrase(name, `已完结全${total}集`);
}

// ───────────────────────── 解析：RSS / 网页 ─────────────────────────

interface Candidate {
  title: string;
  shareUrl: string;
  sharePasscode: string | null;
  pan: string | null;
  sourceUrl: string | null;
  /**
   * 指纹覆盖值。分享目录订阅时同一分享里的多个条目共用分享链接，
   * 必须用「分享链接#条目ID」区分，否则条目之间会互相顶掉。
   */
  fingerprintKey?: string;
}

function isFeed(text: string, contentType: string): boolean {
  if (/xml|rss|atom/i.test(contentType)) return true;
  return /^\s*<\?xml/i.test(text) || /<rss[\s>]/i.test(text) || /<feed[\s>]/i.test(text);
}

function pickTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  if (!m) return "";
  return stripTags(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
}

function pickLink(block: string): string | null {
  const alt = /<link[^>]*href=["']([^"']+)["'][^>]*>/i.exec(block);   // atom
  if (alt) return alt[1];
  const plain = /<link[^>]*>([\s\S]*?)<\/link>/i.exec(block);        // rss
  if (plain) return stripTags(plain[1]) || null;
  const guid = /<guid[^>]*>([\s\S]*?)<\/guid>/i.exec(block);
  return guid ? stripTags(guid[1]) || null : null;
}

/** 解析 RSS / Atom */
function parseFeed(text: string): Candidate[] {
  const blocks = text.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  const out: Candidate[] = [];
  for (const block of blocks) {
    const title = pickTag(block, "title");
    const link = pickLink(block);
    const body = `${pickTag(block, "description")} ${pickTag(block, "content:encoded")} ${pickTag(block, "content")} ${pickTag(block, "summary")}`;
    for (const share of extractPanLinks(`${body} ${block}`)) {
      out.push({
        title: title || share.title || "未命名资源",
        shareUrl: share.url,
        sharePasscode: share.passcode,
        pan: detectPan(share.url),
        sourceUrl: link,
      });
    }
  }
  return out;
}

/**
 * 反转义：JSON 里的 `https:\/\/`、`\u002F`，以及 HTML 实体 `&amp;`。
 * 大量更新站把分享链接放在 <script> 的 JSON 数据里，不反转义就提取不到。
 */
function unescapeDoc(raw: string): string {
  return raw
    .replace(/\\\//g, "/")
    .replace(/\\u002[fF]/g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/");
}

/** 单个 URL 的反转义（用在 href / 属性值上） */
function unescapeUrl(raw: string): string {
  return unescapeDoc(raw).trim();
}

/** 列表页没有直链时，最多跟进多少个详情页 */
const MAX_DETAIL_FOLLOW = 8;

/** <script> 块里出现的分享链接数量（仅用于诊断：区分"没链接"和"链接在 JS 里没解析到"） */
function countScriptLinks(doc: string): number {
  let n = 0;
  for (const block of doc.matchAll(/<script[\s\S]*?<\/script>/gi)) {
    const hits = block[0].match(/https?:\/\/[^\s"'<>()[\]{},]+/gi) ?? [];
    n += hits.filter((u) => detectPan(u)).length;
  }
  return n;
}

/** 就近推断标题：优先 JSON 字段名，其次最近的标签文本 */
function guessTitleBefore(doc: string, idx: number, fallback: string | null): string {
  const window = doc.slice(Math.max(0, idx - 600), idx);
  const jsonKeys = [
    ...window.matchAll(/"(?:name|title|vod_name|vodname|fileName|seriesName|post_title)"\s*:\s*"([^"]{2,80})"/gi),
  ];
  if (jsonKeys.length > 0) {
    const t = stripTags(jsonKeys[jsonKeys.length - 1][1]).trim();
    if (t) return t.slice(0, 120);
  }
  const text = stripTags(window).trim();
  if (text) {
    const last = text.split(/[\n|｜]/).pop()?.trim();
    if (last && last.length >= 2) return last.slice(0, 120);
  }
  return fallback ?? "未命名资源";
}

/**
 * 从一段文本/HTML 中提取所有网盘分享链接（带标题与提取码）。
 * 注意：在「反转义后的原文」上扫描，不先 stripTags —— 否则 <script> 里的链接会被删掉。
 */
function extractPanLinks(raw: string): Array<{ url: string; title: string; passcode: string | null }> {
  const doc = unescapeDoc(raw);
  const results: Array<{ url: string; title: string; passcode: string | null }> = [];
  const seen = new Set<string>();

  // 1) <a href="...">标题</a>
  const anchorRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(doc)) !== null) {
    const href = unescapeUrl(m[1]);
    if (!detectPan(href)) continue;
    const key = normalizeShareUrl(href);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = stripTags(m[2]).slice(0, 120);
    const after = doc.slice(m.index + m[0].length, m.index + m[0].length + 100);
    const before = stripTags(doc.slice(Math.max(0, m.index - 60), m.index));
    // 链接自带的 ?pwd=xxxx 最权威（百度/夸克复制链接就长这样），其次才是链接前后的文字说明
    results.push({ url: href, title, passcode: passcodeFromUrl(href) ?? extractPasscode(after, before) });
  }

  // 2) 裸链接（含 <script> JSON、data-* 属性、纯文本）
  const bareRe = /https?:\/\/[^\s"'<>()[\]{},]+/gi;
  while ((m = bareRe.exec(doc)) !== null) {
    const url = m[0].replace(/[)\],.;。，、]+$/, "");
    if (!detectPan(url)) continue;
    const key = normalizeShareUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const idx = m.index;
    const after = doc.slice(idx + m[0].length, idx + m[0].length + 100);
    const before = doc.slice(Math.max(0, idx - 60), idx);
    results.push({
      url,
      title: guessTitleBefore(doc, idx, null),
      passcode: passcodeFromUrl(url) ?? extractPasscode(after, stripTags(before)),
    });
  }

  return results;
}

/** 从清单页里挑出「详情页」候选（同域、标题像剧名/含更新特征），用于二级页跟进 */
function pickDetailLinks(
  doc: string,
  baseUrl: string,
  limit: number
): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return out;
  }
  const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    const href = unescapeUrl(m[1]).trim();
    const text = stripTags(m[2]).trim();
    if (!href || text.length < 2) continue;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (abs.hostname !== base.hostname) continue; // 只跟进同域
    if (/(\.jpg|\.jpeg|\.png|\.gif|\.webp|\.svg|\.css|\.js|\.zip|\.rar|\.mp4|\.m3u8)$/i.test(abs.pathname)) continue;
    if (detectPan(abs.href)) continue; // 已是分享链接，无需跟进
    if (abs.href.replace(base.origin, "").length <= 1) continue; // 首页/空路径
    const looksLikeItem =
      /(更新|全\s*\d+\s*集|第\s*\d+\s*集|\d{4}|EP\s*\d+|完结|高清|4K|1080|下载)/i.test(text) ||
      text.length >= 4;
    if (!looksLikeItem) continue;
    const key = abs.href.replace(/[?#].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: abs.href, title: text.slice(0, 120) });
    if (out.length >= limit) break;
  }
  return out;
}

/** RSS/Atom 条目（用于条目摘要里没有直链时跟进详情页） */
function feedEntries(doc: string): Array<{ url: string; title: string }> {
  const blocks = doc.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  const out: Array<{ url: string; title: string }> = [];
  for (const b of blocks) {
    const link = pickLink(b);
    if (link && /^https?:/i.test(link)) out.push({ url: link, title: pickTag(b, "title") || "未命名资源" });
  }
  return out;
}

/** 解析网页更新页：网页里通常是「标题 + 分享链接」的列表 */
function parsePage(html: string, pageUrl: string): Candidate[] {
  return extractPanLinks(html).map((s) => ({
    title: s.title || "未命名资源",
    shareUrl: s.url,
    sharePasscode: s.passcode,
    pan: detectPan(s.url),
    sourceUrl: pageUrl,
  }));
}

async function fetchSource(url: string): Promise<{ text: string; contentType: string }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      // 部分站点做防盗链校验，带上自身来源可提高抓取成功率
      Referer: url,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!res.ok) throw new Error(`订阅源返回 HTTP ${res.status}`);
  return { text, contentType };
}

/** 解析诊断信息：让用户/开发者一眼看出「为什么没抓到」 */
interface ParseMeta {
  isFeed: boolean;
  pageTitle: string | null;
  anchorCount: number;
  /** <script> 里的分享链接数（>0 说明链接在 JS 数据里） */
  scriptLinks: number;
  /** 清单页直接命中的分享链接数 */
  directLinks: number;
  /** 疑似详情页数量 */
  detailCandidates: number;
  /** 实际成功抓取的详情页数 */
  detailFollowed: number;
  detailFailed: number;
  /** 详情页里命中的分享链接数 */
  detailLinks: number;
  sampleLinks: string[];
}

interface ParseOutcome {
  candidates: Candidate[];
  meta: ParseMeta;
}

/**
 * 解析订阅源。
 * 清单页/RSS 里没有直链时，自动跟进前 MAX_DETAIL_FOLLOW 个详情页（影视更新站通常把网盘链接放详情页）。
 */
async function parseSource(
  text: string,
  contentType: string,
  sourceUrl: string,
  sourceType: string,
  opts: { followDetail?: boolean } = {}
): Promise<ParseOutcome> {
  const followDetail = opts.followDetail !== false;
  const feed = sourceType === "rss" || (sourceType === "auto" && isFeed(text, contentType));
  const doc = unescapeDoc(text);

  const meta: ParseMeta = {
    isFeed: feed,
    pageTitle: (pickTag(doc, "title") || "").slice(0, 120) || null,
    anchorCount: (doc.match(/<a\s[^>]*href=/gi) ?? []).length,
    scriptLinks: countScriptLinks(doc),
    directLinks: 0,
    detailCandidates: 0,
    detailFollowed: 0,
    detailFailed: 0,
    detailLinks: 0,
    sampleLinks: [],
  };

  const direct = feed ? parseFeed(doc) : parsePage(doc, sourceUrl);
  meta.directLinks = direct.length;
  if (direct.length > 0 || !followDetail) return { candidates: direct, meta };

  // 没有直链 → 二级页跟进
  const details = feed
    ? feedEntries(doc).slice(0, MAX_DETAIL_FOLLOW)
    : pickDetailLinks(doc, sourceUrl, MAX_DETAIL_FOLLOW);
  meta.detailCandidates = details.length;
  meta.sampleLinks = details.slice(0, 8).map((d) => d.url);

  const out: Candidate[] = [];
  for (const d of details) {
    try {
      const { text: detailText } = await fetchSource(d.url);
      meta.detailFollowed++;
      const links = extractPanLinks(detailText);
      meta.detailLinks += links.length;
      for (const s of links) {
        out.push({
          title: d.title && d.title !== "未命名资源" ? d.title : s.title || "未命名资源",
          shareUrl: s.url,
          sharePasscode: s.passcode,
          pan: detectPan(s.url),
          sourceUrl: d.url,
        });
      }
    } catch {
      meta.detailFailed++;
    }
  }
  return { candidates: out, meta };
}

/** 给出「为什么没抓到/为什么被过滤」的可执行提示 */
function parseHint(meta: ParseMeta, total: number, filtered: number): string | null {
  if (total > 0 && filtered === 0) {
    return `解析到 ${total} 条分享链接，但全被「关键字过滤」排除了，请检查关键字是否写得太窄`;
  }
  if (total === 0) {
    if (meta.directLinks === 0 && meta.detailCandidates === 0) {
      return meta.scriptLinks > 0
        ? `页面里有 ${meta.scriptLinks} 个分享链接但藏在 JS 数据里，未能解析——请把该源地址发我，我按这个站的结构适配`
        : `页面里没有网盘分享链接，也没找到可跟进的详情页（共 ${meta.anchorCount} 个链接）——这类页面多为 JS 动态渲染，需要改填该站的 RSS 或接口地址`;
    }
    if (meta.detailCandidates > 0 && meta.detailFollowed === 0) {
      return `找到 ${meta.detailCandidates} 个疑似详情页但全部抓取失败（可能需要登录或有反爬限制）`;
    }
    if (meta.detailFollowed > 0 && meta.detailLinks === 0) {
      return `已跟进 ${meta.detailFollowed} 个详情页，但页面里没有分享链接（链接可能由 JS 加载或需要登录）`;
    }
  }
  return null;
}

/** 关键字过滤（多个用 | 分隔） */
function matchKeyword(title: string, keyword: string | null): boolean {
  if (!keyword?.trim()) return true;
  const parts = keyword.split("|").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return true;
  return parts.some((p) => title.toLowerCase().includes(p.toLowerCase()));
}

function fingerprintOf(c: Candidate): string {
  return c.fingerprintKey ?? normalizeShareUrl(c.shareUrl);
}

// ───────────────────────── 网盘转存适配器 ─────────────────────────

interface TransferResult {
  ok: boolean;
  /** 转存后「自己的分享链接」：夸克可生成；光鸭开放平台暂无创建分享接口，故为空 */
  shareUrl?: string;
  message: string;
  /** 本次转存的文件数 */
  transferred?: number;
  /** 本次提交转存的文件（带原名，用于转存后清洗重命名） */
  files?: ShareFile[];
  /** 夸克：转存任务产出的新 fid（顺序与 files 对应） */
  savedFids?: string[];
  raw?: unknown;
}

interface GypTokens {
  access_token: string;
  refresh_token?: string;
  client_id?: string;
  /** access_token 到期时间（毫秒时间戳）：快到点时提前续期，避免刚好过期白跑一次 */
  expires_at?: number;
}

/** 网盘凭据（Cookie 型 / OAuth 型统一） */
interface PanCred {
  kind: "cookie" | "oauth";
  userId: string;
  cookie?: string;
  tokens?: GypTokens;
  /** 迅雷：OAuth 令牌 + 设备号（drive 接口需要 x-device-id） */
  xunlei?: XlTokens;
  rootDir?: string | null;
  rootDirId?: string | null;
  /** 百度：写操作必需的 bdstoken（随 Cookie 一起存，可自动重取） */
  bdstoken?: string;
  /** 百度：本人 uk（存 cookie_enc 里，能取到就带） */
  uk?: string;
  /** 123 云盘：凭证是 Bearer 令牌（存在 cookie_enc 列里，读取时当 token 用，不是 Cookie） */
  token?: string;
}

/** OAuth 令牌已失效或续期失败——调用方据此标记账号需要重新填令牌 */
class GuangyaAuthError extends Error {}

/**
 * 光鸭业务级限流：HTTP 200，但 msg 是「操作过于频繁，请稍后重试」。
 * 实测并发 50 跑 60 条订阅时约 3% 会撞上它；读操作退避后重试即可恢复，
 * 不能当成「链接失效/目录读不到」直接判失败（写操作仍然不重试，避免重复转存）。
 */
class GuangyaRateLimitError extends Error {}

/** 夸克网盘转存：分享 token → 文件列表 → 保存 → 创建自己的分享 */
async function quarkTransfer(
  cookie: string,
  shareUrl: string,
  passcode: string | null,
  dir: string | null,
  cd: CdCfg = CD_QUARK
): Promise<TransferResult> {
  const shareId = /\/s\/([A-Za-z0-9]+)/.exec(shareUrl)?.[1];
  if (!shareId) return { ok: false, message: "无法从分享链接解析出网盘分享 ID" };

  const base = cd.base;
  const qs = cd.qs;
  const headers = { Cookie: cookie, "Content-Type": "application/json", "User-Agent": UA, Referer: cd.referer };

  try {
    // 1) 分享 token
    const tokenRes = await fetch(`${base}/share/sharepage/token?${qs}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pwd_id: shareId, passcode: passcode ?? "" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const tokenJson = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || tokenJson?.status !== 200) {
      return { ok: false, message: tokenJson?.message || `获取分享信息失败（HTTP ${tokenRes.status}）`, raw: tokenJson };
    }
    const stoken = tokenJson?.data?.stoken as string;

    // 2) 分享文件列表（第一页即可）
    const detailRes = await fetch(
      `${base}/share/sharepage/detail?${qs}&pwd_id=${shareId}&stoken=${encodeURIComponent(stoken)}&pdir_fid=0&force=0&_page=1&_size=100&_fetch_banner=0&_fetch_share=0`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    const detailJson = await detailRes.json().catch(() => null);
    const allFiles = detailJson?.data?.list ?? [];
    if (!allFiles.length) return { ok: false, message: detailJson?.message || "分享内容为空", raw: detailJson };
    // 图片不转存（海报/封面/截图）
    const files = allFiles.filter((f: { file_name?: string }) => !isImageFile(String(f.file_name ?? "")));
    if (!files.length) {
      return { ok: false, message: "分享里只有图片/文本文件，已按设置跳过不转存", raw: detailJson };
    }
    // 记录文件名：转存后清洗重命名要用
    const shareFiles: ShareFile[] = files
      .filter((f: { fid?: string }) => f.fid)
      .map((f: { fid: string; file_name?: string; share_fid_token?: string }) => ({
        id: f.fid,
        name: f.file_name ?? f.fid,
        token: f.share_fid_token ?? null,
      }));

    // 3) 保存到我的网盘（目录为空时用根目录）
    // fid 与 token 必须一一对应：只过滤 token 数组会让两个列表错位，导致夸克报「token校验异常」
    const sendable = shareFiles.filter((f) => f.id && f.token);
    if (sendable.length === 0) {
      return { ok: false, message: "分享文件缺少转存 token，无法转存", raw: detailJson };
    }
    const saveRes = await fetch(`${base}/share/sharepage/save?${qs}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fid_list: sendable.map((f) => f.id),
        fid_token_list: sendable.map((f) => f.token),
        to_pdir_fid: dir || "0",
        pwd_id: shareId,
        stoken,
        pdir_fid: "0",
        scene: "link",
        create_new_folder: false,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const saveJson = await saveRes.json().catch(() => null);
    if (!saveRes.ok || saveJson?.status !== 200) {
      return { ok: false, message: saveJson?.message || `保存到网盘失败（HTTP ${saveRes.status}）`, raw: saveJson };
    }

    // 4) 等待任务完成后创建自己的分享
    const taskId = saveJson?.data?.task_id;
    let savedFids: string[] = [];
    for (let i = 0; i < 8 && taskId; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const tRes = await fetch(`${base}/task?${qs}&task_id=${taskId}&retry_index=${i}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const tJson = await tRes.json().catch(() => null);
      // 判成功顺序与 quarkTransferFiles 一致：先看 save_as 落地结果，再看 status 语义
      const topFids = (tJson?.data?.save_as?.save_as_top_fids ?? []) as string[];
      if (Array.isArray(topFids) && topFids.length > 0) {
        savedFids = topFids;
        break;
      }
      const status = Number(tJson?.data?.status ?? -1);
      if (status === 2) break;
      if (status === 3) {
        return { ok: false, message: `${cd.label}转存任务失败（${JSON.stringify(tJson).slice(0, 200)}）`, raw: tJson };
      }
    }

    const shareRes = await fetch(`${base}/share/create?${qs}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fid_list: savedFids.length ? savedFids : sendable.map((f) => f.id),
        title: "订阅转存",
        url_type: 1,
        expired_type: 1,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const shareJson = await shareRes.json().catch(() => null);
    const shareIdNew = shareJson?.data?.share_id;
    if (!shareIdNew) {
      return { ok: false, message: shareJson?.message || "转存成功但创建分享失败", raw: shareJson };
    }
    return {
      ok: true,
      shareUrl: `${cd.shareHost}/${shareIdNew}`,
      message: `${cd.label}转存成功`,
      files: shareFiles,
      savedFids,
    };
  } catch (e) {
    return { ok: false, message: `${cd.label}转存异常：${(e as Error).message}` };
  }
}

/**
 * 夸克自检（**只读**）：打开分享 + 列顶层文件，验证 Cookie/分享链接可用。
 * 以前自检直接调 transfer(..., dir=null)，会真的把样本分享里的文件转存到
 * 用户网盘根目录（历史事故：根目录出现 S01E11 这类文件）。自检不该有写操作。
 */
async function quarkProbeShare(
  cookie: string,
  shareUrl: string,
  passcode: string | null,
  cd: CdCfg = CD_QUARK
): Promise<{ ok: boolean; message: string; fileCount?: number; sample?: string[] }> {
  const shareId = /\/s\/([A-Za-z0-9]+)/.exec(shareUrl)?.[1];
  if (!shareId) return { ok: false, message: "无法从分享链接解析出网盘分享 ID" };
  const headers = {
    Cookie: cookie,
    "Content-Type": "application/json",
    "User-Agent": UA,
    Referer: cd.referer,
  };
  try {
    const tokenRes = await fetch(`${cd.base}/share/sharepage/token?${cd.qs}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pwd_id: shareId, passcode: passcode ?? "" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const tokenJson = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || tokenJson?.status !== 200) {
      return {
        ok: false,
        message: tokenJson?.message || `获取分享信息失败（HTTP ${tokenRes.status}）`,
      };
    }
    const stoken = String(tokenJson?.data?.stoken ?? "");
    const detailRes = await fetch(
      `${cd.base}/share/sharepage/detail?${cd.qs}&pwd_id=${shareId}&stoken=${encodeURIComponent(stoken)}&pdir_fid=0&force=0&_page=1&_size=100&_fetch_banner=0&_fetch_share=0`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    const detailJson = await detailRes.json().catch(() => null);
    if (!detailRes.ok || detailJson?.status !== 200) {
      return {
        ok: false,
        message: detailJson?.message || `读取分享目录失败（HTTP ${detailRes.status}）`,
      };
    }
    const list = (detailJson?.data?.list ?? []) as Array<Record<string, unknown>>;
    return {
      ok: true,
      message: `${cd.label} Cookie 可用：分享可正常读取（顶层 ${list.length} 项，自检不做任何转存/写操作）`,
      fileCount: list.length,
      sample: list.slice(0, 5).map((x) => String(x.file_name ?? x.fileName ?? "")),
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message || `${cd.label}自检失败` };
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 最近一次续期失败的原因（用于在报错里说清「为什么让你重新填令牌」） */
let gyLastRefreshError: string | null = null;

/** 用 refresh_token 续期并回写（光鸭 refresh_token 会轮换，必须一并保存） */
async function gyRefreshToken(cred: PanCred): Promise<boolean> {
  const t = cred.tokens;
  gyLastRefreshError = null;
  if (!t?.refresh_token) {
    gyLastRefreshError = "没有保存 refresh_token";
    return false;
  }
  try {
    // 续期：account 域 /v1/auth/token，JSON body + X-Action: 401
    // 必须用官方 SDK 硬编码的 client_id（官方插件注释「勿改」）：光鸭账号网关按 client_id
    // 路由，用浏览器 localStorage 里那套 client_id 会被当成未知客户端、直接 404 not_found
    // —— 这正是「用着用着就提示续期失败（原因：not found）」的根因（实测）。
    const payload: Record<string, unknown> = {
      client_id: GY_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
    };
    // 插件实现不带 client_secret；仅机密客户端需要
    if (GY_CLIENT_SECRET) payload.client_secret = GY_CLIENT_SECRET;

    const r = await gyAccountPost("/v1/auth/token", payload, {}, { clientId: GY_CLIENT_ID, action: "401" });
    const d = r.body;
    const at = typeof d.access_token === "string" ? d.access_token : "";
    if (r.status !== 200 || !at) {
      const why = String(d.error_description ?? d.error ?? d.msg ?? `HTTP ${r.status}`);
      // 404/not_found 基本都是 client_id 不对或令牌已失效，直接说清该怎么办
      gyLastRefreshError =
        r.status === 404 || /not[_ ]?found/i.test(why)
          ? "刷新令牌已失效或与官方客户端不匹配，请重新扫码授权登录"
          : why;
      return false;
    }
    t.access_token = at.replace(/^Bearer\s+/i, "").trim();
    // 轮换后的 refresh_token 必须一并保存，否则下一次续期就会失败
    if (typeof d.refresh_token === "string" && d.refresh_token) t.refresh_token = d.refresh_token;
    // client_id 统一成官方值（老数据里可能存的是浏览器那套）
    t.client_id = GY_CLIENT_ID;
    const expiresIn = Number(d.expires_in ?? 0);
    if (expiresIn > 0) t.expires_at = Date.now() + expiresIn * 1000 - 5 * 60_000;
    await admin.rpc("update_pan_oauth_token", {
      p_user_id: cred.userId,
      p_pan: "guangya",
      p_token_json: JSON.stringify(t),
      p_key: CRED_KEY,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 重新读取该用户的光鸭令牌，判断是不是「别的进程刚刚续期并回写了」。
 *
 * 背景：光鸭 refresh_token 一次性轮换，同一个 refresh_token 被并发使用两次时，
 * 第一次成功、第二次必然报 `invalid refresh token ... has been refreshed by other process`。
 * 订阅是并发跑的，于是大量实例拿着同一份旧令牌去续期 → 一部分成功（数据库已更新为新令牌）、
 * 一部分失败。失败的实例以前直接判定「登录已过期」→ mark_pan_account 标记失效 →
 * cred_fail_count 累加到阈值 → 该用户的订阅全被 paused_reason=credential 停掉。
 *
 * 这里在判定失效之前先回读一次：若库里的 refresh_token 与本进程手里这份不同，
 * 说明确实有别的进程刚刷新过，直接采用它再重试，避免把有效账号误判为失效。
 * 返回 true 表示已换上新令牌、可以重试本次请求。
 */
async function gyAdoptFreshToken(cred: PanCred): Promise<boolean> {
  try {
    // 令牌是加密列，只能通过 load_pan_oauth RPC 取明文（与 loadPanCred 同一口径）
    const { data, error } = await admin.rpc("load_pan_oauth", {
      p_user_id: cred.userId,
      p_pan: "guangya",
      p_key: CRED_KEY,
    });
    if (error) return false;
    const row = ((data ?? []) as Array<{ token_json: string | null }>)[0];
    if (!row?.token_json) return false;
    let fresh: GypTokens;
    try {
      fresh = JSON.parse(row.token_json) as GypTokens;
    } catch {
      return false;
    }
    if (!fresh.access_token) return false;
    // 库里的 refresh_token 与本进程这份完全一致 → 说明没人刷新过，续期是真的失败了
    if ((fresh.refresh_token ?? "") === (cred.tokens?.refresh_token ?? "")) return false;
    cred.tokens = {
      ...(cred.tokens ?? {}),
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token ?? cred.tokens?.refresh_token ?? "",
      client_id: fresh.client_id ?? GY_CLIENT_ID,
      expires_at: fresh.expires_at ?? Date.now() + 5 * 60_000,
    };
    console.warn(
      `[gy-token] ${cred.userId.slice(0, 8)}… 续期失败但库中已有更新令牌（其它实例刚刷新过），改用新令牌重试`
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 光鸭 API 调用。
 * 成功码 0；156 = 该文件已转存过，按成功返回。
 * 令牌被拒（code=112 / HTTP 401）→ 续期一次后重试（请求已被服务端拒绝，重试安全）。
 * 超时/网络类错误 → 仅读操作重试；写操作（转存）传 retryTransient:false，避免重复转存。
 */
async function gyCall(
  cred: PanCred,
  path: string,
  body: Record<string, unknown>,
  opts: { retryTransient?: boolean; timeoutMs?: number; attempts?: number } = {}
): Promise<Record<string, unknown>> {
  // 跨境链路会间歇性挂起（同一请求可能 150ms 返回、也可能直接卡死），因此「读」类调用默认
  // 重试 3 次、单次 10 秒；写操作（转存）必须传 retryTransient:false，避免重复转存。
  const retryTransient = opts.retryTransient !== false;
  const attempts = Math.max(1, opts.attempts ?? (retryTransient ? 3 : 1));
  const timeoutMs = opts.timeoutMs ?? (retryTransient ? 10000 : FETCH_TIMEOUT_MS);

  const raw = async () => {
    const token = cred.tokens?.access_token ?? "";
    // 统一经数据库代理（pg_net）发出：Edge 直连光鸭整体超时；
    // client_id 必须与换取令牌时一致（官方插件同样用 X-Client-Id 标识客户端）。
    const r = await gyHttp("api", path, body, {
      bearer: token,
      clientId: cred.tokens?.client_id ?? GY_CLIENT_ID,
      timeoutMs,
    });
    const json = r.body;
    return { http: r.status, json, text: JSON.stringify(json) };
  };

  const normalize = (r: { http: number; json: Record<string, unknown> | null; text: string }) => {
    const code = Number(r.json?.code ?? NaN);
    if (code === 0 || code === 156) return r.json ?? {};
    const msg = String(r.json?.msg ?? r.json?.message ?? "");
    if (msg === "success" || msg === "ok") return r.json ?? {};
    // 令牌失效的判定：112（旧文档）与 117「无效token」（实测过期令牌返回这个）
    // 都要触发续期，否则会把「无效token」原样抛给用户、永远不自动续期。
    if (code === 112 || code === 117 || r.http === 401) {
      throw new GuangyaAuthError(msg || `光鸭令牌失效（code=${Number.isNaN(code) ? r.http : code}）`);
    }
    // 业务级限流：单独成类，交给 gyCall 退避重试（读操作）
    if (/操作过于频繁|过于频繁|too many requests|rate ?limit/i.test(msg)) {
      throw new GuangyaRateLimitError(msg || "光鸭提示操作过于频繁");
    }
    throw new Error(
      msg || `光鸭接口异常：${path}（code=${Number.isNaN(code) ? "-" : code} status=${r.http}）`
    );
  };

  // access_token 快到点就主动续期：避免「刚好过期」时白跑一次 401 再重试
  if (cred.tokens?.refresh_token && cred.tokens.expires_at && Date.now() > cred.tokens.expires_at) {
    await gyRefreshToken(cred);
  }

  let refreshed = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: { http: number; json: Record<string, unknown> | null; text: string };
    try {
      res = await raw();
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      const timedOut = (e as Error)?.name === "TimeoutError" || /timed out/i.test(msg);
      // 超时与连接类错误都按「跨境链路抖动」处理：退避后重试，最后一次才把错误抛出去
      if (retryTransient && attempt < attempts - 1) {
        await wait(600 * (attempt + 1));
        continue;
      }
      // 超时区分说明：光鸭该平台会间歇性无响应（实测同一请求 150ms 与直接挂到超时都出现过），
      // 报错里写清"等多久/哪个接口 + 该怎么办"，避免被误读成参数问题。
      if (timedOut) {
        throw new Error(
          `光鸭接口暂无响应（等待 ${Math.round(timeoutMs / 1000)}s，接口 ${path}）：该平台偶发挂起（疑似短时限流），请隔 1~2 分钟再试`
        );
      }
      throw e;
    }
    try {
      return normalize(res);
    } catch (e) {
      // 业务级限流（「操作过于频繁」）：退避后重试。只有读操作会带 attempts>1，
      // 写操作（转存，attempts=1）不会重试 —— 避免重复转存。
      if (e instanceof GuangyaRateLimitError && attempt < attempts - 1) {
        await wait(2000 * (attempt + 1));
        continue;
      }
      if (e instanceof GuangyaAuthError && !refreshed) {
        refreshed = true;
        if (await gyRefreshToken(cred)) continue;
        // 【防误判失效】光鸭的 refresh_token 是「一次性」的：用掉即轮换，旧值立刻作废
        // （服务端会报 invalid refresh token ... has been refreshed by other process）。
        // 本实例续期失败，很可能只是**别的进程/别的订阅实例**刚用同一个 refresh_token
        // 续期成功、并已把新令牌写回数据库——这时令牌其实完全有效，账号不该被判失效、
        // 订阅更不该被暂停。失败后先把数据库里的最新令牌读回来再试一次。
        const picked = await gyAdoptFreshToken(cred);
        if (picked) continue;
        throw new GuangyaAuthError(
          `光鸭登录已过期且自动续期失败，请到「订阅转存」页重新授权登录${
            gyLastRefreshError ? `（原因：${gyLastRefreshError}）` : ""
          }`
        );
      }
      throw e;
    }
  }
  throw new Error("光鸭请求失败");
}

function gyParseShareId(url: string): string | null {
  // 注意排除 # 片段：浏览器地址栏复制的分享链接常带 `#/share` 后缀，
  // 若把它吞进 shareId，光鸭会返回「分享链接错误」导致整个目录读取失败。
  const m = url.match(/guangyapan\.com\/s\/([^/?#]+)/);
  return m ? m[1] : null;
}

/**
 * 光鸭「读」类调用的公共选项。
 * 配了中继时由中继内部重试一次（同一条 TCP 链路、不吃并发预算），这里就只发一次；
 * 没配中继（走 pg_net）时才在函数侧重试，避免把下面的并发闸和队列拖长。
 */
const GY_READ_OPTS = { timeoutMs: 12000, attempts: GY_RELAY_ON ? 1 : 2 };

/**
 * 光鸭分享令牌的并发闸 + 「同分享合并」。
 * 实测（2026-10-17）该接口在并发突增时会被上游 RST（10s 后 fetch failed），
 * 而多个订阅设成「每 5 分钟」时会同一秒齐发，于是一屏全红。这里：
 *   · 全局限 3 路并发；
 *   · 同一个（用户, 分享）只发一次，其余等同一份结果。
 */
const GY_TOKEN_MAX_CONCURRENCY = 3;
let gyTokenActive = 0;
const gyTokenWaiters: Array<() => void> = [];
const gyTokenInflight = new Map<string, Promise<string>>();

async function withGyTokenSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (gyTokenActive >= GY_TOKEN_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => gyTokenWaiters.push(resolve));
  }
  gyTokenActive++;
  try {
    return await fn();
  } finally {
    gyTokenActive--;
    gyTokenWaiters.shift()?.();
  }
}

async function gyShareAccessToken(cred: PanCred, shareId: string): Promise<string> {
  const key = `${cred.userId}:${shareId}`;
  const hit = gyTokenInflight.get(key);
  if (hit) return await hit;
  const p = withGyTokenSlot(async () => {
    const r = await gyCall(cred, "/userres/v1/get_share_access_token", { shareId }, GY_READ_OPTS);
    const token = (r?.data as Record<string, unknown> | undefined)?.accessToken as string | undefined;
    if (!token) throw new Error("获取光鸭分享访问令牌失败");
    return token;
  });
  gyTokenInflight.set(key, p);
  try {
    return await p;
  } finally {
    gyTokenInflight.delete(key);
  }
}

/**
 * 分享目录列表：必须翻页取全，否则漏读会把已存在文件误判为新增。
 *
 * 关键：光鸭「分享」接口 `/userres/v1/get_share_page_files_list` 是【游标分页】——
 * 请求参数是 `cursor`（偏移量）+ `pageSize`，响应里给 `cursor`（下一个偏移）与 `hasMore`。
 * 实测传 `page` 会被完全忽略：每一页都返回前 pageSize 条（同一批），
 * 于是 243 个文件只拿得到前 200 个 → 订阅永远只同步到第 200 集。
 * （目录接口 `/userres/v1/file/get_file_list` 则是普通 page 分页，两者不同，勿混。）
 */
async function gyListShareFiles(
  cred: PanCred,
  sat: string,
  parentId: string
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let cursor = 0;
  let total = Number.POSITIVE_INFINITY;

  for (let i = 0; i < GY_MAX_LIST_PAGES; i++) {
    const r = await gyCall(
      cred,
      "/userres/v1/get_share_page_files_list",
      { accessToken: sat, parentId, cursor, pageSize: GY_PAGE_SIZE },
      GY_READ_OPTS
    );
    const data = (r?.data ?? {}) as Record<string, unknown>;
    const list = (data.list ?? []) as Array<Record<string, unknown>>;
    const t = Number(data.total ?? NaN);
    if (Number.isFinite(t)) total = t;

    for (const it of list) {
      const id = String(it.fileId ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      all.push(it);
    }

    const next = Number(data.cursor ?? NaN);
    const advanced = Number.isFinite(next) && next > cursor;
    // 停止条件：空页 / 明确没有更多 / 游标未推进（防死循环）/ 已取到 total / 末页不满一页
    if (list.length === 0) break;
    if (data.hasMore === false || !advanced || list.length < GY_PAGE_SIZE) break;
    cursor = next;
    if (all.length >= total) break;
  }
  return all;
}

/** 递归收集分享中的叶子文件 ID（resType=2 为目录） */
async function gyCollectLeafFiles(
  cred: PanCred,
  sat: string,
  parentId: string,
  acc: string[],
  depth = 0
): Promise<void> {
  if (depth > 16) return;
  const list = await gyListShareFiles(cred, sat, parentId);
  for (const item of list) {
    const fileId = String(item.fileId ?? "");
    if (!fileId) continue;
    if (Number(item.resType ?? 1) === 2) await gyCollectLeafFiles(cred, sat, fileId, acc, depth + 1);
    else acc.push(fileId);
  }
}

/** 光鸭令牌失效时标记账号需要重新绑定 */
async function markGuangyaInvalid(cred: PanCred, message: string): Promise<void> {
  await admin.rpc("mark_pan_account", {
    p_user_id: cred.userId,
    p_pan: "guangya",
    p_ok: false,
    p_error: message,
  });
}

/** 光鸭：只转存「指定的这批文件」（分享目录订阅用，避免每次重复转整个分享） */
async function gyTransferFiles(
  cred: PanCred,
  shareUrl: string,
  files: ShareFile[],
  dir: string | null
): Promise<TransferResult> {
  const shareId = gyParseShareId(shareUrl);
  if (!shareId) return { ok: false, message: "无法从链接解析出光鸭分享 ID" };
  if (files.length === 0) return { ok: false, message: "没有需要转存的文件" };
  // 去重：同一个物理文件可能以不同名字出现在分享的多个位置（顶层 + 子目录），
  // 它们的 fileId 相同、显示名不同，目录差集据此无法识别为同一文件，会导致同一批里出现重复 id，
  // 光鸭 restore_share 收到重复 id 会整体拒收并回报「文件不存在」。按 fileId 去重避免该问题。
  const uniqFiles = files.filter((f, i) => files.findIndex((x) => x.id === f.id) === i);
  try {
    const sat = await gyShareAccessToken(cred, shareId);
    const parentId = dir || cred.rootDirId || "";
    // 绝不在「没有目标目录」时把文件写进网盘根目录：空 parentId 在光鸭就等于根目录，
    // 会在用户根目录里留下一堆文件（历史事故：根目录出现 S01E11 这种文件）。
    // 宁可不转存并报错，让用户先去选转存目录。
    if (!parentId) {
      return {
        ok: false,
        message:
          "没有可用的转存目录（订阅未设转存目录、账号也没记录默认目录）：为避免文件落进网盘根目录，本次不转存，请先在订阅里选择转存目录",
      };
    }
    // 写操作：单次请求不重试（避免重复转存）；fileIds 过多时一次性传入会被光鸭截断/拒绝，
    // 因此按 GY_TRANSFER_BATCH 分批调用，每批 ≤50、逐批累计。
    // 注意：光鸭 restore_share 真实参数仅为 accessToken + fileIds + parentId（见调研报告 3.3），
    // 子目录里的文件也只需 fileId，无需、也不能额外传 share_fid_token 等字段，否则会被整体拒收。
    let done = 0;
    const failed: string[] = [];
    for (let i = 0; i < uniqFiles.length; i += GY_TRANSFER_BATCH) {
      const batch = uniqFiles.slice(i, i + GY_TRANSFER_BATCH);
      try {
        // retryTransient:false 仅禁用「超时/网络」重试；112（令牌过期）/401 由 gyCall 内部续期后再安全重试
        const r = await gyCall(
          cred,
          "/userres/v1/restore_share",
          { accessToken: sat, fileIds: batch.map((f) => f.id), parentId },
          { retryTransient: false }
        );
        const taskId = (r?.data as Record<string, unknown> | undefined)?.taskId as string | undefined;
        if (taskId) done += batch.length;
        else {
          // 没返回 taskId：视为该批未成功（code=156 已转存过也走成功分支，这里只兜底）
          done += batch.length;
        }
      } catch (e) {
        if (e instanceof GuangyaAuthError) { await markGuangyaInvalid(cred, e.message); throw e; }
        failed.push((e as Error).message);
      }
    }
    if (failed.length > 0) {
      return {
        ok: done > 0,
        transferred: done,
        message: `已转存 ${done}/${uniqFiles.length} 个文件（${failed.length} 批失败：${failed[0]}）`,
      };
    }
    return {
      ok: true,
      transferred: done,
      message: `已转存 ${done} 个文件到光鸭网盘`,
    };
  } catch (e) {
    if (e instanceof GuangyaAuthError) await markGuangyaInvalid(cred, e.message);
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * 光鸭转存（整份分享）：分享令牌 → 收集叶子文件 → restore_share 到目标目录。
 * 光鸭开放平台暂无「创建分享」接口，因此转存后不产生自己的分享链接，
 * 入库仍使用源分享链接（文件已实际落到你的网盘，源链接失效也不影响已转存的文件）。
 */
async function guangyaTransfer(
  cred: PanCred,
  shareUrl: string,
  _passcode: string | null,
  dir: string | null
): Promise<TransferResult> {
  const shareId = gyParseShareId(shareUrl);
  if (!shareId) return { ok: false, message: "无法从链接解析出光鸭分享 ID" };
  try {
    const sat = await gyShareAccessToken(cred, shareId);
    const all: ShareFile[] = [];
    await gyCollectLeafFilesNamed(cred, sat, "", all);
    // 图片与文本一律不转存（海报/封面/截图、说明/字幕/清单）
    const { files, skipped } = dropNonContent(all);
    if (files.length === 0) {
      return {
        ok: false,
        message:
          skipped > 0
            ? `分享里只有 ${skipped} 个图片文件，已按设置跳过不转存`
            : "分享中未找到可转存的文件",
      };
    }
    const r = await gyTransferFiles(cred, shareUrl, files, dir);
    return { ...r, files };
  } catch (e) {
    if (e instanceof GuangyaAuthError) await markGuangyaInvalid(cred, e.message);
    return { ok: false, message: (e as Error).message };
  }
}

async function transfer(
  pan: string,
  cred: PanCred,
  shareUrl: string,
  passcode: string | null,
  dir: string | null
): Promise<TransferResult> {
  // 空目录一律拒绝：光鸭的空 parentId 与夸克的 "0" 都是「网盘根目录」，
  // 传 null 会把整份分享倒进用户根目录（历史事故：根目录出现 S01E11 这类文件）。
  // 统一在这里兜住，任何调用方都不会再「静默落根目录」。
  const target = dir || cred.rootDirId || cred.rootDir || null;
  if (!target) {
    return {
      ok: false,
      message:
        "没有可用的转存目录（订阅未设转存目录、账号也没记录默认目录）：为避免文件落进网盘根目录，本次不转存，请先在订阅里选择转存目录",
    };
  }
  // 提取码：库里存的为空时，认链接自带的 ?pwd=xxxx（百度/夸克复制链接常见写法）
  const pwd = (passcode ?? "").trim() || passcodeFromUrl(shareUrl);
  if (pan === "quark") return quarkTransfer(cred.cookie ?? "", shareUrl, pwd, target);
  if (pan === "uc") return quarkTransfer(cred.cookie ?? "", shareUrl, pwd, target, CD_UC);
  if (pan === "guangya") return guangyaTransfer(cred, shareUrl, pwd, target);
  if (pan === "baidu") return baiduTransfer(cred, shareUrl, pwd, target);
  if (pan === "p123") return p123Transfer(cred.token ?? "", shareUrl, pwd, target);
  const lockMsg = panLockedMsg(pan);
  if (lockMsg) return { ok: false, message: lockMsg };
  if (pan === "xunlei") return xunleiTransfer(cred, shareUrl, pwd, target);
  return { ok: false, message: `暂不支持的网盘：${pan}` };
}

// ───────────── 迅雷云盘（OAuth 设备码扫码 + drive Web 接口）─────────────
//
// 凭证：OAuth 2.0 Device Authorization Grant（与光鸭同一套「扫码 → 令牌」），
// 复用 save_pan_oauth / load_pan_oauth（credential_type = 'oauth'）：
//   token_json = { access_token, refresh_token, expires_at, open_id, device_id }
//   · device_id（32 位 hex）是 drive 接口必需请求头 x-device-id，绑定时生成后随令牌一起存；
//   · 过期前 5 分钟用 refresh_token 主动续期，续期失败才提示重新扫码。
//
// drive 接口：https://api-pan.xunlei.com/drive/v1（请求头见《迅雷网盘接口文档》1.4）
//   列目录 GET  /files?parent_id=&usage=DISPLAY&limit=...
//   分享详情 GET /share/detail?share_id=&pass_code=
//   转存     POST /share/restore {share_id, pass_code_token, file_ids, ancestor_ids}
// 说明：分享/转存两个接口官方文档只给到「源码提取」级别（未真实抓包），
// 调用都做了保守处理——失败只回错误信息，不会产生半截数据；参数若与线上有出入，
// 报错信息里会带上迅雷原始 error/error_description，便于快速修正。
const XL_AUTH = "https://xluser-ssl.xunlei.com";
const XL_DRIVE = "https://api-pan.xunlei.com/drive/v1";
/** OAuth 授权页 client_id（设备码 / 令牌接口专用） */
const XL_OAUTH_CLIENT_ID = "XW5SkOhLDjnOZP7J";
/** 网盘主站 client_id（drive 接口 x-client-id） */
const XL_DRIVE_CLIENT_ID = "Xqp0kJBXWhwaTpB6";
/** 官方 Web 端申请的 scope：带 offline 才能拿到 refresh_token */
const XL_SCOPE = "user pan profile offline";

interface XlTokens {
  access_token: string;
  refresh_token?: string;
  /** access_token 到期时间（毫秒时间戳）；提前 5 分钟续期 */
  expires_at?: number;
  open_id?: string;
  /** drive 接口必需：32 位小写 hex */
  device_id?: string;
  /**
   * 客户端身份（令牌绑定模式下由用户自己的客户端提供）。
   * 迅雷的 drive 接口按「client_id + device_id」查设备档案，档案是在客户端登录时建立的；
   * 服务端扫码（设备码 OAuth）建不了档案，只能用用户已注册设备的那套身份，否则一律
   * 400 captcha_invalid（error_details: "no client info found"）。
   */
  client_id?: string;
  client_version?: string;
  /** 续期用（Android 客户端要 client_secret，网页端拿不到可不填） */
  client_secret?: string;
  /** 与令牌同源客户端的 UA */
  user_agent?: string;
  /**
   * 风控票种子（ck0.*）：captcha/init 必须用它当种子，新票才继承 client info。
   * 绑定时装用户浏览器那枚，之后每次续期都把新票写回来，形成链条。
   */
  captcha_seed?: string;
  /** 种子最近一次续期时间（毫秒），仅用于排查 */
  captcha_seed_at?: number;
}

/** 迅雷登录态失效（令牌过期且续期失败 / 被踢下线）——调用方据此标记账号需要重新扫码 */
class XunleiAuthError extends Error {}

/** 生成 drive 接口用的设备号（16 字节随机 → 32 位 hex） */
function xlNewDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 当前凭据使用的 client_id：令牌绑定模式下用用户客户端的，扫码模式退回默认值 */
function xlClientId(t?: XlTokens): string {
  return t?.client_id?.trim() || XL_DRIVE_CLIENT_ID;
}

function xlHeaders(t: XlTokens, extra: Record<string, string> = {}): Record<string, string> {
  const ver = t.client_version?.trim();
  return {
    "Content-Type": "application/json",
    "User-Agent": t.user_agent?.trim() || UA,
    "x-client-id": xlClientId(t),
    ...(ver ? { "x-client-version": ver } : {}),
    ...(t.device_id ? { "x-device-id": t.device_id } : {}),
    ...(t.access_token ? { Authorization: `Bearer ${t.access_token}` } : {}),
    ...extra,
  };
}

/**
 * 统一的 JSON 请求（不抛：把 status / json / text 都交给调用方判定）
 *
 * 只对幂等请求（GET/HEAD 与风控票申领）做网络重试：服务器的 IPv6 出口到迅雷是黑的，
 * 偶尔一次 connect 会卡到超时（"Signal timed out"），重试一次基本就恢复；
 * 转存/删除这类非幂等 POST 绝不重试，避免重复操作。
 */
async function xlFetchJson(
  url: string,
  init: RequestInit
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD" || /shield\/captcha\/init/.test(url);
  const attempts = idempotent ? 2 : 1;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch { /* 非 JSON（如 HTML 错误页） */ }
      return { status: res.status, json, text };
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

/** 用 refresh_token 续期并回写（迅雷 refresh_token 会轮换，必须一并保存） */
async function xlRefreshToken(cred: PanCred): Promise<boolean> {
  const t = cred.xunlei;
  if (!t?.refresh_token) return false;
  try {
    const r = await xlFetchJson(`${XL_AUTH}/v1/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": t.user_agent?.trim() || UA },
      body: JSON.stringify({
        // 续期必须用令牌所属的 client（令牌绑定模式下来自用户自己的客户端）
        client_id: t.client_id?.trim() || XL_OAUTH_CLIENT_ID,
        ...(t.client_secret ? { client_secret: t.client_secret } : {}),
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
      }),
    });
    const at = typeof r.json?.access_token === "string" ? r.json.access_token : "";
    if (r.status !== 200 || !at) return false;
    t.access_token = at.replace(/^Bearer\s+/i, "").trim();
    if (typeof r.json?.refresh_token === "string" && r.json.refresh_token) t.refresh_token = r.json.refresh_token;
    const exp = Number(r.json?.expires_in ?? 0);
    if (exp > 0) t.expires_at = Date.now() + exp * 1000 - 5 * 60_000;
    await admin.rpc("update_pan_oauth_token", {
      p_user_id: cred.userId,
      p_pan: "xunlei",
      p_token_json: JSON.stringify(t),
      p_key: CRED_KEY,
    });
    return true;
  } catch {
    return false;
  }
}

/** 取可用令牌（快过期就提前续期） */
async function xlEnsureToken(cred: PanCred): Promise<XlTokens> {
  const t = cred.xunlei;
  if (!t?.access_token) throw new XunleiAuthError("迅雷登录态缺失，请到「网盘账号」重新扫码绑定");
  if (t.expires_at && t.expires_at - Date.now() < 5 * 60_000 && t.refresh_token) {
    await xlRefreshToken(cred);
  }
  return cred.xunlei!;
}

/**
 * 迅雷风控令牌：drive 接口必须带 x-captcha-token（`ck0.` 前缀，5 分钟有效）。
 * 取法：POST xluser-ssl.xunlei.com/v1/shield/captcha/init
 *   { client_id, action: "方法:路径", device_id, captcha_token: "", meta: {} }
 * 令牌与 device_id + action 绑定，所以按「设备+操作」做短缓存，过期自动重新申请。
 * 不带的后果实测为：{"error":"...","error_description":"验证码无效"}。
 */
const XL_CAPTCHA_CACHE = new Map<string, { token: string; exp: number }>();

async function xlCaptchaToken(t: XlTokens, action: string, force = false): Promise<string> {
  const deviceId = t.device_id ?? "";
  const clientId = xlClientId(t);
  const ver = t.client_version?.trim();
  const key = `${clientId}|${deviceId}|${action}`;
  if (!force) {
    const hit = XL_CAPTCHA_CACHE.get(key);
    if (hit && hit.exp > Date.now()) return hit.token;
  }
  try {
    const r = await xlFetchJson(`${XL_AUTH}/v1/shield/captcha/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": t.user_agent?.trim() || UA,
        "x-client-id": clientId,
        ...(ver ? { "x-client-version": ver } : {}),
        ...(deviceId ? { "x-device-id": deviceId } : {}),
        ...(t.access_token ? { Authorization: `Bearer ${t.access_token}` } : {}),
      },
      body: JSON.stringify({
        client_id: clientId,
        action,
        device_id: deviceId,
        /**
         * 关键：种子票。实测（2026-10-17，真实账号）同一套四件套下——
         *   seed=""      → 新票调 /files 返回 400 captcha_invalid（detail: no client info found）
         *   seed=有效票   → 新票调 /files 返回 200
         * 迅雷靠种子把 client info 继承给新票；空种子发出来的票永远"查无档案"。
         * 所以这里必须带上一枚（绑定时的浏览器票 → 之后链式续期，每枚新票都当下一轮的种子）。
         */
        captcha_token: t.captcha_seed?.trim() ?? "",
        meta: ver ? { client_version: ver } : {},
      }),
    });
    const token = String(r.json?.captcha_token ?? "");
    if (!token) return "";
    // 新票回写为下一轮的种子（内存里立刻生效，调用方可再回写数据库）
    t.captcha_seed = token;
    t.captcha_seed_at = Date.now();
    const ttl = Math.max(60, Number(r.json?.expires_in ?? 300)) * 1000;
    XL_CAPTCHA_CACHE.set(key, { token, exp: Date.now() + Math.max(30_000, ttl - 30_000) });
    return token;
  } catch {
    return "";
  }
}

/** 把续期后的风控种子写回数据库（不阻塞调用；失败只影响下次能不能续上） */
async function xlSaveSeed(cred: PanCred, t: XlTokens): Promise<void> {
  try {
    await admin.rpc("update_pan_oauth_token", {
      p_user_id: cred.userId,
      p_pan: "xunlei",
      p_token_json: JSON.stringify(t),
      p_key: CRED_KEY,
    });
  } catch { /* 忽略：种子仍在内存缓存里可用 */ }
}

/** 调 drive 接口：自动补风控令牌；401 自动续期；验证码无效时换新令牌重试一次 */
async function xlCall(cred: PanCred, path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const t = await xlEnsureToken(cred);
  const action = `${String(init.method ?? "GET").toUpperCase()}:${path.split("?")[0]}`;
  const run = async (tk: XlTokens, captcha: string) =>
    xlFetchJson(`${XL_DRIVE}${path}`, {
      ...init,
      headers: {
        ...xlHeaders(tk),
        ...(captcha ? { "x-captcha-token": captcha } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** 续期后的种子写回数据库，保证下次（甚至换个实例）还能接着链上 */
  const persistSeed = () => {
    if (!t.captcha_seed) return;
    const p = xlSaveSeed(cred, t);
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
    else void p;
  };

  let captcha = tk_device(t) ? await xlCaptchaToken(t, action) : "";
  persistSeed();
  let r = await run(t, captcha);

  // 风控：验证码无效 / 需要验证码 → 重新申请令牌再试一次
  const errOf = (x: typeof r) => String(x.json?.error_description ?? x.json?.error ?? "");
  if (/验证码|captcha/i.test(errOf(r)) && t.device_id) {
    captcha = await xlCaptchaToken(t, action, true);
    persistSeed();
    r = await run(t, captcha);
  }

  if (r.status === 401) {
    if (!(await xlRefreshToken(cred))) throw new XunleiAuthError("迅雷登录已失效，请重新绑定");
    const t2 = cred.xunlei!;
    captcha = t2.device_id ? await xlCaptchaToken(t2, action) : "";
    r = await run(t2, captcha);
  }
  if (r.status === 401) throw new XunleiAuthError("迅雷登录已失效，请重新绑定");
  const err = String(r.json?.error ?? "");
  if (r.status >= 400 || (err && err !== "0")) {
    const msg = String(r.json?.error_description ?? r.json?.message ?? err ?? `HTTP ${r.status}`);
    if (err === "unauthenticated") throw new XunleiAuthError(`迅雷登录已失效：${msg}`);
    if (/验证码|captcha/i.test(msg)) {
      // 设备档案缺失（no client info found）不是「稍后再试」能解决的：必须换成
      // 用户自己客户端那套 client_id + device_id 的令牌，才可能过风控。
      const detail = String(
        ((r.json?.error_details as Array<{ detail?: string }> | undefined) ?? [])[0]?.detail ?? ""
      );
      if (/client info/i.test(detail)) {
        throw new Error(
          "迅雷风控种子已失效（no client info found）：请到「网盘账号 → 迅雷 → 令牌」重新填一次浏览器 localStorage 里的 captcha token（设备 ID 保持同一个即可续上链条）"
        );
      }
      throw new Error(`迅雷风控校验未通过（${msg}）：已自动申请风控令牌重试仍失败，请稍后再试`);
    }
    // 把服务端的 error_details 一起带出来：400「请求参数错误」这类泛化文案只有它能说明是哪个字段
    const details = r.json?.error_details ?? r.json?.details ?? null;
    const tail = details ? `｜${JSON.stringify(details).slice(0, 300)}` : "";
    throw new Error(`迅雷接口异常（${path.split("?")[0]}）：${msg}${tail}`);
  }
  return r.json ?? {};
}

/** 令牌里是否带了设备号（drive 接口必需） */
function tk_device(t: XlTokens): boolean {
  return !!t.device_id;
}

/** 迅雷：登录态校验（只读 /about，成功即令牌可用） */
async function xlAuthCheck(cred: PanCred): Promise<{ ok: boolean; message: string; quota?: unknown }> {
  try {
    const j = await xlCall(cred, "/about", { method: "GET" });
    return { ok: true, message: "登录态有效", quota: j?.quota ?? null };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** 迅雷：列目录（root 用空 parent_id） */
async function xlListDirs(cred: PanCred, parentId: string): Promise<Array<{ id: string; name: string }>> {
  const qs = new URLSearchParams({
    parent_id: (parentId ?? "").trim(),
    usage: "DISPLAY",
    // 迅雷分页参数叫 page_size；早期写成 limit 会被忽略，目录多时只看得到默认条数
    page_size: "100",
    with_audit: "true",
    filters: JSON.stringify({ trashed: { eq: false } }),
  });
  const j = await xlCall(cred, `/files?${qs.toString()}`, { method: "GET" });
  const files = (j.files ?? []) as Array<Record<string, unknown>>;
  return files
    .filter((f) => String(f.kind ?? "") === "drive#folder")
    .map((f) => ({ id: String(f.id ?? ""), name: String(f.name ?? "") }))
    .filter((d) => d.id);
}

/** 迅雷分享链接 → share_id / 提取码：https://pan.xunlei.com/s/VNxxxx?pwd=abcd# */
function xlParseShare(shareUrl: string): { shareId: string; passCode: string } {
  let u: URL;
  try {
    u = new URL(shareUrl);
  } catch {
    throw new Error("不是有效的分享链接");
  }
  const m = /\/s\/([A-Za-z0-9_-]+)/.exec(u.pathname);
  const shareId = m?.[1] ?? "";
  if (!shareId) throw new Error("链接里没有 share_id（应形如 https://pan.xunlei.com/s/xxxx?pwd=abcd）");
  const hash = (u.hash ?? "").replace(/^#/, "");
  const passCode = u.searchParams.get("pwd") ?? new URLSearchParams(hash).get("pwd") ?? "";
  return { shareId, passCode };
}

/** 迅雷：读分享详情（顶层文件 + 转存必需的 pass_code_token） */
async function xlShareDetail(
  cred: PanCred,
  shareUrl: string,
  passcode: string | null
): Promise<{ shareId: string; passCodeToken: string; title: string; files: ShareFile[] }> {
  const { shareId, passCode } = xlParseShare(shareUrl);
  const code = (passcode ?? "").trim() || passCode;
  /**
   * 注意：读分享内容用的是 GET /drive/v1/share（不是 /share/detail）。
   * 实测（2026-10-17，真实链接 https://pan.xunlei.com/s/VP3fQvIsFsFG8gkEFepmRwWjA1?pwd=nxbg）：
   *   GET /share?share_id=..&pass_code=nxbg  → 200，share_status=OK，files=[…]，pass_code_token=…
   *   GET /share/detail?…（pass_code/code/pwd/头都试过）→ share_status=PASS_CODE_EMPTY，files=[]
   * 之前用 /share/detail 一直是「分享里没读到文件」，就是这个原因。
   */
  const j = await xlCall(cred, `/share?${(() => {
    const qs = new URLSearchParams({ share_id: shareId, thumbnail_size: "SIZE_MEDIUM" });
    if (code) qs.set("pass_code", code);
    return qs.toString();
  })()}`, { method: "GET" });

  const status = String(j.share_status ?? "");
  const passCodeToken = String(j.pass_code_token ?? "");
  const raw = (j.files ?? []) as Array<Record<string, unknown>>;
  const files: ShareFile[] = raw.map((f) => ({
    id: String(f.id ?? ""),
    name: String(f.name ?? ""),
    size: Number(f.size ?? 0) || null,
  })).filter((f) => f.id && f.name);

  if (files.length === 0) {
    if (status === "PASS_CODE_EMPTY") throw new Error("该分享需要提取码：请在订阅里填写提取码（或直接在链接后带上 ?pwd=）");
    if (status === "PASS_CODE_ERROR") throw new Error("提取码不对，请核对分享链接里的 pwd");
    if (status === "SHARE_NOT_FOUND" || status === "NOT_FOUND") throw new Error("分享不存在或已被取消（share_status=" + status + "）");
    throw new Error(
      `分享里没读到文件（share_status=${status || "未知"}；链接可能已失效、提取码不对，或该分享需要登录后转存）`
    );
  }
  return { shareId, passCodeToken, title: String(j.title ?? shareId), files };
}

/** 迅雷：列出某目录下的全部条目（含文件），转存后靠它定位刚落地的文件 */
async function xlListChildren(
  cred: PanCred,
  parentId: string
): Promise<Array<{ id: string; name: string; kind: string }>> {
  const qs = new URLSearchParams({
    parent_id: parentId ?? "",
    usage: "DISPLAY",
    page_size: "100",
    with_audit: "true",
    filters: JSON.stringify({ trashed: { eq: false } }),
  });
  const j = await xlCall(cred, `/files?${qs.toString()}`, { method: "GET" });
  return ((j.files ?? []) as Array<Record<string, unknown>>)
    .map((f) => ({ id: String(f.id ?? ""), name: String(f.name ?? ""), kind: String(f.kind ?? "") }))
    .filter((f) => f.id && f.name);
}

/**
 * 迅雷：提交转存，并把结果挪到订阅指定的目录。
 *
 * 实测（2026-10-17，真实分享）：
 *   · `ancestor_ids` 指的是「分享内文件的祖先链」，不是目标目录——传目标目录会报
 *     `invalid file ancestors`；顶层条目必须传空数组。
 *   · restore 因此只会落到「我的转存」，响应里的 file_id 就是那个落地目录。
 *   · 目标目录靠转完之后再搬：`POST /drive/v1/files/{id}/move` + `{to:{parent_id}}`
 *     （PATCH /files/{id} 只认改名，会报「无内容更新」）。
 *   · restore 是异步任务（RESTORE_START），所以要先轮询等文件出现再搬。
 *
 * 耗时约束（2026-10-17 实测报错 "The upstream server is timing out"）：那是 Kong 的
 * proxy_read_timeout（默认 60s）掐断了请求，不是迅雷返回的错误。所以这里所有等待
 * 都必须有上限：落地轮询按「时间预算」而不是固定 12 轮，搬移走并发而不是串行
 * （串行时 100 个文件 = 100 次请求，光 RTT 就能把函数顶到网关超时）。
 * 没等到 / 没搬完的文件仍留在「我的转存」，下一轮按目标目录差集自然会补齐。
 */
/** 落地轮询的总时间预算（restore 通常几秒内就落地） */
const XL_RESTORE_WAIT_MS = Math.max(2_000, Number(Deno.env.get("XL_RESTORE_WAIT_MS") ?? 8_000));
/** 搬移并发数：太高会触发迅雷风控（验证码/限流），4 是实测的温和值 */
const XL_MOVE_CONCURRENCY = Math.max(1, Number(Deno.env.get("XL_MOVE_CONCURRENCY") ?? 4));

/** 并发把文件搬进目标目录；单个失败不阻断（文件仍在「我的转存」） */
async function xlMoveMany(cred: PanCred, ids: string[], dir: string): Promise<void> {
  const queue = [...ids];
  const worker = async () => {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      try {
        await xlCall(cred, `/files/${id}/move`, {
          method: "POST",
          body: JSON.stringify({ to: { parent_id: dir } }),
        });
      } catch { /* 搬移失败不阻断转存结论 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(XL_MOVE_CONCURRENCY, queue.length) }, worker));
}

async function xlRestore(
  cred: PanCred,
  shareId: string,
  passCodeToken: string,
  fileIds: string[],
  dir: string,
  names: string[] = []
): Promise<void> {
  const body: Record<string, unknown> = {
    share_id: shareId,
    file_ids: fileIds,
    ancestor_ids: [],
  };
  if (passCodeToken) body.pass_code_token = passCodeToken;
  const r = await xlCall(cred, "/share/restore", { method: "POST", body: JSON.stringify(body) });

  if (!dir || names.length === 0) return;
  let landing = String(r.file_id ?? "");
  if (!landing) {
    try {
      const root = await xlListChildren(cred, "");
      landing = root.find((c) => c.name === "我的转存")?.id ?? "";
    } catch { /* 找不到落地目录就放弃搬移，文件仍在「我的转存」 */ }
  }
  if (!landing) return;

  const want = new Set(names);
  const found = new Map<string, string>();
  const deadline = Date.now() + XL_RESTORE_WAIT_MS;
  for (;;) {
    try {
      for (const c of await xlListChildren(cred, landing)) {
        if (want.has(c.name)) found.set(c.name, c.id);
      }
    } catch { /* 单次失败继续等 */ }
    if (found.size >= want.size || Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, 800));
  }

  if (found.size === 0) return;
  await xlMoveMany(cred, [...found.values()], dir);
}

/** 迅雷：令牌失效时标记账号需要重新扫码 */
async function markXunleiInvalid(cred: PanCred, message: string): Promise<void> {
  await admin.rpc("mark_pan_account", {
    p_user_id: cred.userId,
    p_pan: "xunlei",
    p_ok: false,
    p_error: message,
  });
}

/** 迅雷：转存整份分享 */
async function xunleiTransfer(
  cred: PanCred,
  shareUrl: string,
  passcode: string | null,
  dir: string
): Promise<TransferResult> {
  try {
    const detail = await xlShareDetail(cred, shareUrl, passcode);
    const only = dropNonContent(detail.files).files;
    if (only.length === 0) return { ok: false, message: "分享中未找到可转存的文件" };
    await xlRestore(cred, detail.shareId, detail.passCodeToken, only.map((f) => f.id), dir, only.map((f) => f.name));
    return { ok: true, transferred: only.length, message: `已转存 ${only.length} 个条目到迅雷云盘`, files: only };
  } catch (e) {
    if (e instanceof XunleiAuthError) await markXunleiInvalid(cred, e.message);
    return { ok: false, message: (e as Error).message };
  }
}

/** 迅雷：转存「指定文件」（分享目录订阅只转新增文件） */
async function xunleiTransferFiles(
  cred: PanCred,
  shareUrl: string,
  passcode: string | null,
  files: ShareFile[],
  dir: string | null
): Promise<TransferResult> {
  try {
    const target = dir || cred.rootDirId || cred.rootDir || "";
    if (!target) return { ok: false, message: "没有可用的转存目录，请先在订阅里选择转存目录" };
    const detail = await xlShareDetail(cred, shareUrl, passcode);
    const want = new Set(files.map((f) => f.id));
    const ids = detail.files.filter((f) => want.has(f.id)).map((f) => f.id);
    const use = ids.length > 0 ? ids : dropNonContent(detail.files).files.map((f) => f.id);
    if (use.length === 0) return { ok: false, message: "没有需要转存的文件" };
    const useSet = new Set(use);
    const useNames = detail.files.filter((f) => useSet.has(f.id)).map((f) => f.name);
    await xlRestore(cred, detail.shareId, detail.passCodeToken, use, target, useNames);
    return { ok: true, transferred: use.length, message: `已转存 ${use.length} 个条目到迅雷云盘` };
  } catch (e) {
    if (e instanceof XunleiAuthError) await markXunleiInvalid(cred, e.message);
    return { ok: false, message: (e as Error).message };
  }
}

/** 迅雷：把整份分享当作一个「顶层条目」（分享目录订阅 / 预览） */
async function xlListShareEntries(
  cred: PanCred,
  shareUrl: string,
  passcode: string | null
): Promise<ShareEntry[]> {
  const detail = await xlShareDetail(cred, shareUrl, passcode);
  const { files, skipped } = dropNonContent(detail.files);
  return [{
    key: detail.shareId,
    title: detail.title || detail.shareId,
    files,
    skippedImages: skipped,
  }];
}

// ───────────── 百度网盘（Web 接口 + 登录 Cookie）─────────────
//
// 凭证（按《百度网盘登录转存凭证接口清单》实现）：
//   用户在浏览器登录 pan.baidu.com 后，把请求头里那一整串 Cookie 粘进来
//   （必须含 BDUSS；带上 STOKEN / PTOKEN / UBI 更稳）。服务端再用它换两个派生凭证：
//     · bdstoken —— 所有写操作（转存 / 建目录 / 改名）必需的 query 参数
//                    GET /api/gettemplatevariable?fields=["bdstoken","uk"]
//     · uk       —— 本人账号 id（能拿到就存，拿不到不影响转存）
//   三者合成 JSON 存进 pan_accounts.cookie_enc（加密列），credential_type = 'cookie'，
//   与夸克同一套 save_pan_account / load_pan_account，不需要新表新列。
//
// 转存链路（真实抓包口径）：
//   1) 解析分享 → shareid / share_uk（转存的 from）/ sekey（= 分享页 BDCLND）
//        · GET /share/wxlist（可带提取码，最快；顺带给 seckey）
//        · 回退抓分享页 HTML 里的 yunData（shareid / share_uk）
//        · 分享有提取码且还没拿到 sekey：POST /share/verify?surl=<去掉前导 1 的短码> → randsk 即 sekey
//          （surl 带前导 1 一律回 105「需要验证码」）
//   2) 列分享目录：GET /share/wxlist（root=1 列根 / dir= 列子目录，num+page 分页，带 pwd）
//        · 注意 /share/list 对带提取码的分享恒回 -9「提取码验证失败」，不能用来列目录
//   3) 转存：POST /share/transfer?shareid=&from=&sekey=&ondup=newcopy&async=1&bdstoken=
//            body: fsidlist=[fs_id...] & path=/目标目录
//   4) 自有网盘：列目录 GET /api/list（回退 /api/filemetas）、建目录 POST /api/create、
//      改名 POST /api/filemanager（这三个是 Web 端同族接口，同样需要 bdstoken）
//
// bdstoken 会随会话变化：接口回 errno=-6（未登录 / 登录态失效）时，自动用 Cookie 重取一次
// 再试一次；仍失败才判「Cookie 失效」，提示用户重新登记。
//
// 注意：百度转存是异步任务，落地后目录里才会出现文件 —— 清洗（改名）要轮询等它出现。

/** 百度登录态失效（Cookie 过期 / bdstoken 取不到）——调用方据此标记账号需要重新登记 */
class BaiduAuthError extends Error {}

const BAIDU_PAN = "https://pan.baidu.com";
/** 网盘 Web 端固定 app_id */
const BAIDU_APP_ID = "250528";
/** 单次列目录上限 */
const BAIDU_LIST_LIMIT = 1000;
/** 分享目录递归深度上限 */
const BAIDU_SHARE_MAX_DEPTH = 6;
/** 单次转存的 fsidlist 上限：超限会被整体拒收，按 100 分批 */
const BAIDU_TRANSFER_BATCH = 100;

/** 百度接口错误码 → 人话（只列常用的，其余原样带上 errno 便于排查） */
const BAIDU_ERRNO_TEXT: Record<number, string> = {
  "-6": "百度登录态失效（Cookie 已过期或 bdstoken 无效）",
  "-7": "文件或目录不存在",
  "-9": "分享提取码错误",
  "-10": "分享链接已失效",
  "-130": "分享需要提取码（未填或已失效）",
  "200025": "分享提取码错误",
  "2": "参数错误",
  "4": "请求被百度拒绝（可能触发风控，稍后重试）",
  "12": "批量操作失败",
  "105": "需要验证码",
  "111": "已有其它转存任务在进行",
  "112": "转存任务进行中",
  "31023": "请求参数错误",
  "31066": "文件不存在",
  "31068": "分享文件已被删除或已转存过",
  "31069": "分享文件不存在",
  "31070": "分享已取消",
  "31075": "转存的文件数量超出上限",
};

function baiduErrText(errno: number, msg?: string): string {
  const code = String(errno);
  const base = BAIDU_ERRNO_TEXT[code] ?? `百度接口错误（errno=${errno}）`;
  const extra = (msg ?? "").trim();
  // 百度有时把 errmsg 写成 "errno code 31066" 这类噪声，只在有信息量时才拼上
  return extra && !extra.includes(`errno code ${errno}`) ? `${base}：${extra}` : base;
}

/** sekey 在分享接口里是 URL 编码过的，转存时要还原 */
function baiduDecodeSeKey(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 解析出来的百度登录凭证 */
interface BaiduCred {
  /** 原始 Cookie 串（必须含 BDUSS） */
  cookie: string;
  /** 写操作必需的 bdstoken（可自动重取） */
  bdstoken: string;
  /** 本人 uk（可空，拿不到不影响转存） */
  uk: string;
}

/** 从 PanCred 里取出百度凭证：cookie_enc 里存的是 {cookie,bdstoken,uk} 的 JSON */
function baiduCredOf(cred: PanCred): BaiduCred {
  const raw = String(cred.cookie ?? "").trim();
  const out: BaiduCred = {
    cookie: raw,
    bdstoken: String(cred.bdstoken ?? "").trim(),
    uk: String(cred.uk ?? "").trim(),
  };
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as { cookie?: string; bdstoken?: string; uk?: string };
      if (j.cookie) out.cookie = String(j.cookie).trim();
      if (j.bdstoken) out.bdstoken = String(j.bdstoken).trim();
      if (j.uk) out.uk = String(j.uk).trim();
    } catch { /* 不是 JSON：按原始 Cookie 串用 */ }
  }
  return out;
}

/**
 * 把百度凭证（Cookie + bdstoken + uk）写回加密列。
 * displayName 只在绑定时传一次：默认传空，靠 save_pan_account 的 COALESCE 保留库里已有的显示名，
 * 免得「刷新 bdstoken」这类自动回写把用户填的账号名冲掉。
 */
async function baiduSaveCred(
  userId: string,
  c: BaiduCred,
  opts: { displayName?: string; rootDir?: string | null } = {}
): Promise<void> {
  const { error } = await admin.rpc("save_pan_account", {
    p_user_id: userId,
    p_pan: "baidu",
    p_username: opts.displayName ?? "",
    p_cookie: JSON.stringify({ cookie: c.cookie, bdstoken: c.bdstoken, uk: c.uk }),
    p_root_dir: opts.rootDir ?? "",
    p_key: CRED_KEY,
  });
  if (error) throw new Error(`保存百度凭据失败：${error.message}`);
}

/** 百度：带 Cookie 的请求头 */
// ───────────── 百度扫码登录（passport 二维码 → BDUSS → 整串 Cookie） ─────────────
//
// 链路（与网页版登录框一致）：
//   1) GET passport /v2/api/getqrcode?lp=pc&qrloginfrom=pc&tpl=netdisk&apiver=v3
//      → {sign, imgurl}，同时下发 BAIDUID 等匿名 Cookie（轮询要带上）
//   2) GET passport /channel/unicast?channel_id=<sign>&tpl=netdisk&apiver=v3&tt=..&callback=cb
//      · 未扫码时百度会把请求挂住（长轮询）→ 超时即视为「继续等」
//      · 已扫码：errno=0，channel_v 里是 {"v":"<BDUSS>","status":0}
//      · 二维码失效：errno=2；channel_id 无效：errno=-1
//   3) 拿到 BDUSS 后访问一次 /disk/home，把响应里的 Set-Cookie（STOKEN/PANWEB…）合并进 Cookie，
//      再用现有的 baiduFetchTokens 换 bdstoken 做一次可用性校验，通不过就不落库。
const BAIDU_PASSPORT = "https://passport.baidu.com";

/** 取响应里的 Set-Cookie：优先用 getSetCookie()，老运行时退化成分隔解析 */
function readSetCookies(h: Headers): string[] {
  const anyH = h as unknown as { getSetCookie?: () => string[] };
  if (typeof anyH.getSetCookie === "function") {
    const list = anyH.getSetCookie();
    if (list && list.length > 0) return list;
  }
  const merged = h.get("set-cookie") ?? "";
  // 合并后的 header 用 ", " 分隔；Expires 里的逗号后面跟的是日期而不是 name=，据此粗切
  return merged ? merged.split(/,\s*(?=[A-Za-z0-9_.-]+=)/) : [];
}

/** 合并 Cookie：base 在前，setCookies 覆盖同名项 */
function cookieMerge(base: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  const put = (raw: string) => {
    const first = raw.split(";")[0].trim();
    const i = first.indexOf("=");
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1));
  };
  for (const part of base.split(";")) if (part.trim()) put(part);
  for (const c of setCookies) put(c);
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** 百度扫码：申请二维码（返回 sign、会话 Cookie、二维码图片地址） */
async function baiduQrStart(): Promise<{ sign: string; cookie: string; qrUrl: string }> {
  const tt = Date.now();
  const res = await fetch(
    `${BAIDU_PASSPORT}/v2/api/getqrcode?lp=pc&qrloginfrom=pc&tpl=netdisk&apiver=v3&tt=${tt}&_=${tt}`,
    {
      headers: { "User-Agent": UA, Referer: `${BAIDU_PAN}/` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }
  );
  const cookie = cookieMerge("", readSetCookies(res.headers));
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const sign = String(j?.sign ?? "");
  if (Number(j?.errno ?? -1) !== 0 || !sign) {
    throw new Error(`百度扫码初始化失败（HTTP ${res.status}）：${JSON.stringify(j ?? {}).slice(0, 120)}`);
  }
  const img = String(j?.imgurl ?? "");
  // imgurl 是相对地址（passport.baidu.com/v2/api/qrcode?sign=...）
  const qrUrl = img.startsWith("http") ? img : `https://${img.replace(/^\/+/, "")}`;
  return { sign, cookie, qrUrl };
}

/**
 * 百度扫码：轮询一次结果（超时 = 还没扫码，继续等）。
 * 扫码确认后百度除了在 channel_v 里给一个短票（v，约 32 位），还可能在
 * **响应头里直接 Set-Cookie 下发完整 BDUSS** —— 所以这里把 Set-Cookie 一起带回去。
 */
async function baiduQrPoll(
  sign: string,
  cookie: string
): Promise<{
  state: "waiting" | "scanned" | "ok" | "expired" | "failed";
  bduss?: string;
  message?: string;
  /** 本次响应下发的 Set-Cookie（可能含完整 BDUSS/STOKEN） */
  setCookies?: string[];
  /** channel_v 解析出的键名，失败时用于排查（不含值） */
  channelKeys?: string[];
}> {
  const tt = Date.now();
  const url = `${BAIDU_PASSPORT}/channel/unicast?channel_id=${encodeURIComponent(sign)}`
    + `&tpl=netdisk&apiver=v3&tt=${tt}&callback=cb&_=${tt}`;
  let text = "";
  let setCookies: string[] = [];
  try {
    // 未扫码时百度会把请求挂住（长轮询）：3.5s 就当「继续等」，别把请求拖成前端超时
    const res = await fetch(url, {
      headers: { Cookie: cookie, "User-Agent": UA, Referer: `${BAIDU_PAN}/` },
      signal: AbortSignal.timeout(3500),
    });
    setCookies = readSetCookies(res.headers);
    text = await res.text().catch(() => "");
  } catch {
    return { state: "waiting" };
  }
  // JSONP：cb({...}) 或 cb({...});
  const body = text.replace(/^[^(]*\(/, "").replace(/\)\s*;?\s*$/, "").trim();
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(body) as Record<string, unknown>; } catch { return { state: "waiting" }; }
  const errno = Number(j?.errno ?? -1);
  if (errno === 1) return { state: "waiting" };
  if (errno === 2) return { state: "expired", setCookies };
  if (errno !== 0) return { state: "failed", message: `百度扫码接口返回 errno=${errno}`, setCookies };

  const cv = String(j?.channel_v ?? "");
  let v = "";
  let status = 0;
  let channelKeys: string[] = [];
  if (cv) {
    try {
      const o = JSON.parse(cv) as Record<string, unknown>;
      channelKeys = Object.keys(o);
      v = String(o.v ?? o.bduss ?? "");
      status = Number(o.status ?? 0);
    } catch { /* channel_v 不是 JSON 就当没拿到 */ }
  }
  if (!v) {
    // status=1：手机已扫码、还没点「确认登录」
    return { state: status === 1 ? "scanned" : "waiting", setCookies, channelKeys };
  }
  return { state: "ok", bduss: v, setCookies, channelKeys };
}

/**
 * 百度：扫码票 → 完整 Cookie。
 * unicast 的 channel_v.v 只是 32 位短票（当 BDUSS 用会回 errno=-6），
 * 必须再走一次 passport 的 bdusslogin：它是 302，Set-Cookie 里给出
 * BDUSS(192)/STOKEN(64)/PTOKEN(32) 等整套登录态。**该票一次性有效**，只能换一次。
 */
async function baiduBdussExchange(ticket: string, baseCookie = ""): Promise<string> {
  const tt = Date.now();
  const url = `${BAIDU_PASSPORT}/v2/api/bdusslogin?bduss=${encodeURIComponent(ticket)}`
    + `&u=${encodeURIComponent(`${BAIDU_PAN}/`)}&tpl=netdisk&apiver=v3&tt=${tt}&subpro=&sug=0&callback=`;
  try {
    const res = await fetch(url, {
      headers: { Cookie: baseCookie, "User-Agent": UA, Referer: `${BAIDU_PAN}/` },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return cookieMerge(baseCookie, readSetCookies(res.headers));
  } catch {
    return baseCookie;
  }
}

/**
 * 百度：用 BDUSS 换整串 Cookie。
 * 关键：/disk/home 收到 BDUSS 后通常是 302，STOKEN 等是同一次跳转的响应头里下发的，
 * 而 fetch 跟随跳转后只保留「最终响应」的 Set-Cookie → 会漏掉 STOKEN。
 * 所以这里手动跟跳转（最多 3 跳），把每一跳的 Set-Cookie 都合并进来。
 */
async function baiduCookieFromBduss(bduss: string, baseCookie = ""): Promise<string> {
  // 扫码会话里可能已经带上了 STOKEN 等，从它起步；BDUSS 用刚拿到的覆盖
  let cookie = cookieMerge(baseCookie, [`BDUSS=${bduss}`]);
  let url = `${BAIDU_PAN}/disk/home`;
  try {
    for (let hop = 0; hop < 3; hop++) {
      const res = await fetch(url, {
        headers: { Cookie: cookie, "User-Agent": UA, Accept: "text/html", Referer: `${BAIDU_PAN}/` },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      cookie = cookieMerge(cookie, readSetCookies(res.headers));
      const loc = res.headers.get("location") ?? "";
      if (!loc) break;
      url = loc.startsWith("http") ? loc : `${BAIDU_PAN}${loc.startsWith("/") ? "" : "/"}${loc}`;
    }
  } catch { /* 网络问题就用手上已有的 Cookie 继续试 */ }
  return cookie;
}

// ───────────── 夸克扫码登录（uop CAS 二维码 → service_ticket → Cookie） ─────────────
//
// 链路（与网页版登录框一致；client_id=532 是 PC Web 端固定值）：
//   1) GET uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=<uuid>
//      → data.members.token（sta 前缀）
//   2) 二维码内容 = su.quark.cn 扫码页 + token/client_id/ssb 等参数（页面模板取自网页版登录组件，
//      所以不用自己编码任何私有协议，扫到的就是官方登录页）
//   3) GET .../getServiceTicketByQrcodeToken?token=<token>...（每 2s 轮询，request_id 必须与第 1 步同值）
//      status=50004001 待扫码 / 50004002 已过期 / 2000000 成功（data.members.service_ticket）
//   4) GET pan.quark.cn/account/info?st=<service_ticket>&lw=scan → 响应头 Set-Cookie 下发整套登录态
//   5) 用 /1/clouddrive/auth/pc/flush 校验（code=0 才有效），再按 Cookie 加密落库
//   service_ticket 短期且一次性：换票前先把 ticket 写回会话，换失败也不会重复换同一张票。
const QUARK_UOP = "https://uop.quark.cn";
const QUARK_PAN = "https://pan.quark.cn";
/** 扫码页模板（网页版登录组件 config.scanLoginPage 的原值） */
const QUARK_SCAN_PAGE = "https://su.quark.cn/4_eMHBJ";
const QUARK_CLIENT_ID = "532";
/** 扫码页业务参数（原样取自网页版登录组件，改了会打到「不支持的环境」页） */
const QUARK_SCAN_BIZ = "S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0";

/** 夸克扫码：token → 二维码内容 */
function quarkQrContent(token: string): string {
  const qs = new URLSearchParams({
    token,
    client_id: QUARK_CLIENT_ID,
    ssb: "weblogin",
    uc_param_str: "",
    uc_biz_str: QUARK_SCAN_BIZ,
  });
  return `${QUARK_SCAN_PAGE}?${qs.toString()}`;
}

/** 夸克扫码：申请二维码（返回二维码 token、同一轮轮询用的 request_id、二维码内容） */
async function quarkQrStart(): Promise<{ token: string; requestId: string; qrUrl: string }> {
  const requestId = crypto.randomUUID();
  const res = await fetch(
    `${QUARK_UOP}/cas/ajax/getTokenForQrcodeLogin?client_id=${QUARK_CLIENT_ID}&v=1.2&request_id=${requestId}`,
    {
      headers: { "User-Agent": UA, Referer: `${QUARK_PAN}/` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }
  );
  const j = (await res.json().catch(() => null)) as
    | { status?: number; message?: string; data?: { members?: { token?: string } } }
    | null;
  const token = String(j?.data?.members?.token ?? "");
  if (Number(j?.status ?? 0) !== 2000000 || !token) {
    throw new Error(
      `夸克扫码初始化失败（HTTP ${res.status}）：${String(j?.message ?? JSON.stringify(j ?? {}).slice(0, 100))}`
    );
  }
  return { token, requestId, qrUrl: quarkQrContent(token) };
}

/** 夸克扫码：轮询一次（50004001 = 还没扫，继续等） */
async function quarkQrPoll(
  token: string,
  requestId: string
): Promise<{ state: "waiting" | "ok" | "expired" | "failed"; ticket?: string; message?: string }> {
  const url = `${QUARK_UOP}/cas/ajax/getServiceTicketByQrcodeToken`
    + `?client_id=${QUARK_CLIENT_ID}&v=1.2&request_id=${encodeURIComponent(requestId)}&token=${encodeURIComponent(token)}`;
  let j: {
    status?: number;
    message?: string;
    data?: { members?: { service_ticket?: string } };
  } | null = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: `${QUARK_PAN}/` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    j = (await res.json().catch(() => null)) as typeof j;
  } catch {
    // 网络抖动按「继续等」处理，别把扫码流程判死
    return { state: "waiting" };
  }
  const status = Number(j?.status ?? 0);
  if (status === 2000000) {
    const ticket = String(j?.data?.members?.service_ticket ?? "");
    if (!ticket) return { state: "failed", message: "扫码已通过，但未取到 service_ticket，请重新扫码" };
    return { state: "ok", ticket };
  }
  if (status === 50004002) return { state: "expired" };
  if (status === 50004001) return { state: "waiting" };
  return {
    state: "failed",
    message: `夸克扫码接口返回 status=${status}${j?.message ? `：${j.message}` : ""}`,
  };
}

/**
 * 夸克：service_ticket → 整串 Cookie。
 * 关键：登录态是 Set-Cookie 写下来的（HttpOnly 也在里面），服务端必须自己收集响应头；
 * 而且 /account/info 可能 302 到 /list 再下发剩余 Cookie，所以手动跟跳转、逐跳合并。
 */
async function quarkCookieFromTicket(
  ticket: string
): Promise<{ cookie: string; nickname: string; code: string; msg: string }> {
  let cookie = "";
  let nickname = "";
  let code = "";
  let msg = "";
  let url = `${QUARK_PAN}/account/info?st=${encodeURIComponent(ticket)}&lw=scan`;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      headers: { Cookie: cookie, "User-Agent": UA, Referer: `${QUARK_PAN}/` },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    cookie = cookieMerge(cookie, readSetCookies(res.headers));
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("json")) {
      const j = (await res.json().catch(() => null)) as
        | { success?: boolean; code?: string; msg?: string; message?: string; data?: { nickname?: string } }
        | null;
      if (j) {
        code = String(j.code ?? "");
        msg = String(j.msg ?? j.message ?? "");
        nickname = String(j.data?.nickname ?? "") || nickname;
      }
    }
    const loc = res.headers.get("location") ?? "";
    if (!loc) break;
    url = loc.startsWith("http") ? loc : `${QUARK_PAN}${loc.startsWith("/") ? "" : "/"}${loc}`;
  }
  return { cookie, nickname, code, msg };
}

// ───────────── UC 扫码登录（api.open.uc.cn CAS 二维码 → service_ticket → Cookie） ─────────────
//
// 链路（《UC网盘接口逆向文档》§2.2，与夸克 CAS 同构，差异只有域名 / client_id / 扫码页）：
//   1) GET api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin?client_id=381&v=1.2&request_id=<uuid>
//   2) 二维码内容 = su.uc.cn 扫码页 + token / client_id / uc_param_str / uc_biz_str（官方登录页，不自造协议）
//   3) GET .../getServiceTicketByQrcodeToken（每 2s 轮询，request_id 必须与第 1 步同值）
//      status=50004001 待扫码 / 50004002 过期 / 2000000 成功（data.members.service_ticket）
//   4) GET drive.uc.cn/account/info?st=<ticket>&fr=pc&platform=pc → 响应头 Set-Cookie 下发整套登录态
//   5) POST pc-api.uc.cn/1/clouddrive/transfer/upload/pdir?pr=UCBrowser&fr=pc（空 body）→ 再补一次
//      Set-Cookie，把 __puus 也拿到（部分接口强依赖它）
// service_ticket 短期且一次性：换票成功先写回会话，换 Cookie 失败也不会重复用同一张票。
const UC_UOP = "https://api.open.uc.cn";
const UC_PAN = "https://drive.uc.cn";
/** 扫码页模板（网页版登录组件的原值） */
const UC_SCAN_PAGE = "https://su.uc.cn/1_n0ZCv";
const UC_CLIENT_ID = "381";
/** 扫码页固定业务参数（原样照抄，改了会跳到「不支持的环境」页） */
const UC_SCAN_PARAM = "dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt";
const UC_SCAN_BIZ = "S:custom|C:titlebar_fix";

/** UC 扫码：token → 二维码内容 */
function ucQrContent(token: string): string {
  const qs = new URLSearchParams({
    uc_param_str: UC_SCAN_PARAM,
    token,
    client_id: UC_CLIENT_ID,
    uc_biz_str: UC_SCAN_BIZ,
  });
  return `${UC_SCAN_PAGE}?${qs.toString()}`;
}

/** UC 扫码：申请二维码（返回二维码 token、同轮轮询用的 request_id、二维码内容） */
async function ucQrStart(): Promise<{ token: string; requestId: string; qrUrl: string }> {
  const requestId = crypto.randomUUID();
  const res = await fetch(
    `${UC_UOP}/cas/ajax/getTokenForQrcodeLogin?client_id=${UC_CLIENT_ID}&v=1.2&request_id=${requestId}`,
    {
      headers: { "User-Agent": UA, Referer: `${UC_PAN}/` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }
  );
  const j = (await res.json().catch(() => null)) as
    | { status?: number; message?: string; data?: { members?: { token?: string } } }
    | null;
  const token = String(j?.data?.members?.token ?? "");
  if (Number(j?.status ?? 0) !== 2000000 || !token) {
    throw new Error(
      `UC 扫码初始化失败（HTTP ${res.status}）：${String(j?.message ?? JSON.stringify(j ?? {}).slice(0, 100))}`
    );
  }
  return { token, requestId, qrUrl: ucQrContent(token) };
}

/** UC 扫码：轮询一次（50004001 = 还没扫，继续等） */
async function ucQrPoll(
  token: string,
  requestId: string
): Promise<{ state: "waiting" | "ok" | "expired" | "failed"; ticket?: string; message?: string }> {
  const url = `${UC_UOP}/cas/ajax/getServiceTicketByQrcodeToken`
    + `?__t=${Date.now()}&client_id=${UC_CLIENT_ID}&v=1.2&request_id=${encodeURIComponent(requestId)}&token=${encodeURIComponent(token)}`;
  let j: {
    status?: number;
    message?: string;
    data?: { members?: { service_ticket?: string } };
  } | null = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: `${UC_PAN}/` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    j = (await res.json().catch(() => null)) as typeof j;
  } catch {
    // 网络抖动按「继续等」处理，别把扫码流程判死
    return { state: "waiting" };
  }
  const status = Number(j?.status ?? 0);
  if (status === 2000000) {
    const ticket = String(j?.data?.members?.service_ticket ?? "");
    if (!ticket) return { state: "failed", message: "扫码已通过，但未取到 service_ticket，请重新扫码" };
    return { state: "ok", ticket };
  }
  if (status === 50004002) return { state: "expired" };
  if (status === 50004001) return { state: "waiting" };
  return {
    state: "failed",
    message: `UC 扫码接口返回 status=${status}${j?.message ? `：${j.message}` : ""}`,
  };
}

/**
 * UC：service_ticket → 整串 Cookie。
 * 登录态是 Set-Cookie 写下来的（HttpOnly 也在里面），必须自己收集响应头；
 * account/info 可能 302 到别处再补 Cookie，所以手动跟跳转、逐跳合并。
 */
async function ucCookieFromTicket(
  ticket: string
): Promise<{
  cookie: string;
  nickname: string;
  code: string;
  msg: string;
  probeStatus?: number | null;
  probeMsg?: string;
  hasPus?: boolean;
  cookieKeys?: string[];
  hops?: string[];
}> {
  let cookie = "";
  let nickname = "";
  let code = "";
  let msg = "";
  /**
   * 票据换登录态。UC 在不同环境下「发 __pus 的入口」不总是同一个，所以按候选顺序试：
   *   入口1 = 文档 §2.2 给的 drive.uc.cn/account/info?st=…
   *   入口2 = 首页带票据（部分 CAS 实现在这里才真正下发登录态）
   * 只要 Cookie 里出现 __pus 就立刻停手。
   * 逐跳记录状态码与 Set-Cookie 的**字段名**（不含值），失败时据此定位是哪一跳没生效。
   */
  const hops: string[] = [];
  const candidates = [
    `${UC_PAN}/account/info?st=${encodeURIComponent(ticket)}&fr=pc&platform=pc`,
    `${UC_PAN}/?st=${encodeURIComponent(ticket)}&fr=pc&platform=pc`,
  ];
  const hasPusCookie = () => cookie.split(";").some((s) => s.trim().startsWith("__pus="));

  for (const [ci, candidate] of candidates.entries()) {
    let url = candidate;
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetch(url, {
        headers: { Cookie: cookie, "User-Agent": UA, Referer: `${UC_PAN}/` },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const setCookies = readSetCookies(res.headers);
      hops.push(
        `入口${ci + 1}第${hop + 1}跳 HTTP ${res.status} 下发[${setCookies.map((c) => c.split("=")[0]).filter(Boolean).join(",") || "无Set-Cookie"}]`
      );
      cookie = cookieMerge(cookie, setCookies);
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("json")) {
        const j = (await res.json().catch(() => null)) as
          | {
              success?: boolean;
              code?: string | number;
              msg?: string;
              message?: string;
              status?: string | number;
              data?: { nickname?: string; nick?: string; name?: string };
            }
          | null;
        if (j) {
          code = String(j.code ?? j.status ?? "");
          msg = String(j.msg ?? j.message ?? "");
          nickname = String(j.data?.nickname ?? j.data?.nick ?? j.data?.name ?? "") || nickname;
        }
      }
      const loc = res.headers.get("location") ?? "";
      if (!loc) break;
      url = loc.startsWith("http") ? loc : `${UC_PAN}${loc.startsWith("/") ? "" : "/"}${loc}`;
    }
    if (hasPusCookie()) break;
  }
  if (!cookie) return { cookie: "", nickname, code, msg, hops };

  // Cookie 里到底有哪些字段（只列名不列值）：判断「有没有换到真正的登录态」最快的办法
  const cookieKeys = cookie
    .split(";")
    .map((s) => s.split("=")[0]?.trim() ?? "")
    .filter(Boolean);
  /** __pus 是登录态核心；只有它而没有 __puus 时部分接口仍会判定为 guest */
  const hasPus = cookieKeys.includes("__pus");

  /**
   * 补全 __puus：改用「真正要用的业务接口」file/sort（文档 §3.1 实测可用）。
   * 两件事一起做：把响应里的 Set-Cookie 合并进来（__puus 就是在这里下发的），
   * 同时拿它的 status 当作「Cookie 到底够不够用」的探针，供上层报错时说明原因。
   */
  let probeStatus: number | null = null;
  let probeMsg = "";
  try {
    const r2 = await fetch(`${CD_UC.base}/file/sort?${CD_UC.qs}&pdir_fid=0&_page=1&_size=1&_fetch_total=1`, {
      method: "GET",
      headers: { Cookie: cookie, "User-Agent": UA, Referer: CD_UC.referer },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    cookie = cookieMerge(cookie, readSetCookies(r2.headers));
    const j2 = (await r2.json().catch(() => null)) as { status?: number; message?: string } | null;
    probeStatus = Number(j2?.status ?? 0) || null;
    probeMsg = String(j2?.message ?? "");
  } catch (e) {
    probeMsg = (e as Error).message;
  }

  return { cookie, nickname, code, msg, probeStatus, probeMsg, hasPus, cookieKeys, hops };
}

/** 夸克：登录态校验（doc：/auth/pc/flush 的 code=0 即凭证有效） */
async function quarkAuthCheck(cookie: string, cd: CdCfg = CD_QUARK): Promise<{ ok: boolean; message: string }> {
  try {
    /**
     * 夸克用 /auth/pc/flush（code=0 为有效）；UC 没有这个接口，
     * 按《UC网盘接口逆向文档》§3.2 用 /user/info（status=200 即凭证有效）。
     */
    const isUc = cd === CD_UC;
    const res = await fetch(`${cd.base}${isUc ? "/user/info" : "/auth/pc/flush"}?${cd.qs}`, {
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "User-Agent": UA,
        Referer: cd.referer,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const j = (await res.json().catch(() => null)) as { status?: number; code?: number; message?: string } | null;
    const okFlag = res.ok
      && Number(j?.status ?? 0) === 200
      && (isUc || Number(j?.code ?? -1) === 0);
    if (isUc && !okFlag) {
      /**
       * UC 的 /user/info 对「登录态不完整」（常见于只拿到 __pus、缺 __puus）会直接返回
       * status≠200，而 message 恒为 "No message available" 这句占位，看不出真实原因。
       * 所以再用真正要用的业务接口 file/sort 复测一次 —— 能列目录就说明 Cookie 够用。
       */
      try {
        const r2 = await fetch(`${cd.base}/file/sort?${cd.qs}&pdir_fid=0&_page=1&_size=1&_fetch_total=1`, {
          headers: { Cookie: cookie, "User-Agent": UA, Referer: cd.referer },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const j2 = (await r2.json().catch(() => null)) as { status?: number; message?: string } | null;
        if (r2.ok && Number(j2?.status ?? 0) === 200) {
          return { ok: true, message: "UC Cookie 可用（file/sort 复测通过）" };
        }
        return {
          ok: false,
          message: `user/info=${j?.status ?? "无"} / file/sort=${j2?.status ?? "无"}`
            + `（${String(j2?.message ?? j?.message ?? "无说明").slice(0, 120)}）`,
        };
      } catch (e) {
        return { ok: false, message: `${(e as Error).message}（user/info=${j?.status ?? "无"}）` };
      }
    }
    return { ok: okFlag, message: String(j?.message ?? `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** 夸克：已登录 Cookie 取昵称（扫码响应偶尔不带，兜底用；失败就回空串） */
async function quarkAccountName(cookie: string, cd: CdCfg = CD_QUARK): Promise<string> {
  /**
   * UC：先 pc-api 的 /user/info（文档 §3.2）；它对不完整登录态会直接失败，
   * 这时再退到网页版 /account/info（同一份 Cookie），两个都拿不到才回空串。
   */
  const urls = cd === CD_UC
    ? [`${cd.base}/user/info?${cd.qs}`, `${UC_PAN}/account/info?fr=pc&platform=pc`]
    : [`${QUARK_PAN}/account/info?fr=pc&platform=pc`];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Cookie: cookie, "User-Agent": UA, Referer: cd.referer },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const j = (await res.json().catch(() => null)) as {
        data?: { nickname?: string; nick?: string; name?: string };
      } | null;
      const name = String(j?.data?.nickname ?? j?.data?.nick ?? j?.data?.name ?? "");
      if (name) return name;
    } catch { /* 试下一个接口 */ }
  }
  return "";
}

/** 百度：换 bdstoken 的「带错误码」版本，扫码失败时用它给出可排查的信息 */
async function baiduBdstokenProbe(cookie: string): Promise<{ bdstoken: string; errno: number; errmsg: string }> {
  try {
    const res = await fetch(
      `${BAIDU_PAN}/api/gettemplatevariable?clienttype=0&app_id=${BAIDU_APP_ID}&web=1&channel=chunlei`
      + `&fields=${encodeURIComponent(JSON.stringify(["bdstoken"]))}`,
      {
        headers: { Cookie: cookie, "User-Agent": UA, Referer: `${BAIDU_PAN}/disk/home` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const errno = Number(j?.errno ?? -1);
    const r = (j?.result ?? {}) as Record<string, unknown>;
    return {
      bdstoken: errno === 0 ? String(r.bdstoken ?? "") : "",
      errno,
      errmsg: String(j?.errmsg ?? j?.err_msg ?? j?.show_msg ?? ""),
    };
  } catch (e) {
    return { bdstoken: "", errno: -1, errmsg: (e as Error).message };
  }
}

/** 百度：带 Cookie 的请求头 */
function baiduHeaders(c: BaiduCred, extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: c.cookie, "User-Agent": UA, Referer: `${BAIDU_PAN}/disk/home`, ...extra };
}

/**
 * 读 errno 并抛可读错误；errno=-6 归一成 BaiduAuthError，方便提示「重新登记 Cookie」。
 * 注意：百度少数接口（如 /share/verify 的失败态）不给 errno 只给 error_msg，
 * 这里对「没有 errno 但有错误信息」也判失败，避免把失败当成功。
 */
function baiduThrowErr(j: Record<string, unknown>): void {
  const hasErrno = j?.errno !== undefined && j?.errno !== null;
  const errno = Number(j?.errno ?? 0);
  const msg = String(j?.errmsg ?? j?.err_msg ?? j?.show_msg ?? j?.error_msg ?? j?.error ?? "");
  if (hasErrno && errno === 0) return;
  if (!hasErrno && !msg) return;
  if (hasErrno && errno === -6) throw new BaiduAuthError(baiduErrText(errno, msg));
  throw new Error(baiduErrText(hasErrno ? errno : -1, msg));
}

/** 百度：读一个模板变量（失败/字段不被支持都回空串，不抛错） */
async function baiduTemplateVar(c: BaiduCred, field: string): Promise<string> {
  try {
    const res = await fetch(
      `${BAIDU_PAN}/api/gettemplatevariable?clienttype=0&app_id=${BAIDU_APP_ID}&web=1&channel=chunlei`
      + `&fields=${encodeURIComponent(JSON.stringify([field]))}`,
      { headers: baiduHeaders(c), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (Number(j?.errno ?? -1) !== 0) return "";
    const r = (j?.result ?? {}) as Record<string, unknown>;
    return String(r[field] ?? "");
  } catch {
    return "";
  }
}

/**
 * 百度：用 Cookie 换 bdstoken（所有写操作必需）。
 * 只请求 bdstoken 这一个字段（字段名不被支持时会整体失败，所以不合并请求）；
 * uk 是锦上添花，单独取、失败就算了。
 */
async function baiduFetchTokens(c: BaiduCred): Promise<{ bdstoken: string; uk: string }> {
  let bdstoken = await baiduTemplateVar(c, "bdstoken");
  // 兜底：接口不可用时从网盘首页 HTML 里抠（页面里有 window.locals.userInfo.bdstoken）
  if (!bdstoken) bdstoken = await baiduBdstokenFromHtml(c);
  if (!bdstoken) {
    throw new BaiduAuthError(
      "无法用 Cookie 换取 bdstoken：Cookie 可能不完整（必须含 BDUSS）或已失效，请重新复制整串 Cookie"
    );
  }
  return { bdstoken, uk: await baiduTemplateVar(c, "uk") };
}

/** 兜底：从网盘首页 HTML 里抠 bdstoken */
async function baiduBdstokenFromHtml(c: BaiduCred): Promise<string> {
  try {
    const html = await fetch(`${BAIDU_PAN}/disk/home`, {
      headers: baiduHeaders(c, { Accept: "text/html" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).then((r) => r.text()).catch(() => "");
    return /"bdstoken"\s*:\s*"([0-9a-zA-Z]{16,})"/.exec(html)?.[1] ?? "";
  } catch {
    return "";
  }
}

/** 确保 bdstoken 可用（缺失或 force 时用 Cookie 重取并回写） */
async function baiduEnsureBdstoken(cred: PanCred, force = false): Promise<BaiduCred> {
  const c = baiduCredOf(cred);
  if (!c.cookie) throw new BaiduAuthError("未绑定百度网盘账号，请先在「网盘账号」里粘贴登录 Cookie");
  if (!c.bdstoken || force) {
    const t = await baiduFetchTokens(c);
    c.bdstoken = t.bdstoken;
    if (t.uk) c.uk = t.uk;
    // 内存与库里都更新：同一次运行内后续调用直接用新 bdstoken
    cred.cookie = JSON.stringify({ cookie: c.cookie, bdstoken: c.bdstoken, uk: c.uk });
    cred.bdstoken = c.bdstoken;
    cred.uk = c.uk;
    await baiduSaveCred(cred.userId, c);
  }
  return c;
}

/**
 * 百度：带 Cookie + bdstoken 的 Web 接口调用。
 * query 固定带上 app_id / web / channel / clienttype（Web 端同族接口都认这套）。
 * errno=-6 时用 Cookie 重取一次 bdstoken 再试一次 —— 只影响鉴权，不会造成重复写入。
 */
async function baiduCall(
  cred: PanCred,
  path: string,
  params: Record<string, string | number | undefined> = {},
  opts: { method?: "GET" | "POST"; body?: Record<string, string | number | undefined>; needToken?: boolean } = {}
): Promise<Record<string, unknown>> {
  const method = opts.method ?? "GET";

  const attempt = async (c: BaiduCred) => {
    const qs = new URLSearchParams();
    const merged = { ...params, app_id: BAIDU_APP_ID, web: 1, channel: "chunlei", clienttype: 0 };
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined || v === null || v === "") continue;
      qs.set(k, String(v));
    }
    if (opts.needToken !== false) qs.set("bdstoken", c.bdstoken);
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.body ?? {})) {
      if (v === undefined || v === null) continue;
      body.set(k, String(v));
    }
    const res = await fetch(`${BAIDU_PAN}${path}?${qs}`, {
      method,
      headers: baiduHeaders(c, method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      body: method === "POST" ? body : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
    return { status: res.status, json, text };
  };

  let c = await baiduEnsureBdstoken(cred);
  let r = await attempt(c);
  if (r.json && Number(r.json.errno) === -6) {
    // bdstoken 失效很常见（换设备 / 会话过期）：重取一次再试
    c = await baiduEnsureBdstoken(cred, true);
    r = await attempt(c);
  }
  if (!r.json) {
    throw new Error(`百度接口返回异常（HTTP ${r.status}）：${r.text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  baiduThrowErr(r.json);
  return r.json;
}

/** 百度：登录态校验（绑定 / 自检用） */
async function baiduAuthCheck(cred: PanCred): Promise<void> {
  await baiduCall(cred, "/api/auth/check", {});
}

/** 百度：账号信息（用 /api/quota 验登录态，顺带把容量显示出来） */
async function baiduAccountInfo(cred: PanCred): Promise<{ uk: string; quota: string }> {
  const c = await baiduEnsureBdstoken(cred);
  const j = await baiduCall(cred, "/api/quota", { checkexpire: 1, checkfree: 1 });
  const total = Number(j.total ?? 0);
  return { uk: c.uk, quota: total > 0 ? `${(total / 1024 / 1024 / 1024).toFixed(1)}GB` : "" };
}

/** 百度：一条目录/文件项（id = fs_id，path = 绝对路径 —— 百度侧目录就是按路径定位的） */
interface BaiduEntry {
  id: string;
  name: string;
  size: number;
  isDir: boolean;
  path: string;
  raw?: Record<string, unknown>;
}

/** 百度：把接口返回的 list/info 数组映射成统一结构（不同接口的字段名略有差异） */
function baiduMapEntries(list: Array<Record<string, unknown>>): BaiduEntry[] {
  const out: BaiduEntry[] = [];
  for (const it of list) {
    const name = String(it.server_filename ?? it.filename ?? it.name ?? "");
    if (!name) continue;
    out.push({
      id: String(it.fs_id ?? it.fsid ?? ""),
      name,
      size: Number(it.size ?? 0) || 0,
      isDir: Number(it.isdir ?? 0) === 1,
      path: String(it.path ?? ""),
      raw: it,
    });
  }
  return out;
}

/**
 * 百度：列出自己网盘某目录下的条目（dirPath 为绝对路径，根 = "/"）。
 * 主路 GET /api/list（分页）；失败再回退 GET /api/filemetas（一次给全，接口清单里的「刷新目录」）。
 */
async function baiduListOwnDir(cred: PanCred, dirPath: string): Promise<BaiduEntry[]> {
  const dir = !dirPath || dirPath === "" ? "/" : (dirPath.startsWith("/") ? dirPath : `/${dirPath}`);
  const out: BaiduEntry[] = [];
  try {
    for (let page = 1; page <= 50; page++) {
      const j = await baiduCall(cred, "/api/list", {
        order: "name", desc: 0, showempty: 0, page, num: BAIDU_LIST_LIMIT, dir, t: Date.now(),
        ...(dir === "/" ? { root: 1 } : {}),
      });
      const list = (j.list ?? []) as Array<Record<string, unknown>>;
      out.push(...baiduMapEntries(list));
      if (list.length < BAIDU_LIST_LIMIT) return out;
    }
    return out;
  } catch (e) {
    if (out.length > 0) return out; // 翻页途中失败：把已拿到的交出去，别整批丢
    const j = await baiduCall(cred, "/api/filemetas", {
      target: JSON.stringify([dir]), dlink: 1, detail: 1, web: 1,
    });
    const arr = Array.isArray(j.info) ? (j.info as Array<Record<string, unknown>>) : [];
    if (arr.length === 0) throw e;
    return baiduMapEntries(arr);
  }
}

/** 百度：列出某目录下的子目录（目录浏览器用；目录的「id」就是它的绝对路径） */
async function baiduListDirs(cred: PanCred, parentPath: string): Promise<Array<{ id: string; name: string }>> {
  const items = await baiduListOwnDir(cred, parentPath);
  return items
    .filter((it) => it.isDir)
    .map((it) => ({ id: it.path || `/${it.name}`, name: it.name }))
    .filter((d) => d.id)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/** 百度：确保目标目录存在（转存不会自动建目录；path 不存在会整批报错） */
async function baiduEnsureDir(cred: PanCred, dirPath: string): Promise<void> {
  const path = !dirPath || dirPath === "/" ? "/" : `/${dirPath.split("/").filter(Boolean).join("/")}`;
  if (path === "/") return;
  let cur = "";
  for (const seg of path.split("/").filter(Boolean)) {
    const parent = cur || "/";
    const child = `${cur}/${seg}`;
    const items = await baiduListOwnDir(cred, parent);
    if (!items.some((it) => it.isDir && it.name === seg)) {
      // Web 端建目录：POST /api/create?a=commit，body: path / isdir / block_list
      await baiduCall(cred, "/api/create", { a: "commit" }, {
        method: "POST",
        body: { path: child, isdir: 1, block_list: "[]" },
      });
    }
    cur = child;
  }
}

/** 百度：重命名（按绝对路径） */
async function baiduRenameByPath(cred: PanCred, path: string, newName: string): Promise<void> {
  // Web 端文件管理：POST /api/filemanager?opera=rename，body: filelist=[{path,newname,isdir}]
  await baiduCall(cred, "/api/filemanager", { opera: "rename", async: 1, onnest: "fail" }, {
    method: "POST",
    body: { filelist: JSON.stringify([{ path, newname: newName, isdir: 0 }]) },
  });
}

/**
 * 百度：按绝对路径删除（进回收站，可恢复）。
 * Web 端接口：POST /api/filemanager?opera=delete，body: filelist=["/目录/文件", ...]
 * 只用于「文件夹模式」转后清理顺带进来的图片/文本/文档，路径全部来自服务端列目录结果。
 */
async function baiduDeleteByPath(cred: PanCred, paths: string[]): Promise<number> {
  const list = paths.map((p) => p.trim()).filter((p) => p && p !== "/");
  if (list.length === 0) return 0;
  let done = 0;
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    await baiduCall(cred, "/api/filemanager", { opera: "delete", async: 1, onnest: "fail" }, {
      method: "POST",
      body: { filelist: JSON.stringify(chunk) },
    });
    done += chunk.length;
  }
  return done;
}

/** 百度：按名字在目录里找文件（转存是异步任务，需要轮询等它落地才能改名） */
async function baiduFindFilesByName(
  cred: PanCred,
  dirPath: string,
  names: Set<string>,
  tries = 6
): Promise<Array<{ id: string; name: string; path: string }>> {
  const found: Array<{ id: string; name: string; path: string }> = [];
  const remaining = new Set(names);
  for (let i = 0; i < tries && remaining.size > 0; i++) {
    if (i > 0) await wait(3000);
    const items = await baiduListOwnDir(cred, dirPath);
    for (const it of items) {
      if (it.isDir || !remaining.has(it.name)) continue;
      found.push({ id: it.id, name: it.name, path: it.path });
      remaining.delete(it.name);
    }
  }
  return found;
}

/** 百度：从分享链接解析出短码（支持 /s/xxxx 与 share/init?surl=xxxx） */
function baiduShareShort(url: string): string | null {
  const s = /pan\.baidu\.com\/s\/([A-Za-z0-9_-]+)/i.exec(url)?.[1];
  if (s) return s;
  return /[?&]surl=([A-Za-z0-9_-]+)/i.exec(url)?.[1] ?? null;
}

/**
 * 分享短码的两种写法：链接是 /s/1YnB-xxx，接口里的 surl 有的端点要整段、
 * 有的（share/verify、wxlist）要去掉前导的「1」。两种都试，谁通用谁。
 */
function baiduShareShorts(url: string): string[] {
  const s = baiduShareShort(url);
  if (!s) return [];
  const out = [s];
  if (s.startsWith("1") && s.length > 1) out.push(s.slice(1));
  return out;
}

interface BaiduShare {
  shorturl: string;
  shareid: string;
  /** 分享者 uk —— 转存接口的 from 参数 */
  uk: string;
  /** 分享页 BDCLND（有提取码的分享必须带，否则转存报 -9） */
  sekey: string;
  passcode: string | null;
}

/**
 * 解析百度分享：shareid / uk（转存的 from，即分享者）/ sekey（= 分享页 BDCLND Cookie）。
 *
 * 顺序（与接口清单一致，并对「带提取码」的分享做完整支持）：
 *   1) GET /share/wxlist —— 能带提取码，直接给 shareid / uk / sekey
 *   2) 回退抓分享页 HTML 里的 yunData（shareid / share_uk）
 *   3) 有提取码但还没拿到 sekey：POST /share/verify —— 成功时 randsk 即 sekey，
 *      而且它会把 shareid / uk 一起带回来（带码分享靠这一步就能全拿到）
 *
 * 注意 surl 有「带前导 1 / 不带前导 1」两种写法（不同端点要求不一样），两种都试一遍。
 */
async function baiduShareMeta(cred: PanCred, shareUrl: string, passcode: string | null): Promise<BaiduShare> {
  const shorts = baiduShareShorts(shareUrl);
  if (shorts.length === 0) throw new Error("无法从链接解析出百度网盘分享短码（形如 https://pan.baidu.com/s/1xxxx）");
  const short = shorts[0];
  // verify 的 surl 必须用「去掉前导 1」的写法（带 1 一律回 105 需要验证码），所以去掉 1 的排前面
  const verifyShorts = [...shorts].sort((a, b) => Number(a.startsWith("1")) - Number(b.startsWith("1")));
  // 带提取码的分享不给码连列表都拉不到：库里没填就认链接自带的 ?pwd=xxxx（百度复制链接的默认写法）
  const pwd = (passcode ?? "").trim() || (passcodeFromUrl(shareUrl) ?? "");
  const c = await baiduEnsureBdstoken(cred);

  let shareid = "";
  let uk = "";
  let sekey = "";
  /** wxlist 顺带给的 seckey（拼写如此，值就是 BDCLND）：verify 失败时兜底用 */
  let sekeyHint = "";
  /** 该分享要提取码但我们没拿到（用于给出可执行的提示，而不是笼统的「解析失败」） */
  let needPwd = false;
  /** 填了提取码但百度判错（errno=-9）：直接报错，不用再往下试 */
  let pwdRejected = false;
  /** verify 的失败原因，最终报错时带上，方便判断是「码错」还是「要验证码」 */
  let verifyErr = "";

  // 1) share/wxlist：两种 surl 写法都试
  for (const s of shorts) {
    if (shareid && uk) break;
    try {
      const qs = new URLSearchParams({
        channel: "web", version: "2.2.2", clienttype: "25", web: "1",
        shorturl: s, root: "1",
      });
      if (pwd) qs.set("pwd", pwd);
      const res = await fetch(`${BAIDU_PAN}/share/wxlist?${qs}`, {
        headers: baiduHeaders(c, { Referer: `${BAIDU_PAN}/s/${short}` }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const d = (j?.data ?? {}) as Record<string, unknown>;
      const errno = Number(j?.errno ?? -1);
      if (errno === 0) {
        // 换了 surl 写法后成功了：说明提取码本身没问题，清掉之前写法上的 -9 误判
        pwdRejected = false;
        shareid = String(d.share_id ?? d.shareid ?? j?.shareid ?? "");
        uk = String(d.uk ?? d.share_uk ?? j?.uk ?? "");
        // 注意字段名是 seckey（百度自己的拼写错误），值就是分享页 BDCLND
        sekeyHint = baiduDecodeSeKey(String(d.seckey ?? d.sekey ?? ""));
        // 有的分享 errno=0 但带加密标记且不给 seckey —— 说明必须先过提取码校验
        const encrypted = Number(d.need_pwd ?? j?.need_pwd ?? d.is_encrypt ?? j?.is_encrypt ?? 0) === 1;
        if (encrypted && !sekeyHint) needPwd = !pwd;
      } else if (errno === -9 || errno === 200025) {
        // -9 / 200025：提取码错误
        if (pwd) pwdRejected = true;
        else needPwd = true;
      } else if (errno === -130) {
        // -130：分享带提取码但这次没给（或提取码已失效）
        needPwd = true;
      }
    } catch { /* 换下一种写法 / 抓分享页 */ }
  }

  // 2) 回退：分享页 HTML 里的 yunData / locals（页面必须用原样短码 /s/1xxxx）
  if (!shareid || !uk) {
    const html = await fetch(`${BAIDU_PAN}/s/${short}`, {
      headers: baiduHeaders(c, { Referer: `${BAIDU_PAN}/disk/home`, Accept: "text/html" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).then((r) => r.text()).catch(() => "");
    shareid = shareid || /"shareid"\s*:\s*"?(\d+)/.exec(html)?.[1] || "";
    uk = uk || /"share_uk"\s*:\s*"?(\d+)/.exec(html)?.[1] || "";
    if (!sekey) {
      const t = /"sekey"\s*:\s*"([^"]+)"/.exec(html)?.[1];
      if (t) sekey = baiduDecodeSeKey(t);
    }
  }

  // 3) 有提取码但还没拿到 sekey：share/verify（成功时连 shareid / uk 一起给）
  if (pwd && !pwdRejected && !sekey) {
    for (const s of verifyShorts) {
      try {
        const res = await fetch(
          `${BAIDU_PAN}/share/verify?surl=${encodeURIComponent(s)}&t=${Date.now()}`
          + `&channel=chunlei&web=1&app_id=${BAIDU_APP_ID}&clienttype=0&bdstoken=${encodeURIComponent(c.bdstoken)}`,
          {
            method: "POST",
            headers: baiduHeaders(c, {
              "Content-Type": "application/x-www-form-urlencoded",
              Referer: `${BAIDU_PAN}/s/${short}`,
            }),
            body: new URLSearchParams({ pwd, vcode: "", vcode_str: "" }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          }
        );
        const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        const errno = Number(j?.errno ?? -1);
        if (errno === 0) {
          pwdRejected = false;
          verifyErr = "";
          sekey = baiduDecodeSeKey(String(j?.randsk ?? ""));
          shareid = shareid || String(j?.shareid ?? "");
          uk = uk || String(j?.uk ?? j?.share_uk ?? "");
          if (sekey) break;
        } else {
          verifyErr = baiduErrText(errno, String(j?.errmsg ?? j?.err_msg ?? ""));
          // -9 / 200025：提取码错误，换写法也没用
          if (errno === -9 || errno === 200025) { pwdRejected = true; break; }
        }
      } catch { /* 换下一种写法 */ }
    }
  }
  // verify 没拿到（如该分享其实不需要提取码）：退回 wxlist 顺带给的 seckey
  if (!sekey && sekeyHint) sekey = sekeyHint;

  if (pwdRejected) {
    throw new Error("百度分享提取码不正确：请核对链接里的 ?pwd= 或订阅里填的「分享提取码」");
  }
  if (!shareid || !uk) {
    if (needPwd && !pwd) {
      throw new Error("该百度分享需要提取码：请把带 ?pwd=xxxx 的完整链接粘进来，或在订阅里填「分享提取码」");
    }
    if (pwd && verifyErr) throw new Error(`解析百度分享失败：${verifyErr}`);
    throw new Error(
      pwd
        ? "解析百度分享失败：链接可能已失效，或提取码不正确"
        : "解析百度分享失败：链接可能已失效；若该分享带提取码，请把带 ?pwd=xxxx 的完整链接粘进来"
    );
  }
  return { shorturl: short, shareid, uk, sekey, passcode: pwd || null };
}

/**
 * 百度：分享内的目录列表 —— 用分享页真正在用的 /share/wxlist。
 *
 * 实测（2026-10）：
 *   · 根目录 → root=1；子目录 → dir=<分享内的绝对路径>。两者同时带只会回目录自己。
 *   · 带提取码的分享必须每次都带 pwd，否则 errno=-130。
 *   · 分页是 num + page（page 从 1 起），靠 has_more 判断结束。
 *   · 老的 /share/list 对带提取码的分享恒回 -9「提取码验证失败」（sekey 放 query 或
 *     BDCLND Cookie 都一样），所以列表一律走 wxlist，只在其不可用时兜底 /share/list。
 */
async function baiduWxlist(
  cred: PanCred,
  share: BaiduShare,
  dir: string,
  page: number,
  num: number
): Promise<Record<string, unknown>> {
  const c = await baiduEnsureBdstoken(cred);
  const qs = new URLSearchParams({
    channel: "web", version: "2.2.2", clienttype: "25", web: "1",
    shorturl: share.shorturl,
    num: String(num), page: String(page),
  });
  if (dir) qs.set("dir", dir);
  else qs.set("root", "1");
  if (share.passcode) qs.set("pwd", share.passcode);
  const res = await fetch(`${BAIDU_PAN}/share/wxlist?${qs}`, {
    headers: baiduHeaders(c, { Referer: `${BAIDU_PAN}/s/${share.shorturl}` }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(text) as Record<string, unknown>; } catch { j = null; }
  if (!j) throw new Error(`百度接口返回异常（HTTP ${res.status}）：${text.slice(0, 120).replace(/\s+/g, " ")}`);
  const errno = Number(j.errno ?? -1);
  if (errno === -130 || errno === 200025) {
    throw new Error("该百度分享需要正确的提取码：请把带 ?pwd=xxxx 的完整链接粘进来，或在订阅里填「分享提取码」");
  }
  baiduThrowErr(j);
  return (j.data ?? {}) as Record<string, unknown>;
}

/** 百度：列出分享中某目录下的条目（dirPath 为空 = 分享根目录；path 是分享内的绝对路径） */
async function baiduListShareDir(cred: PanCred, share: BaiduShare, dirPath: string): Promise<BaiduEntry[]> {
  const PAGE = 100;
  const dir = dirPath && dirPath !== "/" ? (dirPath.startsWith("/") ? dirPath : `/${dirPath}`) : "";
  const out: BaiduEntry[] = [];
  let wxErr: Error | null = null;
  try {
    for (let page = 1; page <= 50; page++) {
      const d = await baiduWxlist(cred, share, dir, page, PAGE);
      const list = (d.list ?? []) as Array<Record<string, unknown>>;
      out.push(...baiduMapEntries(list));
      if (list.length === 0 || Number(d.has_more ?? 0) !== 1) break;
    }
    return out;
  } catch (e) {
    wxErr = e as Error;
    // 半份列表 / 提取码或登录态问题：直接报错，别回退成老接口的更含糊的错
    if (out.length > 0 || /提取码|登录态|验证码|Cookie/.test(wxErr.message)) throw e;
  }

  // 兜底：老接口 /share/list（未加密的分享仍可能可用）
  try {
    const j = await baiduCall(cred, "/share/list", {
      is_from_web: 1,
      sekey: share.sekey || undefined,
      uk: share.uk, shareid: share.shareid,
      order: "time", desc: 1, showempty: 0, view_mode: 1,
      limit: PAGE, page: 1, dir: dir || "/", t: Date.now(),
      ...(dir ? {} : { root: 1 }),
    });
    return baiduMapEntries((j.list ?? []) as Array<Record<string, unknown>>);
  } catch (e) {
    throw wxErr ?? (e as Error);
  }
}

/** 百度：递归收集分享目录下的叶子文件（整份分享转存用；转存是把文件平铺进目标目录） */
async function baiduCollectShareFiles(
  cred: PanCred,
  share: BaiduShare,
  dirPath: string,
  acc: ShareFile[],
  depth: number
): Promise<void> {
  if (depth > BAIDU_SHARE_MAX_DEPTH) return;
  const items = await baiduListShareDir(cred, share, dirPath);
  for (const it of items) {
    if (!it.id) continue;
    if (it.isDir) {
      await baiduCollectShareFiles(cred, share, it.path || dirPath, acc, depth + 1);
    } else {
      acc.push({ id: it.id, name: it.name, size: it.size || null });
    }
  }
}

/** 百度：列出分享目录的顶层条目（一条 = 一个目录或一个散文件，对应一条资源） */
async function baiduListShareEntries(
  cred: PanCred,
  shareUrl: string,
  passcode: string | null
): Promise<ShareEntry[]> {
  const share = await baiduShareMeta(cred, shareUrl, passcode);
  const top = await baiduListShareDir(cred, share, "");
  const entries: ShareEntry[] = [];
  for (const item of top) {
    const rawKeys = entries.length === 0 && item.raw ? Object.keys(item.raw) : undefined;
    if (item.isDir) {
      const all: ShareFile[] = [];
      await baiduCollectShareFiles(cred, share, item.path || "/", all, 1);
      const { files, skipped } = dropNonContent(all);
      if (files.length === 0) continue;
      entries.push({
        key: item.id,
        title: item.name,
        files,
        skippedImages: skipped,
        // 文件夹模式：百度整目录转存用「目录自身的 fs_id」（百度会保留子目录、不产生平铺副本）
        dirMarker: { id: item.id, name: item.name },
        rawKeys,
      });
    } else {
      if (isNonContentFile(item.name)) continue;
      entries.push({
        key: item.id,
        title: stripExt(item.name) || item.name,
        files: [{ id: item.id, name: item.name, size: item.size || null }],
        rawKeys,
      });
    }
  }
  return entries;
}

/**
 * 百度：把分享里这批 fs_id 转存到自己的 dirPath。
 * 写操作只在「授权失效」（errno=-6 且已续期）时才重发，网络超时一律不重试，
 * 避免重复转存出多份文件。
 */
async function baiduTransferShareFiles(
  cred: PanCred,
  share: BaiduShare,
  files: ShareFile[],
  dirPath: string
): Promise<TransferResult> {
  if (files.length === 0) return { ok: false, message: "没有需要转存的文件" };
  // 百度侧的「目录」是绝对路径（必须 / 开头）；目录选择器给的就是绝对路径，这里再兜一层
  const target = !dirPath || dirPath === "/"
    ? "/"
    : `/${String(dirPath).split("/").filter(Boolean).join("/")}`;
  // 百度不会自动建目录：目标目录不存在时整批都会失败，先确保存在
  await baiduEnsureDir(cred, target);

  // 同一个物理文件可能以多个名字出现在分享里（顶层 + 子目录），fs_id 相同 → 去重
  const uniq = files.filter((f, i) => files.findIndex((x) => x.id === f.id) === i);
  let done = 0;
  const failed: string[] = [];
  for (let i = 0; i < uniq.length; i += BAIDU_TRANSFER_BATCH) {
    const batch = uniq.slice(i, i + BAIDU_TRANSFER_BATCH);
    try {
      await baiduTransferOnce(cred, share, batch.map((f) => f.id), target);
      done += batch.length;
    } catch (e) {
      if (e instanceof BaiduAuthError) { await markBaiduInvalid(cred, e.message); throw e; }
      failed.push((e as Error).message);
      // 业务错误（分享失效 / 数量超限）继续下一批没有意义，直接收尾，把原因说清楚
      if (/分享|失效|超出上限|不存在/.test((e as Error).message)) break;
    }
  }
  if (failed.length > 0) {
    return {
      ok: done > 0,
      transferred: done,
      message: `已转存 ${done}/${uniq.length} 个文件（失败：${failed[0]}）`,
    };
  }
  return { ok: true, transferred: done, message: `已转存 ${done} 个文件到百度网盘` };
}

/**
 * 百度：一次转存请求（接口清单口径）。
 * POST /share/transfer?shareid=&from=&sekey=&ondup=newcopy&async=1&bdstoken=
 *   body: fsidlist=[fs_id...] & path=/目标目录
 */
async function baiduTransferOnce(
  cred: PanCred,
  share: BaiduShare,
  fsIds: string[],
  dirPath: string
): Promise<void> {
  const ids = fsIds.map((s) => Number(s)).filter((n) => Number.isFinite(n));
  if (ids.length === 0) throw new Error("分享文件缺少 fs_id，无法转存");
  await baiduCall(cred, "/share/transfer", {
    shareid: share.shareid,
    from: share.uk,
    sekey: share.sekey || undefined,
    ondup: "newcopy",
    async: 1,
  }, {
    method: "POST",
    body: { fsidlist: JSON.stringify(ids), path: dirPath },
  });
}

/** 百度：令牌失效时标记账号需要重新授权 */
async function markBaiduInvalid(cred: PanCred, message: string): Promise<void> {
  await admin.rpc("mark_pan_account", {
    p_user_id: cred.userId,
    p_pan: "baidu",
    p_ok: false,
    p_error: message,
  });
}

/** 百度：转存「指定文件」（分享目录订阅只转新增文件） */
async function baiduTransferFiles(
  cred: PanCred,
  shareUrl: string,
  passcode: string | null,
  files: ShareFile[],
  dir: string | null
): Promise<TransferResult> {
  try {
    const share = await baiduShareMeta(cred, shareUrl, passcode);
    return await baiduTransferShareFiles(cred, share, files, dir || "/");
  } catch (e) {
    if (e instanceof BaiduAuthError) await markBaiduInvalid(cred, e.message);
    return { ok: false, message: (e as Error).message };
  }
}

/** 百度：转存整份分享（收集全部叶子文件 → 分批转存到目标目录） */
async function baiduTransfer(
  cred: PanCred,
  shareUrl: string,
  passcode: string | null,
  dir: string | null
): Promise<TransferResult> {
  try {
    const share = await baiduShareMeta(cred, shareUrl, passcode);
    const all: ShareFile[] = [];
    await baiduCollectShareFiles(cred, share, "", all, 0);
    const { files, skipped } = dropNonContent(all);
    if (files.length === 0) {
      return {
        ok: false,
        message: skipped > 0
          ? `分享里只有 ${skipped} 个图片/文本文件，已按设置跳过不转存`
          : "分享中未找到可转存的文件（分享可能已失效或需要提取码）",
      };
    }
    const r = await baiduTransferShareFiles(cred, share, files, dir || "/");
    return { ...r, files };
  } catch (e) {
    if (e instanceof BaiduAuthError) await markBaiduInvalid(cred, e.message);
    return { ok: false, message: (e as Error).message };
  }
}

// ───────────── 123 网盘（123pan：动态签名参数 + Bearer 令牌）─────────────
//
// 依据《123网盘接口文档》要点：
//   · 每个请求 URL 都要带动态签名 `?<timeSign>=<timestamp>-<random>-<dataSign>`
//       timeSign = crc32(把北京时间 "200601021504" 的每个数字字符替换成 table[i] 后的串)
//       dataSign = crc32("{timestamp}|{random}|{path}|web|3|{timeSign}")   path 不含域名与查询串
//   · 凭证是浏览器 localStorage 的 authorToken → 请求头 Authorization: Bearer <token>
//     **不是 Cookie**，所以绑定形态是「粘贴令牌」（存进 cookie_enc 列，读取时当 token 用）。
//   · 分享页跑在专属子域（https://<分享号>.share.123pan.cn），个人网盘接口在
//     https://yun.123pan.com/b/api；签名里的 path 不含域名，所以同一套代码两边都能用。
const P123_TABLE = [
  "a", "d", "e", "f", "g", "h", "l", "m", "y", "i", "j",
  "n", "o", "p", "k", "q", "r", "s", "t", "u", "b", "c", "v", "w", "s", "z",
];
const P123_WEB = "https://yun.123pan.com";
const P123_B = "https://yun.123pan.com/b/api";
const P123_SHARE_HOST_RE = /https?:\/\/([a-z0-9-]+)\.share\.123pan\.cn/i;
/** 空内容的 md5/etag：123 建空目录时必须带，缺了报「请输入Etag」 */
const P123_EMPTY_MD5 = "d41d8cd98f00b204e9800998ecf8427e";
/** 会话 UUID：123 网页版每次开页面随机生成一个，我们自己造一个即可 */
const P123_LOGIN_UUID = crypto.randomUUID().replace(/-/g, "").slice(0, 22);

/** CRC32(IEEE) 查表：123 的 timeSign / dataSign 都是它算出来的 */
const P123_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function p123Crc32(s: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < s.length; i++) {
    crc = (crc >>> 8) ^ P123_CRC_TABLE[(crc ^ s.charCodeAt(i)) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 生成 123 的签名查询串（含前导 ?，后面再拼业务查询参数要用 &） */
function p123Sign(path: string, tsMs = Date.now()): string {
  const ts = Math.floor(tsMs / 1000);
  const bj = new Date(tsMs + 8 * 3600 * 1000); // 北京时间
  const p2 = (n: number) => String(n).padStart(2, "0");
  const raw =
    `${bj.getUTCFullYear()}${p2(bj.getUTCMonth() + 1)}${p2(bj.getUTCDate())}`
    + `${p2(bj.getUTCHours())}${p2(bj.getUTCMinutes())}`;
  let mapped = "";
  for (const ch of raw) mapped += P123_TABLE[Number(ch)] ?? ch;
  const timeSign = p123Crc32(mapped);
  const rand = Math.floor(Math.random() * 1e7) + 1;
  const dataSign = p123Crc32(`${ts}|${rand}|${path}|web|3|${timeSign}`);
  return `?${timeSign}=${ts}-${rand}-${dataSign}`;
}

function p123Headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json;charset=UTF-8",
    "User-Agent": UA,
    platform: "web",
    "App-Version": "149",
    LoginUuid: P123_LOGIN_UUID,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

interface P123Result<T = any> {
  ok: boolean;
  status: number;
  code: number;
  message: string;
  data: T | null;
}

/** 统一请求：自动签名 + 公共头；query 传业务参数（不含前导 ?） */
async function p123FetchJson<T = any>(
  base: string,
  path: string,
  opts: { method?: string; token?: string; body?: unknown; query?: string } = {}
): Promise<P123Result<T>> {
  const extra = opts.query ? (opts.query.startsWith("?") ? opts.query : `&${opts.query}`) : "";
  const url = `${base}${path}${p123Sign(path)}${extra}`;
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: p123Headers(opts.token),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const j = (await res.json().catch(() => null)) as {
    code?: number;
    message?: string;
    msg?: string;
    data?: T;
  } | null;
  return {
    ok: res.ok,
    status: res.status,
    // 123 成功码不统一：0 与 200 都见过，都当成功
    code: Number(j?.code ?? -1),
    message: String(j?.message ?? j?.msg ?? ""),
    data: (j?.data ?? null) as T | null,
  };
}

/** 从分享链接取出子域与 shareKey */
function p123ShareCtx(shareUrl: string): { base: string; shareKey: string } {
  const m = P123_SHARE_HOST_RE.exec(shareUrl);
  const base = m ? `https://${m[1]}.share.123pan.cn` : P123_WEB;
  const shareKey =
    /\/123pan\/([A-Za-z0-9_-]+)/.exec(shareUrl)?.[1] ??
    /[?&]shareKey=([A-Za-z0-9_-]+)/.exec(shareUrl)?.[1] ??
    "";
  return { base, shareKey };
}

interface P123Info {
  FileId: number | string;
  FileName: string;
  Type: number;
  Size?: number;
}

interface P123ShareSession {
  base: string;
  shareKey: string;
  pwd: string;
  token: string;
}

/** 123 分享里的一项（Type: 0 文件 / 1 文件夹） */
async function p123ListShare(session: P123ShareSession, parentId: string): Promise<P123Info[]> {
  const r = await p123FetchJson<P123ShareSession & { InfoList?: P123Info[]; Next?: number }>(
    session.base,
    "/api/share/get",
    {
      token: session.token,
      query:
        `limit=100&next=0&orderBy=file_name&orderDirection=asc`
        + `&shareKey=${encodeURIComponent(session.shareKey)}`
        + `&ParentFileId=${encodeURIComponent(parentId)}`
        + `&Page=1&event=homeListFile&operateType=1&OrderId=&superAdmin=null`
        + `&SharePwd=${encodeURIComponent(session.pwd)}`,
    }
  );
  if (!r.ok || (r.code !== 0 && r.code !== 200) || !r.data) {
    throw new Error(r.message || `读取 123 分享目录失败（HTTP ${r.status} / code ${r.code}）`);
  }
  return r.data.InfoList ?? [];
}

/** 递归收集分享里某个目录下的**叶子文件**（123 不返回目录树，只能自己下钻） */
async function p123CollectFiles(
  session: P123ShareSession,
  parentId: string,
  depth = 0
): Promise<ShareFile[]> {
  if (depth > 6) return [];
  const list = await p123ListShare(session, parentId);
  const out: ShareFile[] = [];
  for (const it of list) {
    if (Number(it.Type) === 1) {
      out.push(...(await p123CollectFiles(session, String(it.FileId), depth + 1)));
    } else {
      out.push({ id: String(it.FileId), name: String(it.FileName ?? ""), size: Number(it.Size ?? 0) });
    }
  }
  return out;
}

/** 123：列出分享的顶层条目（供「分享目录订阅」用） */
async function p123ListShareEntries(
  token: string,
  shareUrl: string,
  passcode: string | null
): Promise<ShareEntry[]> {
  const { base, shareKey } = p123ShareCtx(shareUrl);
  if (!shareKey) throw new Error("无法从链接解析出 123 云盘分享 key（形如 .../123pan/xxxx）");
  const session: P123ShareSession = {
    base,
    shareKey,
    pwd: (passcode ?? "").trim() || pwdFromUrl(shareUrl),
    token,
  };
  const top = await p123ListShare(session, "0");
  const entries: ShareEntry[] = [];
  for (const it of top) {
    const id = String(it.FileId);
    const isDir = Number(it.Type) === 1;
    let files: ShareFile[] = [];
    if (isDir) {
      files = await p123CollectFiles(session, id, 1);
    } else {
      files = [{ id, name: String(it.FileName ?? ""), size: Number(it.Size ?? 0) }];
    }
    const kept = dropNonContent(files).files;
    entries.push({
      key: id,
      title: String(it.FileName ?? ""),
      files: kept,
      // 文件夹模式：整目录转存必须传「目录自身」（123 转存接口用 type:1 表示目录）
      dirMarker: isDir ? { id, name: String(it.FileName ?? ""), size: Number(it.Size ?? 0), isDir: true } : null,
      skippedImages: files.length - kept.length,
      rawKeys: kept.map((f) => f.id),
    });
  }
  return entries;
}

/**
 * 123：按路径逐级建目录。
 * 关键点（2026-10 实测）：
 *   1. 123 没有 `/file/mkdir`（返回 404），建目录要用 `POST /file/upload_request`，
 *      body = {parentFileId, fileName, size:0, md5:空串md5, etag:空串md5, type:1}，
 *      type:1 才是目录（type:0 建出来是空文件），返回的 fid 在 data.Info.FileId（不是 data.FileId）。
 *   2. 目录在 123 里是用 FileId 标识的：目录选择器给的「34835785」这种值就是 FileId，
 *      不是目录名。当整段是纯数字时直接当 FileId 用，不要拿它去建同名目录。
 */
async function p123EnsureDir(token: string, path: string): Promise<string> {
  const raw = (path ?? "").trim();
  // 纯数字 = FileId，直接用（目录选择器传的就是它）
  if (/^\d+$/.test(raw)) return raw;
  let cur = "0";
  for (const seg of raw.split("/").filter(Boolean)) {
    const dirs = await p123ListDirs(token, cur);
    const hit = dirs.find((d) => d.name === seg);
    if (hit) {
      cur = hit.id;
      continue;
    }
    const r = await p123FetchJson<{ Info?: { FileId?: number | string }; FileId?: number | string }>(
      P123_B,
      "/file/upload_request",
      {
        method: "POST",
        token,
        body: {
          parentFileId: Number(cur),
          fileName: seg,
          size: 0,
          md5: P123_EMPTY_MD5,
          etag: P123_EMPTY_MD5,
          type: 1,
        },
      }
    );
    const fid = r.data?.Info?.FileId ?? r.data?.FileId;
    if (!fid || (r.code !== 0 && r.code !== 200)) {
      throw new Error(
        `123 创建目录「${seg}」失败：${r.code} ${r.message || `HTTP ${r.status}`}`
      );
    }
    cur = String(fid);
  }
  return cur;
}

/** 123：转存「指定文件」到自己的网盘（copy/save → 轮询任务） */
async function p123TransferFiles(
  token: string,
  shareUrl: string,
  passcode: string | null,
  files: ShareFile[],
  dir: string | null
): Promise<TransferResult> {
  const only = dropNonContent(files).files;
  if (only.length === 0) return { ok: false, message: "没有需要转存的文件（图片/文本已跳过）" };
  const { base, shareKey } = p123ShareCtx(shareUrl);
  if (!shareKey) return { ok: false, message: "无法从链接解析出 123 云盘分享 key" };
  const pwd = (passcode ?? "").trim() || pwdFromUrl(shareUrl);
  const session: P123ShareSession = { base, shareKey, pwd, token };

  let targetFid = "0";
  let fellBackToRoot = false;
  try {
    targetFid = dir ? await p123EnsureDir(token, dir) : "0";
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  /**
   * 目录有效性探测：123 的目录被删除后重建会**换新的 FileId**，订阅里存的旧 id 就成了空壳。
   * 这种情况下 123 提交转存照样返回 code 0 + taskID（任务实际失败），轮询接口又 404 查不到原因，
   * 只能靠遍历目录树提前识别：失效就落根目录，别让整批文件凭空消失。
   */
  if (targetFid !== "0" && !(await p123DirExists(token, targetFid))) {
    targetFid = "0";
    fellBackToRoot = true;
  }

  /**
   * 提交转存。parentFileID 就是目标目录（实测有效）。
   * 2026-10-18 按《123云盘转存接口》抓包对齐（此前实现一直报 101310 的根因全在这里）：
   *   · 提交地址是**分享子域**的 /api/restful/goapi/v1/file/copy/save
   *     （个人盘 b/api、以及不带 /api 的写法都 404 / no Route matched）
   *   · body 不是 fileIds 数组，而是 fileList 对象数组：
   *       {fileList:[{fileID,size,etag,type,parentFileID,fileName,driveID}],
   *        shareKey, sharePwd, currentLevel:0, superAdmin:null}
   */
  const submit = async (parentFileId: number) =>
    await p123FetchJson<{ taskID?: string; taskId?: string }>(
      session.base,
      "/api/restful/goapi/v1/file/copy/save",
      {
        method: "POST",
        token,
        body: {
          fileList: only.map((f) => ({
            fileID: Number(f.id),
            size: Number(f.size ?? 0),
            etag: "",
            /** type：0 = 文件，1 = 目录（文件夹模式整目录转存就靠这个标志） */
            type: f.isDir ? 1 : 0,
            parentFileID: parentFileId,
            fileName: f.name,
            driveID: 0,
          })),
          shareKey,
          sharePwd: pwd || "",
          currentLevel: 0,
          superAdmin: null,
        },
      }
    );
  const failed = (x: { ok: boolean; code: number; message: string; status: number }) =>
    !x.ok || (x.code !== 0 && x.code !== 200);

  /**
   * 落地回查 + 轮询：
   * 123 的轮询接口 /api/restful/goapi/v1/file/copy/save/get 实测全站 404，
   * 只能按「目标目录里有没有同名文件」判断；转存是异步任务，需要反复查（最多约 25s）。
   */
  const verifyLoop = async (fid: string): Promise<string[]> => {
    let got: string[] = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((res) => setTimeout(res, i === 0 ? 2500 : 3000));
      got = await p123VerifyLanded(token, fid, only);
      if (got.length >= only.length) break;
    }
    return got;
  };

  let r = await submit(Number(targetFid) || 0);
  if (failed(r)) {
    return {
      ok: false,
      message: `123 转存提交失败：${r.code} ${r.message || `HTTP ${r.status}`}`,
      raw: r,
    };
  }
  let taskId = String(r.data?.taskID ?? r.data?.taskId ?? "");
  let landed = await verifyLoop(targetFid);

  /**
   * 目标目录失效的兜底：123 对**已删除/已重建的目录 FileId** 照样返回 code 0 + taskID，
   * 但文件不会落地（轮询接口又 404，看不到失败原因），回查只能查出「0 个落地」。
   * 这时直接改存网盘根目录重试一次，宁可位置不对也别让整批文件凭空消失。
   */
  if (landed.length === 0 && targetFid !== "0") {
    targetFid = "0";
    fellBackToRoot = true;
    const r2 = await submit(0);
    if (!failed(r2)) {
      taskId = String(r2.data?.taskID ?? r2.data?.taskId ?? "");
      landed = await verifyLoop("0");
    }
  }

  const whereNote = fellBackToRoot ? "（原转存目录已失效，本次改存到网盘根目录）" : "";
  if (landed.length > 0) {
    return {
      ok: true,
      transferred: landed.length,
      message: taskId
        ? `已转存 ${landed.length}/${only.length} 个文件到 123 云盘（任务 ${taskId}）${whereNote}`
        : `已转存 ${landed.length}/${only.length} 个文件到 123 云盘${whereNote}`,
      files: only.slice(0, landed.length),
      savedFids: landed,
    };
  }
  return {
    ok: false,
    message: taskId
      ? `123 转存任务已提交（${taskId}），但目标目录里还没出现这些文件${whereNote}`
      : "123 转存提交成功，但目标目录里没有出现这些文件",
    raw: r,
  };
}

/**
 * 目标目录是否还在网盘里。
 *
 * 123 的坑：目录被删除后重建会**换新 FileId**，订阅里存的旧 id 就成了空壳；
 * 而 `/file/list/new` 对「失效 id」和「空目录」返回**完全一样**（code 0 + 空列表），
 * `/file/info`、`/file/get_info`、`/file/get_path_history` 全都 404 —— 接口层无法区分。
 * 只能遍历目录树确认这个 FileId 真的挂在某个父目录下。
 *
 * 保守策略：遍历到上限仍没找到就认为存在（宁可落错也不要静默回退），
 * 真正兜底的是「落地失败后改存根目录重试」。
 */
async function p123DirExists(token: string, fid: string): Promise<boolean> {
  if (!fid || fid === "0") return true;
  const MAX_DIRS = 40;
  const MAX_DEPTH = 3;
  const seen = new Set<string>();
  let frontier: Array<{ id: string; depth: number }> = [{ id: "0", depth: 0 }];
  let visited = 0;
  while (frontier.length > 0) {
    const next: Array<{ id: string; depth: number }> = [];
    for (const cur of frontier) {
      if (visited >= MAX_DIRS) return true;
      visited++;
      let entries: Array<{ id: string; name: string; size: number; isDir: boolean }>;
      try {
        entries = await p123ListEntries(token, cur.id);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDir) continue;
        if (e.id === fid) return true;
        if (!seen.has(e.id) && cur.depth + 1 < MAX_DEPTH) {
          seen.add(e.id);
          next.push({ id: e.id, depth: cur.depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * 复核：目标目录里有没有这些同名文件（保序前缀，fid 用于改名清洗）。
 *
 * 两个现实问题必须兜住（2026-10-18 实测踩到）：
 *   1. 123 遇到重名会自动改名成 `xxx(1).mkv`，精确匹配必然漏判 → 去掉 `(n)` 后缀再匹配；
 *   2. 转存是异步任务，秒传完成的也可能晚几秒才出现在列表里 → 由调用方反复轮询。
 */
async function p123VerifyLanded(token: string, parentId: string, files: ShareFile[]): Promise<string[]> {
  try {
    const entries = await p123ListEntries(token, parentId);
    const mk = (list: typeof entries) => {
      const exact = new Map<string, string>();
      /** 去掉 123 自动加的重名后缀后 → FileId（同名多个时取 id 最大的，即最新转存的那份） */
      const loose = new Map<string, string>();
      for (const e of list) {
        exact.set(e.name, e.id);
        const k = e.name.replace(/\(\d+\)(?=\.[^.]+$|$)/, "");
        const prev = loose.get(k);
        if (!prev || Number(e.id) > Number(prev)) loose.set(k, e.id);
      }
      return { exact, loose };
    };
    const filesIdx = mk(entries.filter((x) => !x.isDir));
    const dirsIdx = mk(entries.filter((x) => x.isDir));
    const out: string[] = [];
    for (const f of files) {
      // 文件夹模式传的是目录，回查也必须去目录索引里找，否则永远判未落地
      const idx = f.isDir ? dirsIdx : filesIdx;
      const id = idx.exact.get(f.name) ?? idx.loose.get(f.name.replace(/\(\d+\)(?=\.[^.]+$|$)/, ""));
      if (!id) break;
      out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

/** 123：转存整份分享（普通订阅用；123 的「创建分享」接口文档未覆盖，返回源链接） */
async function p123Transfer(
  token: string,
  shareUrl: string,
  passcode: string | null,
  dir: string | null
): Promise<TransferResult> {
  const entries = await p123ListShareEntries(token, shareUrl, passcode);
  const files = entries.flatMap((e) => e.files);
  if (files.length === 0) return { ok: false, message: "分享里没有可转存的文件" };
  const t = await p123TransferFiles(token, shareUrl, passcode, files, dir);
  return t.ok ? { ...t, shareUrl } : t;
}

/** 123：个人网盘列目录（浏览/选择转存位置） */
async function p123ListEntries(
  token: string,
  parentId: string
): Promise<Array<{ id: string; name: string; size: number; isDir: boolean }>> {
  const r = await p123FetchJson<{ InfoList?: P123Info[] }>(P123_B, "/file/list/new", {
    token,
    query:
      `driveId=0&limit=200&next=0&orderBy=file_id&orderDirection=desc`
      + `&parentFileId=${encodeURIComponent(parentId || "0")}&trashed=false&SearchData=&Page=1`
      + `&OnlyLookAbnormalFile=0&event=homeListFile&operateType=4&inDirectSpace=false`,
  });
  if (!r.ok || (r.code !== 0 && r.code !== 200) || !r.data) {
    throw new Error(r.message || `读取 123 云盘目录失败（HTTP ${r.status} / code ${r.code}）`);
  }
  return (r.data.InfoList ?? []).map((it) => ({
    id: String(it.FileId),
    name: String(it.FileName ?? ""),
    size: Number(it.Size ?? 0),
    isDir: Number(it.Type) === 1,
  }));
}

async function p123ListDirs(token: string, parentId: string): Promise<Array<{ id: string; name: string }>> {
  return (await p123ListEntries(token, parentId))
    .filter((e) => e.isDir)
    .map((e) => ({ id: e.id, name: e.name }));
}

async function p123RenameFile(token: string, fileId: string, newName: string): Promise<void> {
  const r = await p123FetchJson(P123_B, "/file/rename", {
    method: "POST",
    token,
    body: { FileId: Number(fileId), FileName: newName, DriveId: 0, driveId: 0 },
  });
  if (!r.ok || (r.code !== 0 && r.code !== 200)) {
    throw new Error(`123 重命名失败：${r.code} ${r.message || `HTTP ${r.status}`}`);
  }
}

/**
 * 123：删除文件/目录。
 * 实测结论（2026-10-18）：
 *   · operation 必须给值（缺了报「请输入Operation」）；给 **1** 时接口返回 code 0 但文件纹丝不动（假成功），
 *     给 **2** 才真的把文件**移入回收站**（可在 123 网页端恢复）。
 *   · 注意：移入回收站的目录会从原目录树里消失，**引用它的订阅 target_dir 就会失效**——
 *     123 提交转存时不会报错，只会给一个 taskID 然后文件不落地，轮询接口 404 也查不到原因。
 *     所以除了这里，p123TransferFiles 里也做了「目录树遍历校验 + 失效回退根目录」。
 */
async function p123DeleteFiles(token: string, fileIds: string[]): Promise<number> {
  const list = fileIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  if (list.length === 0) return 0;
  const r = await p123FetchJson(P123_B, "/file/trash", {
    method: "POST",
    token,
    body: { fileIds: list, FileIds: list, operation: 2, Operation: 2 },
  });
  if (!r.ok || (r.code !== 0 && r.code !== 200)) {
    throw new Error(`123 删除失败：${r.code} ${r.message || `HTTP ${r.status}`}`);
  }
  return list.length;
}

/** 123：登录态校验（/user/info；文档标注成功码可能是 0 或 200） */
async function p123AuthCheck(token: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await p123FetchJson<{ nickname?: string }>(P123_B, "/user/info", { token });
    return { ok: r.ok && (r.code === 0 || r.code === 200), message: r.message || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

async function p123AccountName(token: string): Promise<string> {
  try {
    const r = await p123FetchJson<{ nickname?: string; nickName?: string; name?: string }>(
      P123_B,
      "/user/info",
      { token }
    );
    const d = r.data ?? {};
    return String(d.nickname ?? d.nickName ?? d.name ?? "");
  } catch {
    return "";
  }
}

// ───────────── 123 云盘扫码登录 ─────────────
// 登录中心在另一个域（user.123pan.cn），这两个接口不带 2.2 节那套动态签名，实测直接 GET 即可。
const P123_USER = "https://user.123pan.cn";

/**
 * 申请扫码会话：返回 uniID 与二维码内容（官方页面地址 + uniID）。
 *
 * 关键（2026-10-18 实测，之前一直用错导致「App 扫码弹微信」）：
 *   `qr-code/generate` 的二维码类型**由 platform 请求头决定**：
 *     · platform=web / app / 5 / 6 / 7 → url = yun.123pan.cn/wx-app-login.html（微信 H5 页）
 *     · platform=android / ios        → url = yun.123pan.cn/qr-scan-page   （App 原生扫码页）
 *   只有 qr-scan-page 才是 123云盘 App 认的码：扫完由 App 完成授权，
 *   轮询 result 会按文档 3.2 直接下发 data.token（scanPlatform=7）。
 *   固定用 android 即可 —— android 与 ios 下发的是同一个 qr-scan-page。
 */
async function p123QrStart(): Promise<{ uniId: string; qrUrl: string }> {
  const r = await fetch(`${P123_USER}/api/user/qr-code/generate`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...p123Headers(),
      platform: "android",
    },
  });
  const text = await r.text();
  let j: { code?: number; message?: string; data?: { url?: string; uniID?: string } } = {};
  try {
    j = JSON.parse(text) as typeof j;
  } catch {
    throw new Error(`123 申请扫码失败：返回非 JSON（HTTP ${r.status}）`);
  }
  const uniId = String(j.data?.uniID ?? "");
  const pageUrl = String(j.data?.url ?? "https://yun.123pan.cn/qr-scan-page");
  if (j.code !== 0 || !uniId) {
    throw new Error(`123 申请扫码失败：${j.message || `HTTP ${r.status}`}${uniId ? "" : "（未拿到 uniID）"}`);
  }
  /**
   * 二维码内容必须与官方前端完全一致（2026-10-18 从 app bundle 里挖出的原文）：
   *   `${data.url}?env=production&uniID=${uniID}&source=123pan&type=login`
   * 只拼 `?uniID=` 的话，App 收不到 `type=login`，就**不会弹登录确认框**（表现为扫了没反应）。
   */
  const qrUrl = /uniID=/i.test(pageUrl)
    ? pageUrl
    : `${pageUrl}?env=production&uniID=${encodeURIComponent(uniId)}&source=123pan&type=login`;
  return { uniId, qrUrl };
}

/**
 * 微信通道的官方兑换（文档 3.3 节）——**这正是之前一直拿不到令牌的原因**：
 * 微信里点「确认」后，令牌不是由 `qr-code/result` 下发的，而是要我们自己两步换：
 *   1) POST /api/user/qr-code/wx_code  {uniID}            → data.wxCode
 *   2) POST /api/user/sign_in  {from:"web", wechat_code, type:4} → data.token（= authorToken）
 * 只轮询 result 的话，微信端明明显示「已登录」，服务端这边永远停在 waiting。
 * （App 扫码才是 result 直接给 data.token 的那条路。）
 */
async function p123WxRedeem(uniId: string): Promise<string> {
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${P123_USER}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json;charset=UTF-8", ...p123Headers() },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    try {
      return JSON.parse(t) as { code?: number; message?: string; data?: { wxCode?: string; token?: string } };
    } catch {
      return { code: -1, message: t.slice(0, 120) };
    }
  };
  const w = await post("/api/user/qr-code/wx_code", { uniID: uniId });
  const wxCode = String(w?.data?.wxCode ?? "");
  console.log(
    `[p123-wx] uniID=${uniId.slice(0, 8)}… wx_code code=${w?.code} wxCodeLen=${wxCode.length}`
  );
  if (!wxCode) return "";
  const s = await post("/api/user/sign_in", { from: "web", wechat_code: wxCode, type: 4 });
  const token = String(s?.data?.token ?? "");
  if (!token) {
    console.log(
      `[p123-qr] sign_in 未换到令牌：code=${s?.code} message=${s?.message ?? ""} dataKeys=${Object.keys(s?.data ?? {}).join(",")}`
    );
  }
  return token;
}

/**
 * 轮询扫码状态（1s 一次）。枚举按《123云盘登录凭证接口》源码：
 *   0 NotScanned 未扫码 ｜ 1 Scanned 已扫码待确认 ｜ 2 rejected 用户拒绝
 *   3 Allowed 已确认（App 扫码时 data.token 直接下发）｜ 4 expired 二维码过期
 *
 * 微信通道下 result **不会**给 token，要靠 p123WxRedeem 兑换；两条路都试。
 */
async function p123QrPoll(
  uniId: string
): Promise<{ state: "waiting" | "ok" | "expired" | "failed"; token?: string; message?: string }> {
  const u = `${P123_USER}/api/user/qr-code/result?uniID=${encodeURIComponent(uniId)}&remember=true&gray=true`;
  const r = await fetch(u, {
    method: "GET",
    headers: { Accept: "application/json", ...p123Headers(), platform: "android" },
  });
  const text = await r.text();
  let j: {
    code?: number;
    message?: string;
    data?: {
      loginStatus?: number;
      token?: string;
      accessToken?: string;
      authorToken?: string;
      access_token?: string;
    };
  } = {};
  try {
    j = JSON.parse(text) as typeof j;
  } catch {
    return { state: "failed", message: `扫码状态异常：返回非 JSON（HTTP ${r.status}）` };
  }
  const st = Number(j.data?.loginStatus ?? 0);
  /**
   * 诊断日志：微信里显示「已登录」但我们拿不到令牌时，唯一能定位的证据就是这里的原始响应。
   * 只打状态码与字段名，绝不打 token 本身。
   */
  const dataKeys = Object.keys(j.data ?? {});
  console.log(
    `[p123-qr] uniID=${uniId.slice(0, 8)}… code=${j.code} loginStatus=${st} `
    + `dataKeys=${dataKeys.join(",")} raw=${text.slice(0, 200)}`
  );
  const code = Number(j.code ?? -1);
  if (code === 5019 || code === 5020) return { state: "expired", message: j.message };
  // 官方前端把 result 的 code=200 也当成功（0 是常规成功码，200 是 App 授权成功的回执码）
  if (code !== 0 && code !== 200) return { state: "failed", message: j.message || `扫码接口返回 code=${code}` };

  const d = j.data ?? {};
  const token = String(d.token ?? d.accessToken ?? d.authorToken ?? d.access_token ?? "");
  if (token) return { state: "ok", token };
  /**
   * result 没给令牌（微信通道的常态）→ 走官方两步兑换。
   * 不看 loginStatus 就直接试：wx_code 本身就是「按 uniID 查 wxCode」的查询接口，
   * 未授权时返回空串，授权后立刻有值 —— 用 loginStatus 当门槛反而可能一直卡住不换。
   */
  try {
    const wxToken = await p123WxRedeem(uniId);
    if (wxToken) return { state: "ok", token: wxToken };
  } catch {
    // 兑换失败不判死，继续等（用户可能还没在微信里点确认）
  }
  const tip = "；也可以改用「令牌」按钮粘贴 authorToken 绑定";
  if (st === 2) return { state: "failed", message: `本次登录未确认（loginStatus=2 rejected）${tip}` };
  if (st === 4) return { state: "expired", message: `二维码已过期，请点「刷新二维码」重新获取${tip}` };
  if (st === 3) return { state: "waiting", message: `微信端已确认登录，正在向 123 换取令牌${tip}` };
  if (st === 1) return { state: "waiting", message: "已扫码，请在手机上点「确认登录」" };
  return { state: "waiting" };
}

// ───────────── 分享目录订阅（把网盘分享链接本身当订阅源：监控新增文件） ─────────────

/** 分享里的一个文件（夸克保存时需要 share_fid_token） */
interface ShareFile {
  id: string;
  name: string;
  token?: string | null;
  /**
   * 夸克：产出该 token 时的会话 stoken。
   * share_fid_token 与 stoken 绑定——保存时必须沿用同一个 stoken，否则 token 立即失效
   * （报「转存文件token校验异常」）。列目录时随文件带回，保存时直接复用。
   */
  stoken?: string | null;
  /** 文件体积（字节）：清洗后重名时用来决定谁加「高码」；拿不到时为空 */
  size?: number | null;
  /** true = 这是一条**目录**（文件夹模式整目录转存用；123 转存接口靠 type:1 表示目录） */
  isDir?: boolean;
}

/** 分享里的一个顶层条目（目录或散文件）：一个条目对应一条资源 */
interface ShareEntry {
  /** 稳定标识（顶层条目 fileId/fid），与分享链接一起构成去重指纹 */
  key: string;
  title: string;
  files: ShareFile[];
  /**
   * 夸克文件夹模式：该条目（目录）**自身**的转存标记（fid + share_fid_token）。
   * 整目录转存必须用它 —— 用目录里某个文件去转只会得到「该目录不存在」之类的报错。
   */
  dirMarker?: ShareFile | null;
  /** 因是图片被跳过的文件数（海报/截图/封面等，不转存） */
  skippedImages?: number;
  /** 首个条目的原始字段名：接口字段名若有差异，靠它一眼定位 */
  rawKeys?: string[];
}

/**
 * 图片类扩展名：订阅转存一律跳过（海报、封面、截图之类不是剧集内容）。
 * 在「收集文件清单」阶段就剔掉，这样它们不参与转存、不影响集数计算、
 * 也不会被「目标目录差集」当成缺失文件反复重试。
 */
const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "gif", "webp", "bmp", "tif", "tiff",
  "avif", "heic", "heif", "svg", "ico", "raw", "cr2", "nef", "arw", "dng", "psd",
]);

/** 文件名是不是图片（只看扩展名） */
function isImageFile(name: string): boolean {
  const m = /\.([A-Za-z0-9]{2,5})$/.exec((name ?? "").trim());
  return !!m && IMAGE_EXTENSIONS.has(m[1].toLowerCase());
}

/**
 * 文本类扩展名：订阅转存一律跳过。
 * 说明文件、字幕、清单、播放列表这类都算 —— 不是剧集内容，转存下来只占网盘空间，
 * 还会干扰「集数统计 / 目标目录差集」（把说明文件当成缺失的集数反复重试）。
 */
const TEXT_EXTENSIONS = new Set([
  // 纯文本 / 字幕 / 说明
  "txt", "md", "markdown", "nfo", "srt", "ass", "ssa", "sub", "idx", "cue", "vtt", "lrc",
  "log", "json", "xml", "html", "htm", "url", "ini", "cfg", "conf", "yml", "yaml", "toml",
  "csv", "tsv", "rtf", "mht", "mhtml", "js", "css", "bat", "sh", "sql",
  // 文档 / 表格 / 演示（Office 与常见办公格式：这类也不是剧集内容）
  "doc", "docx", "docm", "dot", "dotx", "xls", "xlsx", "xlsm", "xlsb",
  "ppt", "pptx", "pptm", "pps", "ppsx", "pdf", "odt", "ods", "odp",
  "epub", "wps", "et", "dps", "pages", "numbers", "key",
  "pub", "vsd", "vsdx", "chm", "tex", "wpd", "djvu",
]);

/** 文件名是不是文本类文件（只看扩展名） */
function isTextFile(name: string): boolean {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec((name ?? "").trim());
  return !!m && TEXT_EXTENSIONS.has(m[1].toLowerCase());
}

/** 不参与转存的「非内容文件」：图片（海报/封面）+ 文本（说明/字幕/清单） */
function isNonContentFile(name: string): boolean {
  return isImageFile(name) || isTextFile(name);
}

/** 从一批文件里剔除「非内容文件」（图片 + 文本），返回保留的文件与被跳过的数量 */
function dropNonContent(files: ShareFile[]): { files: ShareFile[]; skipped: number } {
  const kept = files.filter((f) => !isNonContentFile(f.name));
  return { files: kept, skipped: files.length - kept.length };
}

/**
 * 夸克 / UC 共用同一套 clouddrive 接口（同架构、同参数），差异只有 base / qs / Referer：
 *   · 夸克：https://drive-pc.quark.cn/1/clouddrive，pr=ucpro
 *   · UC  ：https://pc-api.uc.cn/1/clouddrive，pr=UCBrowser（《UC网盘接口逆向文档》§3/§4）
 * 因此下面的 quark* 实现统一接受一个 cfg，UC 只是换一份配置跑同一套代码。
 */
interface CdCfg {
  base: string;
  qs: string;
  referer: string;
  /** 分享链接前缀（创建分享时拼 URL 用） */
  shareHost: string;
  /** 报错文案里的网盘名 */
  label: string;
}

const CD_QUARK: CdCfg = {
  base: "https://drive-pc.quark.cn/1/clouddrive",
  qs: "pr=ucpro&fr=pc&uc_param_str=",
  referer: "https://pan.quark.cn/",
  shareHost: "https://pan.quark.cn/s",
  label: "夸克",
};

const CD_UC: CdCfg = {
  base: "https://pc-api.uc.cn/1/clouddrive",
  qs: "pr=UCBrowser&fr=pc",
  referer: "https://drive.uc.cn/",
  shareHost: "https://drive.uc.cn/s",
  label: "UC",
};

/** 按网盘取配置（非 uc 一律按夸克处理，保持旧行为） */
function cdOf(pan: string): CdCfg {
  return pan === "uc" ? CD_UC : CD_QUARK;
}

const QUARK_BASE = CD_QUARK.base;
const QUARK_QS = CD_QUARK.qs;

/** 去掉扩展名：S01E09.mkv → S01E09 */
function stripExt(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{2,5}$/, "").trim();
}

/**
 * 光鸭文件名字段读取：盘内文件列表用 fileName（探测接口已验证），分享列表可能用 name，
 * 因此取「第一个非空」的候选字段，避免字段名差异导致名字为空。
 */
function gyFieldName(item: Record<string, unknown>): string {
  for (const key of ["fileName", "name", "fname", "file_name"]) {
    const v = String(item[key] ?? "").trim();
    if (v) return v;
  }
  return "";
}

/**
 * 目录列表超时：光鸭这个接口认证后要在服务端盘点目录，实测偏慢（尤其大目录），
 * 因此给足 30 秒；同时不重试（重试只会让用户多等一轮）。
 */
const GY_DIR_TIMEOUT_MS = 10000;
const GY_DIR_PAGE_SIZE = 100;

/**
 * 目录列表短缓存（5 分钟）。
 * 实测光鸭该接口会「间歇性无响应」：同一请求可能 150ms 返回，也可能挂到超时，
 * 因此浏览目录时尽量复用结果、减少调用次数（重命名时要找刚落地的新文件，不能用缓存）。
 */
const gyDirCache = new Map<string, { at: number; data: Array<Record<string, unknown>> }>();
const GY_DIR_CACHE_TTL = 5 * 60 * 1000;

/**
 * 光鸭：列出某个目录下的条目（自动翻页）。
 * 参数严格照抄前端自身「文件夹树」的加载逻辑：
 *   f9({ page, pageSize: 100, parentId, resType: 2, needSubFolderStat: true })
 * 关键：必须带 resType —— 不带的请求在认证后服务端会长时间不返回（表现为 Signal timed out）；
 * 根目录因为是空 parentId 走了短路，才会「看起来正常」。
 * files=true 时用 resType=1 取文件（转存后改名时按名字找回文件用）。
 */
async function gyListFolder(
  cred: PanCred,
  parentId: string,
  opts: { files?: boolean; maxPages?: number; refresh?: boolean; strict?: boolean } = {}
): Promise<Array<Record<string, unknown>>> {
  const dirId = parentId || cred.rootDirId || "";
  const maxPages = opts.maxPages ?? 10;

  // 浏览目录用缓存（找刚转存的新文件时必须实时，因此 opts.files 不走缓存）
  const cacheKey = `${cred.userId}|${dirId}|${opts.files ? "files" : "dirs"}`;
  if (!opts.files && !opts.refresh) {
    const hit = gyDirCache.get(cacheKey);
    if (hit && Date.now() - hit.at < GY_DIR_CACHE_TTL) return hit.data;
  }

  const all: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let total = Number.POSITIVE_INFINITY;

  const fetchPage = async (page: number) => {
    const r = await gyCall(
      cred,
      "/userres/v1/file/get_file_list",
      {
        page,
        pageSize: GY_DIR_PAGE_SIZE,
        parentId: dirId,
        resType: opts.files ? 1 : 2,
        // 前端树会带 needSubFolderStat 统计子目录文件数；这里只在浏览目录，不需要它，
        // 去掉可显著减少服务端要做的活（这个接口本来就是慢在服务端盘点）
      },
      { timeoutMs: GY_DIR_TIMEOUT_MS }
    );
    const data = (r?.data ?? {}) as Record<string, unknown>;
    const list = (data.list ?? []) as Array<Record<string, unknown>>;
    // 注意 null：Number(null) === 0，会把「没返回 total」误判成「目录是空的」。
    // 只有接口明确给了数字才算数，否则保持未知（= 不可信，不能据此认为目录为空）。
    if (data.total != null && Number.isFinite(Number(data.total))) total = Number(data.total);
    return list;
  };

  // 页码起点实测不稳定（0 / 1 两说）：先按 0 取，首页为空就按 1 再试一次。
  // 不做这一步时，1-based 的账号会「一页都取不到」→ 表现为目录读取失败/为空。
  let startPage = 0;
  let first = await fetchPage(startPage);
  if (first.length === 0) {
    startPage = 1;
    first = await fetchPage(1);
  }
  if (first.length === 0) {
    // 【防重复转存的关键，仅 strict 模式】只有一种情况能断定「读失败」：
    // 接口明确说这个目录里有 total 个条目、却一个都没返回 —— 列表不完整，
    // 把它当成「空目录」就会让上层认为该集全都缺失而整份重转。
    //
    // 注意：total **未知**（接口没返回该字段）时不能当成读失败 —— 清空后的真空目录
    // 正是这个样子（实测：目录清空后接口返回空 list 且不带 total）。早先这里把
    // 「total 未知 + 空列表」也判成读失败，结果是目录一清空就再也转不进去，
    // 只能手动恢复。而真正的链路无响应是由 gyCall 抛错的（超时/错误码），
    // 那种情况压根走不到这里 —— 返回空列表说明请求本身是成功的。
    if (opts.strict && Number.isFinite(total) && total > 0) {
      throw new Error(
        `读取光鸭目录 ${dirId || "根目录"} 不完整（应有 ${total} 个条目但一个都没返回），`
        + `无法可靠判断哪些文件已存在；该平台偶发无响应，请稍后重试`
      );
    }
    if (!opts.files && !opts.strict) gyDirCache.set(cacheKey, { at: Date.now(), data: all });
    return all;
  }

  for (const it of first) {
    const id = String(it.fileId ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    all.push(it);
  }

  let lastLen = first.length;
  for (let i = 1; i < maxPages; i++) {
    if (all.length >= total) break;
    if (lastLen < GY_DIR_PAGE_SIZE) break;
    let list = await fetchPage(startPage + i);
    if (list.length === 0) {
      // 空页也可能是跨境抖动，不是真的翻到头了：重试同一页一次。
      // 原来这里直接 break，少列的部分会被上层当成「目录里没有这些文件」→ 重复转存。
      list = await fetchPage(startPage + i);
      if (list.length === 0) break;
    }
    lastLen = list.length;
    for (const it of list) {
      const id = String(it.fileId ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      all.push(it);
    }
  }
  // 取不满（total 已知且已取条数少于它）说明列表被截断，不能当成「完整目录」——
  // 没看到的文件会被上层当成缺失而重转。只在 strict 下抛错。
  if (opts.strict && Number.isFinite(total) && all.length < total) {
    throw new Error(
      `读取光鸭目录 ${dirId || "根目录"} 不完整（已取 ${all.length}/${total}），`
      + `无法可靠判断哪些文件已存在；该平台偶发无响应，请稍后重试`
    );
  }
  if (!opts.files && !opts.strict) gyDirCache.set(cacheKey, { at: Date.now(), data: all });
  return all;
}

/** 光鸭：递归收集某目录下的叶子文件（带文件名） */
async function gyCollectLeafFilesNamed(
  cred: PanCred,
  sat: string,
  parentId: string,
  acc: ShareFile[],
  depth = 0
): Promise<void> {
  if (depth > 16) return;
  const list = await gyListShareFiles(cred, sat, parentId);
  for (const item of list) {
    const fileId = String(item.fileId ?? "");
    if (!fileId) continue;
    if (Number(item.resType ?? 1) === 2) {
      await gyCollectLeafFilesNamed(cred, sat, fileId, acc, depth + 1);
    } else {
      acc.push({
        id: fileId,
        name: gyFieldName(item) || fileId,
        size: Number(item.fileSize ?? 0) || null,
      });
    }
  }
}

/** 光鸭：列出分享的顶层条目（每个目录/散文件 = 一条资源） */
async function gyListShareEntries(cred: PanCred, shareUrl: string): Promise<ShareEntry[]> {
  const shareId = gyParseShareId(shareUrl);
  if (!shareId) throw new Error("无法从链接解析出光鸭分享 ID");
  const sat = await gyShareAccessToken(cred, shareId);
  const top = await gyListShareFiles(cred, sat, "");
  const entries: ShareEntry[] = [];
  for (const item of top) {
    const fileId = String(item.fileId ?? "");
    if (!fileId) continue;
    const rawName = gyFieldName(item);
    const rawKeys = entries.length === 0 ? Object.keys(item) : undefined;
    if (Number(item.resType ?? 1) === 2) {
      const all: ShareFile[] = [];
      await gyCollectLeafFilesNamed(cred, sat, fileId, all);
      // 图片不转存：直接剔掉——不参与转存、不计入集数、也不会被当成「缺失文件」反复重试
      const { files, skipped } = dropNonContent(all);
      if (files.length === 0) continue;
      entries.push({
        key: fileId,
        title: rawName || `目录 ${fileId.slice(0, 8)}`,
        files,
        skippedImages: skipped,
        rawKeys,
      });
    } else {
      // 顶层散文件同样跳过图片与文本
      const name = rawName || "未命名文件";
      if (isNonContentFile(name)) continue;
      entries.push({
        key: fileId,
        title: stripExt(name) || name,
        files: [{ id: fileId, name, size: Number(item.fileSize ?? 0) || null }],
        rawKeys,
      });
    }
  }
  return entries;
}

interface QuarkSession {
  shareId: string;
  stoken: string;
  headers: Record<string, string>;
  /** 夸克 / UC 的接口配置（列目录、转存都要沿用它，否则会串到另一家接口） */
  cd: CdCfg;
}

/** 夸克 / UC：打开分享，拿 stoken 与请求头 */
async function quarkOpenShare(
  cookie: string,
  shareUrl: string,
  passcode: string | null,
  cd: CdCfg = CD_QUARK
): Promise<QuarkSession | { error: string }> {
  const shareId = /\/s\/([A-Za-z0-9]+)/.exec(shareUrl)?.[1];
  if (!shareId) return { error: "无法从分享链接解析出网盘分享 ID" };
  const headers = {
    Cookie: cookie,
    "Content-Type": "application/json",
    "User-Agent": UA,
    Referer: cd.referer,
  };
  const res = await fetch(`${cd.base}/share/sharepage/token?${cd.qs}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ pwd_id: shareId, passcode: passcode ?? "" }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.status !== 200) return { error: j?.message || `获取分享信息失败（HTTP ${res.status}）` };
  const stoken = j?.data?.stoken as string | undefined;
  if (!stoken) return { error: `获取${cd.label}分享令牌失败` };
  return { shareId, stoken, headers, cd };
}

/** 夸克 / UC：列出分享中某目录下的全部条目（自动翻页） */
async function quarkListDir(sess: QuarkSession, pdirFid: string): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(
      `${sess.cd.base}/share/sharepage/detail?${sess.cd.qs}&pwd_id=${sess.shareId}&stoken=${encodeURIComponent(sess.stoken)}&pdir_fid=${pdirFid}&force=0&_page=${page}&_size=100&_fetch_banner=0&_fetch_share=0`,
      { headers: sess.headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    const j = await res.json().catch(() => null);
    const list = (j?.data?.list ?? []) as Array<Record<string, unknown>>;
    all.push(...list);
    if (list.length < 100) break;
  }
  return all;
}

/** 夸克：递归收集目录下的叶子文件 */
async function quarkCollectFiles(
  sess: QuarkSession,
  parentFid: string,
  acc: ShareFile[],
  depth = 0
): Promise<void> {
  if (depth > 3) return;
  const list = await quarkListDir(sess, parentFid);
  for (const item of list) {
    const fid = String(item.fid ?? "");
    if (!fid) continue;
    const name = String(item.file_name ?? "").trim();
    if (item.dir === true) await quarkCollectFiles(sess, fid, acc, depth + 1);
    else acc.push({
      id: fid,
      name: name || fid,
      token: (item.share_fid_token as string) ?? null,
      stoken: sess.stoken,
      size: Number(item.size ?? item.file_size ?? 0) || null,
    });
  }
}

/** 夸克 / UC：列出分享的顶层条目 */
async function quarkListShareEntries(
  cookie: string,
  shareUrl: string,
  passcode: string | null,
  cd: CdCfg = CD_QUARK
): Promise<ShareEntry[]> {
  const sess = await quarkOpenShare(cookie, shareUrl, passcode, cd);
  if ("error" in sess) throw new Error(sess.error);
  const top = await quarkListDir(sess, "0");
  const entries: ShareEntry[] = [];
  for (const item of top) {
    const fid = String(item.fid ?? "");
    if (!fid) continue;
    const name = String(item.file_name ?? "").trim();
    const rawKeys = entries.length === 0 ? Object.keys(item) : undefined;
    if (item.dir === true) {
      const all: ShareFile[] = [];
      await quarkCollectFiles(sess, fid, all);
      // 图片与文本不转存：剔掉后再判断条目是否还有内容
      const { files, skipped } = dropNonContent(all);
      if (files.length === 0) continue;
      entries.push({
        key: fid,
        title: name || `目录 ${fid.slice(0, 8)}`,
        files,
        skippedImages: skipped,
        // 文件夹模式：整目录转存要用「目录自身的 fid + share_fid_token」（顶层列表里就带回来了）
        dirMarker: {
          id: fid,
          name: name || fid,
          token: (item.share_fid_token as string) ?? null,
          stoken: sess.stoken,
        },
        rawKeys,
      });
    } else {
      const fname = name || fid;
      if (isImageFile(fname)) continue;
      entries.push({
        key: fid,
        title: stripExt(fname) || fname,
        files: [{
          id: fid,
          name: fname,
          token: (item.share_fid_token as string) ?? null,
          stoken: sess.stoken,
          size: Number(item.size ?? item.file_size ?? 0) || null,
        }],
        rawKeys,
      });
    }
  }
  return entries;
}

/** 夸克：转存指定文件到目标目录 */
async function quarkTransferFiles(
  cookie: string,
  shareUrl: string,
  passcode: string | null,
  files: ShareFile[],
  dir: string | null,
  cd: CdCfg = CD_QUARK
): Promise<TransferResult> {
  if (files.length === 0) return { ok: false, message: "没有需要转存的文件" };
  const shareId = /\/s\/([A-Za-z0-9]+)/.exec(shareUrl)?.[1];
  if (!shareId) return { ok: false, message: "无法从分享链接解析出网盘分享 ID" };
  const headers = {
    Cookie: cookie,
    "Content-Type": "application/json",
    "User-Agent": UA,
    Referer: cd.referer,
  };

  // 关键：必须沿用「列目录那一刻的同一个 stoken」。夸克的 share_fid_token 与 stoken 绑定，
  // 换一个 stoken（例如再开一次分享）后旧 token 立即失效，保存会报「转存文件token校验异常」。
  // 正常情况下 token 与 stoken 都由列目录随文件带回，直接复用即可。
  let stoken = files.find((f) => f.stoken)?.stoken ?? null;
  let list = files;
  if (!stoken) {
    // 兜底（整份转存等路径没带 stoken）：现场开一个会话并重列，取同一会话的 fid→token
    const sess = await quarkOpenShare(cookie, shareUrl, passcode, cd);
    if ("error" in sess) return { ok: false, message: sess.error };
    stoken = sess.stoken;
    const all: ShareFile[] = [];
    const top = await quarkListDir(sess, "0");
    for (const item of top) {
      const fid = String(item.fid ?? "");
      if (!fid) continue;
      if (item.dir === true) await quarkCollectFiles(sess, fid, all);
      else {
        all.push({
          id: fid,
          name: String(item.file_name ?? fid),
          token: (item.share_fid_token as string) ?? null,
          stoken: sess.stoken,
        });
      }
    }
    const tok = new Map(all.map((f) => [f.id, f.token]));
    list = files.map((f) => ({ ...f, token: tok.get(f.id) ?? f.token, stoken: sess.stoken }));
  }

  // fid 与 token 必须一一对应：缺 token 的夸克会拒收，且不能只过滤 token 数组（会与 fid 列表错位），
  // 这里整体剔除缺 token 的文件。
  const sendable = list.filter((f) => f.id && f.token);
  if (sendable.length === 0) return { ok: false, message: "分享文件缺少转存 token，无法转存" };

  try {
    const res = await fetch(`${cd.base}/share/sharepage/save?${cd.qs}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fid_list: sendable.map((f) => f.id),
        fid_token_list: sendable.map((f) => f.token),
        to_pdir_fid: dir || "0",
        pwd_id: shareId,
        stoken,
        pdir_fid: "0",
        scene: "link",
        create_new_folder: false,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || j?.status !== 200) {
      return { ok: false, message: j?.message || `保存到网盘失败（HTTP ${res.status}）`, raw: j };
    }
    /**
     * UC 专用复核：task 回执（save_as / status）在 UC 上不可靠 —— 实测会出现
     * 「status=3 + code=32003 capacity limit」却已把文件落地的情况。
     * 所以以「目标目录里有没有这些同名文件」为唯一判据，顺带把 fid 取回来（改名清洗要用）。
     * 返回 null = 无法判定（非 UC，或列目录失败）。
     */
    const verifyLanded = async (): Promise<string[] | null> => {
      if (cd !== CD_UC || !dir) return null;
      try {
        const entries = await quarkListEntriesWithIds(cookie, dir, cd);
        const byName = new Map(entries.filter((e) => !e.isDir).map((e) => [e.name, e.id] as const));
        const out: string[] = [];
        for (const f of sendable) {
          const id = byName.get(f.name);
          // 只取「保序前缀」：清洗逻辑按索引配对 files / savedFids，错位会改错文件
          if (!id) break;
          out.push(id);
        }
        return out;
      } catch {
        return null;
      }
    };

    /** 回执异常但文件确实已落地时的统一返回（fid 按 sendable 顺序对齐） */
    const okLanded = (landed: string[], receipt: string): TransferResult => ({
      ok: true,
      transferred: landed.length,
      message: `已转存 ${landed.length}/${sendable.length} 个文件到${cd.label}网盘`
        + `（任务回执异常：${receipt}；已按目标目录实际落地情况判定）`
        + (landed.length < sendable.length
          ? `，有 ${sendable.length - landed.length} 个未落地（提示 capacity limit 即为 UC 转存容量限制）`
          : ""),
      files: sendable.slice(0, landed.length),
      savedFids: landed,
    });

    // 等保存任务完成，拿新 fid（清洗重命名需要）
    const taskId = j?.data?.task_id as string | undefined;
    let savedFids: string[] = [];
    let lastTask: unknown = null;
    for (let i = 0; i < 8 && taskId; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const tRes = await fetch(`${cd.base}/task?${cd.qs}&task_id=${taskId}&retry_index=${i}`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const tJson = await tRes.json().catch(() => null);
      lastTask = tJson;
      /**
       * 判成功要「先看结果、后看状态码」：
       *   · 文档 §4.4 的权威判据是 data.save_as.save_as_top_fids（非空 = 已落地，还能拿到新 fid）
       *   · data.status 的 2/3 语义是夸克那套；UC 这套不同，把 status=3 直接当失败会误杀已成功的任务
       */
      const topFids = (tJson?.data?.save_as?.save_as_top_fids ?? []) as string[];
      if (Array.isArray(topFids) && topFids.length > 0) {
        savedFids = topFids;
        break;
      }
      const st = Number(tJson?.data?.status ?? -1);
      if (st === 2) break; // 夸克语义：任务已完成（可能没有 top_fids）
      if (st === 3) {
        /**
         * UC 的完成回执常见「status=400/3 + code=32003(capacity limit)」，
         * 但 message 里带着 "save as select top…" —— 服务端其实已经选好了落地 fid，
         * 文件很可能已经在网盘里。回执不可信，一律改用 verifyLanded() 判真实结果。
         */
        const receipt = `${Number(tJson?.code ?? 0)} ${String(tJson?.message ?? "").slice(0, 160)}`.trim();
        const landed = await verifyLanded();
        if (landed && landed.length > 0) return okLanded(landed, receipt);
        return {
          ok: false,
          message: `${cd.label}转存任务失败（${receipt}）`
            + (landed === null ? "；复核目标目录失败" : "；复核后目标目录内未发现这些文件"),
          raw: tJson,
        };
      }
    }

    // 轮询走完仍没取回落地 fid（UC 的 task 回执常常不给 save_as）：同样复核一次目录
    if (savedFids.length === 0 && lastTask) {
      const lt = lastTask as { code?: number; message?: string } | null;
      const landed = await verifyLanded();
      if (landed && landed.length > 0) {
        return okLanded(landed, `${Number(lt?.code ?? 0)} ${String(lt?.message ?? "").slice(0, 160)}`.trim());
      }
    }
    return {
      ok: true,
      transferred: sendable.length,
      message: `已转存 ${sendable.length} 个文件到${cd.label}网盘`
        + (savedFids.length === 0 && lastTask
          ? `（任务已提交但未取回落地 fid：${JSON.stringify(lastTask).slice(0, 120)}）`
          : ""),
      files: sendable,
      savedFids,
    };
  } catch (e) {
    return { ok: false, message: `${cd.label}转存异常：${(e as Error).message}` };
  }
}

/** 列出分享目录的顶层条目（需要该网盘已绑定账号） */
async function listPanShareEntries(
  pan: string,
  cred: PanCred,
  shareUrl: string,
  passcode: string | null
): Promise<ShareEntry[]> {
  // 提取码：库里为空时认链接自带的 ?pwd=xxxx
  const pwd = (passcode ?? "").trim() || passcodeFromUrl(shareUrl);
  if (pan === "guangya") return await gyListShareEntries(cred, shareUrl);
  if (pan === "quark") return await quarkListShareEntries(cred.cookie ?? "", shareUrl, pwd);
  if (pan === "uc") return await quarkListShareEntries(cred.cookie ?? "", shareUrl, pwd, CD_UC);
  if (pan === "baidu") return await baiduListShareEntries(cred, shareUrl, pwd);
  if (pan === "p123") return await p123ListShareEntries(cred.token ?? "", shareUrl, pwd);
  const lockMsg = panLockedMsg(pan);
  if (lockMsg) throw new Error(lockMsg);
  if (pan === "xunlei") return await xlListShareEntries(cred, shareUrl, pwd);
  throw new Error(`暂不支持监控${PAN_LABELS[pan] ?? pan}的分享目录`);
}

/** 转存「指定文件」（分享目录订阅只转新增文件） */
async function transferShareFiles(
  pan: string,
  cred: PanCred,
  shareUrl: string,
  passcode: string | null,
  files: ShareFile[],
  dir: string | null
): Promise<TransferResult> {
  // 双保险：调用方在收集文件清单时已经剔过，这里再兜一次 —— 图片与文本永不转存
  const only = dropNonContent(files).files;
  if (only.length === 0) return { ok: false, message: "没有需要转存的文件（图片/文本已跳过）" };
  // 提取码：库里为空时认链接自带的 ?pwd=xxxx
  const pwd = (passcode ?? "").trim() || passcodeFromUrl(shareUrl);
  if (pan === "guangya") return await gyTransferFiles(cred, shareUrl, only, dir);
  if (pan === "quark") return await quarkTransferFiles(cred.cookie ?? "", shareUrl, pwd, only, dir);
  if (pan === "uc") return await quarkTransferFiles(cred.cookie ?? "", shareUrl, pwd, only, dir, CD_UC);
  if (pan === "baidu") return await baiduTransferFiles(cred, shareUrl, pwd, only, dir);
  if (pan === "p123") return await p123TransferFiles(cred.token ?? "", shareUrl, pwd, only, dir);
  const lockMsg = panLockedMsg(pan);
  if (lockMsg) return { ok: false, message: lockMsg };
  if (pan === "xunlei") return await xunleiTransferFiles(cred, shareUrl, pwd, only, dir);
  return { ok: false, message: `暂不支持的网盘：${pan}` };
}

// ───────────── 文件名清洗 & 目录定位（转存后重命名 / 选择转存位置） ─────────────

const EP_PATTERNS: Array<{ re: RegExp; fn: (m: RegExpExecArray) => { s: number; e: number } }> = [
  { re: /S(\d{1,2})[\s._-]*E(?:P)?(\d{1,3})/i, fn: (m) => ({ s: Number(m[1]), e: Number(m[2]) }) },
  { re: /(?:^|[\s._-])E(?:P)?[\s._-]?(\d{1,3})(?=[\s._-]|$)/i, fn: (m) => ({ s: 1, e: Number(m[1]) }) },
  { re: /第\s*(\d{1,4})\s*[集话話]/, fn: (m) => ({ s: 1, e: Number(m[1]) }) },
  { re: /(?:^|[\s._-])(\d{1,3})\s*[集话話](?=[\s._-]|$)/, fn: (m) => ({ s: 1, e: Number(m[1]) }) },
];

/** 常见噪声词：分辨率 / 来源 / 编码 / 音轨 / 字幕标记等 */
const NOISE_WORDS = [
  "2160p", "1080p", "720p", "480p", "4k", "8k", "hdr", "hdr10", "sdr", "dolby", "vision", "dv", "vivid",
  "web-dl", "webdl", "webrip", "web", "bluray", "blu-ray", "bdrip", "bd", "hdrip", "remux", "hdtv",
  "h.264", "h264", "h.265", "h265", "hevc", "avc", "x264", "x265", "10bit", "8bit", "60fps", "hq", "repack", "proper",
  "aac", "ac3", "eac3", "ddp", "dts", "dts-hd", "truehd", "atmos", "flac", "mp3", "5.1", "7.1", "2.0",
  "chs", "cht", "gb", "big5", "multi", "internal", "complete", "双语", "中字", "内嵌", "外挂", "简体", "繁体",
];

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 去噪：删掉含噪声词的括号组与噪声词本身，分隔符归一为空格 */
function stripNoise(base: string): string {
  let s = base.replace(/[[(（【]([^\])）】]{0,40})[\])）】]/g, (whole, inner: string) => {
    const low = inner.toLowerCase();
    return NOISE_WORDS.some((w) => low.includes(w)) ? " " : whole;
  });
  for (const w of NOISE_WORDS) {
    s = s.replace(new RegExp(`(?:^|[\\s._-])${escRe(w)}(?=$|[\\s._-])`, "gi"), " ");
  }
  return s.replace(/[._]+/g, " ").replace(/\s{2,}/g, " ").replace(/^[\s-]+|[\s-]+$/g, "").trim();
}

/**
 * 清洗文件名（不含扩展名），episode 模式：
 *   A.Prophet. 2026.S01E01.2160p.WEB-DL.H.265.HDR Vivid.DDP 5.1 → S01E01
 *   无集数标记时退化为「去噪」；清洗结果为空则保留原名。
 */
function cleanFileName(base: string, mode: string): string {
  if (mode !== "episode") return base;
  const raw = base.trim();
  for (const p of EP_PATTERNS) {
    const m = p.re.exec(raw);
    if (m) {
      const { s, e } = p.fn(m);
      if (e > 0) return `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
    }
  }
  return stripNoise(raw) || raw;
}

/** 拆扩展名 → 清洗 → 拼回（清洗后与原名相同则返回原名，调用方据此跳过改名） */
function cleanFileFullName(name: string, mode: string): string {
  if (mode !== "episode") return name;
  const m = /^(.*?)(\.[A-Za-z0-9]{2,5})$/.exec(name.trim());
  // 源名没有可识别的扩展名（多半是网盘给的内部名，如 32 位 hash）→ 保持原名不改：
  // 否则会拼出「S01E11」这种没有扩展名的文件，播放器打不开，用户也不知道哪来的。
  if (!m) return name;
  const base = m[1];
  const ext = m[2];
  const cleaned = cleanFileName(base, mode);
  if (!cleaned || cleaned === base) return name;
  return `${cleaned}${ext}`;
}

/** 在扩展名之前插入标记：S01E12.mp4 → S01E12高码.mp4 */
function tagBeforeExt(name: string, tag: string): string {
  const m = /^(.*?)(\.[A-Za-z0-9]{2,5})$/.exec(name.trim());
  return m ? `${m[1]}${tag}${m[2]}` : `${name}${tag}`;
}

/**
 * 规划一整批文件的清洗结果（原名 → 新名，只包含需要改名的）。
 *
 * 关键规则：**按「集号」分组**（清洗后去掉扩展名的名字），同一集的多个版本里体积最大的那个
 *   在名字后加「高码」区分；「高码」插在扩展名之前，各自保留自己的容器：
 *     S01E01 的 SDR 1.6G.mkv + HDR 3.7G.mp4 → S01E01高码.mp4 + S01E01.mkv
 *   注意不能按「完整文件名」分组——同一集的 mkv 与 mp4 是两个不同的文件名，
 *   那样会被当成两集、永远分不出高码版（历史 bug）。
 *
 * dirSizes：「目标目录里已有文件名 → 体积」。目标目录里同一集的已有文件也一起参与比较，
 *   这样「后补的更高画质版本」会被算成高码版，而不是撞上已有文件名后改名失败/覆盖别人。
 *   两边体积都拿得到且不同才算「被别的版本占着」；拿不到体积时不判重、不判占用（维持原名）。
 */
function planCleanedNames(
  files: ShareFile[],
  mode: string,
  dirSizes: Map<string, number> = new Map(),
  /** 仅清洗（文件夹模式）：不按体积加「高码」后缀，只用清洗名 */
  plainOnly = false
): Map<string, string> {
  const plan = new Map<string, string>();
  if (mode !== "episode" || files.length === 0) return plan;

  // 集号 = 清洗后的名字去掉扩展名；扩展名（含点）单独留着，改名时拼回去
  const baseOf = (n: string) => stripExt(n);
  const extOf = (n: string) => n.slice(stripExt(n).length);

  const rows = files.map((f) => {
    const target = cleanFileFullName(f.name, mode);
    return {
      name: f.name,
      target,
      base: baseOf(target),
      ext: extOf(target),
      size: Number(f.size ?? 0) || 0,
    };
  });

  // 目标目录里同一集的已有文件（同样按集号归并：S01E01.mkv / S01E01高码.mp4 /
  // S01E01-2160P-DV.mkv 都算这一集）
  const dirEpisodes = new Map<string, Array<{ name: string; size: number }>>();
  for (const [n, sz] of dirSizes) {
    const b = baseOf(n);
    const arr = dirEpisodes.get(b);
    if (arr) arr.push({ name: n, size: sz });
    else dirEpisodes.set(b, [{ name: n, size: sz }]);
  }
  // 同一集可能散落在「基名 / 基名高码 / 基名-画质」多个 key 下，按归并后的集号取
  const dirByEpisode = new Map<string, Array<{ name: string; size: number }>>();
  for (const [, arr] of dirEpisodes) {
    for (const it of arr) {
      const ep = stripQualitySuffix(baseOf(it.name));
      const list = dirByEpisode.get(ep) ?? [];
      list.push(it);
      dirByEpisode.set(ep, list);
    }
  }
  const dirOfEpisode = (base: string) => dirByEpisode.get(stripQualitySuffix(base)) ?? [];

  /** 该名字已被目录里「同集的另一个文件」占着（两边体积都拿得到且不同） */
  const takenByOther = (target: string, size: number): boolean => {
    const dirSize = dirSizes.get(target);
    if (!dirSize || !size) return false;
    return dirSize !== size;
  };

  // 本次已经规划出去的新名字：两个文件不能改成同一个名字
  const used = new Set<string>();

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const g = groups.get(r.base);
    if (g) g.push(r);
    else groups.set(r.base, [r]);
  }

  for (const [base, group] of groups) {
    const dirFiles = dirOfEpisode(base);
    // 这一集在「本批 + 目录」里是否真的存在多个文件；只有一个就用普通清洗名，不需要区分
    const multi = new Set([...group.map((r) => r.name), ...dirFiles.map((d) => d.name)]).size > 1;

    for (const r of group) {
      if (plan.has(r.name)) continue;
      /**
       * 目标名：
       *   · **能从原始名提取到画质 → 一律加画质后缀**，不管这一集是 1 个版本还是多个：
       *       `S01E01-2160P-DV.mkv` / `S01E01-2160P-SDR.mkv` / 单版本也标 `S01E09-2160P-DV.mkv`。
       *     统一标注才不会有的带有的不带（实测 E01–E08 双版本带标注、E09/E10 单版本没带，
       *     看起来像漏了）。命名规则一致，用户一眼能看出每个文件是什么画质。
       *   · 提取不到画质（原始名里没有分辨率/动态范围信息）→ 用普通清洗名；
       *     此时若同集还有别的版本，再退到「高码」档避免撞名。
       */
      let target = r.target;
      if (!plainOnly) {
        const q = qualitySuffixOf(r.name);
        if (q) target = `${base}${q}${r.ext}`;
        else if (multi) target = `${base}高码${r.ext}`;
      }
      if (!target || target === r.name) continue;
      if (takenByOther(target, r.size) || used.has(target)) {
        // 目标名被占用（目录里已有同名的另一版本，或本批已用掉）→ 依次退到备用档位
        const q = qualitySuffixOf(r.name);
        const alts = [
          `${base}高码${r.ext}`,      // 画质相同/提取不到时的老档位
          ...(q ? [`${base}${q}${r.ext}`] : []),
          r.target,
        ];
        target = "";
        for (const alt of alts) {
          if (!alt || alt === r.name) continue;
          if (used.has(alt)) continue;
          if (takenByOther(alt, r.size)) continue;
          target = alt;
          break;
        }
      } else if (dirSizes.get(target) === r.size) {
        // 同名同体积：目录里已经是这个文件了，不必改名（改了也会撞名）
        continue;
      }
      if (!target || used.has(target)) continue;
      plan.set(r.name, target);
      used.add(target);
    }
  }
  return plan;
}

/** 光鸭：列出某目录下的子目录（parentId 为空 = 根目录 / 绑定时的默认目录） */
async function gyListDirs(cred: PanCred, parentId: string): Promise<Array<{ id: string; name: string }>> {
  let list: Array<Record<string, unknown>>;
  try {
    // resType=2：只要文件夹（与前端文件夹树一致）
    list = await gyListFolder(cred, parentId, { maxPages: 5 });
  } catch (e) {
    // 带上接口名，失败时一眼能看出是哪个调用出的问题
    throw new Error(`${(e as Error).message}（光鸭 /file/get_file_list）`);
  }
  return list
    .filter((it) => Number(it.resType ?? 2) === 2)
    .map((it) => ({ id: String(it.fileId ?? ""), name: gyFieldName(it) }))
    .filter((d) => d.id)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/** 光鸭：按名字在目录中找回刚转存的文件（转存是异步任务，需要轮询等待落地） */
async function gyFindFilesByName(
  cred: PanCred,
  parentId: string,
  names: Set<string>,
  tries = 6
): Promise<Array<{ id: string; name: string }>> {
  const found: Array<{ id: string; name: string }> = [];
  const remaining = new Set(names);
  for (let i = 0; i < tries && remaining.size > 0; i++) {
    if (i > 0) await wait(3000);
    // 翻页取全（maxPages 给足，避免目标目录文件超过 300 时漏找）+ 实时（不读 5 分钟缓存，
    // 因为刚转存完，文件还在异步落地）
    const list = await gyListFolder(cred, parentId, { files: true, maxPages: 500, refresh: true });
    for (const it of list) {
      const id = String(it.fileId ?? "");
      const nm = gyFieldName(it);
      if (id && remaining.has(nm)) {
        found.push({ id, name: nm });
        remaining.delete(nm);
      }
    }
  }
  return found;
}

/** 光鸭：重命名文件 */
async function gyRenameFile(cred: PanCred, fileId: string, newName: string): Promise<void> {
  await gyCall(cred, "/userres/v1/file/rename", { fileId, newName }, { retryTransient: false });
}

/**
 * 光鸭：删除文件（批量）。
 * 只用于清理「同内容的重复副本」——我们自己重复转存产生的乱名副本；调用点有严格判定
 * （同 gcid / 同体积、且目录里已有正常命名的同一份），绝不碰用户正常命名的文件。
 * 路径取自社区实现（AList 的 guangyapan 驱动）：POST /nd.bizuserres.s/v1/file/delete_file
 * body { fileIds: [...] } → { msg: "success", data: { taskId } }（异步任务）。
 */
async function gyDeleteFiles(cred: PanCred, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  // 社区实现用的是 /nd.bizuserres.s 前缀；本仓的 rename 一直用 /userres 前缀也能通，
  // 因此两个都试，第一个成功即返回（删错的风险由调用点的判定兜住，不靠路径）。
  let lastErr = "";
  for (const path of ["/nd.bizuserres.s/v1/file/delete_file", "/userres/v1/file/delete_file"]) {
    try {
      await gyCall(cred, path, { fileIds: ids }, { retryTransient: false });
      return ids.length;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  throw new Error(lastErr || "光鸭删除接口不可用");
}

/** 夸克 / UC：列出某目录下的子目录 */
async function quarkListDirs(
  cookie: string,
  parentFid: string,
  cd: CdCfg = CD_QUARK
): Promise<Array<{ id: string; name: string }>> {
  try {
    return await quarkListDirsInner(cookie, parentFid, cd);
  } catch (e) {
    throw new Error(`${(e as Error).message}（${cd.label} /file/sort）`);
  }
}

async function quarkListDirsInner(
  cookie: string,
  parentFid: string,
  cd: CdCfg = CD_QUARK
): Promise<Array<{ id: string; name: string }>> {
  // 翻页取全：原来只取第 1 页（200 个）→ 目录里子文件夹超过 200 个就会漏看，
  // 而「找同名文件夹 / 判断是否已落地」依赖它，漏看会导致重复转存。与 quarkListFiles 同口径：每页 200、最多 20 页。
  const out: Array<{ id: string; name: string }> = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(
      `${cd.base}/file/sort?${cd.qs}&pdir_fid=${parentFid || "0"}&_page=${page}&_size=200&_fetch_total=1&_sort=file_type:asc,updated_at:desc`,
      {
        headers: { Cookie: cookie, "User-Agent": UA, Referer: cd.referer },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    const j = await res.json().catch(() => null);
    if (!res.ok || (j?.status != null && Number(j.status) !== 200) || !j?.data) {
      throw new Error(j?.message || `读取${cd.label}目录失败（HTTP ${res.status}）`);
    }
    const list = (j?.data?.list ?? []) as Array<Record<string, unknown>>;
    for (const it of list) {
      if (it.dir !== true) continue;
      const id = String(it.fid ?? "");
      if (id) out.push({ id, name: String(it.file_name ?? "") });
    }
    if (list.length < 200) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/**
 * 夸克：列出某目录下的文件（名字 + 体积）。
 * 用于「目标目录差集」判断已有文件、以及区分「同一集的另一个版本」。
 * 取不到列表时**抛错**（Cookie 失效会返回空列表，静默当成「目录里什么都没有」
 * 会让整份分享被重新转存一遍）。
 */
async function quarkListFiles(
  cookie: string,
  parentFid: string,
  cd: CdCfg = CD_QUARK
): Promise<Array<{ name: string; size: number | null }>> {
  const out: Array<{ name: string; size: number | null }> = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(
      `${cd.base}/file/sort?${cd.qs}&pdir_fid=${parentFid || "0"}&_page=${page}&_size=200&_fetch_total=1&_sort=file_type:asc,updated_at:desc`,
      {
        headers: { Cookie: cookie, "User-Agent": UA, Referer: cd.referer },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    const j = await res.json().catch(() => null);
    if (!res.ok || (j?.status != null && Number(j.status) !== 200) || !j?.data) {
      throw new Error(j?.message || `读取${cd.label}目录失败（HTTP ${res.status}）`);
    }
    const list = (j.data.list ?? []) as Array<Record<string, unknown>>;
    for (const it of list) {
      if (it.dir === true) continue;
      const n = String(it.file_name ?? "");
      if (!n) continue;
      out.push({ name: n, size: Number(it.size ?? it.file_size ?? it.fileSize ?? 0) || null });
    }
    if (list.length < 200) break;
  }
  return out;
}

/** 夸克 / UC：重命名文件 */
async function quarkRenameFile(
  cookie: string,
  fid: string,
  newName: string,
  cd: CdCfg = CD_QUARK
): Promise<void> {
  await fetch(`${cd.base}/file/rename?${cd.qs}`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "User-Agent": UA, Referer: cd.referer },
    body: JSON.stringify({ fid, file_name: newName }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/**
 * 夸克：删除文件 / 目录（进**回收站**，可恢复）。
 * 接口是异步任务：先 POST /file/delete 拿 task_id，再轮询 /task 等完成 ——
 * 不等完成的话，紧接着列目录仍会看到它（文件夹模式清理会误判）。
 * 返回请求删除的条目数；任务失败抛错。
 */
async function quarkDeleteFiles(
  cookie: string,
  fids: string[],
  cd: CdCfg = CD_QUARK
): Promise<number> {
  const list = fids.map((x) => String(x)).filter(Boolean);
  if (list.length === 0) return 0;
  const headers = {
    Cookie: cookie,
    "Content-Type": "application/json",
    "User-Agent": UA,
    Referer: cd.referer,
  };
  const res = await fetch(`${cd.base}/file/delete?${cd.qs}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action_type: 2, filelist: list, exclude_fids: [] }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || (j?.status != null && Number(j.status) !== 200)) {
    throw new Error(j?.message || `${cd.label}删除失败（HTTP ${res.status}）`);
  }
  const taskId = j?.data?.task_id as string | undefined;
  for (let i = 0; i < 8 && taskId; i++) {
    await wait(1200);
    const tRes = await fetch(`${cd.base}/task?${cd.qs}&task_id=${taskId}&retry_index=${i}`, {
      headers: { Cookie: cookie, "User-Agent": UA, Referer: cd.referer },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const tJson = await tRes.json().catch(() => null);
    const st = Number(tJson?.data?.status ?? 0);
    if (st === 2) return list.length;
    if (st === 3) throw new Error(`${cd.label}删除任务失败`);
  }
  return list.length;
}

/**
 * 夸克：列出某目录下的全部条目（文件 + 目录，带 fid 与体积）。
 * 文件夹模式要用到 fid（找同名文件夹、读文件夹内部、清洗重命名），
 * 而 quarkListFiles 只返回名字+体积，所以单独提供这个带 id 的版本。
 */
async function quarkListEntriesWithIds(
  cookie: string,
  parentFid: string,
  cd: CdCfg = CD_QUARK
): Promise<Array<{ id: string; name: string; size: number; isDir: boolean }>> {
  const out: Array<{ id: string; name: string; size: number; isDir: boolean }> = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(
      `${cd.base}/file/sort?${cd.qs}&pdir_fid=${parentFid || "0"}&_page=${page}&_size=200&_fetch_total=1&_sort=file_type:asc,updated_at:desc`,
      {
        headers: { Cookie: cookie, "User-Agent": UA, Referer: cd.referer },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    const j = await res.json().catch(() => null);
    if (!res.ok || (j?.status != null && Number(j.status) !== 200) || !j?.data) {
      throw new Error(j?.message || `读取${cd.label}目录失败（HTTP ${res.status}）`);
    }
    const list = (j.data.list ?? []) as Array<Record<string, unknown>>;
    for (const it of list) {
      const id = String(it.fid ?? "");
      const name = String(it.file_name ?? "");
      if (!id || !name) continue;
      out.push({
        id,
        name,
        size: Number(it.size ?? it.file_size ?? it.fileSize ?? 0) || 0,
        isDir: it.dir === true,
      });
    }
    if (list.length < 200) break;
  }
  return out;
}

/** 列出网盘目录（目录浏览器用）。注意：百度的「目录 id」就是它的绝对路径 */
async function listPanDirs(pan: string, cred: PanCred, parentId: string): Promise<Array<{ id: string; name: string }>> {
  if (pan === "guangya") return await gyListDirs(cred, parentId);
  if (pan === "quark") return await quarkListDirs(cred.cookie ?? "", parentId);
  if (pan === "uc") return await quarkListDirs(cred.cookie ?? "", parentId, CD_UC);
  if (pan === "baidu") return await baiduListDirs(cred, parentId);
  if (pan === "p123") return await p123ListDirs(cred.token ?? "", parentId);
  const lockMsg = panLockedMsg(pan);
  if (lockMsg) throw new Error(lockMsg);
  if (pan === "xunlei") return await xlListDirs(cred, parentId);
  throw new Error(`暂不支持浏览${PAN_LABELS[pan] ?? pan}的目录`);
}

/**
 * 转存后按 clean_mode 清洗文件名（重命名网盘里刚转存的文件）。
 * 任何失败都不抛出：转存已成功，清洗只是附加动作，原因写进备注。
 */
/**
 * 转存「同一集的新版本」后，清理该集在目标目录里的**旧版本**。
 *
 * 为什么需要：presentInDir 的规则是「同名但体积不同 → 视为另一个版本 → 仍要转存」。
 * 这条规则是为了支持「分享方后来发了 4K/DV，自动补一份」，但代价是**源文件更新后旧版永不退场**：
 * 目录里会同时躺着旧版和新版，同一集 2~4 个文件；把旧版删掉后，下一轮又会因为
 * 「没有同体积文件能证明已存在」而被判成缺失、再转回来，永远删不掉（真实案例：醉梦）。
 *
 * 做法：新版本转存+清洗完成后，按「集名」把目录里同集但体积不同的旧条目删掉，
 * 只保留刚转存的这批（savedFids）。
 *
 * 安全阀（避免误删用户自己的文件）：
 *   · 必须能拿到本次新落地的文件 id（savedFids 非空），否则不做任何删除；
 *   · 只删「集名与本次转存文件相同」且「体积与所有新文件都不同」的条目；
 *   · 体积相同的绝不删（那是同一份内容，只可能是显示名不同）；
 *   · 单次删除数量有上限；
 *   · 可用环境变量 CLEAN_STALE_VERSIONS=0 关闭（默认开启）。
 */
/**
 * 「转存同一集的新版本后，自动删除目录里的旧版本」总开关。
 * 默认关闭：该功能会**删除用户网盘里的文件**，属于不可逆操作，必须显式打开。
 * 需要时改成 true，或用环境变量 CLEAN_STALE_VERSIONS=1 打开。
 */
const STALE_VERSION_CLEANUP_ENABLED = (Deno.env.get("CLEAN_STALE_VERSIONS") ?? "") === "1";

/**
 * 从**分享原始文件名**里提取画质标签。
 *
 * 为什么必须用原始名：落地后文件名已被清洗成 `S01E01.mkv` / `S01E01高码.mkv`，
 * 画质信息（4K/HDR/SDR/60FPS…）全丢了；而基线里存的 file_name 是原始名，信息还在。
 *
 * 判定用途：区分「同一集的两种画质」（要都留）与「同一画质被更新了源文件」（要删旧的）。
 * 只在两个标签集合**完全相同**时才认为是同画质；认不出来就返回空集，调用方按「不删」处理。
 */
function qualityTags(name: string): Set<string> {
  const tags = new Set<string>();
  const n = name;
  // 动态范围要按优先级判定：DV / HDR Vivid 命中后就不再当成普通 HDR 或 SDR
  if (/\bDV\b|Dolby[\s._-]?Vision/i.test(n)) tags.add("DV");
  else if (/HDR[\s._-]?Vivid/i.test(n)) tags.add("HDRVIVID");
  else if (/HDR10\+|HDR/i.test(n)) tags.add("HDR");
  else if (/\bSDR\b/i.test(n)) tags.add("SDR");
  // 分辨率
  if (/2160p|\b4K\b|\bUHD\b|3840\s*[x×*]\s*2160/i.test(n)) tags.add("2160P");
  else if (/1080p|1920\s*[x×*]\s*1080/i.test(n)) tags.add("1080P");
  else if (/720p|1280\s*[x×*]\s*720/i.test(n)) tags.add("720P");
  // 帧率（60FPS 与 30FPS 属不同版本）
  if (/\b60\s*FPS\b|\b60FPS\b|2160p60/i.test(n)) tags.add("60FPS");
  else if (/\b24\s*FPS\b|\b23\.976\b/i.test(n)) tags.add("24FPS");
  // 编码
  if (/HEVC|H\.?265/i.test(n)) tags.add("H265");
  else if (/AVC|H\.?264/i.test(n)) tags.add("H264");
  return tags;
}

/** 两个画质标签集合是否「同一画质」：任一方为空都算「认不出」，返回 false（保守不删） */
function sameQuality(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/**
 * 由画质标签生成**文件名后缀**，例如 `-2160P-DV`、`-2160P-SDR`、`-1080P`。
 *
 * 为什么要有它：同一集有多个画质时，旧做法是用「高码」区分（体积最大的那个叫高码），
 * 既看不出是什么画质，也和体积大小绑定（源文件一更新，名字含义就变了）。
 * 改成直接写画质，才是稳定的身份标识 —— 用户看到 `-2160P-DV` 就知道那是杜比视界版。
 *
 * 只取「分辨率 + 动态范围」两项：帧率与编码再加会让文件名过长，且这两项已足够区分。
 */
function qualitySuffixFromTags(tags: Set<string>): string {
  if (tags.size === 0) return "";
  const parts: string[] = [];
  for (const r of ["2160P", "1080P", "720P"]) { if (tags.has(r)) { parts.push(r); break; } }
  for (const d of ["DV", "HDRVIVID", "HDR", "SDR"]) { if (tags.has(d)) { parts.push(d); break; } }
  return parts.length ? `-${parts.join("-")}` : "";
}

/** 从分享原始名直接取画质后缀（如 `-2160P-DV`）；提取不到返回空串 */
function qualitySuffixOf(name: string): string {
  return qualitySuffixFromTags(qualityTags(name));
}

/**
 * 去掉「画质后缀」，还原成集号基名。
 * `S01E01-2160P-DV.mkv` → `S01E01`；`S01E01高码.mkv` → `S01E01`。
 * 用于「同一集」的归并判断。
 */
function stripQualitySuffix(base: string): string {
  return base.replace(/高码$/, "").replace(/-(?:\d{3,4}P|DV|HDRVIVID|HDR|SDR)(?:-(?:\d{3,4}P|DV|HDRVIVID|HDR|SDR))*$/i, "").trim();
}

/** 文件名是否属于该集（含高码/画质后缀两种变体） */
function isEpisodeOf(fileBase: string, base: string): boolean {
  return stripQualitySuffix(fileBase) === stripQualitySuffix(base);
}

async function cleanupStaleVersions(
  pan: string,
  cred: PanCred,
  dirId: string,
  files: ShareFile[],
  mode: string,
  savedFids: string[] | undefined,
  dirSizes: Map<string, number> | undefined,
  /** 本订阅历史上转存过的网盘文件 id：只有在这个集合里的文件才允许删（用户自己放的绝不能碰） */
  ownedFileIds: Set<string>,
  /** 网盘文件 id → 该文件当初对应的**分享原始名**（画质标签只能从这里取） */
  origNameByFileId: Map<string, string>
): Promise<string> {
  if (process.env.CLEAN_STALE_VERSIONS === "0") return "";
  if (mode !== "episode" || files.length === 0) return "";
  const keep = new Set((savedFids ?? []).map(String));
  // 拿不到新落地文件的 id 就无法区分「新版」与「旧版」，一律不动
  if (keep.size === 0) return "";
  // 归属校验不可省：没有它就分不清「旧版本」和「用户自己收藏的同集 4K」，
  // 一旦误判就会删掉用户的数据 —— 宁可少删（历史数据没记 fileId 时不删），绝不多删。
  if (ownedFileIds.size === 0) return "";

  const planned = planCleanedNames(files, mode, dirSizes ?? new Map());
  // 本次落地的集名（去掉扩展名、「高码」与画质后缀后的归一集名）
  const epOf = (n: string) => stripQualitySuffix(stripExt(n));
  // 每个集名下「本次新转存的文件」（原始名 + 体积 + 画质标签）
  const newByEp = new Map<string, Array<{ size: number; tags: Set<string> }>>();
  for (const f of files) {
    const finalName = planned.get(f.name) ?? f.name;
    const ep = epOf(finalName);
    const list = newByEp.get(ep) ?? [];
    list.push({ size: Number(f.size ?? 0), tags: qualityTags(f.name) });
    newByEp.set(ep, list);
  }
  if (newByEp.size === 0) return "";

  // 重新实时列目录（必须实时：刚转存完，缓存里没有新文件）
  let current: Array<{ id: string; name: string; size: number }> = [];
  try {
    if (pan === "guangya") {
      const l = await gyListFolder(cred, dirId, { files: true, maxPages: 200, refresh: true, strict: true });
      current = l
        .filter((x) => Number(x.resType ?? 1) !== 2)
        .map((x) => ({
          id: String(x.fileId ?? ""),
          name: gyFieldName(x),
          size: Number(x.fileSize ?? 0) || 0,
        }))
        .filter((x) => x.id && x.name);
    } else if (pan === "quark" || pan === "uc") {
      current = (await quarkListFiles(cred.cookie ?? "", dirId, cdOf(pan))).map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
      }));
    } else if (pan === "baidu") {
      current = (await baiduListOwnDir(cred, dirId))
        .filter((d) => !d.isDir)
        .map((d) => ({ id: d.id, name: d.name, size: d.size }));
    } else if (pan === "p123") {
      current = (await p123ListEntries(cred.token ?? "", dirId))
        .filter((d) => !d.isDir)
        .map((d) => ({ id: d.id, name: d.name, size: d.size }));
    } else {
      return "";
    }
  } catch {
    // 读不到目录就绝不删：宁可留着旧版，也不要在判断不了的情况下删文件
    return "";
  }

  /**
   * 挑出「该删的同集旧版本」：
   *   1. 不是本次刚转存的那份（keep）
   *   2. 确实是本订阅转存上去的（归属校验，避免删用户自己的文件）
   *   3. 集名与本次转存的集名相同
   *   4. 体积与本次所有新文件都不同（否则是同一份内容）
   *   5. **画质与某个新文件完全相同** —— 这一条是关键：
   *      · 画质不同（如旧的 HDR + 新的 SDR）→ 用户要同时留多画质，**保留**
   *      · 画质相同、体积变了（分享方更新了同一画质的源文件）→ 才算旧版，删除
   *      · 认不出画质（标签为空）→ 保守**保留**，宁可少删
   */
  const stale: Array<{ id: string; name: string; size: number }> = [];
  const keptByQuality: Array<{ id: string; name: string }> = [];
  for (const f of current) {
    if (keep.has(f.id)) continue;               // 本次刚转存的那份
    if (!ownedFileIds.has(f.id)) continue;      // 不是本订阅转存上去的 → 用户自己的文件，不碰
    const ep = epOf(f.name);
    const newFiles = newByEp.get(ep);
    if (!newFiles || newFiles.length === 0) continue;  // 不是本次转存的集 → 不碰
    const newSizes = new Set(newFiles.map((x) => x.size).filter((s) => s > 0));
    if (newSizes.has(f.size)) continue;         // 体积与新版一致 → 同一份内容，不删
    // 画质判定只能靠「原始分享名」：落地名已被清洗成 S01E01.mkv，画质信息全丢
    const origName = origNameByFileId.get(f.id);
    const oldTags = origName ? qualityTags(origName) : null;
    if (!oldTags || oldTags.size === 0) {
      keptByQuality.push({ id: f.id, name: f.name });
      continue;                                 // 认不出画质 → 保守保留
    }
    const dupQuality = newFiles.some((nf) => sameQuality(oldTags, nf.tags));
    if (!dupQuality) {
      keptByQuality.push({ id: f.id, name: f.name });
      continue;                                 // 画质不同 → 多画质并存，保留
    }
    stale.push(f);
  }
  if (stale.length === 0) return "";

  const LIMIT = 200;
  const targets = stale.slice(0, LIMIT);
  try {
    if (pan === "guangya") await gyDeleteFiles(cred, targets.map((t) => t.id));
    else if (pan === "quark" || pan === "uc") await quarkDeleteFiles(cred.cookie ?? "", targets.map((t) => t.id), cdOf(pan));
    else return "";   // 其余网盘没有删除接口：只统计不删
  } catch (e) {
    return `（旧版本清理失败：${(e as Error).message}）`;
  }
  return `已清理 ${targets.length} 个同集旧版本（同画质被更新）${
    keptByQuality.length ? `；保留 ${keptByQuality.length} 个不同画质版本` : ""
  }${stale.length > LIMIT ? `（另有 ${stale.length - LIMIT} 个未处理）` : ""}`;
}

/**
 * 说明：`cleanTransferredFiles` 现在接受 `recordIdsFor`，会把「分享原始名 → 网盘文件 id」
 * 回填给调用方。
 *
 * 为什么需要：光鸭的转存接口**不返回**新文件的 id（只能按文件名轮询等待落地），
 * 于是 recordTransferred 拿不到 savedFids，`subscription_transferred.pan_file_id` 一直是空。
 * 后果有两处：
 *   · 「清理同集旧版本」的归属校验拿不到集合 → 那个功能等于从未生效；
 *   · 想给已有文件按画质补改名时，没有原始名可依据。
 * 改名那一步本来就按名字把这些文件找出来了（gyFindFilesByName），顺手回填即可，不用额外请求。
 */
async function cleanTransferredFiles(
  pan: string,
  cred: PanCred,
  dirId: string | null,
  files: ShareFile[],
  mode: string,
  opts: {
    savedFids?: string[];
    tries?: number;
    dirSizes?: Map<string, number>;
    plainOnly?: boolean;
    /** 传入一个 Map 即可回填「分享原始名 → 网盘文件 id」（光鸭转存接口不返回 id，只能这样补） */
    recordIdsFor?: Map<string, string>;
  } = {}
): Promise<string> {
  const { savedFids, tries = 6, dirSizes, plainOnly = false, recordIdsFor } = opts;
  if (mode !== "episode" || files.length === 0) return "";
  // 原名 → 新名（清洗后重名的，体积大的那个会带「高码」，见 planCleanedNames；
  // 目标目录里已有同集别的版本时，本次这个文件直接改成「高码」名，避免撞名/覆盖）
  const wanted = planCleanedNames(files, mode, dirSizes ?? new Map(), plainOnly);
  if (wanted.size === 0) return "";

  try {
    if (pan === "guangya") {
      const lookupDir = dirId ?? cred.rootDirId ?? "";
      // 没有目录可比对时不要退回根目录（空串 = 根目录，会把根目录里的同名文件改名）：直接不改名
      if (!lookupDir) return "未设置转存目录，本次未改名";
      const found = await gyFindFilesByName(cred, lookupDir, new Set(wanted.keys()), tries);
      let renamed = 0;
      for (const f of found) {
        const target = wanted.get(f.name);
        if (!target) continue;
        try {
          await gyRenameFile(cred, f.id, target);
          renamed++;
        } catch { /* 单个文件失败忽略 */ }
      }
      /**
       * 顺手记下「分享原始名 → 网盘文件 id」：转存接口不给 id，这是唯一能拿到的时机。
       * 供 recordTransferred 写入 pan_file_id（归属校验与按画质补改名都依赖它）。
       */
      if (recordIdsFor) {
        const m = recordIdsFor;
        for (const f of found) {
          if (wanted.has(f.name) && !m.has(f.name)) m.set(f.name, f.id);
        }
      }
      if (renamed > 0) return `已清洗 ${renamed}/${wanted.size} 个文件名`;
      return `${wanted.size} 个文件尚未出现在目标目录，本次未改名（可在网盘里手动改名，或删除该条目后重跑）`;
    }
    if (pan === "quark" || pan === "uc") {
      const cd = cdOf(pan);
      if (!savedFids?.length || savedFids.length !== files.length) {
        return `${cd.label}未返回转存后的文件 ID，本次未改名`;
      }
      let renamed = 0;
      for (let i = 0; i < files.length; i++) {
        const target = wanted.get(files[i].name);
        if (!target) continue;
        try {
          await quarkRenameFile(cred.cookie ?? "", savedFids[i], target, cd);
          renamed++;
        } catch { /* 忽略单个失败 */ }
      }
      return renamed > 0 ? `已清洗 ${renamed}/${wanted.size} 个文件名` : "";
    }
    if (pan === "baidu") {
      const lookupDir = dirId ?? cred.rootDirId ?? cred.rootDir ?? "";
      // 百度同理：空路径 = 根目录，没有目录可比对时绝不改名
      if (!lookupDir) return "未设置转存目录，本次未改名";
      // 百度转存是异步任务：文件要等一会儿才出现在目录里，因此这里多轮询几次
      const found = await baiduFindFilesByName(cred, lookupDir, new Set(wanted.keys()), tries);
      let renamed = 0;
      for (const f of found) {
        const target = wanted.get(f.name);
        if (!target || !f.path) continue;
        try {
          await baiduRenameByPath(cred, f.path, target);
          renamed++;
        } catch { /* 单个文件失败忽略 */ }
      }
      if (renamed > 0) return `已清洗 ${renamed}/${wanted.size} 个文件名`;
      return `${wanted.size} 个文件尚未出现在目标目录，本次未改名（可在网盘里手动改名，或删除该条目后重跑）`;
    }
    if (pan === "p123") {
      const token = cred.token ?? "";
      // 123 的转存任务也可能不回落地 fid：没有 fid 时按名字到目录里找一遍再改名
      const lookupDir = dirId || "0";
      const found: Array<{ id: string; name: string }> = [];
      if (savedFids?.length === files.length) {
        files.forEach((f, i) => found.push({ id: String(savedFids[i]), name: f.name }));
      } else {
        const entries = await p123ListEntries(token, lookupDir);
        const byName = new Map(entries.filter((e) => !e.isDir).map((e) => [e.name, e.id] as const));
        for (const f of files) {
          const id = byName.get(f.name);
          if (id) found.push({ id, name: f.name });
        }
      }
      if (found.length === 0) return "123 目标目录里尚未找到这些文件，本次未改名";
      let renamed = 0;
      for (const f of found) {
        const target = wanted.get(f.name);
        if (!target) continue;
        try {
          await p123RenameFile(token, f.id, target);
          renamed++;
        } catch { /* 单个文件失败忽略 */ }
      }
      return renamed > 0 ? `已清洗 ${renamed}/${wanted.size} 个文件名` : "";
    }
    return "";
  } catch (e) {
    return `文件名清洗失败：${(e as Error).message}`;
  }
}

/**
 * 列出自己网盘某目录下的文件（id / 名称 / 体积），用于「转存是否真的落地」的核查。
 * 读不到就返回空数组（调用方按「无法确认」处理）。
 */
async function listDirFilesForCheck(
  pan: string,
  cred: PanCred,
  dirId: string
): Promise<Array<{ id: string; name: string; size: number }>> {
  try {
    if (pan === "guangya") {
      const l = await gyListFolder(cred, dirId, { files: true, maxPages: 200, refresh: true, strict: true });
      return l
        .filter((x) => Number(x.resType ?? 1) !== 2)
        .map((x) => ({ id: String(x.fileId ?? ""), name: gyFieldName(x), size: Number(x.fileSize ?? 0) || 0 }))
        .filter((x) => x.id);
    }
    if (pan === "quark" || pan === "uc") {
      return (await quarkListFiles(cred.cookie ?? "", dirId, cdOf(pan))).map((f) => ({
        id: String(f.id ?? ""),
        name: f.name,
        size: Number(f.size ?? 0) || 0,
      }));
    }
    if (pan === "baidu") {
      return (await baiduListOwnDir(cred, dirId))
        .filter((d) => !d.isDir)
        .map((d) => ({ id: d.id, name: d.name, size: Number(d.size ?? 0) || 0 }));
    }
    if (pan === "p123") {
      return (await p123ListEntries(cred.token ?? "", dirId))
        .filter((d) => !d.isDir)
        .map((d) => ({ id: d.id, name: d.name, size: Number(d.size ?? 0) || 0 }));
    }
  } catch { /* 读不到 → 空 */ }
  return [];
}

/**
 * 转存返回失败时，核查这批文件是不是**其实已经落地**了。
 *
 * 为什么必须查：跨境链路经常「服务端已转存成功、但响应没回来」（超时/连接重置），
 * 接口因此返回失败。而 transferInto 一看到失败就会**把同一批文件再转一次到另一个目录**，
 * 结果就是同一份内容在两个目录各留一份 —— 真实案例：醉梦的内容落进了嫁金钗的目录。
 *
 * 判定用体积：转存不会改变文件体积，比文件名可靠（落地后可能已被清洗改名）。
 * 同一个体积在「待转存」里出现几次，就要求目录里至少出现同样多次。
 *
 * 返回 null = 无法确认（读不到目录、没体积信息、files 为空），调用方应保持原有行为。
 */
async function detectLandedFiles(
  pan: string,
  cred: PanCred,
  dirId: string,
  files: ShareFile[] | null
): Promise<{ ids: string[]; allLanded: boolean } | null> {
  if (!files || files.length === 0) return null;
  const need = new Map<number, number>();
  for (const f of files) {
    const s = Number(f.size ?? 0);
    if (!(s > 0)) return null;      // 体积未知 → 不做判断
    need.set(s, (need.get(s) ?? 0) + 1);
  }
  const dirFiles = await listDirFilesForCheck(pan, cred, dirId);
  if (dirFiles.length === 0) return null;
  const have = new Map<number, number>();
  for (const f of dirFiles) {
    if (need.has(f.size)) have.set(f.size, (have.get(f.size) ?? 0) + 1);
  }
  let allLanded = true;
  for (const [size, n] of need) {
    if ((have.get(size) ?? 0) < n) { allLanded = false; break; }
  }
  // 收集匹配到的文件 id（每个体积最多取 need 个），供清洗与基线登记使用
  const ids: string[] = [];
  const taken = new Map<number, number>();
  for (const f of dirFiles) {
    const want = need.get(f.size);
    if (!want) continue;
    const used = taken.get(f.size) ?? 0;
    if (used >= want) continue;
    taken.set(f.size, used + 1);
    ids.push(f.id);
  }
  return { ids, allLanded };
}

/**
 * 转存到指定目录，目录不可用时（被删/无权限）自动回退到绑定时的根目录，保证转存不中断。
 * 目录全程用 ID 定位：用户在网盘里重命名文件夹不影响这里。
 *
 * 【重要】回退之前会先核查「这批文件是不是其实已经落地」：
 * 跨境链路常有「服务端转存成功但响应丢失」，此时若直接回退重转，同一份内容就会
 * 在两个目录各留一份（醉梦的内容曾落进嫁金钗目录）。已落地就按成功返回，不再重转。
 */
async function transferInto(
  pan: string,
  cred: PanCred,
  shareUrl: string,
  passcode: string | null,
  files: ShareFile[] | null,
  dirId: string | null
): Promise<{ result: TransferResult; note: string; usedDir: string | null; files: ShareFile[] }> {
  const run = (dir: string | null) =>
    files
      ? transferShareFiles(pan, cred, shareUrl, passcode, files, dir)
      : transfer(pan, cred, shareUrl, passcode, dir);

  const first = await run(dirId);
  if (first.ok || !dirId) {
    return { result: first, note: "", usedDir: dirId, files: files ?? resultFiles(first) };
  }
  // 失败 ≠ 没落地：跨境链路常见「服务端已完成、响应丢失」。先查目标目录，
  // 确认这批文件其实已经在里面了就按成功返回，绝不能再转一次到别处。
  const landed = await detectLandedFiles(pan, cred, dirId, files);
  if (landed?.allLanded) {
    return {
      result: {
        ...first,
        ok: true,
        message: "转存接口返回异常，但已确认文件已落地",
        savedFids: landed.ids,
      },
      note: "转存响应异常（多为跨境超时），已核实文件确已落地，未重复转存",
      usedDir: dirId,
      files: files ?? resultFiles(first),
    };
  }
  // 没记录默认目录时**不要**回退：null/空串在光鸭与夸克都等于「网盘根目录」，
  // 会把整批文件直接倒进用户根目录。宁可保留第一次的失败原因。
  const fallback = cred.rootDirId ?? cred.rootDir ?? null;
  if (!fallback || fallback === dirId) {
    return { result: first, note: "", usedDir: dirId, files: files ?? resultFiles(first) };
  }
  const retry = await run(fallback);
  return retry.ok
    ? { result: retry, note: "指定转存目录不可用，已改存到网盘默认目录", usedDir: fallback, files: files ?? resultFiles(retry) }
    : { result: first, note: "", usedDir: dirId, files: files ?? resultFiles(first) };
}

/** 取转存结果里携带的文件清单（整份分享转存时由适配器回填） */
function resultFiles(r: TransferResult): ShareFile[] {
  return r.files ?? [];
}

// ───────────── 与「资源管理」联动：按名称匹配已有资源（订阅不再新建资源） ─────────────

/** 资源管理里的一条候选资源（只取联动需要的字段） */
interface ResourceRow {
  id: string;
  name: string;
  episode_count: number | null;
  is_finished: boolean | null;
  link: string | null;
  links: unknown;
}

/**
 * 归一化剧名，用于把「订阅抓到的标题/文件名」对上「资源管理里的资源名」：
 *   去扩展名 / 去 S01E01 / 去「更新至第12集」/ 去噪声词 / 去空白与标点
 */
function normalizeTitle(name: string): string {
  let s = stripExt(name);
  s = s.replace(/[Ss]\d{1,2}[\s._-]*[Ee](?:[Pp])?\d{1,3}/g, " ");
  s = s.replace(/(?:^|[\s._-])[Ee][Pp]?[\s._-]?\d{1,3}(?=$|[\s._-])/gi, " ");
  s = s.replace(/(?:更新至|更至|全|共)\s*\d+\s*[集话話]/g, " ");
  s = s.replace(/第\s*\d{1,4}\s*[集话話]/g, " ");
  s = s.replace(/(?:^|[\s._-])\d{1,4}\s*[集话話](?=$|[\s._-])/g, " ");
  s = stripNoise(s);
  return s.replace(/[\s._\-—·:：、,，。!！?？'"“”()[\]【】]/g, "").toLowerCase();
}

/** 读取该用户的全部资源，建立「归一化名 → 资源」索引（用 service role 客户端，按 owner_id 限定） */
async function loadResourceIndex(userId: string): Promise<Map<string, ResourceRow>> {
  const { data } = await admin
    .from("resources")
    .select("id, name, episode_count, is_finished, link, links")
    .eq("owner_id", userId)
    .limit(2000);
  const index = new Map<string, ResourceRow>();
  for (const row of (data ?? []) as ResourceRow[]) {
    const key = normalizeTitle(row.name);
    if (key && !index.has(key)) index.set(key, row);
  }
  return index;
}

/** 按 id 读取一条资源（订阅里手动绑定的那条） */
async function loadResourceById(id: string): Promise<ResourceRow | null> {
  const { data } = await admin
    .from("resources")
    .select("id, name, episode_count, is_finished, link, links")
    .eq("id", id)
    .maybeSingle<ResourceRow>();
  return data ?? null;
}

/** 在索引里找最合适的资源：先全等，再「包含」匹配（取归一化名更长的那个，更具体） */
function matchResource(index: Map<string, ResourceRow>, title: string): ResourceRow | null {
  const key = normalizeTitle(title);
  if (!key || key.length < 2) return null;
  const exact = index.get(key);
  if (exact) return exact;
  let best: { key: string; row: ResourceRow } | null = null;
  for (const [rk, row] of index) {
    if (rk.length < 2) continue;
    if (!rk.includes(key) && !key.includes(rk)) continue;
    if (!best || rk.length > best.key.length) best = { key: rk, row };
  }
  return best?.row ?? null;
}

/** 把新的网盘链接合并进资源的 links（按 url 去重，保留原有项） */
function mergeLinks(existing: unknown, url: string, panName: string): Array<Record<string, unknown>> {
  const list: Array<Record<string, unknown>> = Array.isArray(existing)
    ? (existing as Array<Record<string, unknown>>).filter((x) => x && typeof x === "object")
    : [];
  if (!list.some((l) => String(l.url ?? "") === url)) {
    list.push({ url, pan_name: panName, status: "unknown" });
  }
  return list;
}

// ───────────────────────── 智能检测（自适应调度）─────────────────────────

/** 北京时间的小时（0-23）：不依赖服务端时区 */
function bjHour(nowMs: number): number {
  return new Date(nowMs + BJ_OFFSET_MINUTES * 60_000).getUTCHours();
}

/** 小时 h 是否落在「预期更新时段 ±1 小时」内（跨 0 点也算） */
function inHotWindow(hours: number[] | null | undefined, h: number): boolean {
  if (!hours || hours.length === 0) return false;
  return hours.some((x) => {
    const diff = (((x - h) % 24) + 24) % 24;
    return diff <= 1 || diff >= 23;
  });
}

type ScheduleInput = {
  /** 基准间隔（用户设置，分钟） */
  baseMinutes: number;
  /** 是否开启智能检测 */
  adaptive: boolean;
  /** 学到的典型更新时段（北京小时）；null/空 = 冷启动（样本不足） */
  hours: number[] | null;
  /** 距上次抓到新增的小时数；null = 从没有过新增 */
  staleHours: number | null;
  /** 平常的更新间隔（分钟，画像里的中位数）；null = 未知 */
  gapMinutes: number | null;
  /** 账号级固定节奏策略（day15_night60 = 白天 15 分钟 / 深夜 1 小时）；null = 无 */
  policy?: string | null;
};

/**
 * 算「这次执行完，隔多久再检查」。规则（智能检测开启时）：
 *   · 预期更新时段（±1 小时） → min(基准, 5 分钟)：出通知更快；
 *   · 深夜（北京 0-7 点）      → clamp(基准 × 8, 30 分钟, 4 小时)；
 *   · 其余时段                → clamp(基准 × 4, 1 小时, 2 小时)；
 *   · 长期零更新（阈值随剧集节奏放宽，周更剧不误判）→ 每天 1 次；
 *   · 兜底：距上次新增 > max(36 小时, 1.5 × 平常间隔) → 收紧到 1 小时内，防历史规律失效漏更。
 * 关闭智能检测 → 严格按用户设置的间隔。
 */
function computeNextCheckAt(
  p: ScheduleInput,
  nowMs: number
): { nextAt: string; minutes: number; reason: string } {
  const base = Math.max(1, Math.min(1440, Math.round(p.baseMinutes || 30)));
  // 账号级固定节奏策略（特殊码账号）：与用户设置、智能检测都无关，按北京时间切 15 / 60 分钟
  if (p.policy === POLICY_DAY_NIGHT) {
    const h = bjHour(nowMs);
    const night = h >= 0 && h < 7;
    const minutes = night ? POLICY_NIGHT_MINUTES : POLICY_DAY_MINUTES;
    return {
      nextAt: new Date(nowMs + minutes * 60_000).toISOString(),
      minutes,
      reason: night ? "固定节奏·深夜 1 小时" : "固定节奏·白天 15 分钟",
    };
  }
  if (!p.adaptive) {
    return { nextAt: new Date(nowMs + base * 60_000).toISOString(), minutes: base, reason: "按设置的检查时间" };
  }
  const h = bjHour(nowMs);
  const hasProfile = !!p.hours && p.hours.length > 0;
  let minutes: number;
  let reason: string;
  if (hasProfile && inHotWindow(p.hours, h)) {
    minutes = Math.min(base, HOT_MAX_MINUTES);
    reason = "预期更新时段";
  } else if (h >= 0 && h < 7) {
    minutes = Math.min(Math.max(base * NIGHT_MULTIPLIER, NIGHT_MIN_MINUTES), NIGHT_MAX_MINUTES);
    reason = "深夜降频";
  } else {
    minutes = Math.min(Math.max(base * COLD_MULTIPLIER, COLD_MIN_MINUTES), COLD_MAX_MINUTES);
    reason = "非预期时段";
  }

  const stale = p.staleHours;
  if (hasProfile && stale !== null) {
    const gapHours = p.gapMinutes && p.gapMinutes > 0 ? p.gapMinutes / 60 : null;
    const staleAfterHours = Math.max(STALE_DAYS * 24, (gapHours ?? 0) * 2.5);
    const fallbackAfterHours = Math.max(STALE_FALLBACK_HOURS, (gapHours ?? 0) * 1.5);
    if (stale >= staleAfterHours) {
      // 停更 / 完结：每天一次即可
      minutes = Math.max(minutes, 1440);
      reason = "长期无更新";
    } else if (stale >= fallbackAfterHours) {
      // 该更没更：可能是历史规律失效（提前/延后/临时加更）→ 收紧盯一段时间
      minutes = Math.min(minutes, STALE_FALLBACK_MINUTES);
      reason = "超时未更新";
    }
  }
  return { nextAt: new Date(nowMs + minutes * 60_000).toISOString(), minutes, reason };
}

/** 北京时间 HH:mm（界面提示用） */
function bjHHmm(iso: string): string {
  const d = new Date(Date.parse(iso) + BJ_OFFSET_MINUTES * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 每次执行结束都要写的「调度字段」：下次检查时间 / 连续未抓到新增的次数 / 最近一次抓到新增的时间。
 * 返回的 note 追加到 last_message 里，让用户在订阅详情能看懂「为什么下次要等到那时候」。
 */
function scheduleFields(sub: SubRow, foundNew: boolean, nowMs = Date.now()) {
  const gapRaw = Number((sub.update_profile as { gap_min?: number } | null | undefined)?.gap_min);
  const lastFoundMs = sub.last_found_at ? Date.parse(sub.last_found_at) : null;
  const staleHours = foundNew
    ? 0
    : lastFoundMs === null || Number.isNaN(lastFoundMs)
      ? null
      : (nowMs - lastFoundMs) / 3_600_000;
  const plan = computeNextCheckAt(
    {
      baseMinutes: Number(sub.interval_minutes ?? 30),
      adaptive: sub.adaptive_enabled !== false,
      policy: sub.schedule_policy ?? null,
      hours: Array.isArray(sub.update_hours) ? sub.update_hours.map(Number) : null,
      staleHours,
      gapMinutes: Number.isFinite(gapRaw) && gapRaw > 0 ? gapRaw : null,
    },
    nowMs
  );
  return {
    patch: {
      next_check_at: plan.nextAt,
      checks_since_update: foundNew ? 0 : Number(sub.checks_since_update ?? 0) + 1,
      ...(foundNew ? { last_found_at: new Date(nowMs).toISOString() } : {}),
    },
    note: `智能检测：下次检查 ${bjHHmm(plan.nextAt)}（${plan.reason}）`,
  };
}

// ───────────────────────── 主流程 ─────────────────────────

type SubRow = {
  id: string;
  user_id: string;
  name: string;
  source_url: string;
  source_type: string;
  /** 分享目录订阅的提取码（夸克分享常用） */
  source_passcode: string | null;
  keyword: string | null;
  /** 转存后文件名清洗：none / episode */
  clean_mode: string;
  pan: string;
  /** 转存目录 ID（不是名称：用户重命名文件夹不影响转存） */
  target_dir: string | null;
  /** 转存目录显示名（仅界面展示） */
  target_dir_name: string | null;
  auto_publish: boolean;
  enabled: boolean;
  /** 手动绑定的资源（资源管理）；为空则按剧名自动匹配 */
  resource_id: string | null;
  /** 检查间隔（分钟）：用户设置，智能检测下作为「基准间隔」 */
  interval_minutes?: number;
  /** 智能检测（自适应调度）开关，默认开 */
  adaptive_enabled?: boolean;
  /** 下次检查时间（智能检测开启时生效） */
  next_check_at?: string | null;
  /** 学到的典型更新时段（北京小时）；null/空 = 冷启动 */
  update_hours?: number[] | null;
  /** 更新画像 {batches,hours,gap_min,last_found_at,computed_at} */
  update_profile?: Record<string, unknown> | null;
  /** 连续多少次检查没抓到新增 */
  checks_since_update?: number;
  /** 最近一次抓到新增的时间 */
  last_found_at?: string | null;
  /** 账号级调度策略（由 profiles.schedule_policy 同步）：day15_night60 = 固定节奏 */
  schedule_policy?: string | null;
  /** 连续「凭据失效」次数：成功清零，达到 3 次自动停止检测 */
  cred_fail_count?: number;
  /** 最近一次凭据失效时间 */
  cred_fail_at?: string | null;
  /** 系统暂停原因：credential = 凭据失效（重新绑定后手动点「执行」自动恢复） */
  paused_reason?: string | null;
  /** 文件夹模式（仅光鸭）：true = 按文件夹整体转存 + 转后清理文档/图片；false = 逐文件只转视频 */
  folder_mode?: boolean;
  /** 全集数（用户填写）：同步到的集数达到该值即判定完结；NULL/0 = 不自动完结 */
  total_episodes?: number | null;
  /** 判定为已完结的时间（达到全集数时写入） */
  finished_at?: string | null;
  /** 自动删除时间（完结时 = now + 1 小时） */
  delete_after?: string | null;
  /** 上一轮执行结果：ok / partial / failed / retry（上游临时故障） */
  last_status?: string | null;
};

/** 一次订阅执行的结果 */
type RunResult = {
  found: number;
  created: number;
  updated: number;
  transferred: number;
  imported: number;
  /** 未匹配到资源管理里的资源（或被设置跳过）而只完成转存的条数 */
  skipped: number;
  failed: number;
  message: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const svc = createClient(APP_URL, SVC_KEY, { auth: { persistSession: false } });
  const url = new URL(req.url);

  if (req.method !== "POST") return fail("仅支持 POST 请求", 405);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch { /* 允许空 body */ }
  const action = (url.searchParams.get("action") ?? String(body.action ?? "")).trim();

  // ── 鉴权：定时任务的共享密钥 或 用户登录态 ──
  const cronSecret = req.headers.get("x-subscription-secret") ?? "";
  const isCron = !!CRON_SECRET && cronSecret === CRON_SECRET;
  let userId: string | null = null;
  if (!isCron) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return fail("请先登录本应用", 401);
    const { data: { user } } = await svc.auth.getUser(token);
    if (!user?.id) return fail("登录态无效，请重新登录", 401);
    userId = user.id;
  }

  // ── 订阅功能权限：仅管理员，或由管理员开通订阅功能的用户可用 ──
  // 定时任务（cron）走统一共享密钥、无法判定单用户，改在 runAll 里按订阅归属用户的
  // subscriptions_enabled 过滤；这里只在「用户登录态」下做硬性拒绝。
  let subFeatureOk = true;
  /** 受限账号（特殊邀请码注册）：只能使用订阅功能，且只能订阅管理员维护的订阅源 */
  let subOnly = false;
  /**
   * 订阅数量上限：数值(>=1)=上限；**null = 不限**（不做数量校验）。
   *  · 管理员：不限（null）
   *  · 特殊邀请码注册的「订阅专用」账号：profiles.max_subscriptions（注册时写入 10），
   *    管理员清空该字段 = 不限，所以这里 null 只可能是管理员主动放开的
   *  · 普通用户：默认 DEFAULT_MAX_SUBS（80），管理员单独设过数值则以该值为准
   */
  let maxSubs: number | null = null;
  /** 调用者角色（仅非定时任务时有值）：维护类动作只允许管理员调用 */
  let callerRole: string | null = null;
  if (!isCron) {
    const { data: pf } = await svc
      .from("profiles")
      .select("role, subscriptions_enabled, subscription_only, max_subscriptions, can_subscriptions")
      .eq("id", userId!)
      .maybeSingle<{
        role: string;
        subscriptions_enabled: boolean | null;
        subscription_only: boolean | null;
        max_subscriptions: number | null;
        can_subscriptions: boolean | null;
      }>();
    callerRole = pf?.role ?? null;
    // 订阅功能：管理员恒可用；老字段 subscriptions_enabled 与新功能开关 can_subscriptions 取或
    const enabled = pf
      ? (pf.role === "admin" || pf.subscriptions_enabled === true || pf.can_subscriptions === true)
      : false;
    if (!enabled) subFeatureOk = false;
    // 管理员不受限制；订阅数量上限（普通用户 80 / 订阅专用账号 10 或管理员设定值）
    // 在 saveSubscription 里硬校验，受限账号的「只能订阅管理员订阅源」也在那里校验。
    if (pf?.role !== "admin") {
      const raw = pf?.max_subscriptions;
      const explicitLimit = typeof raw === "number" && raw > 0 ? raw : null;
      if (pf?.subscription_only === true) {
        subOnly = true;
        // 订阅专用账号：注册时写入 10；被管理员改成「不限」（null）就不做数量校验
        maxSubs = explicitLimit ?? (raw === null || raw === undefined ? null : 10);
      } else {
        // 普通用户：默认 80；管理员为个别账号单独设过数值则尊重该数值
        maxSubs = explicitLimit ?? DEFAULT_MAX_SUBS;
      }
    }
  }
  // 需要订阅功能权限的 action；读操作（listSubscriptions / items）放行，便于前端展示锁定态
  const SUB_GATED = new Set([
    "saveSubscription", "removeSubscription", "toggleSubscription",
    "bindPan", "removePan", "panList", "panDirs", "panProbe",
    "panDeviceStart", "panDevicePoll", "panBindTokens", "panBindXunleiToken", "panXunleiPrefill",
    "run", "runAll", "preview",
  ]);
  if (!isCron && !subFeatureOk && SUB_GATED.has(action)) {
    return fail("您的订阅功能尚未开通，请联系管理员开通后再使用", 403);
  }

  // 维护类动作：都带 userId 参数、会操作「他人的网盘与数据」，因此只允许管理员或定时任务调用
  //（否则任何登录用户都能借 userId 去删别人的转存记录 / 在别人的网盘里复制文件）。
  const MAINT_ONLY = new Set([
    "cleanup_text_transfers", "cleanup_flat_duplicates",
    "oneoff_share_to_subdirs", "oneoff_share_ls", "oneoff_gy_probe",
    "oneoff_scan_dupes", "oneoff_http_probe", "oneoff_quark_share_ls",
    "oneoff_quark_delete",
  ]);
  if (MAINT_ONLY.has(action) && !isCron && callerRole !== "admin") {
    return fail("该操作仅限管理员", 403);
  }

  const listPan = async (uid: string) => {
    const { data } = await svc
      .from("pan_accounts")
      .select("pan, username, root_dir, root_dir_id, credential_type, status, last_check_at, last_error")
      .eq("user_id", uid);
    return (data ?? []) as Array<{ pan: string }>;
  };

  /** 读取网盘凭据：光鸭走 OAuth 令牌；夸克 / 百度走 Cookie（百度在 Cookie 列里存 JSON） */
  const loadPanCred = async (uid: string, pan: string): Promise<PanCred | null> => {
    if (pan === "guangya") {
      const { data, error } = await svc.rpc("load_pan_oauth", { p_user_id: uid, p_pan: pan, p_key: CRED_KEY });
      if (error) throw new Error(`读取${PAN_LABELS[pan] ?? pan}凭据失败：${error.message}`);
      const row = ((data ?? []) as Array<{ token_json: string | null; root_dir_id: string | null }>)[0];
      if (!row?.token_json) return null;
      let tokens: GypTokens;
      try {
        tokens = JSON.parse(row.token_json) as GypTokens;
      } catch {
        return null;
      }
      if (!tokens.access_token) return null;
      return { kind: "oauth", userId: uid, tokens, rootDirId: row.root_dir_id ?? null };
    }
    if (pan === "xunlei") {
      // 迅雷与光鸭同属 OAuth：token_json 里多存了 device_id / open_id
      const { data, error } = await svc.rpc("load_pan_oauth", { p_user_id: uid, p_pan: pan, p_key: CRED_KEY });
      if (error) throw new Error(`读取${PAN_LABELS[pan]}凭据失败：${error.message}`);
      const row = ((data ?? []) as Array<{ token_json: string | null; root_dir_id: string | null }>)[0];
      if (!row?.token_json) return null;
      let tokens: XlTokens;
      try {
        tokens = JSON.parse(row.token_json) as XlTokens;
      } catch {
        return null;
      }
      if (!tokens.access_token) return null;
      // 老数据可能没存 device_id：补一个并回写，否则 drive 接口会 400 device_id is empty
      if (!tokens.device_id) {
        tokens.device_id = xlNewDeviceId();
        try {
          await admin.rpc("update_pan_oauth_token", {
            p_user_id: uid,
            p_pan: pan,
            p_token_json: JSON.stringify(tokens),
            p_key: CRED_KEY,
          });
        } catch { /* 回写失败不影响本次使用 */ }
      }
      return { kind: "oauth", userId: uid, xunlei: tokens, rootDirId: row.root_dir_id ?? null };
    }
    if (pan === "p123") {
      // 123 云盘的凭证是 authorToken（请求头 Authorization: Bearer），不是 Cookie；
      // 为复用既有加解密链路，仍存在 cookie_enc 列里，取出后放进 token 字段。
      const { data, error } = await svc.rpc("load_pan_account", { p_user_id: uid, p_pan: pan, p_key: CRED_KEY });
      if (error) throw new Error(`读取${PAN_LABELS[pan]}凭据失败：${error.message}`);
      const row = ((data ?? []) as Array<{ cookie: string | null; root_dir: string | null }>)[0];
      const token = String(row?.cookie ?? "").trim();
      if (!token) return null;
      return { kind: "cookie", userId: uid, token, rootDir: row?.root_dir ?? null };
    }
    const { data, error } = await svc.rpc("load_pan_account", { p_user_id: uid, p_pan: pan, p_key: CRED_KEY });
    if (error) throw new Error(`读取网盘账号失败：${error.message}`);
    const row = ((data ?? []) as Array<{ cookie: string | null; root_dir: string | null }>)[0];
    if (!row?.cookie) return null;
    const cred: PanCred = { kind: "cookie", userId: uid, cookie: row.cookie, rootDir: row.root_dir ?? null };
    if (pan === "baidu") {
      // 百度的 cookie_enc 里存的是 {cookie,bdstoken,uk} 的 JSON：拆开塞进 PanCred，
      // 调用层（baiduEnsureBdstoken）缺 bdstoken 时还能用 Cookie 现取
      const c = baiduCredOf({ ...cred, cookie: row.cookie });
      if (!c.cookie) return null;
      cred.bdstoken = c.bdstoken;
      cred.uk = c.uk;
    }
    return cred;
  };

  /** 执行一个订阅：抓取 → 去重入库 → 转存 → 写入 resources */
  /**
   * 登记一条「待推送站点」任务：服务端改了资源（集数/链接），但站点推送依赖用户会话、
   * 自动重登与网盘链接匹配，这套逻辑只存在于前端（ResourceTable.syncToSite）；
   * 所以这里只登记，前端打开资源管理页时自动补推。
   */
  async function queueResourceSync(
    userId: string,
    resourceId: string,
    name: string,
    reason: string
  ): Promise<void> {
    try {
      await svc.from("resource_sync_queue").upsert(
        {
          user_id: userId,
          resource_id: resourceId,
          resource_name: name,
          reason,
          created_at: new Date().toISOString(),
        },
        { onConflict: "resource_id" }
      );
    } catch (e) {
      // 登记失败不影响订阅本身：集数已经改好，用户手动同步一次即可。
      // 但必须打日志：这条任务丢了就意味着「站点不会自动更新」，排查时得看得到。
      console.error("[subscription-run] 登记待推送任务失败：", (e as Error).message, resourceId);
    }
  }

  /**
   * 写变更记录（失败重试一次 + 打日志）。
   *
   * 为什么重要：change_history 是「资源管理-更新栏」和「开放接口 /updated 的最近变更」的数据源。
   * 以前这里是裸 insert、不检查错误：一旦偶发失败（网络抖动/瞬时错误），
   * 资源集数已经改成第 8 集，但变更记录还停在「第 7 集/链接」，
   * 结果自动发帖脚本按「最近变更时间」判断 → 认为没有新更新 → 不推送（真实故障）。
   */
  const insertChange = async (row: Record<string, unknown>): Promise<void> => {
    for (let i = 0; i < 2; i++) {
      const { error } = await svc.from("change_history").insert(row);
      if (!error) return;
      console.error(
        "[subscription-run] 写变更记录失败：",
        error.message,
        String(row.field_name ?? ""),
        String(row.resource_id ?? ""),
      );
      await wait(300);
    }
  }

  /**
   * 把资源集数对齐成 newCount，并把资源名里的「第N集」一起改掉（与前端「资源管理」改集数时的行为一致：
   * 资源名既要展示、又是推站点的标题来源，名字不改站点上还是旧集数）。
   * 写变更记录并登记待推送站点。返回是否真的改了。
   */
  async function applyEpisodeCount(
    sub: SubRow,
    res: { id: string; name: string; episode_count: number | null },
    oldCount: number,
    newCount: number
  ): Promise<boolean> {
    if (newCount === oldCount) return false;
    // 只替换「第N集」这一段，保留名字里的其它内容（如「更新至第3集 新剧开播 无广告」）
    const newName = res.name.replace(/第\s*\d+\s*集/, `第${newCount}集`);
    const patch: Record<string, unknown> = { episode_count: newCount };
    if (newName !== res.name) patch.name = newName;

    await svc.from("resources").update(patch).eq("id", res.id);
    await insertChange({
      resource_id: res.id,
      resource_name: newName,
      field_name: "episode_count",
      field_label: "集数",
      old_value: String(oldCount),
      new_value: String(newCount),
      user_id: sub.user_id,
    });
    if (newName !== res.name) {
      await insertChange({
        resource_id: res.id,
        resource_name: newName,
        field_name: "name",
        field_label: "资源名称",
        old_value: res.name,
        new_value: newName,
        user_id: sub.user_id,
      });
    }
    await queueResourceSync(
      sub.user_id,
      res.id,
      newName,
      `订阅转存：集数 ${oldCount} → ${newCount}${newName !== res.name ? "，资源名已同步" : ""}`
    );
    return true;
  }

  /**
   * 本轮「判定完结」的说明（按订阅 id 暂存）：几条执行路径最后都会写 last_message，
   * 在那里统一补上，避免每条路径各自传参。用完即删，避免无限增长。
   */
  const finishedNotes = new Map<string, string>();

  /**
   * 「全集数」到齐即判定完结（需求①）：
   *   ① 资源名改成「已完结全N集」（示例：雷霆令 2026 更新第18集 2160P SDR + 全集 30 → 雷霆令 2026 已完结全30集 2160P SDR）
   *   ② 资源置 is_finished=true → 资源管理里自动移到「已完结」，对外开放 API 的资源状态随之变成「已完结」
   *   ③ 取消订阅（enabled=false），写入 delete_after=now+1h，由 pg_cron 定时删除
   * 返回给用户看的说明；未设全集数 / 还没到全集 / 已经判定过 → 返回 null（不重复改）。
   */
  async function finishSubscriptionIfComplete(
    sub: SubRow,
    res: { id: string; name: string; episode_count: number | null },
    currentCount: number
  ): Promise<string | null> {
    const total = Math.max(0, Number(sub.total_episodes ?? 0) || 0);
    if (!total || currentCount < total) return null;
    // 一轮里同一订阅可能被命中多次（多条候选/多个条目）：先确认库里还没判定过，避免重复改名与重复登记推送
    const { data: fresh } = await svc
      .from("subscriptions")
      .select("finished_at")
      .eq("id", sub.id)
      .maybeSingle<{ finished_at: string | null }>();
    if (fresh?.finished_at) return null;

    const oldCount = Number(res.episode_count ?? 0);
    const newName = finishedName(res.name, total);
    // 集数一律按「全集数」落库：分享里偶尔会多出 31 集这种，以用户填的全集数为准
    const patch: Record<string, unknown> = { is_finished: true, episode_count: total };
    if (newName !== res.name) patch.name = newName;
    await svc.from("resources").update(patch).eq("id", res.id);
    if (oldCount !== total) {
      await insertChange({
        resource_id: res.id,
        resource_name: newName,
        field_name: "episode_count",
        field_label: "集数",
        old_value: String(oldCount),
        new_value: String(total),
        user_id: sub.user_id,
      });
    }
    if (newName !== res.name) {
      await insertChange({
        resource_id: res.id,
        resource_name: newName,
        field_name: "name",
        field_label: "资源名称",
        old_value: res.name,
        new_value: newName,
        user_id: sub.user_id,
      });
    }
    await insertChange({
      resource_id: res.id,
      resource_name: newName,
      field_name: "is_finished",
      field_label: "完结状态",
      old_value: "否",
      new_value: "是",
      user_id: sub.user_id,
    });
    await queueResourceSync(
      sub.user_id,
      res.id,
      newName,
      `订阅完结：已同步到全集 ${total} 集，资源名改为「${newName}」并移入已完结`
    );
    await svc.from("subscriptions").update({
      enabled: false,
      finished_at: new Date().toISOString(),
      delete_after: new Date(Date.now() + FINISH_DELETE_DELAY_MS).toISOString(),
    }).eq("id", sub.id);
    const note = `已同步到全集 ${total} 集 → 判定完结：资源名改为「${newName}」、已移入「已完结」；本订阅已取消，1 小时后自动删除`;
    // 交给本轮收尾时的 finish()/最终写库补进 last_message（几条执行路径共用，不必各自传参）
    finishedNotes.set(sub.id, note);
    return note;
  }

  /**
   * 把一次转存结果绑定到「资源管理」里的资源上（订阅不再新建资源）。
   * 目标资源：订阅里手动绑定的那条优先（用户明确选了要更新谁）；没绑定才按归一化剧名匹配。
   * 命中后：合并网盘链接（去重）、集数取大、完结状态只进不退，写变更记录，并登记待推送站点。
   * 返回匹配到的资源；没匹配到返回 null（调用方按「跳过」处理）。
   */
  async function bindTransferToResource(
    sub: SubRow,
    index: Map<string, ResourceRow>,
    title: string,
    url: string,
    episodeCount: number,
    panLabel: string
  ): Promise<ResourceRow | null> {
    const bound = sub.resource_id ? await loadResourceById(sub.resource_id) : null;
    const matched = bound ?? matchResource(index, title);
    if (!matched) return null;

    const oldCount = matched.episode_count ?? 0;
    const newCount = Math.max(oldCount, episodeCount);
    const finished = !!matched.is_finished || looksFinished(title);
    const merged = mergeLinks(matched.links, url, panLabel);
    // 集数变了 → 资源名里的「第N集」一起改（前端推站点用的就是资源名）
    const newName = newCount !== oldCount
      ? matched.name.replace(/第\s*\d+\s*集/, `第${newCount}集`)
      : matched.name;
    const patch: Record<string, unknown> = { links: merged };
    if (!matched.link) patch.link = url;
    if (newCount !== oldCount) patch.episode_count = newCount;
    if (newName !== matched.name) patch.name = newName;
    if (finished !== !!matched.is_finished) patch.is_finished = finished;

    await svc.from("resources").update(patch).eq("id", matched.id);
    await insertChange({
      resource_id: matched.id,
      resource_name: newName,
      field_name: "auto_transfer",
      field_label: "订阅联动",
      old_value: matched.link ?? "",
      new_value: url,
      user_id: sub.user_id,
    });
    if (newCount !== oldCount) {
      await insertChange({
        resource_id: matched.id,
        resource_name: newName,
        field_name: "episode_count",
        field_label: "集数",
        old_value: String(oldCount),
        new_value: String(newCount),
        user_id: sub.user_id,
      });
    }
    if (newName !== matched.name) {
      await insertChange({
        resource_id: matched.id,
        resource_name: newName,
        field_name: "name",
        field_label: "资源名称",
        old_value: matched.name,
        new_value: newName,
        user_id: sub.user_id,
      });
    }

    // 集数/名称/链接有变化，或「站点已推送集数」落后于库内集数 → 登记待推送
    const { data: matchedCur } = await svc
      .from("resources")
      .select("synced_episode_count")
      .eq("id", matched.id)
      .maybeSingle();
    const matchedSynced = (matchedCur as { synced_episode_count?: number | null } | null)?.synced_episode_count ?? null;
    if (newCount !== oldCount || newName !== matched.name || !matched.link || matchedSynced !== newCount) {
      await queueResourceSync(
        sub.user_id,
        matched.id,
        newName,
        `订阅联动：集数 ${oldCount} → ${newCount}，链接已并入`
      );
    }

    // 需求①：订阅设了「全集数」且这次已达全集 → 判定完结（改名 + 移入已完结 + 取消订阅 + 1 小时后删除）
    await finishSubscriptionIfComplete(
      sub,
      { id: matched.id, name: newName, episode_count: newCount },
      newCount
    );

    // 同一轮里可能有多条候选命中同一资源，回写索引避免读到旧值
    index.set(normalizeTitle(matched.name), {
      ...matched,
      name: newName,
      episode_count: newCount,
      link: matched.link ?? url,
      links: merged,
      is_finished: finished,
    });
    return matched;
  }

  /**
   * 执行一次订阅：抓取源 → 按指纹去重 → 新增文件转存到目标目录。
   * startedAt 由调度方传入（抢占时刻）并作为 last_run_at 记录：「每隔 N 分钟检查」按开始时刻计算，
   * 否则一次耗时较久的执行会把下一次检查一直往后推，n 分钟的设置就变成了 n + 本次耗时。
   */
  async function runSubscription(sub: SubRow, startedAt = new Date().toISOString()): Promise<RunResult> {
    // 源地址本身就是网盘分享链接 → 走「分享目录监控」：列目录、只转新增文件
    const sharePan = detectPan(sub.source_url);
    /**
     * 锁定中的网盘（迅雷）：整条订阅直接跳过。
     * 不写 failed —— 否则「凭据失效」计数会被这条文案刷上去，解锁后还要人工恢复。
     */
    if (XUNLEI_LOCKED && (sub.pan === "xunlei" || sharePan === "xunlei")) {
      return {
        found: 0, created: 0, updated: 0, transferred: 0, imported: 0, skipped: 0, failed: 0,
        message: XUNLEI_LOCKED_MSG,
      };
    }
    if (sharePan) return await runPanShareSubscription(sub, sharePan, startedAt);

    const stats = { found: 0, created: 0, updated: 0, transferred: 0, imported: 0, skipped: 0, failed: 0 };
    let message = "";

    // 1) 抓取 + 解析
    let candidates: Candidate[] = [];
    let hint: string | null = null;
    try {
      const { text, contentType } = await fetchSource(sub.source_url);
      const parsed = await parseSource(text, contentType, sub.source_url, sub.source_type);
      candidates = parsed.candidates;
      hint = parseHint(parsed.meta, candidates.length, candidates.filter((c) => matchKeyword(c.title, sub.keyword)).length);
    } catch (e) {
      message = `抓取失败：${(e as Error).message}`;
      const sch = scheduleFields(sub, false);
      const cred = credentialPatch(sub, "failed", message);
      await svc.from("subscriptions").update({
        last_run_at: startedAt, run_lock_at: null, last_status: "failed",
        last_message: `${message}。${sch.note}`, stats, ...sch.patch, ...cred,
      }).eq("id", sub.id);
      return { ...stats, message };
    }

    stats.found = candidates.length;

    // 2) 关键字过滤 + 去重入库
    const fresh: Array<{ id: string; share_url: string; share_passcode: string | null; title: string; pan: string | null }> = [];
    for (const c of candidates) {
      if (!matchKeyword(c.title, sub.keyword)) continue;
      const fingerprint = fingerprintOf(c);
      const { data: inserted } = await svc
        .from("subscription_items")
        .insert({
          subscription_id: sub.id,
          user_id: sub.user_id,
          title: c.title.slice(0, 200),
          source_url: c.sourceUrl,
          share_url: c.shareUrl,
          share_passcode: c.sharePasscode,
          pan: c.pan,
          fingerprint,
          status: "pending",
        })
        .select("id")
        .maybeSingle();
      if (inserted?.id) {
        stats.created++;
        fresh.push({ id: inserted.id, share_url: c.shareUrl, share_passcode: c.sharePasscode, title: c.title, pan: c.pan });
      }
      if (fresh.length >= MAX_ITEMS_PER_RUN) break;
    }

    // 3) 逐条转存 + 与「资源管理」联动
    //    开启「绑定资源管理中的资源」时读一次资源索引（按归一化剧名匹配，不新建资源）
    const resourceIndex = sub.auto_publish
      ? await loadResourceIndex(sub.user_id)
      : new Map<string, ResourceRow>();
    for (const item of fresh) {
      const itemUrl = item.share_url;
      let finalUrl = itemUrl;
      let transferNote = "";
      // 这一条是否真的转存成功了（决定后面记「已转存」还是「已跳过」）
      let transferredOk = false;

      if (item.pan && item.pan !== sub.pan) {
        // 跨盘不能直接转存（需要下载再上传），保留源链接入库
        transferNote = `源链接是${PAN_LABELS[item.pan] ?? item.pan}，与目标网盘（${PAN_LABELS[sub.pan] ?? sub.pan}）不一致，未转存，已用源链接入库`;
      } else {
        try {
          const cred = await loadPanCred(sub.user_id, sub.pan);
          if (!cred) {
            transferNote = `未绑定${PAN_LABELS[sub.pan] ?? sub.pan}账号，未转存，已用源链接入库`;
          } else {
            const r = await transfer(sub.pan, cred, itemUrl, item.share_passcode, sub.target_dir ?? cred.rootDir ?? null);
            if (r.ok) {
              stats.transferred++;
              transferredOk = true;
              // 夸克能生成自己的分享链接；光鸭暂无「创建分享」接口 → 沿用源链接
              if (r.shareUrl) finalUrl = r.shareUrl;
              transferNote = r.shareUrl ? r.message : `${r.message}；链接沿用源分享链接`;
              await svc.from("subscription_items").update({
                status: "transferred",
                transfer_url: r.shareUrl ?? null,
                error: null,
              }).eq("id", item.id);
            } else {
              transferNote = r.message;
              // 凭据类问题才标记账号失效，避免误标（如分享链接本身有问题）
              if (/(登录|Cookie|令牌|失效|过期|未授权|重新扫码|重新授权)/i.test(r.message)) {
                await svc.rpc("mark_pan_account", {
                  p_user_id: sub.user_id,
                  p_pan: sub.pan,
                  p_ok: false,
                  p_error: r.message,
                });
              }
              await svc.from("subscription_items").update({
                status: "failed",
                error: r.message,
              }).eq("id", item.id);
              stats.failed++;
              continue;
            }
          }
        } catch (e) {
          transferNote = (e as Error).message;
        }
      }

      // 4) 与「资源管理」联动：匹配已有资源并更新（不再新建资源）
      const title = item.title || "未命名资源";
      if (!sub.auto_publish) {
        // 转存成功就是「已转存」；真没转成（跨盘 / 未绑定 / 异常）才记「已跳过」。
        // 以前一律记 skipped，用户会以为文件没有转存进去。
        await svc.from("subscription_items").update({
          status: transferredOk ? "transferred" : "skipped",
          transfer_url: finalUrl,
          error: transferredOk
            ? `已转存（未开启「绑定资源管理中的资源」，未做联动）${transferNote ? `；${transferNote}` : ""}`
            : `未转存：${transferNote || "未开启转存"}`,
        }).eq("id", item.id);
        stats.skipped++;
        continue;
      }

      const matched = await bindTransferToResource(
        sub,
        resourceIndex,
        title,
        finalUrl,
        parseEpisodeCount(title),
        PAN_LABELS[sub.pan] ?? sub.pan
      );
      if (!matched) {
        await svc.from("subscription_items").update({
          status: "skipped",
          transfer_url: finalUrl,
          error: `资源管理里没有匹配「${title.slice(0, 40)}」的资源，未新建（按设置只做联动）${transferNote ? `；${transferNote}` : ""}`,
        }).eq("id", item.id);
        stats.skipped++;
        continue;
      }

      await svc.from("subscription_items").update({
        status: "imported",
        resource_id: matched.id,
        transfer_url: finalUrl,
        error: `已联动资源「${matched.name}」${transferNote ? `；${transferNote}` : ""}`,
      }).eq("id", item.id);
      stats.imported++;
    }

    // 判定成败看「这一轮有没有真的做成事」（转存 / 联动 / 更新）：
    // 没开「绑定资源管理」时 imported 恒为 0，但文件其实已经转存进网盘了，按 imported 判
    // 会永远显示「失败」。什么都没做成（没解析到、没转存、没匹配到）才算失败。
    const progressed = stats.transferred + stats.imported + stats.updated + stats.skipped;
    const status = progressed === 0 ? "failed" : stats.failed > 0 ? "partial" : "ok";
    const base = `抓取 ${stats.found} 条，转存 ${stats.transferred} 次，联动更新 ${stats.imported} 条${stats.skipped ? `，未联动/未转存 ${stats.skipped} 条` : ""}${stats.failed ? `，失败 ${stats.failed} 条` : ""}`;
    message = hint ? `${base}。${hint}` : base;
    // 本轮刚好判定完结（达到全集数）→ 把完结说明补进消息
    {
      const finNote = finishedNotes.get(sub.id);
      if (finNote) {
        finishedNotes.delete(sub.id);
        message = `${message}。${finNote}`;
      }
    }
    // 这一轮有没有真的抓到新增文件：决定「连续未更新次数」清零还是 +1，以及下次检查时间
    const sch = scheduleFields(sub, stats.transferred + stats.imported > 0);
    const cred = credentialPatch(sub, status, message);
    await svc.from("subscriptions").update({
      last_run_at: startedAt, run_lock_at: null, last_status: status,
      last_message: `${message}。${sch.note}`, stats, ...sch.patch, ...cred,
    }).eq("id", sub.id);

    return { ...stats, message };
  }

  /**
   * 分享目录订阅（源地址 = 光鸭/夸克分享链接）。
   * 把分享里的每个顶层条目（目录或散文件）当作一条资源：
   *   · 新条目 → 转存该条目的文件 + 入库
   *   · 已有条目 → 比较文件数，多了就转存新增文件、更新集数并记录变更（监控的核心）
   *   · 条目名出现「完结/全N集」→ 自动标记为已完结
   */
  async function runPanShareSubscription(
    sub: SubRow,
    sharePan: string,
    startedAt: string
  ): Promise<RunResult> {
    const stats = { found: 0, created: 0, updated: 0, transferred: 0, imported: 0, skipped: 0, failed: 0 };
    const panLabel = PAN_LABELS[sharePan] ?? sharePan;

    const finish = async (status: string, msg: string): Promise<RunResult> => {
      // 本轮刚好判定完结（达到全集数）→ 把完结说明补进消息
      const finNote = finishedNotes.get(sub.id);
      if (finNote) finishedNotes.delete(sub.id);
      const fullMsg = finNote ? `${msg}。${finNote}` : msg;
      const sch = scheduleFields(sub, stats.transferred + stats.imported > 0);
      // 凭据失效计数 / 连续 3 次自动停止（cred 里的 last_message 会覆盖上面的拼接）
      const cred = credentialPatch(sub, status, fullMsg);
      await svc.from("subscriptions").update({
        last_run_at: startedAt, run_lock_at: null, last_status: status,
        last_message: `${fullMsg}。${sch.note}`, stats, ...sch.patch, ...cred,
      }).eq("id", sub.id);
      return { ...stats, message: fullMsg };
    };

    /**
     * 上游临时故障（不是链接/凭据问题）：
     *   · 保留上次结果（之前是 ok/partial 就继续显示正常，否则标 retry「重试中」）
     *   · 2 分钟后自动重试，不占用正常的检查节奏（也不推进「连续未更新」计数）
     */
    const finishTransient = async (msg: string): Promise<RunResult> => {
      const retryAt = new Date(Date.now() + 2 * 60_000);
      const keep = sub.last_status === "ok" || sub.last_status === "partial" ? sub.last_status : "retry";
      const fullMsg = `${msg}；上游临时拥塞（不是链接失效），已安排在 ${bjHHmm(retryAt.toISOString())} 自动重试`;
      await svc.from("subscriptions").update({
        last_run_at: startedAt,
        run_lock_at: null,
        last_status: keep,
        last_message: fullMsg,
        stats,
        next_check_at: retryAt.toISOString(),
      }).eq("id", sub.id);
      return { ...stats, message: fullMsg };
    };

    if (sharePan !== sub.pan) {
      return await finish("failed", `该订阅源是${panLabel}分享链接，但目标网盘选的是${PAN_LABELS[sub.pan] ?? sub.pan}，跨盘无法转存；请把目标网盘改为${panLabel}`);
    }

    const cred = await loadPanCred(sub.user_id, sharePan);
    if (!cred) {
      return await finish("failed", `未绑定${panLabel}账号，分享目录需要登录态才能读取；请先在「网盘账号」绑定${panLabel}`);
    }

    let entries: ShareEntry[] = [];
    {
      // 分享目录读取失败会直接把订阅标成「失败」，但网盘侧会偶发误报：
      // 夸克对同一个有效分享会间歇性回 41012「好友已取消了分享」（实测同一链接上一轮还正常、
      // 下轮又正常），只看一次就把订阅判失败，用户会以为刚换的链接也无效。
      // 因此这里隔 1.5 秒重试两次，三次都失败才认定失败；消息里带上实际用的分享 ID，
      // 便于用户确认「程序到底读的是哪个链接」。
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          entries = await listPanShareEntries(sharePan, cred, sub.source_url, sub.source_passcode);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e as Error;
          if (attempt < 1) await wait(1500);
        }
      }
      if (lastErr) {
        const shareId = /\/s\/([^/?#]+)/.exec(sub.source_url)?.[1] ?? sub.source_url;
        const base = `读取分享目录失败（分享 ${shareId}）：${lastErr.message}`;
        // 上游网络类故障（中继 502 / 上游超时 / 连接被重置）：不是链接问题，
        // 别把订阅标成「失败」吓用户 —— 保留上次状态，2 分钟后自动重试。
        if (TRANSIENT_UPSTREAM_RE.test(lastErr.message)) {
          return await finishTransient(base);
        }
        const transient = /41012|好友已取消|分享已失效|已被取消|不存在/.test(lastErr.message);
        return await finish(
          "failed",
          base +
            (transient
              ? "；若该链接在浏览器/「解析测试」里能正常打开，多为网盘侧偶发误报，下一轮会自动重试成功，无需改配置"
              : "")
        );
      }
    }
    stats.found = entries.length;
    if (entries.length === 0) {
      return await finish("failed", "这个分享里没有读到任何文件（分享可能已失效，或分享目录为空）；可在「解析测试」里再确认一次");
    }

    // 只认目录 ID：用户在自己的网盘里重命名文件夹不会影响转存
    const dir = sub.target_dir ?? cred.rootDirId ?? null;
    // 开启「绑定资源管理中的资源」时读一次资源索引（按归一化剧名匹配，不新建资源）
    const resourceIndex = sub.auto_publish
      ? await loadResourceIndex(sub.user_id)
      : new Map<string, ResourceRow>();

    // ── 新增文件检测 ──
    // 光鸭/夸克都是把文件平铺转存进目标目录的，所以「分享条目里的文件 − 目标目录里已存在的文件」
    // 就是还没转存的新文件。这是检测分享里新增文件的唯一可靠依据（只看条目是否处理过
    // 是不够的：同一目录里后来加的文件会被漏掉）。
    // 目标目录名集合每次运行只列一次，转存成功后把新名字补进去。
    /**
     * 目标目录快照：能不能列（known）、有哪些名字（names）、各自体积（sizes）、
     * 全部体积集合（sizeSet：用来「按内容」判断某一集是不是已经在目录里——
     * 光鸭转存后可能先落一个内部名条目，名字对不上但内容就是那一集）。
     */
    type DirSnapshot = {
      known: boolean;
      names: Set<string>;
      sizes: Map<string, number>;
      sizeSet: Set<number>;
      /** 无扩展名的条目（网盘内部名 / 老版本遗留），用于「按体积归位改名」 */
      strays: Array<{ id: string; name: string; size: number }>;
    };

    /** 列目标目录里的文件（fresh=true 时用多页、实时的方式复核） */
    const listTargetDir = async (fresh: boolean): Promise<DirSnapshot> => {
      const names = new Set<string>();
      const sizes = new Map<string, number>();
      const sizeSet = new Set<number>();
      const strays: Array<{ id: string; name: string; size: number }> = [];
      /** 名字不带扩展名（S01E11 / 32e442c4…086 这类）→ 需要按体积认领回正确名字 */
      const isStray = (n: string) => !/\.[A-Za-z0-9]{2,5}$/.test(n);
      const add = (id: string, n: string, sz: number) => {
        names.add(n);
        if (sz) {
          sizes.set(n, sz);
          sizeSet.add(sz);
        }
        if (isStray(n)) strays.push({ id, name: n, size: sz });
      };
      if (sharePan === "guangya") {
        const list = await gyListFolder(cred, dir ?? "", {
          files: true,
          // 目标目录通常远小于 200 页；给到 200 是为「别因为页数上限而误判成不完整」
          maxPages: 200,
          refresh: fresh,
          // 去重判定的依据必须是「完整的目录」：读不全就会把没看到的文件当成缺失而重转
          strict: true,
        });
        for (const f of list) {
          const n = String(f.fileName ?? "");
          if (!n) continue;
          add(String(f.fileId ?? ""), n, Number(f.fileSize ?? 0) || 0);
        }
      } else if (sharePan === "quark" || sharePan === "uc") {
        for (const f of await quarkListFiles(cred.cookie ?? "", dir ?? "", cdOf(sharePan))) {
          names.add(f.name);
          if (f.size) {
            sizes.set(f.name, f.size);
            sizeSet.add(f.size);
          }
        }
      } else if (sharePan === "baidu") {
        // 百度：列自己网盘的目标目录（fs_id 有、但改名要用绝对路径，所以走 add 一起记 strays）
        for (const f of await baiduListOwnDir(cred, dir ?? "/")) {
          if (f.isDir) continue;
          add(f.id, f.name, f.size);
        }
      } else if (sharePan === "p123") {
        // 123：列自己网盘的目标目录（FileId 就是后续改名/删除用的 id）
        for (const f of await p123ListEntries(cred.token ?? "", dir ?? "0")) {
          if (f.isDir) continue;
          add(f.id, f.name, f.size);
        }
      }
      return { known: true, names, sizes, sizeSet, strays };
    };

    let dirSnap: DirSnapshot | null = null;
    /** 目标目录读不到时的原始错误（用来在订阅备注里说清「为什么这轮没同步」） */
    let dirError: string | null = null;
    /** 本轮是否出现过「读不到目标目录」 */
    let dirUnreadable = false;
    const targetDir = async (): Promise<DirSnapshot> => {
      if (dirSnap) return dirSnap;
      try {
        dirSnap = await listTargetDir(false);
      } catch (e) {
        // 列目录失败 → 不能判断哪些已存在。此时 known=false，调用方退回旧行为
        // （已转存过的条目不再重复转），绝不能在判断不了时把整份文件再转一遍。
        // 但**必须**把原因暴露出去：以前这里静默吞掉，转存目录被删掉后订阅一直显示
        // 「无变化」，用户完全看不出是「读不到目录」而不是「真的没有新增」。
        dirError = (e as Error).message || "未知原因";
        dirSnap = { known: false, names: new Set(), sizes: new Map(), sizeSet: new Set(), strays: [] };
      }
      return dirSnap;
    };

    // ── 持久化基线：本订阅已经成功转存过的文件（跨运行保留）──
    // 以「条目 + 文件 ID」为稳定键。基线只在「列不了目标目录」时兜底（判断不了时绝不
    // 把整份文件重转一遍）；**不能**拿它直接否决一次转存——文件转存后若被从目标目录
    // 删掉/移走（手工整理、误删），基线仍记着它，那样它就永远不会被补回来，
    // 订阅还一直报「无变化」。是否要转，一律以目标目录里有没有这个文件为准。
    const { data: baseRows } = await svc
      .from("subscription_transferred")
      .select("file_key, pan_file_id, file_name")
      .eq("subscription_id", sub.id);
    const baseKeys = new Set<string>((baseRows ?? []).map((r: { file_key: string }) => r.file_key));
    /**
     * 本订阅历史上转存过的**网盘文件 id**。
     * 「同集旧版本清理」只在这个集合里删：用户自己放在目标目录里的同集文件（自己的 4K 收藏等）
     * 不在集合中，因此绝不会被误删。历史数据没有这一列记录时会偏保守（不删），属安全方向。
     */
    const ownedFileIds = new Set<string>();
    /** 网盘文件 id → 当初对应的**分享原始名**；画质标签（4K/HDR/SDR…）只能从这里取 */
    const origNameByFileId = new Map<string, string>();
    for (const r of (baseRows ?? []) as Array<{ pan_file_id?: string | null; file_name?: string | null }>) {
      const fid = String(r.pan_file_id ?? "").trim();
      if (!fid) continue;
      ownedFileIds.add(fid);
      const nm = String(r.file_name ?? "").trim();
      if (nm && !origNameByFileId.has(fid)) origNameByFileId.set(fid, nm);
    }
    const transferKey = (entryKey: string, f: ShareFile): string => `${entryKey}::${f.id || f.name}`;

    // ── 体积索引：本次分享里「体积唯一」的文件 → 该体积代表哪一集 ──
    // 光鸭转存完成后可能先出现一个内部名条目（名字对不上、内容就是那一集），
    // 只能靠体积把内容认出来。体积在同一批分享文件里不唯一时不认（避免误判成别的集）。
    const sizeOwners = new Map<number, ShareFile>();
    {
      const seenSizes = new Set<number>();
      const dupSizes = new Set<number>();
      for (const entry of entries) {
        if (!matchKeyword(entry.title, sub.keyword)) continue;
        for (const f of entry.files) {
          const sz = Number(f.size ?? 0) || 0;
          if (!sz) continue;
          if (seenSizes.has(sz)) dupSizes.add(sz);
          else seenSizes.add(sz);
        }
      }
      for (const entry of entries) {
        if (!matchKeyword(entry.title, sub.keyword)) continue;
        for (const f of entry.files) {
          const sz = Number(f.size ?? 0) || 0;
          if (!sz || dupSizes.has(sz)) continue;
          sizeOwners.set(sz, f);
        }
      }
    }

    /** 目录里是否有「同体积」的文件：有就等于这一集已经在目录里（哪怕名字是网盘内部名） */
    const sameSizeInDir = (f: ShareFile, snap: DirSnapshot): boolean => {
      const sz = Number(f.size ?? 0) || 0;
      if (!sz || snap.sizeSet.size === 0) return false;
      if (sizeOwners.get(sz) !== f) return false; // 体积不唯一 → 不敢认
      return snap.sizeSet.has(sz);
    };

    /**
     * 目标目录里是否已有「这个文件」。
     * 原名命中即算有；命中清洗名/「高码」名时还要比体积——两边体积都拿得到且**不同**，
     * 说明目录里那个是同集的另一个版本（先转了 SDR，之后分享方又发了 4K/DV），本文件仍需转存。
     * 最后再按「体积」兜底：目录里存在同体积的文件就算有（哪怕它现在是网盘内部名）。
     * 这一步是「不再重复转存、不再多出内部名垃圾文件」的关键——光鸭转存落地的可能是
     * 内部名条目，只按名字判断会把它当成「缺这一集」，于是反复重转、每次都多出一份垃圾。
     */
    const presentInDir = (f: ShareFile, snap: DirSnapshot): boolean => {
      if (snap.names.has(f.name)) return true;                        // 仍是原名
      const cleaned = cleanFileFullName(f.name, sub.clean_mode);
      if (cleaned && cleaned !== f.name) {
        /**
         * 候选名要覆盖现在与历史两种命名，否则改命名规则会导致「文件明明在目录里
         * 却被判成缺失」→ 每轮重复转存：
         *   · `S01E01.mkv`               单版本
         *   · `S01E01-2160P-DV.mkv`     多版本（按画质）
         *   · `S01E01高码.mkv`          旧规则留下的
         */
        const base = stripExt(cleaned);
        const ext = cleaned.slice(base.length);
        const q = qualitySuffixOf(f.name);
        const cands = [cleaned, tagBeforeExt(cleaned, "高码")];
        if (q) cands.splice(1, 0, `${base}${q}${ext}`);
        for (const cand of cands) {
          if (!snap.names.has(cand)) continue;
          const dirSize = snap.sizes.get(cand);
          if (dirSize && f.size && dirSize !== f.size) continue;      // 同名不同体积 → 那是别的版本
          return true;
        }
      }
      return sameSizeInDir(f, snap);
    };

    /**
     * 这一轮还需要转存的文件（目标目录里确实没有的）。
     * 返回 null 表示无法判断（列目录失败），由调用方退回「按基线去重」的旧逻辑。
     *
     * 判据只有一条：目标目录里有没有这个文件。基线不再参与否决——否则文件转存后被
     * 从目标目录删掉/移走时（基线仍记着它）就永远补不回来，订阅还会一直报「无变化」。
     * 唯一的例外：基线里记着、目录里却没有的文件会再做一次实时重列复核（目录接口
     * 偶发返回不全），复核仍找不到才认定缺失并补转，避免把已存在的文件重复转存。
     */
    const pendingFiles = async (entryKey: string, files: ShareFile[]): Promise<ShareFile[] | null> => {
      const snap = await targetDir();
      if (!snap.known) {
        dirUnreadable = true;
        return null;
      }
      const missing = files.filter((f) => !presentInDir(f, snap));
      const recorded = missing.filter((f) => baseKeys.has(transferKey(entryKey, f)));
      if (recorded.length === 0) return missing;
      try {
        const fresh = await listTargetDir(true);
        for (const n of fresh.names) snap.names.add(n);
        for (const [n, sz] of fresh.sizes) snap.sizes.set(n, sz);
        for (const sz of fresh.sizeSet) snap.sizeSet.add(sz);
      } catch {
        // 复核失败：本轮宁可不补转，也不重复转存
        return missing.filter((f) => !recorded.includes(f));
      }
      return missing.filter((f) => !presentInDir(f, snap));
    };

    /**
     * 转存成功后把这些文件记进本次运行的目录快照（避免同批文件被下一个条目重复转存）。
     * 登记的是「清洗后实际会落成的名字」——同集已有别的版本时是「高码」名，
     * 这样本轮后续条目/批次判断「目录里有没有」时不会把它当成别的版本。
     */
    const rememberTransferred = async (files: ShareFile[]): Promise<void> => {
      const snap = await targetDir();
      if (!snap.known) return;
      const planned = planCleanedNames(files, sub.clean_mode, snap.sizes);
      for (const f of files) {
        snap.names.add(f.name);
        if (f.size) {
          snap.sizes.set(f.name, f.size);
          snap.sizeSet.add(f.size);
        }
        const finalName = planned.get(f.name);
        if (finalName && finalName !== f.name) {
          snap.names.add(finalName);
          if (f.size) {
            snap.sizes.set(finalName, f.size);
            snap.sizeSet.add(f.size);
          }
        }
      }
    };

    /** 把已成功转存的文件写进持久化基线（跨运行保留）；写库失败也更新内存集合，至少本次运行内不重复 */
    const recordTransferred = async (
      entryKey: string,
      files: ShareFile[],
      /** 本次转存返回的网盘文件 id（与 files 一一对应时才有）：清理同集旧版本时用它确认「这个文件是本订阅转的」 */
      savedFids?: string[]
    ): Promise<void> => {
      if (files.length === 0) return;
      for (const f of files) baseKeys.add(transferKey(entryKey, f));
      const rows = files.map((f, i) => ({
        subscription_id: sub.id,
        user_id: sub.user_id,
        file_key: transferKey(entryKey, f),
        file_name: f.name,
        pan_file_id: savedFids?.[i] ? String(savedFids[i]) : null,
      }));
      const { error } = await svc
        .from("subscription_transferred")
        .upsert(rows, { onConflict: "subscription_id,file_key" });
      if (error) console.warn("写入转存基线失败：", error.message);
    };

    // 分批转存 + 每批立即清洗：每批最多 50 个（光鸭 restore_share 单请求 fileId 上限≈50，
    // 超出会被整体拒收并报「文件不存在」，导致大分享同步不全）。每批转完立刻清洗该批文件名，
    // 这样即使本轮超时，已完成的批次也已「转存+清洗」完毕；剩余文件靠「目标目录差集」
    // （pendingFiles）在下一轮自动续跑，不会被重复转存。
    // 时间预算：临近函数的「墙钟上限」就主动收尾，把剩余文件留给下一轮，避免被平台硬杀在半批
    //（半批被杀 = 这批白转 + 执行锁要等 RUN_LOCK_TTL_MS 才释放）。墙钟上限 = user worker 的
    // worker_timeout_ms（见 main/index.ts）：托管付费档 400s / 免费 150s，自建按 400s 部署。
    // 默认 520s 对应 600s 墙钟，为「一批在途转存 + 清洗」（约 60~80s）留余量；
    // 墙钟更小时用 RUN_CHUNK_BUDGET_MS（毫秒）覆盖，下限 60s 防止误配成 0 导致一轮什么都不做。
    const CHUNK_SIZE = 50;
    const runStartMs = new Date(startedAt).getTime();
    const CHUNK_BUDGET_MS = Math.max(60_000, Number(Deno.env.get("RUN_CHUNK_BUDGET_MS") ?? 520_000));
    const transferAndClean = async (
      entryKey: string,
      files: ShareFile[],
      /** 目标目录覆盖：文件夹模式下写入「已落地的同名文件夹」内部时用 */
      dirOverride?: string | null
    ): Promise<{ ok: boolean; transferredChunks: number; failedChunks: number; notes: string[]; usedDir: string | null }> => {
      const notes: string[] = [];
      let transferredChunks = 0;
      let failedChunks = 0;
      const targetDirId = dirOverride ?? dir;
      let usedDir: string | null = targetDirId;
      // 改名计划要用「转存前」的目录快照：转存成功后 rememberTransferred 会把新文件登记进快照，
      // 若改名读的是登记后的快照，会把这些文件当成「目录里已有同名同体积的文件」而跳过改名。
      const dirSizesBefore = dirSnap ? new Map(dirSnap.sizes) : undefined;
      for (let i = 0; i < files.length; i += CHUNK_SIZE) {
        if (Date.now() - runStartMs > CHUNK_BUDGET_MS) {
          notes.push("已达本轮时间上限，剩余文件将在下一轮继续转存");
          break;
        }
        const chunk = files.slice(i, i + CHUNK_SIZE);
        const t = await transferInto(sharePan, cred, sub.source_url, sub.source_passcode, chunk, targetDirId);
        usedDir = t.usedDir ?? usedDir;
        if (t.note) notes.push(t.note);
        if (t.result.ok) {
          transferredChunks++;
          await rememberTransferred(chunk);
          /**
           * 顺序有讲究：**先改名、再写基线**。
           * 光鸭转存不返回文件 id，而改名那一步会按名字把落地后的文件找出来（唯一能拿到 id 的时机），
           * 所以先跑改名才能把「网盘文件 id」写进基线的 pan_file_id。
           * 那个字段决定「清理同集旧版本」的归属校验能不能生效（拿不到就等于不敢删）。
           */
          const landedIds = new Map<string, string>();
          const cn = await cleanTransferredFiles(sharePan, cred, t.usedDir, chunk, sub.clean_mode, {
            savedFids: t.result.savedFids,
            // 目录快照是按 dir 列的；回退到默认目录时体积对不上，不能拿来判「同集已有别的版本」
            dirSizes: t.usedDir === targetDirId ? dirSizesBefore : undefined,
            recordIdsFor: landedIds,
          });
          if (cn) notes.push(cn);
          // 组装「本次每个文件对应的网盘 id」：接口给的优先，改名时找到的补齐
          const idsByName = new Map<string, string>();
          if (t.result.savedFids?.length) {
            chunk.forEach((f, i) => {
              const id = t.result.savedFids![i];
              if (id) idsByName.set(f.name, String(id));
            });
          }
          for (const [nm, id] of landedIds) if (!idsByName.has(nm)) idsByName.set(nm, id);
          const ids = chunk.map((f) => idsByName.get(f.name) ?? "");
          await recordTransferred(entryKey, chunk, ids.some(Boolean) ? ids : undefined);
          // 清洗完再清旧版本：本次是「同一集的新版本」，把目录里同集但体积不同的旧条目删掉。
          // 不做这一步的话，分享方更新源文件后旧版会一直留着，同一集堆到 3~4 个文件；
          // 而且手动删掉旧版后下一轮还会被当成「缺失」重新转回来（等于删不掉）。
          // 「转存新版后自动删除旧版」已停用：它会删掉用户网盘里的文件，风险不可接受，
          // 用户明确要求停掉。函数本体保留（cleanupStaleVersions），需要时把下面这行
          // 的 STALE_VERSION_CLEANUP_ENABLED 改成 true 即可恢复。
          if (STALE_VERSION_CLEANUP_ENABLED) {
            const sv = await cleanupStaleVersions(
              sharePan,
              cred,
              t.usedDir ?? targetDirId,
              chunk,
              sub.clean_mode,
              t.result.savedFids,
              t.usedDir === targetDirId ? dirSizesBefore : undefined,
              ownedFileIds,
              origNameByFileId
            );
            if (sv) notes.push(sv);
          }
        } else {
          failedChunks++;
          notes.push(`第 ${Math.floor(i / CHUNK_SIZE) + 1} 批（${chunk.length} 个）转存失败：${t.result.message}`);
        }
      }
      return { ok: failedChunks === 0, transferredChunks, failedChunks, notes, usedDir };
    };

    // ── 文件夹模式（光鸭 / 夸克，需订阅勾选 folder_mode）──
    //   勾选后：把条目对应的「整个文件夹」按 folder id 整体转存（保留子目录结构），
    //   再把顺带进来的 图片/文本/文档 递归删掉（站点接口没有「只转视频」的参数，只能转完再删）。
    //   差集判定仍按文件名（由调用方的 pendingFiles 决定是否触发），这里只负责「怎么转」。
    //   若整目录没落地（站点不接受目录 id）→ 自动回退成逐文件转存，不影响订阅正常运转。
    // 文件夹模式：光鸭 / 夸克 / 百度 / UC / 123云盘
    //  · 夸克（实测分享 b24dfd9437e4）：按目录整存会保留子目录，目标目录根下不产生平铺副本
    //  · 百度：/share/transfer 的 fsidlist 直接给目录 fs_id 即可整目录转存（同样保留子目录）
    //  · 123云盘：转存接口 fileList 元素的 type=1 即目录，整目录转存同样保留子目录（2026-10-18 实测）
    const FOLDER_MODE_PANS = new Set(["guangya", "quark", "baidu", "uc", "p123"]);
    const folderMode = sub.folder_mode === true && FOLDER_MODE_PANS.has(sharePan);

    /** 文件夹模式：条目 key → 「目录自身」的转存标记（夸克按目录整存要用；光鸭走原逻辑） */
    const dirMarkerByKey = new Map<string, ShareFile>();
    for (const en of entries) {
      if (en.dirMarker) dirMarkerByKey.set(en.key, en.dirMarker);
    }

    /** 递归列出自己网盘某目录下的文件（带上所属目录 id 与体积，供文件夹模式清理与清洗用） */
    const listOwnFilesDeep = async (
      folderId: string, depth = 0
    ): Promise<Array<{ id: string; name: string; dirId: string; size: number }>> => {
      // 深度上限：文件夹模式下整目录转存可能嵌套较深（剧/季/子目录…）。
      // 原来 3 层：更深处文件「看不见」→ 会被当成缺失而重复转存、也会漏清理。放宽到 6 层。
      if (!folderId || depth > 6) return [];
      const out: Array<{ id: string; name: string; dirId: string; size: number }> = [];

      // 123 云盘：目录用 FileId 标识，列目录返回 id/name/size/isDir，直接递归
      if (sharePan === "p123") {
        let pItems: Array<{ id: string; name: string; size: number; isDir: boolean }>;
        try {
          pItems = await p123ListEntries(cred.token ?? "", folderId);
        } catch {
          return [];
        }
        for (const it of pItems) {
          if (it.isDir) out.push(...(await listOwnFilesDeep(it.id, depth + 1)));
          else out.push({ id: it.id, name: it.name, dirId: folderId, size: it.size || 0 });
        }
        return out;
      }

      // 夸克 / UC：同架构，用带 fid 的列目录递归（quarkListFiles 只给名字+体积，清洗/清理要用 id）
      if (sharePan === "quark" || sharePan === "uc") {
        let qItems: Array<{ id: string; name: string; size: number; isDir: boolean }> = [];
        try {
          qItems = await quarkListEntriesWithIds(cred.cookie ?? "", folderId, cdOf(sharePan));
        } catch {
          return [];
        }
        for (const it of qItems) {
          if (it.isDir) out.push(...(await listOwnFilesDeep(it.id, depth + 1)));
          else out.push({ id: it.id, name: it.name, dirId: folderId, size: it.size });
        }
        return out;
      }

      // 百度：目录的「id」就是绝对路径，一次列目录就能拿到 id/name/path，递归进入子目录即可
      if (sharePan === "baidu") {
        let bItems: BaiduEntry[] = [];
        try {
          bItems = await baiduListOwnDir(cred, folderId);
        } catch {
          return [];
        }
        for (const it of bItems) {
          if (it.isDir) {
            const child = it.path || (folderId === "/" ? `/${it.name}` : `${folderId}/${it.name}`);
            out.push(...(await listOwnFilesDeep(child, depth + 1)));
          } else {
            out.push({ id: it.id, name: it.name, dirId: folderId, size: it.size || 0 });
          }
        }
        return out;
      }

      // 光鸭：文件夹与文件要分两次列（files:true 只返回文件）
      let gItems: Array<Record<string, unknown>> = [];
      try {
        // 关键：gyListFolder 的 files:true 只返回文件（resType=1），不返回文件夹；
        // 不带 files 时才返回文件夹（resType=2）。两边都要列，并显式打上 resType 兜底。
        const dirsOnly = await gyListFolder(cred, folderId, { maxPages: 100, refresh: true });
        const filesOnly = await gyListFolder(cred, folderId, { files: true, maxPages: 100, refresh: true });
        gItems = [
          ...dirsOnly.map((x) => ({ ...x, resType: 2 })),
          ...filesOnly.map((x) => ({ ...x, resType: 1 })),
        ];
      } catch {
        return [];
      }
      for (const it of gItems) {
        const id = String(it.fileId ?? "");
        const name = String(it.fileName ?? "");
        if (!id) continue;
        if (Number(it.resType ?? 1) === 2) {
          out.push(...(await listOwnFilesDeep(id, depth + 1)));
        } else {
          out.push({ id, name, dirId: folderId, size: Number(it.fileSize ?? 0) || 0 });
        }
      }
      return out;
    };

    const transferWholeFolder = async (
      entryKey: string,
      title: string,
      fallbackFiles: ShareFile[]
    ): Promise<{ ok: boolean; transferredChunks: number; failedChunks: number; notes: string[]; usedDir: string | null }> => {
      const notes: string[] = [];
      // 夸克：必须用「该目录自身的 fid + share_fid_token」整存（实测保留子目录、不产生平铺副本）。
      // 正常由列目录时带回来；取不到时**现场重开分享按 fid 再取一次**，
      // 避免某次列表差异就让整个条目失败（上一版实测正是栽在这里）。
      let marker: ShareFile | null = dirMarkerByKey.get(entryKey) ?? null;
      if (!marker && (sharePan === "quark" || sharePan === "uc")) {
        try {
          const sess = await quarkOpenShare(cred.cookie ?? "", sub.source_url, sub.source_passcode, cdOf(sharePan));
          if (!("error" in sess)) {
            const top = await quarkListDir(sess, "0");
            const hit =
              top.find((x) => String(x.fid ?? "") === entryKey) ??
              top.find((x) => x.dir === true && String(x.file_name ?? "").trim() === title.trim());
            if (hit) {
              marker = {
                id: String(hit.fid ?? entryKey),
                name: String(hit.file_name ?? title),
                token: (hit.share_fid_token as string) ?? null,
                stoken: sess.stoken,
              };
            }
          }
        } catch { /* 兜底失败 → 走下面的回退 */ }
      }
      // 123 云盘：目录标记取不到就现场重开分享按 FileId 再取一次（与夸克同思路）
      if (!marker && sharePan === "p123") {
        try {
          const sess = p123ShareCtx(sub.source_url);
          if (sess.shareKey) {
            const session: P123ShareSession = {
              base: sess.base,
              shareKey: sess.shareKey,
              pwd: (sub.source_passcode ?? "").trim() || pwdFromUrl(sub.source_url),
              token: cred.token ?? "",
            };
            const top = await p123ListShare(session, "0");
            const hit =
              top.find((x) => String(x.FileId) === entryKey) ??
              top.find((x) => Number(x.Type) === 1 && String(x.FileName ?? "").trim() === title.trim());
            if (hit) {
              marker = {
                id: String(hit.FileId),
                name: String(hit.FileName ?? title),
                size: Number(hit.Size ?? 0),
                isDir: true,
              };
            }
          }
        } catch { /* 兜底失败 → 走下面的回退 */ }
      }
      // 夸克 / UC 缺 token 必然被拒（save 要 fid_token_list）→ 直接回退逐文件，不让整条订阅白记一个失败
      if ((sharePan === "quark" || sharePan === "uc") && !marker?.token) {
        notes.push("取不到该文件夹的转存 token，已回退为逐文件转存");
        const fb = await transferAndClean(entryKey, fallbackFiles);
        return { ...fb, notes: [...notes, ...fb.notes] };
      }
      const useMarker: ShareFile = marker ?? { id: entryKey, name: title };
      const t = await transferInto(sharePan, cred, sub.source_url, sub.source_passcode, [useMarker], dir);
      const usedDir = t.usedDir ?? dir;
      if (!t.result.ok) {
        // 整目录失败（站点不接受目录 / 分享结构变化）→ 回退逐文件，保证订阅照常运转
        notes.push(`整目录转存失败：${t.result.message}，已回退为逐文件转存`);
        const fb = await transferAndClean(entryKey, fallbackFiles);
        return { ...fb, notes: [...notes, ...fb.notes] };
      }
      await recordTransferred(entryKey, [useMarker]);

      // 转存后落到 usedDir 下的同名文件夹 → 递归清掉里面的 图片/文本/文档
      // 注意：整目录转存是【异步任务】，restore_share 只返回 taskId；目录要过几秒才出现。
      // 以前只列一次，目录还没落地就判「未落地」→ 回退成逐文件转存 → 结果**同一份内容转了两遍**
      // （用户看到的「双份文件」/`xxx(1)` 重复文件夹就是这么来的）。这里必须轮询等待落地。
      let children: Array<Record<string, unknown>> = [];
      const wantName = title.trim();
      let root: Record<string, unknown> | undefined;
      for (let i = 0; i < 6; i++) {
        if (i > 0) await wait(3000);
        try {
          // 列出目标目录下的文件夹，找「刚落地的那个同名文件夹」（按网盘分派）
          children = sharePan === "p123"
            ? (await p123ListDirs(cred.token ?? "", usedDir || "0")).map((d) => ({
                fileId: d.id,
                fileName: d.name,
                resType: 2,
              }))
            : sharePan === "quark" || sharePan === "uc"
              ? (await quarkListDirs(cred.cookie ?? "", usedDir ?? "", cdOf(sharePan))).map((d) => ({
                  fileId: d.id,
                  fileName: d.name,
                  resType: 2,
                }))
            : sharePan === "baidu"
              ? (await baiduListOwnDir(cred, usedDir || "/"))
                  .filter((d) => d.isDir)
                  .map((d) => ({
                    // 百度的目录 id 就是绝对路径（listOwnFilesDeep 也按路径递归）
                    fileId: d.path || `/${d.name}`,
                    fileName: d.name,
                    resType: 2,
                  }))
              : await gyListFolder(cred, usedDir ?? "", { maxPages: 20, refresh: true });
        } catch { continue; }
        root = children.find(
          (x) => Number(x.resType ?? 1) === 2 && String(x.fileName ?? "").trim() === wantName
        );
        if (root) break;
      }
      const landed = root ? await listOwnFilesDeep(String(root.fileId ?? "")) : [];
      if (landed.length === 0) {
        // 整目录没落地 → 站点可能不接受「目录 id」：回退为逐文件转存
        notes.push("站点未接受整目录转存（该文件夹没有落地），已回退为逐文件转存");
        const fb = await transferAndClean(entryKey, fallbackFiles);
        return { ...fb, notes: [...notes, ...fb.notes] };
      }
      const junk = landed.filter((f) => isNonContentFile(f.name));
      let removed = 0;
      if (junk.length > 0) {
        try {
          if (sharePan === "quark" || sharePan === "uc") {
            // 夸克 / UC：删除到回收站（可恢复）。以前这里硬编码光鸭接口，夸克每次都会失败
            removed = await quarkDeleteFiles(cred.cookie ?? "", junk.map((f) => f.id), cdOf(sharePan));
          } else if (sharePan === "p123") {
            // 123：file/trash + operation=2（移入回收站，实测传 1 是假成功）
            removed = await p123DeleteFiles(cred.token ?? "", junk.map((f) => f.id));
          } else if (sharePan === "baidu") {
            // 百度：Web 端删除（进回收站），接口按绝对路径删，用「所属目录 + 文件名」拼出路径
            const paths = junk.map((f) => (f.dirId === "/" ? `/${f.name}` : `${f.dirId}/${f.name}`));
            removed = await baiduDeleteByPath(cred, paths);
          } else {
            removed = await gyDeleteFiles(cred, junk.map((f) => f.id));
          }
        } catch (e) {
          notes.push(`清理文档/图片失败：${(e as Error).message}`);
        }
      }

      // 光鸭「整目录转存」会把文件夹里的文件**同时在目标目录根下平铺一份** →
      // 这里把目标目录根下的这些重复副本删掉（只在「文件名 + 体积」双命中、且不是文件夹内那份时才删，
      // 绝不碰用户自己的同名同体积文件之外的任何东西）。
      // 光鸭「整目录转存」会把文件在目标目录根下平铺一份 → 需要删掉副本；
      // 夸克实测**不会平铺**，所以这段只对光鸭执行（否则会对夸克误调光鸭接口）。
      let flatRemoved = 0;
      if (sharePan === "guangya") try {
        const rootList = await gyListFolder(cred, usedDir ?? "", { files: true, maxPages: 20, refresh: true });
        // 文件夹内那份是分享原名、根下那份可能已被清洗 → 按「体积」比对（拿不到体积时退回同名）
        const dupKey = (name: string, size: number): string => (size > 0 ? `s:${size}` : `n:${name}`);
        const inFolder = new Map(landed.map((f) => [dupKey(f.name, f.size), f.id]));
        const dupes = rootList
          .filter((x) => Number(x.resType ?? 1) !== 2)
          .map((x) => ({
            id: String(x.fileId ?? ""),
            key: dupKey(String(x.fileName ?? ""), Number(x.fileSize ?? 0) || 0),
          }))
          .filter((x) => x.id && inFolder.has(x.key) && inFolder.get(x.key) !== x.id);
        if (dupes.length > 0) {
          flatRemoved = await gyDeleteFiles(cred, dupes.map((d) => d.id));
        }
      } catch { /* 清理平铺副本失败不影响转存结果 */ }
      // 仅清洗（不高码）：按落地目录分组，逐目录把文件名清洗为 SxxExx（沿用订阅的 clean_mode）
      const survived = landed.filter((f) => !isNonContentFile(f.name));
      let cleanedDirs = 0;
      if (survived.length > 0) {
        const byDir = new Map<string, ShareFile[]>();
        for (const f of survived) {
          const arr = byDir.get(f.dirId) ?? [];
          arr.push({ id: f.id, name: f.name, size: f.size });
          byDir.set(f.dirId, arr);
        }
        for (const [dirId, files] of byDir) {
          try {
            const cn = await cleanTransferredFiles(sharePan, cred, dirId, files, sub.clean_mode, {
              tries: 2,
              plainOnly: true,
            });
            if (cn) cleanedDirs++;
          } catch { /* 单个目录清洗失败忽略 */ }
        }
      }
      notes.push(
        `整目录转存：落地 ${landed.length} 个文件`
        + `${removed > 0 ? `，已清理 ${removed} 个文档/图片` : ""}`
        + `${flatRemoved > 0 ? `，已删除 ${flatRemoved} 个平铺重复副本` : ""}`
        + `${cleanedDirs > 0 ? `，已清洗 ${cleanedDirs} 个目录（仅清洗、不加高码）` : ""}`
      );
      return { ok: true, transferredChunks: 1, failedChunks: 0, notes, usedDir };
    };

    // ── 文件夹模式的「已转存」判定（双份文件问题的根因修复）──
    // 整目录转存是把内容放进**同名子文件夹**里，而差集判定一直只看「目标目录根下」的文件名，
    // 于是这类文件在判定里永远「不存在」→ 每轮都重新整目录转存一次 →
    // 站点上就多出 `剧名 (1)` 这样的重复文件夹（用户看到的「双份文件」）。
    // 修复：目标目录里已有同名文件夹 → 该条目视为已落地，只补「该文件夹内部缺的」文件。
    const entryFolderCache = new Map<string, { id: string; name: string } | null>();
    /**
     * 目标目录里是否已有该条目的同名文件夹。
     * 【读不到 ≠ 没有】以前这里 catch 掉异常当作「未落地」，于是一次列目录抖动就会
     * 整目录重转，网盘上多出 `剧名 (1)` 重复文件夹；现在读不到就抛错，由调用方放弃本轮，
     * 宁可漏转（下一轮会补）也不制造重复。
     */
    const entryFolderOf = async (title: string): Promise<{ id: string; name: string } | null> => {
      const key = title.trim();
      if (entryFolderCache.has(key)) return entryFolderCache.get(key)!;
      let found: { id: string; name: string } | null = null;
      // 按网盘分派：夸克用 quarkListDirs（直接给 id+name），光鸭用 gyListFolder，
      // 123 云盘走 p123ListDirs —— 以前 123 漏了分支会 fallthrough 去调光鸭接口，必然读不到。
      const dirs = sharePan === "quark" || sharePan === "uc"
        ? await quarkListDirs(cred.cookie ?? "", dir ?? "", cdOf(sharePan))
        : sharePan === "baidu"
          ? (await baiduListOwnDir(cred, dir || "/"))
              .filter((d) => d.isDir)
              .map((d) => ({ id: d.path || `/${d.name}`, name: d.name }))
          : sharePan === "p123"
            ? await p123ListDirs(cred.token ?? "", dir ?? "0")
            : (await gyListFolder(cred, dir ?? "", { maxPages: 200, refresh: true, strict: true }))
                .filter((d) => Number(d.resType ?? 2) === 2)
                .map((d) => ({ id: String(d.fileId ?? ""), name: gyFieldName(d) }));
      const hit = dirs.find((d) => d.name.trim() === key);
      if (hit) found = { id: hit.id, name: key };
      entryFolderCache.set(key, found);
      return found;
    };

    /** 列出某文件夹内部的文件，做成与目标目录同构的快照（判断「这一集在文件夹里了吗」） */
    const folderSnapshot = async (folderId: string): Promise<DirSnapshot | null> => {
      try {
        const files = await listOwnFilesDeep(folderId);
        const names = new Set<string>();
        const sizes = new Map<string, number>();
        const sizeSet = new Set<number>();
        for (const f of files) {
          names.add(f.name);
          if (f.size) { sizes.set(f.name, f.size); sizeSet.add(f.size); }
        }
        return { known: true, names, sizes, sizeSet, strays: [] };
      } catch { return null; }
    };

    /** 目标目录里同名的「重复文件夹」（`剧名 (1)` 这类历史遗留），仅用于提示用户清理 */
    const dupFoldersOf = async (title: string): Promise<string[]> => {
      try {
        const t = title.trim();
        const names = sharePan === "quark" || sharePan === "uc"
          ? (await quarkListDirs(cred.cookie ?? "", dir ?? "", cdOf(sharePan))).map((d) => d.name.trim())
          : sharePan === "baidu"
            ? (await baiduListOwnDir(cred, dir || "/"))
                .filter((d) => d.isDir)
                .map((d) => d.name.trim())
            : sharePan === "p123"
              ? (await p123ListDirs(cred.token ?? "", dir ?? "0")).map((d) => d.name.trim())
              : (await gyListFolder(cred, dir ?? "", { maxPages: 20, refresh: true }))
                  .filter((d) => Number(d.resType ?? 2) === 2)
                  .map((d) => gyFieldName(d).trim());
        return names.filter((n) => /\(\d+\)$/.test(n) && n.replace(/\(\d+\)$/, "").trim() === t);
      } catch { return []; }
    };

    /**
     * 该条目要写哪些文件、写到哪：
     *   · 文件夹模式 + 目标目录已有同名文件夹 → 只补「文件夹内部还没有的」文件，写入该文件夹内部
     *   · 其它情况 → 沿用原有逻辑（into = null 表示写订阅配置的目标目录）
     *
     * 文件夹模式下「读不到目标目录」时必须放弃本条目（files=null），绝不能落到下面的
     * 逐文件差集或整目录转存：那些文件其实躺在同名子文件夹里，根目录差集一定判为「缺失」，
     * 一次误判就会在网盘上多出一份重复内容 + 一个 `剧名 (1)` 文件夹。
     */
    const pendingForEntry = async (
      entry: ShareEntry
    ): Promise<{ files: ShareFile[] | null; into: string | null; reusedFolder: boolean }> => {
      if (folderMode) {
        let fo: { id: string; name: string } | null = null;
        try {
          fo = await entryFolderOf(entry.title);
        } catch (e) {
          dirUnreadable = true;
          dirError = dirError ?? `读不到目标目录里的文件夹列表：${(e as Error).message}`;
          return { files: null, into: null, reusedFolder: false };
        }
        if (fo) {
          const snapInside = await folderSnapshot(fo.id);
          if (snapInside) {
            return {
              files: entry.files.filter((f) => !presentInDir(f, snapInside)),
              into: fo.id,
              reusedFolder: true,
            };
          }
          // 文件夹在、但读不出它内部（列目录失败）→ 同样不能当成「文件夹里什么都没有」
          dirUnreadable = true;
          dirError = dirError ?? `读不到目标目录里「${entry.title}」文件夹的内容，已跳过本条目以免重复转存`;
          return { files: null, into: null, reusedFolder: false };
        }
      }
      return { files: await pendingFiles(entry.key, entry.files), into: null, reusedFolder: false };
    };

    for (const entry of entries) {
      if (!matchKeyword(entry.title, sub.keyword)) continue;

      const cand: Candidate = {
        title: entry.title,
        shareUrl: sub.source_url,
        sharePasscode: null,
        pan: sharePan,
        sourceUrl: sub.source_url,
        fingerprintKey: `${normalizeShareUrl(sub.source_url)}#${entry.key}`,
      };
      const fingerprint = fingerprintOf(cand);
      const fileCount = entry.files.length;

      const { data: item } = await svc
        .from("subscription_items")
        .select("id, resource_id, status")
        .eq("subscription_id", sub.id)
        .eq("fingerprint", fingerprint)
        .maybeSingle<{ id: string; resource_id: string | null; status: string }>();

      const title = entry.title || sub.name || "未命名资源";
      const itemBase = {
        subscription_id: sub.id,
        user_id: sub.user_id,
        title: title.slice(0, 200),
        source_url: sub.source_url,
        share_url: sub.source_url,
        share_passcode: sub.source_passcode ?? null,
        pan: sharePan,
        fingerprint,
        transfer_url: sub.source_url,
      };
      const saveItem = async (payload: Record<string, unknown>): Promise<void> => {
        if (item?.id) await svc.from("subscription_items").update(payload).eq("id", item.id);
        else await svc.from("subscription_items").insert({ ...itemBase, ...payload });
      };

      // ── 已绑定资源（条目之前匹配到的，或订阅里手动选的）：检测新增文件 / 更新集数 / 完结状态 ──
      const targetResId = sub.resource_id ?? item?.resource_id ?? null;
      if (targetResId) {
        const { data: res } = await svc
          .from("resources")
          .select("id, name, episode_count, is_finished")
          .eq("id", targetResId)
          .maybeSingle<{ id: string; name: string; episode_count: number | null; is_finished: boolean | null }>();
        if (!res) continue;

        const notes: string[] = [];
        const oldCount = res.episode_count ?? 0;

        // 需要补转存的文件：目标目录里还没有的那些（文件夹模式按「同名文件夹内部」比较）
        const pfBound = await pendingForEntry(entry);
        const known = pfBound.files;
        // 不能比对（列目录失败）时退回旧规则：只在文件数变多时把整份转一次
        const pending = known ?? (fileCount > oldCount ? entry.files.filter((f) => !baseKeys.has(transferKey(entry.key, f))) : []);
        // 读不到目标目录必须说清楚：否则「没同步」会被显示成「无变化」，用户查不出问题
        if (known === null) {
          notes.push(
            `读不到目标目录（${dirError ?? "未知原因"}）：该目录可能已被删除/移出，或网盘授权失效；请在订阅里重新选择转存目录后重跑`
          );
        }
        // 集数 = 该条目里「最大的集号」，不是文件数量：同一集常同时有 1080p/4K 两个版本，
        // 文件数会翻倍（6 个文件其实只有 3 集）。解析不出集号时才退回按文件数。
        // 多季分享（同一批文件里出现 S01/S02/S03…）按【最大季】取，见 maxEpisodeInfoOf。
        const epInfo = maxEpisodeInfoOf(entry.files);
        const epMax = epInfo.episode;
        const targetCount = epMax || fileCount;
        if (pending.length > 0) {
          // 文件夹模式：没落地过就整目录转存（保留子目录），已落地则只补文件夹内部缺的文件
          const tc = folderMode && !pfBound.reusedFolder
            ? await transferWholeFolder(entry.key, entry.title, pending)
            : await transferAndClean(entry.key, pending, pfBound.into);
          if (tc.ok) {
            stats.transferred++;
            if (tc.notes.length) notes.push(tc.notes.join("；"));
            if (await applyEpisodeCount(sub, res, oldCount, targetCount)) {
              stats.updated++;
              notes.push(`集数 ${oldCount} → ${targetCount}（新增 ${pending.length} 个文件已转存${epMax > 0 ? `，最新${episodeLabel(epInfo)}` : ""}）`);
            } else {
              notes.push(`新增 ${pending.length} 个文件已转存（集数仍为 ${targetCount}）`);
            }
            // 让用户知道为什么文件数比分享里少
            if (entry.skippedImages) notes.push(`已跳过 ${entry.skippedImages} 个图片文件`);
          } else {
            stats.failed++;
            notes.push(`有新文件但转存失败：${tc.notes.join("；") || "未知错误"}`);
          }
        } else if (targetCount !== oldCount) {
          // 没有新文件、但集数对不上（例如以前按文件数把它记成了 6，或把多季的最大集取错了）→ 纠正过来
          if (await applyEpisodeCount(sub, res, oldCount, targetCount)) {
            stats.updated++;
            notes.push(
              `集数 ${oldCount} → ${targetCount}（按分享里${epMax > 0 ? `最新${episodeLabel(epInfo)}` : `文件数 ${fileCount}`}对齐；目标目录里已有同名文件，未重复转存）`
            );
          }
        } else {
          // 文件齐全、集数也对得上：这一轮确实没事可做，但要记一笔，
          // 否则「什么都没做」会被判成 failed，订阅状态一直显示失败
          stats.skipped++;
        }

        // 需求①：订阅设了「全集数」且已同步到全集 → 判定完结（优先于标题关键词判定）
        const finishedByTotal = await finishSubscriptionIfComplete(sub, res, targetCount);

        if (!res.is_finished && !finishedByTotal && looksFinished(entry.title)) {
          await svc.from("resources").update({ is_finished: true }).eq("id", res.id);
          await insertChange({
            resource_id: res.id,
            resource_name: res.name,
            field_name: "is_finished",
            field_label: "完结状态",
            old_value: "否",
            new_value: "是",
            user_id: sub.user_id,
          });
          stats.updated++;
          notes.push("条目名已完结，自动标记为已完结");
        }

        if (notes.length > 0) {
          // 必须用 saveItem：订阅里手动绑定资源时，这条条目可能是第一次见（item 还不存在），
          // 直接 update ...eq("id", item.id) 会因为 item 为空而报错。
          await saveItem({ status: "imported", resource_id: res.id, error: notes.join("；") });
          stats.imported++;
        }
        continue;
      }

      // ── 新条目 / 已转存过的条目：只补转存「目标目录里还没有的」文件 ──
      // 以前只要条目已存在（transferred/skipped）就整个跳过转存，于是分享里后来新增的文件
      // 永远检测不到；现在按目标目录里的实际文件名算差集：新增的补转存，已转过的不会重复转。
      const prevDone = !!item?.id && (item.status === "skipped" || item.status === "transferred");
      const pfNew = await pendingForEntry(entry);
      const pending = pfNew.files;
      // pending=null（列目录失败）时退回旧行为：首次转整份，之后不再重复转；
      // 无论哪条分支都再经一道基线过滤，确保已转过的文件不会被重复转存。
      const toTransfer = pending ?? (prevDone ? [] : entry.files.filter((f) => !baseKeys.has(transferKey(entry.key, f))));
      // 文件夹模式：已落地过同名文件夹 → 只补文件夹内部缺的文件（写入该文件夹内），
      // 绝不再整目录转存一次（那会在站点上多出 `剧名 (1)` 重复文件夹）。
      const tc = toTransfer.length
        ? (folderMode && !pfNew.reusedFolder
            ? await transferWholeFolder(entry.key, entry.title, toTransfer)
            : await transferAndClean(entry.key, toTransfer, pfNew.into))
        : null;
      const r: TransferResult = tc
        ? { ok: tc.ok, message: tc.ok ? "" : tc.notes.join("；") }
        : { ok: true, message: "" };
      if (r.ok && toTransfer.length) {
        stats.transferred++;
      }
      let dupNote = "";
      if (pfNew.reusedFolder && toTransfer.length === 0) {
        const dupes = await dupFoldersOf(entry.title);
        if (dupes.length > 0) {
          dupNote = `检测到重复文件夹（历史重复转存遗留）：${dupes.join("、")}，可手动删除`;
        }
      }
      const cleanNote = [tc ? tc.notes.join("；") : "", dupNote].filter(Boolean).join("；");
      const newNote = !r.ok
        ? ""
        : toTransfer.length
          ? (prevDone ? `新增 ${toTransfer.length} 个文件已转存` : "")
          : pending === null
            // 列目录失败时不能谎报「无新增」，否则用户会以为分享里没加东西
            ? `读不到目标目录（${dirError ?? "未知原因"}），本轮未检测新增文件：该目录可能已被删除/移出，或网盘授权失效`
            : (prevDone ? "本轮无新增文件" : "");
      const imageNote = entry.skippedImages ? `已跳过 ${entry.skippedImages} 个图片文件` : "";
      const noteText = r.ok ? [newNote, cleanNote, imageNote].filter(Boolean).join("；") : r.message;

      if (!sub.auto_publish) {
        // 文件已经转存进目标目录了，只是没开「绑定资源管理」所以不做联动。
        // 以前这里记成 skipped（已跳过），用户会以为什么都没做；转存失败才是真失败。
        const statusNow = r.ok ? "transferred" : "failed";
        // 只有这一轮真做了事（首次入库 / 补转存了新文件 / 失败 / 状态需要纠正）才写记录。
        // 否则每分钟都会把上一次的有效说明覆盖掉，用户就看不到「新增 N 个文件已转存」了。
        const didWork = !r.ok || !prevDone || toTransfer.length > 0 || item?.status !== statusNow;
        if (didWork) {
          await saveItem({
            status: statusNow,
            error: r.ok
              ? `已转存到目标目录（未开启「绑定资源管理中的资源」，未做联动）${noteText ? `；${noteText}` : ""}`
              : `转存失败：${r.message}`,
          });
        }
        if (r.ok) stats.skipped++;
        else stats.failed++;
        continue;
      }

      const matched = await bindTransferToResource(sub, resourceIndex, title, sub.source_url, fileCount, panLabel);
      if (!matched) {
        await saveItem({
          status: "skipped",
          error: `资源管理里没有匹配「${title.slice(0, 40)}」的资源，未新建（按设置只做联动）${noteText ? `；${noteText}` : ""}`,
        });
        stats.skipped++;
        continue;
      }

      await saveItem({
        status: "imported",
        resource_id: matched.id,
        error: `已联动资源「${matched.name}」（分享目录 ${fileCount} 个文件）${noteText ? `；${noteText}` : ""}`,
      });
      stats.imported++;
    }

    // ── 补清洗：把「已在目标目录、但仍保留原始文件名」的文件补做一次清洗 ──
    // 清洗原本只在「刚转存完」那一刻做；异步落地慢 / 当轮未按原名找到的文件会被永久漏掉，
    // 用户看到的就是个别几集没改成名（如 S01E189-Gyy.mp4 一直没变成 S01E189.mp4）。
    // 这里每轮用【网盘实时文件名】兜底（不依赖本轮内存集合——它会被乐观写入掩盖失败）：
    // 仍在原始名的就补改成清洗名。幂等：已改过名的按原始名找不到，不会被重复改名。
    let staleCleaned = 0;
    let gaomaTagged = 0;
    let gaomaFailed = 0;
    let gaomaErr = "";
    /** 本轮把「网盘内部名条目」改回正确名字的数量 */
    let strayFixed = 0;
    /** 本轮删掉的「同内容重复副本」数量（我们自己重复转存产生的乱名副本） */
    let strayRemoved = 0;
    /** 认得出是重复副本、但不敢/没能删掉的数量（写在备注里，交给用户手动清理） */
    let strayDup = 0;
    /** 清理重复副本时的错误（下次再试） */
    let strayErr = "";
    {
      let realFiles: Array<{ id: string; name: string; size: number; gcid: string }> | null = null;
      try {
        const l = await gyListFolder(cred, dir ?? "", { files: true, maxPages: 100, refresh: true });
        realFiles = l
          .map((x) => ({
            id: String(x.fileId ?? ""),
            name: String(x.fileName ?? ""),
            size: Number(x.fileSize ?? 0) || 0,
            gcid: String(x.gcid ?? ""),
          }))
          .filter((x) => x.name);
      } catch {
        realFiles = null; // 列目录失败 → 本轮不补清洗，绝不误改名
      }
      if (realFiles) {
        const namesNow = new Set(realFiles.map((x) => x.name));
        const sizesNow = new Map<string, number>();
        for (const x of realFiles) if (x.size) sizesNow.set(x.name, x.size);
        // 本次分享里出现过的集号：只对这些集号补「高码」标记，绝不动用户自己整理的文件
        const shareBases = new Set<string>();
        for (const entry of entries) {
          if (!matchKeyword(entry.title, sub.keyword)) continue;
          for (const f of entry.files) {
            const cleaned = cleanFileFullName(f.name, sub.clean_mode);
            if (!cleaned || cleaned === f.name) continue;
            const base = stripExt(cleaned);
            if (/^S\d+E\d+$/i.test(base)) shareBases.add(base);
          }
        }
        for (const entry of entries) {
          if (!matchKeyword(entry.title, sub.keyword)) continue;
          // 仍在原始名、且按「实际改名规则」算得出新名的，就是要补清洗的
          const stale: ShareFile[] = [];
          for (const f of entry.files) {
            if (!namesNow.has(f.name)) continue; // 原始名不在目标目录 → 没转存 / 已改过名
            const wanted = planCleanedNames([f], sub.clean_mode, sizesNow).get(f.name);
            if (!wanted) continue;
            const dirSize = sizesNow.get(wanted);
            if (dirSize && f.size && dirSize === f.size) continue; // 目标名已被同一个文件占着
            stale.push(f);
          }
          if (stale.length === 0) continue;
          // 同集已有别的版本时，新名会是「高码」名（与实际改名用同一套规则）
          const plan = planCleanedNames(stale, sub.clean_mode, sizesNow);
          if (plan.size === 0) continue;
          // tries=2：文件本就在目录里，实时列一两次即可，无需长轮询等待落地
          const cn = await cleanTransferredFiles(sharePan, cred, dir, stale, sub.clean_mode, {
            tries: 2,
            dirSizes: sizesNow,
          });
          if (cn.startsWith("已清洗")) {
            staleCleaned += stale.length;
            for (const nm of plan.values()) namesNow.add(nm);
          }
        }

        // ── 内部名条目归位：光鸭转存后可能先落一个「内部名」条目（一长串字母数字、没有扩展名），
        //    名字对不上任何分享文件，但内容就是某一集。按「体积唯一」认出它属于哪一集，
        //    改回正确名字（带扩展名、必要时带「高码」）。
        //    不做这一步的后果：用户目录里一直躺着一堆乱名文件，而且因为名字对不上，
        //    下一轮还会被当成「缺这一集」反复重转 → 越转越多（这就是截图里那种垃圾文件的来源）。
        //    同内容的正式文件已经在目录里（真重复副本）→ 直接删掉这份多余的（只在
        //    「同 gcid / 同体积且目录里已有正常命名的同一份」时才删，绝不碰正常文件）；
        //    判定不出来的一律不动，只统计出来写在订阅备注里。
        if (sharePan === "guangya") {
          const isStrayName = (n: string) => !/\.[A-Za-z0-9]{2,5}$/.test(n);
          /** 该分享文件在目录里是否已有「正式命名」的对应文件（按名字+体积，不含内部名兜底） */
          const hasProperName = (f: ShareFile): boolean => {
            const cands = new Set<string>([f.name]);
            const cleaned = cleanFileFullName(f.name, sub.clean_mode);
            if (cleaned && cleaned !== f.name) {
              cands.add(cleaned);
              cands.add(tagBeforeExt(cleaned, "高码"));
            }
            for (const c of cands) {
              if (!namesNow.has(c)) continue;
              const sz = sizesNow.get(c);
              if (sz && f.size && sz !== f.size) continue; // 同名不同体积 → 别的版本
              return true;
            }
            return false;
          };
          // 体积唯一 → 期望的最终名字（与实际改名用同一套规则；拿不准就留空）
          const targetBySize = new Map<number, string>();
          for (const entry of entries) {
            if (!matchKeyword(entry.title, sub.keyword)) continue;
            const plan = planCleanedNames(entry.files, sub.clean_mode, sizesNow);
            for (const f of entry.files) {
              const sz = Number(f.size ?? 0) || 0;
              if (!sz || sizeOwners.get(sz) !== f) continue; // 体积不唯一 → 不认
              if (hasProperName(f)) continue;                // 已有正式命名的文件 → 内部名副本属重复
              const planned = plan.get(f.name);
              const cleaned = cleanFileFullName(f.name, sub.clean_mode);
              // 计划里没有、但分享名本身就是最终名（S01E01.mkv）→ 目标名就是它自己；
              // 其余「计划里没有」= 规则判过不改（例如目标名已被同版本占着）→ 不猜
              const target = planned ?? (cleaned && cleaned !== f.name ? "" : f.name);
              if (!target || !/\.[A-Za-z0-9]{2,5}$/.test(target)) continue;
              targetBySize.set(sz, target);
            }
          }
          /**
           * 这个乱名条目是不是「目录里已有正常命名的同一份内容」→ 可以安全删除。
           * 判据：另一个正常命名的文件与它 gcid 相同（最稳）；拿不到 gcid 时退化为
           * 「体积相同、且该体积在本目录里对应一个正常命名的文件」。绝不用名字相似来判。
           */
          const duplicateOf = (x: { name: string; size: number; gcid: string }): boolean => {
            for (const y of realFiles) {
              if (y.name === x.name || isStrayName(y.name) || !y.id) continue;
              if (x.gcid && y.gcid) {
                if (x.gcid === y.gcid) return true;
                continue;
              }
              if (x.size && y.size === x.size) return true;
            }
            return false;
          };
          const dupIds: string[] = [];
          for (const x of realFiles) {
            if (!x.id || !isStrayName(x.name)) continue;
            const target = x.size ? targetBySize.get(x.size) : undefined;
            if (target && !namesNow.has(target)) {
              // 这一集还没有正常命名的文件 → 改名归位
              try {
                await gyRenameFile(cred, x.id, target);
                namesNow.delete(x.name);
                namesNow.add(target);
                if (x.size) sizesNow.set(target, x.size);
                strayFixed++;
              } catch { /* 单个失败忽略，下一轮再试 */ }
              continue;
            }
            // 没有可用目标名 = 同内容的正常命名文件已在目录里 → 这份多余的直接删
            if (duplicateOf(x)) dupIds.push(x.id);
            else strayDup++; // 认不准 → 绝不删，只提示
          }
          if (dupIds.length > 0) {
            try {
              const n = await gyDeleteFiles(cred, dupIds);
              strayRemoved += n;
              for (const x of realFiles) {
                if (dupIds.includes(x.id)) {
                  namesNow.delete(x.name);
                  sizesNow.delete(x.name);
                }
              }
            } catch (e) {
              // 删除接口不可用/失败：退回到「只提示」，下轮再试
              strayDup += dupIds.length;
              if (!strayErr) strayErr = (e as Error).message;
            }
          }
        }

        // ── 同一集多版本却没带「高码」标记 → 给体积最大的那个补上 ──
        // 历史 bug：按「完整文件名（含扩展名）」分组，同一集的 .mkv 与 .mp4 被当成两集，
        // 两个都落成了普通名（S01E01.mkv + S01E01.mp4），看不出哪个是高码版。
        // 幂等：已带「高码」名的一集直接跳过。
        if (shareBases.size > 0) {
          // 上面的补清洗刚改过名，realFiles 已经是旧快照 → 重新列一次，按最新名字判断
          let finalFiles = realFiles;
          if (staleCleaned > 0 || strayFixed > 0) {
            try {
              const l = await gyListFolder(cred, dir ?? "", { files: true, maxPages: 100, refresh: true });
              finalFiles = l
                .map((x) => ({
                  id: String(x.fileId ?? ""),
                  name: String(x.fileName ?? ""),
                  size: Number(x.fileSize ?? 0) || 0,
                  gcid: String(x.gcid ?? ""),
                }))
                .filter((x) => x.name);
            } catch {
              finalFiles = realFiles; // 列不到就用旧快照，至少把已经干净的补上
            }
          }
          const byBase = new Map<string, Array<{ id: string; name: string; size: number }>>();
          for (const x of finalFiles) {
            const base = stripExt(x.name);
            if (!shareBases.has(base)) continue;
            const arr = byBase.get(base);
            if (arr) arr.push(x);
            else byBase.set(base, [x]);
          }
          const finalNames = new Set(finalFiles.map((x) => x.name));
          for (const [base, list] of byBase) {
            if (list.length < 2) continue; // 这一集只有一个文件 → 不用区分
            if ([...finalNames].some((n) => stripExt(n) === `${base}高码`)) continue; // 已有高码版
            if (list.some((x) => !x.id || !x.size)) continue; // 体积/ID 不全 → 不猜
            const biggest = list.reduce((a, b) => (b.size > a.size ? b : a));
            const m = /(\.[A-Za-z0-9]{2,5})$/.exec(biggest.name);
            // 名字没有扩展名（网盘内部名）→ 不猜，否则会造出「S01E11高码」这种怪名字
            if (!m) continue;
            const target = `${base}高码${m[1]}`;
            if (finalNames.has(target)) continue; // 目标名已被占用 → 不动
            try {
              await gyRenameFile(cred, biggest.id, target);
              finalNames.delete(biggest.name);
              finalNames.add(target);
              namesNow.delete(biggest.name);
              namesNow.add(target);
              gaomaTagged++;
            } catch (e) {
              gaomaFailed++;
              if (!gaomaErr) gaomaErr = (e as Error).message;
            }
          }
        }
      }
    }

    // 没开「绑定资源管理」时 imported 恒为 0，但这些运行其实是成功的（文件已转存到目标目录），
    // 不能再拿 imported 判成败，否则状态永远显示「失败」。
    const progressed = stats.transferred + stats.imported + stats.updated + stats.skipped + staleCleaned + gaomaTagged + strayFixed + strayRemoved;
    // 读不到目标目录一律按失败上报：同步根本没做成，不能显示成「无变化」
    const status = dirUnreadable ? "failed" : progressed === 0 ? "failed" : stats.failed > 0 ? "partial" : "ok";
    const msg = `分享目录：${stats.found} 个条目，转存 ${stats.transferred} 次，联动更新 ${stats.imported} 条（其中集数/完结变化 ${stats.updated} 条）${staleCleaned ? `，补清洗 ${staleCleaned} 个文件名` : ""}${strayFixed ? `，修正乱名文件 ${strayFixed} 个` : ""}${strayRemoved ? `，清理重复副本 ${strayRemoved} 个` : ""}${strayDup ? `，重复副本 ${strayDup} 个未清理（${strayErr || "判定不充分"}）` : ""}${gaomaTagged ? `，补「高码」标记 ${gaomaTagged} 个` : ""}${gaomaFailed ? `，补「高码」失败 ${gaomaFailed} 个（${gaomaErr}）` : ""}${stats.skipped ? `，未联动/无变化 ${stats.skipped} 条` : ""}${stats.failed ? `，失败 ${stats.failed} 条` : ""}${dirUnreadable ? `；【需处理】读不到目标目录（${dirError ?? "未知原因"}），本轮同步未生效：该目录可能已被删除/移出，或网盘授权失效，请在订阅里重新选择转存目录` : ""}`;
    return await finish(status, msg);
  }

  /**
   * 重新绑定网盘凭证成功后，把该用户在这个网盘上「因凭证失效被停掉」的订阅重新启用。
   *
   * 为什么必须在这里做：凭证连续失效到阈值后，订阅会被写成 enabled=false + paused_reason=credential；
   * 而定时任务只挑 enabled=true 的订阅（见 runAll），所以这些订阅永远不会被调度，
   * 「跑成功一次就自动恢复」的逻辑也就永远不会触发 —— 形成死锁，只能靠用户手动逐个启用。
   * 用户重新绑定凭证本身就说明凭证已可用，这里直接把检测恢复回来。
   */
  const resumePausedSubs = async (uid: string, pan: string): Promise<number> => {
    try {
      const { data, error } = await svc
        .from("subscriptions")
        .update({
          enabled: true,
          paused_reason: null,
          cred_fail_count: 0,
          cred_fail_at: null,
          next_check_at: new Date().toISOString(),
        })
        .eq("user_id", uid)
        .eq("pan", pan)
        .eq("paused_reason", "credential")
        .select("id");
      if (error) {
        console.warn("[subscription-run] 恢复被凭证停掉的订阅失败：", error.message);
        return 0;
      }
      const n = (data ?? []).length;
      if (n > 0) console.log(`[subscription-run] ${pan} 凭证已重新绑定，已恢复 ${n} 个订阅的检测`);
      return n;
    } catch (e) {
      console.warn("[subscription-run] 恢复被凭证停掉的订阅失败：", (e as Error).message);
      return 0;
    }
  };

  /**
   * 按 fileId 批量删除网盘文件（人工清理用）。
   * 目前只有光鸭实现了删除接口（gyDeleteFiles）；其余网盘明确报错，不做「假装删了」。
   */
  const deletePanFilesByIds = async (uid: string, pan: string, ids: string[]): Promise<number> => {
    const cred = await loadPanCred(uid, pan);
    if (!cred) throw new Error("该用户未绑定该网盘账号");
    if (pan === "guangya") return gyDeleteFiles(cred, ids);
    if (pan === "quark" || pan === "uc") return quarkDeleteFiles(cred.cookie ?? "", ids, cdOf(pan));
    throw new Error(`${PAN_LABELS[pan] ?? pan} 暂不支持按 id 删除`);
  };

  try {
    switch (action) {
      // ── 订阅配置 ──
      case "saveSubscription": {
        if (isCron) return fail("定时任务不能修改订阅", 403);
        const id = body.id ? String(body.id) : null;
        // 手动绑定的资源：必须是当前用户自己的资源（避免绑定到别人的资源）
        const rawResId = String(body.resourceId ?? "").trim();
        let resourceId: string | null = null;
        if (rawResId) {
          const { data: res } = await svc
            .from("resources")
            .select("id")
            .eq("id", rawResId)
            .eq("owner_id", userId!)
            .maybeSingle<{ id: string }>();
          if (!res) return fail("选择绑定的资源不存在或不属于你", 400, "RESOURCE_NOT_FOUND");
          resourceId = res.id;
        }

        const payload = {
          user_id: userId!,
          name: String(body.name ?? "").trim() || "未命名订阅",
          source_url: String(body.sourceUrl ?? "").trim(),
          source_type: ["auto", "rss", "page", "pan_share"].includes(String(body.sourceType))
            ? String(body.sourceType)
            : "auto",
          source_passcode: String(body.sourcePasscode ?? "").trim() || null,
          clean_mode: ["none", "episode"].includes(String(body.cleanMode)) ? String(body.cleanMode) : "none",
          /**
           * 文件夹模式：光鸭 / 夸克 / 百度 / UC / 123云盘。
           * 曾经这里只放行光鸭，导致夸克订阅「界面勾了文件夹模式、存库却是 false」，
           * 执行时退回逐文件转存（只转视频）—— 这与前端开关和后端执行层不一致。
           * DB 触发器 enforce_folder_mode_pan（迁移 00064 / 00077 / 00081）必须同步放行同一批网盘。
           */
          folder_mode: body.folderMode === true
            && ["guangya", "quark", "baidu", "uc", "p123"].includes(String(body.pan ?? "guangya")),
          keyword: String(body.keyword ?? "").trim() || null,
          // 白名单必须与 DB CHECK（00076）一致：漏掉 xunlei 会把迅雷订阅静默存成光鸭，
          // 表现为「表单明明选了迅雷云盘，保存时报目标网盘是光鸭云盘」。
          pan: ["guangya", "quark", "baidu", "xunlei", "uc", "p123"].includes(String(body.pan))
            ? String(body.pan)
            : "guangya",
          target_dir: String(body.targetDir ?? "").trim() || null,
          target_dir_name: String(body.targetDirName ?? "").trim() || null,
          // 指定了资源就一定要联动（用户明确选了要更新哪条资源）
          auto_publish: body.autoPublish === true || !!resourceId,
          resource_id: resourceId,
          enabled: body.enabled !== false,
          // 检查时间（基准间隔）：最小 1 分钟（定时任务每分钟触发一次）。
          // 未传时默认 10 分钟：订阅一多，「1 分钟」会互相抢光鸭代理导致谁都查不及时。
          // 智能检测开启时，这个值作为「基准」：预期更新时段加密、其余时段放宽（见 computeNextCheckAt）。
          interval_minutes: Math.max(1, Math.min(1440, Number(body.intervalMinutes) || 10)),
          // 智能检测（自适应调度）：默认开
          adaptive_enabled: body.adaptiveEnabled !== false,
          // 清空下次检查时间 = 立刻排一次（用户刚保存/改设置，马上看到结果），
          // 之后再按画像自动重算
          next_check_at: new Date().toISOString(),
          // 「全集数」（选填）：同步到的集数达到该值即判定完结（资源改名 + 移入已完结 + 1 小时后删订阅）。
          // 只有请求里带了该字段才改，避免老客户端保存时把它清空；填 0 / 留空 = 取消自动完结。
          ...(body.totalEpisodes === undefined
            ? {}
            : { total_episodes: Math.max(0, Math.floor(Number(body.totalEpisodes) || 0)) || null }),
          // 用户重新保存/启用订阅时清掉「已判定完结待删除」状态，避免刚启用又被清理任务删掉
          ...(body.enabled === false ? {} : { finished_at: null, delete_after: null }),
        };
        if (!payload.source_url) return fail("请填写订阅源地址", 400);
        // 锁定中的网盘：不允许再新建/改成该网盘（前端已禁用选项，这里兜底）
        const saveLockMsg = panLockedMsg(payload.pan);
        if (saveLockMsg) return fail(saveLockMsg, 403, "PAN_LOCKED");

        // 受限账号（订阅专用）：
        //   1) 没有「资源管理」页，不允许开启资源联动，否则每条都会被记成「已跳过」；
        //   2) 文件名清洗固定「不处理」——不改名（前端也已锁死该选项，这里兜底防止绕过接口）。
        if (subOnly) {
          payload.auto_publish = false;
          payload.resource_id = null;
          payload.clean_mode = "none";
        }

        // ── 受限账号（特殊邀请码注册）：只能订阅管理员维护的订阅源，且数量有上限 ──
        if (subOnly) {
          const want = normalizeShareUrl(payload.source_url);
          // 编辑已有订阅时，如果源地址没变（只改名字/间隔/目录），不因管理员下架该源而卡住用户
          let sourceChanged = true;
          if (id) {
            const { data: cur } = await svc
              .from("subscriptions")
              .select("source_url")
              .eq("id", id)
              .eq("user_id", userId!)
              .maybeSingle<{ source_url: string }>();
            if (cur?.source_url && normalizeShareUrl(cur.source_url) === want) sourceChanged = false;
          }
          if (sourceChanged) {
            const { data: srcRows } = await svc
              .from("subscription_sources")
              .select("source_url")
              .eq("is_active", true);
            let allowed = (srcRows ?? []).some(
              (r: { source_url: string }) => normalizeShareUrl(String(r.source_url)) === want
            );
            // 管理员「资源管理」里的资源也可以直接当订阅源（订阅页的「选择订阅源」就是列这些）
            if (!allowed) {
              const { data: okRes } = await svc.rpc("is_admin_resource_url", {
                p_url: payload.source_url,
              });
              allowed = okRes === true;
            }
            if (!allowed) {
              return fail(
                "该账号只能订阅管理员提供的资源 / 订阅源，请从「选择订阅源」列表中选择",
                403,
                "SOURCE_NOT_ALLOWED"
              );
            }
          }
        }

        // ── 订阅数量上限（普通用户 80 / 订阅专用账号 10 或管理员设定值；null = 不限）──
        // 只在「新建」时校验：编辑已有订阅（改名/改间隔/换目录）不该因为额度已满而失败。
        if (!id && maxSubs !== null) {
          const { count } = await svc
            .from("subscriptions")
            .select("id", { count: "exact", head: true })
            .eq("user_id", userId!);
          if ((count ?? 0) >= maxSubs) {
            return fail(`该账号最多只能订阅 ${maxSubs} 个链接，请先删除不用的订阅`, 403, "SUB_LIMIT");
          }
        }

        // 源地址是网盘分享链接 → 固定为「分享目录监控」，并要求目标网盘与分享同盘
        const subSharePan = detectPan(payload.source_url);
        if (subSharePan) {
          payload.source_type = "pan_share";
          const label = PAN_LABELS[subSharePan] ?? subSharePan;
          if (payload.pan !== subSharePan) {
            // 把「收到的值」也写出来：用户常以为自己在别处已经选过同盘，这样能一眼看出表单里实际是什么
            const got = PAN_LABELS[payload.pan] ?? payload.pan ?? "（空）";
            return fail(
              `该订阅源是${label}分享链接，目标网盘请选择${label}（跨盘无法转存；当前收到的是：${got}）`,
              400
            );
          }
          const cred = await loadPanCred(userId!, subSharePan);
          if (!cred) {
            return fail(`请先绑定${label}账号：分享目录需要登录态才能读取`, 400, "PAN_NOT_BOUND");
          }
        }
        // 同一用户的源地址唯一（subscriptions_user_url_key），直接 insert 会抛
        // 「duplicate key value violates unique constraint」这种原始数据库错误。
        // 这里先查已有记录：新建时命中就更新它（并告知前端），编辑时撞别人的地址则明确报错。
        const { data: existing } = await svc
          .from("subscriptions")
          .select("id, name")
          .eq("user_id", userId!)
          .eq("source_url", payload.source_url)
          .maybeSingle<{ id: string; name: string }>();

        if (existing && id && existing.id !== id) {
          return fail(
            `该订阅源已被「${existing.name}」使用，请换一个地址，或直接编辑那条订阅`,
            409,
            "DUPLICATE_SOURCE"
          );
        }

        const finalId = id ?? existing?.id ?? null;
        const q = finalId
          ? svc.from("subscriptions").update(payload).eq("id", finalId).eq("user_id", userId!).select().maybeSingle()
          : svc.from("subscriptions").insert(payload).select().maybeSingle();
        const { data, error } = await q;
        if (error) {
          // 并发下仍可能撞唯一键：翻译成可读提示，不再把数据库错误直接抛给用户
          if (/duplicate key/i.test(error.message)) {
            return fail("该订阅源已存在，请直接编辑已有订阅", 409, "DUPLICATE_SOURCE");
          }
          return fail(`保存订阅失败：${error.message}`, 500);
        }
        return ok({ subscription: data, updatedExisting: !id && !!existing });
      }

      case "listSubscriptions": {
        const uid = isCron ? null : userId!;
        let q = svc.from("subscriptions").select("*").order("created_at", { ascending: false });
        if (uid) q = q.eq("user_id", uid);
        const { data, error } = await q;
        if (error) return fail(`读取订阅失败：${error.message}`, 500);
        return ok({ items: data ?? [] });
      }

      case "removeSubscription": {
        if (isCron) return fail("定时任务不能删除订阅", 403);
        const { error } = await svc.from("subscriptions").delete().eq("id", String(body.id)).eq("user_id", userId!);
        if (error) return fail(`删除失败：${error.message}`, 500);
        return ok({ removed: true });
      }

      case "toggleSubscription": {
        if (isCron) return fail("定时任务不能修改订阅", 403);
        const enable = body.enabled !== false;
        const { error } = await svc
          .from("subscriptions")
          .update({
            enabled: enable,
            // 重新启用时立刻排一次检查（刚打开就该看到结果），否则要等旧的下次检查时间；
            // 同时清掉「凭据失效自动暂停」的计数，让用户重新绑定后能重新累计 3 次尝试
            ...(enable
              ? {
                  next_check_at: new Date().toISOString(),
                  cred_fail_count: 0,
                  cred_fail_at: null,
                  paused_reason: null,
                }
              : {}),
          })
          .eq("id", String(body.id))
          .eq("user_id", userId!);
        if (error) return fail(`更新失败：${error.message}`, 500);
        return ok({ enabled: enable });
      }

      // ── 网盘账号 ──
      case "bindPan": {
        if (isCron) return fail("定时任务不能绑定账号", 403);
        const pan = String(body.pan ?? "");
        if (!["guangya", "quark", "baidu", "xunlei", "uc", "p123"].includes(pan)) return fail(`不支持的网盘：${pan}`, 400);
        // 迅雷是纯 OAuth（扫码换令牌），没有可粘贴的 Cookie
        if (pan === "xunlei") {
          if (XUNLEI_LOCKED) return fail(XUNLEI_LOCKED_MSG, 403, "PAN_LOCKED");
          return fail("迅雷云盘请用「扫码登录」绑定（手机迅雷 App 扫一扫即可，不支持粘贴 Cookie）", 400);
        }
        const cookie = String(body.cookie ?? "").trim();
        if (!cookie) {
          return fail(
            pan === "baidu"
              ? "请粘贴百度网盘登录 Cookie：浏览器登录 pan.baidu.com 后，开发者工具 → 网络 → 任意请求 → 复制整串 Cookie（必须含 BDUSS）"
              : pan === "uc"
                ? "请粘贴 UC 网盘登录 Cookie：浏览器登录 drive.uc.cn 后，开发者工具 → 网络 → 任意请求 → 复制整串 Cookie（必须含 __pus）"
                : pan === "p123"
                  ? "请粘贴 123 云盘登录令牌：浏览器登录 yun.123pan.com 后，开发者工具 → Application → Local Storage → authorToken（完整 JWT 串）"
                  : "请粘贴网盘登录 Cookie（浏览器开发者工具 → 网络 → 任意请求 → Cookie）",
            400
          );
        }
        const username = String(body.username ?? "").trim();
        const rootDir = String(body.rootDir ?? "").trim();

        // 百度：Cookie 是半成品，写操作还要 bdstoken —— 保存前先换一次，换不到直接拒（免得存进去也用不了）
        if (pan === "baidu") {
          let tokens: { bdstoken: string; uk: string };
          try {
            tokens = await baiduFetchTokens({ cookie, bdstoken: "", uk: "" });
          } catch (e) {
            return fail(`百度网盘绑定失败：${(e as Error).message}`, 400);
          }
          try {
            await baiduSaveCred(
              userId!,
              { cookie, bdstoken: tokens.bdstoken, uk: tokens.uk },
              { displayName: username || tokens.uk, rootDir }
            );
          } catch (e) {
            return fail((e as Error).message, 500);
          }
          // 再验一次登录态：Cookie 能换 bdstoken 但可能已被风控限制
          try {
            const cred = await loadPanCred(userId!, "baidu");
            if (cred) await baiduAuthCheck(cred);
          } catch (e) {
            return ok({
              pan,
              saved: true,
              warning: `凭据已保存，但登录态校验未通过：${(e as Error).message}`,
            });
          }
          await resumePausedSubs(userId!, pan);
          return ok({ pan, saved: true, verified: true, uk: tokens.uk || null });
        }

        // UC：Cookie 只是登录态，保存前先验一次（/user/info），免得存进去才发现不能用
        if (pan === "uc") {
          const chk = await quarkAuthCheck(cookie, CD_UC);
          if (!chk.ok) {
            return fail(
              `UC 网盘绑定失败：Cookie 校验未通过（${chk.message}）。请确认已登录 drive.uc.cn，且 Cookie 里含 __pus`,
              400
            );
          }
          const nickname = username || (await quarkAccountName(cookie, CD_UC));
          const { error } = await svc.rpc("save_pan_account", {
            p_user_id: userId!,
            p_pan: "uc",
            p_username: nickname,
            p_cookie: cookie,
            p_root_dir: rootDir,
            p_key: CRED_KEY,
          });
          if (error) return fail(`保存网盘账号失败：${error.message}`, 500);
          await resumePausedSubs(userId!, pan);
          return ok({ pan, saved: true, username: nickname });
        }

        // 123：凭证是 authorToken（不是 Cookie），保存前先调 /user/info 校验，避免存进去才发现已过期
        if (pan === "p123") {
          const chk = await p123AuthCheck(cookie);
          if (!chk.ok) {
            return fail(
              `123 云盘绑定失败：登录令牌校验未通过（${chk.message}）。`
                + "请确认已登录 yun.123pan.com，并粘贴 Local Storage 里的 authorToken（完整 JWT 串）",
              400
            );
          }
          const nickname = username || (await p123AccountName(cookie));
          const { error } = await svc.rpc("save_pan_account", {
            p_user_id: userId!,
            p_pan: "p123",
            p_username: nickname,
            p_cookie: cookie,
            p_root_dir: rootDir,
            p_key: CRED_KEY,
          });
          if (error) return fail(`保存网盘账号失败：${error.message}`, 500);
          await resumePausedSubs(userId!, pan);
          return ok({ pan, saved: true, username: nickname });
        }

        const { error } = await svc.rpc("save_pan_account", {
          p_user_id: userId!,
          p_pan: pan,
          p_username: username,
          p_cookie: cookie,
          p_root_dir: rootDir,
          p_key: CRED_KEY,
        });
        if (error) return fail(`保存网盘账号失败：${error.message}`, 500);
        await resumePausedSubs(userId!, pan);
        return ok({ pan, saved: true });
      }

      case "panList": {
        if (isCron) return fail("定时任务不能读取网盘账号", 403);
        return ok({ items: await listPan(userId!) });
      }

      // ── 目录浏览（选择转存位置）──
      case "panDirs": {
        if (isCron) return fail("定时任务不能浏览目录", 403);
        const pan = ["guangya", "quark", "baidu", "xunlei", "uc", "p123"].includes(String(body.pan)) ? String(body.pan) : "guangya";
        // 百度的 parentId 是绝对路径（空 = 根目录 "/"）
        const parentId = String(body.parentId ?? "").trim();
        const cred = await loadPanCred(userId!, pan);
        if (!cred) return fail(`未绑定${PAN_LABELS[pan] ?? pan}账号，无法浏览目录；请先绑定后再选`, 400, "PAN_NOT_BOUND");
        try {
          const dirs = await listPanDirs(pan, cred, parentId);
          return ok({ pan, parentId, dirs });
        } catch (e) {
          return fail(`读取目录失败：${(e as Error).message}`, 502);
        }
      }

      case "removePan": {
        if (isCron) return fail("定时任务不能修改网盘账号", 403);
        const { error } = await svc.from("pan_accounts").delete().eq("user_id", userId!).eq("pan", String(body.pan));
        if (error) return fail(`删除失败：${error.message}`, 500);
        return ok({ removed: true });
      }

      // ── 光鸭扫码授权（Device Authorization Grant）：直接换回可长期续期的凭证 ──
      // 相比「粘贴令牌」的优势：令牌是发给官方 client_id 的，后续 gyRefreshToken 能一直续期
      // （粘贴浏览器那套令牌时 client_id 不是官方的，账号网关会 404，即「用着用着就失效」）。
      case "panDeviceStart": {
        if (isCron) return fail("定时任务不能绑定账号", 403);
        const startPan = String(body.pan ?? "guangya");
        const startLockMsg = panLockedMsg(startPan);
        if (startLockMsg) return fail(startLockMsg, 403, "PAN_LOCKED");

        // 百度：passport 二维码（扫码 → BDUSS → 整串 Cookie），与光鸭的设备码流程不同
        if (startPan === "baidu") {
          let q: { sign: string; cookie: string; qrUrl: string };
          try {
            q = await baiduQrStart();
          } catch (e) {
            return fail((e as Error).message, 502);
          }
          // 前端每 4s 轮询一次；服务端单次长轮询最长 3.5s，两者不重叠（避免多路并发打百度）
          const interval = 4;
          const expiresIn = 180;
          const { data: row, error } = await svc
            .from("pan_bind_sessions")
            .insert({
              user_id: userId!,
              pan: "baidu",
              status: "pending",
              // device_code 复用：存 sign + 申请二维码时下发的 Cookie（轮询必须带）
              device_code: JSON.stringify({ sign: q.sign, cookie: q.cookie }),
              interval,
              expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
            })
            .select("id")
            .maybeSingle();
          if (error || !row) return fail(`保存授权会话失败：${error?.message ?? "未知错误"}`, 500);
          return ok({
            sessionId: row.id,
            pan: "baidu",
            verifyUrl: q.qrUrl,
            /** 百度给的是现成的二维码图片，前端直接 <img> 展示即可 */
            qrImageUrl: q.qrUrl,
            userCode: null,
            interval,
            expiresIn,
            hint: "用手机「百度 App」或「百度网盘 App」扫一扫，扫码后在手机上点「确认登录」",
          });
        }

        // 123 云盘：uniID 二维码（扫码 → 直接给 authorToken），服务端校验后加密落库
        if (startPan === "p123") {
          let q: { uniId: string; qrUrl: string };
          try {
            q = await p123QrStart();
          } catch (e) {
            return fail((e as Error).message, 502);
          }
          // 官方前端 1s 轮询（文档 3.2），这里跟着 1s；有效期放宽到 5 分钟，
          // 因为用户要点开微信、找到会话、点「确认」，我们才有 wxCode 可换
          const interval = 1;
          const expiresIn = 300;
          const { data: row, error } = await svc
            .from("pan_bind_sessions")
            .insert({
              user_id: userId!,
              pan: "p123",
              status: "pending",
              // device_code 复用：存 uniID（轮询要用，二维码本身是一张一次性会话）
              device_code: JSON.stringify({ uniId: q.uniId }),
              interval,
              expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
            })
            .select("id")
            .maybeSingle();
          if (error || !row) return fail(`保存授权会话失败：${error?.message ?? "未知错误"}`, 500);
          return ok({
            sessionId: row.id,
            pan: "p123",
            /** 二维码内容是官方扫码页 URL（已带 uniID），前端本地编码成二维码即可 */
            verifyUrl: q.qrUrl,
            userCode: null,
            interval,
            expiresIn,
            hint: "请用手机「123云盘」App 扫一扫，扫码后在 App 里点「确认登录」",
          });
        }

        // 夸克：uop CAS 二维码（扫码 → service_ticket → 整串 Cookie），服务端直接加密落库
        if (startPan === "quark") {
          let q: { token: string; requestId: string; qrUrl: string };
          try {
            q = await quarkQrStart();
          } catch (e) {
            return fail((e as Error).message, 502);
          }
          const interval = 2;
          const expiresIn = 180;
          const { data: row, error } = await svc
            .from("pan_bind_sessions")
            .insert({
              user_id: userId!,
              pan: "quark",
              status: "pending",
              // device_code 复用：存二维码 token + 同一轮轮询用的 request_id（两者必须成对使用）
              device_code: JSON.stringify({ token: q.token, requestId: q.requestId }),
              interval,
              expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
            })
            .select("id")
            .maybeSingle();
          if (error || !row) return fail(`保存授权会话失败：${error?.message ?? "未知错误"}`, 500);
          return ok({
            sessionId: row.id,
            pan: "quark",
            /** 二维码内容是官方扫码页 URL，前端本地编码成二维码即可 */
            verifyUrl: q.qrUrl,
            userCode: null,
            interval,
            expiresIn,
            hint: "请用手机「夸克 App」扫一扫，扫码后在手机上点「确认登录」",
          });
        }

        // UC：api.open.uc.cn CAS 二维码（扫码 → service_ticket → 整串 Cookie），服务端直接加密落库
        if (startPan === "uc") {
          let q: { token: string; requestId: string; qrUrl: string };
          try {
            q = await ucQrStart();
          } catch (e) {
            return fail((e as Error).message, 502);
          }
          const interval = 2;
          const expiresIn = 180;
          const { data: row, error } = await svc
            .from("pan_bind_sessions")
            .insert({
              user_id: userId!,
              pan: "uc",
              status: "pending",
              // device_code 复用：存二维码 token + 同一轮轮询用的 request_id（两者必须成对使用）
              device_code: JSON.stringify({ token: q.token, requestId: q.requestId }),
              interval,
              expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
            })
            .select("id")
            .maybeSingle();
          if (error || !row) return fail(`保存授权会话失败：${error?.message ?? "未知错误"}`, 500);
          return ok({
            sessionId: row.id,
            pan: "uc",
            /** 二维码内容是官方扫码页 URL，前端本地编码成二维码即可 */
            verifyUrl: q.qrUrl,
            userCode: null,
            interval,
            expiresIn,
            hint: "请用手机「UC 网盘 App」（或 UC 浏览器）扫一扫，扫码后在手机上点「确认登录」",
          });
        }

        // 迅雷：OAuth 2.0 设备码（扫码内容 = verification_uri_complete），扫码后轮询 /v1/auth/token
        if (startPan === "xunlei") {
          let q: { deviceCode: string; verifyUrl: string; userCode: string | null; interval: number; expiresIn: number };
          try {
            const r = await xlFetchJson(`${XL_AUTH}/v1/auth/device/code`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "User-Agent": UA },
              body: JSON.stringify({ client_id: XL_OAUTH_CLIENT_ID, scope: XL_SCOPE }),
            });
            const d = r.json ?? {};
            const deviceCode = String(d.device_code ?? "");
            // 二维码内容用 verification_uri_complete（自带 user_code，扫码后直接进确认页）
            const verifyUrl = String(d.verification_uri_complete ?? d.verification_url ?? d.short_uri_complete ?? "");
            if (r.status !== 200 || !deviceCode || !verifyUrl) {
              return fail(`迅雷设备码申请失败（HTTP ${r.status}）：${JSON.stringify(d).slice(0, 160)}`, 502);
            }
            q = {
              deviceCode,
              verifyUrl,
              userCode: d.user_code ? String(d.user_code) : null,
              interval: Math.max(2, Number(d.interval ?? 2)),
              expiresIn: Math.max(60, Number(d.expires_in ?? 120)),
            };
          } catch (e) {
            return fail(`迅雷设备码申请失败：${(e as Error).message}`, 502);
          }
          const { data: row, error } = await svc
            .from("pan_bind_sessions")
            .insert({
              user_id: userId!,
              pan: "xunlei",
              status: "pending",
              device_code: q.deviceCode,
              interval: q.interval,
              expires_at: new Date(Date.now() + q.expiresIn * 1000).toISOString(),
            })
            .select("id")
            .maybeSingle();
          if (error || !row) return fail(`保存授权会话失败：${error?.message ?? "未知错误"}`, 500);
          return ok({
            sessionId: row.id,
            pan: "xunlei",
            verifyUrl: q.verifyUrl,
            userCode: q.userCode,
            interval: q.interval,
            expiresIn: q.expiresIn,
            hint: "请用手机「迅雷」扫一扫，扫码后在手机上点「确认登录」",
          });
        }

        const r = await gyAccountPost("/v1/auth/device/code", {
          client_id: GY_CLIENT_ID,
          scope: "user",
        });
        const d = r.body;
        const deviceCode = String(d.device_code ?? "");
        // 光鸭接口把设备授权的「用户确认页」主机误配成 account.guangyapan.com（该子域整域 404，
        // 含根路径也是 nginx 404），真实页面挂在 www.guangyapan.com/__/auth/device/。
        // 不修正的话，扫码/打开授权页会直接 404。这里把主机换回 www（验证过该路径返回 200 的授权页）。
        const fixVerifyHost = (u: string) => u.replace(/^https?:\/\/account\./i, "https://www.");
        // 二维码内容优先用 verification_uri_complete（自带 user_code）：光鸭 App 扫码后
        // 可直接显示「同意登录」确认页，无需再手输验证码。
        const verifyUrl = fixVerifyHost(String(d.verification_uri_complete ?? d.verification_url ?? ""));
        if (r.status !== 200 || !deviceCode || !verifyUrl) {
          return fail(
            `光鸭设备码申请失败（HTTP ${r.status}）：${JSON.stringify(d).slice(0, 160)}`,
            502
          );
        }
        const expiresIn = Number(d.expires_in ?? 120);
        const interval = Math.max(2, Number(d.interval ?? 2));
        const { data: row, error } = await svc
          .from("pan_bind_sessions")
          .insert({
            user_id: userId!,
            pan: "guangya",
            status: "pending",
            device_code: deviceCode,
            interval,
            expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
          })
          .select("id")
          .maybeSingle();
        if (error || !row) return fail(`保存授权会话失败：${error?.message ?? "未知错误"}`, 500);
        return ok({
          sessionId: row.id,
          verifyUrl,
          userCode: d.user_code ?? null,
          interval,
          expiresIn,
        });
      }

      case "panDevicePoll": {
        if (isCron) return fail("定时任务不能绑定账号", 403);
        const sessionId = String(body.sessionId ?? "");
        if (!sessionId) return fail("缺少 sessionId", 400);

        const { data: s } = await svc
          .from("pan_bind_sessions")
          .select("id, user_id, pan, status, device_code, interval, expires_at, last_poll_at")
          .eq("id", sessionId)
          .maybeSingle();
        if (!s || s.user_id !== userId) return fail("授权会话不存在", 404);
        if (s.status === "success") return ok({ status: "success" });
        if (new Date(String(s.expires_at)).getTime() < Date.now()) {
          await svc.from("pan_bind_sessions").update({ status: "expired" }).eq("id", s.id);
          return ok({ status: "expired" });
        }

        // 按站点要求的间隔轮询，避免被判定 slow_down
        // 123 官方前端是 1s 一次（文档 3.2），这里必须跟着走 1s：
        // 用户在微信里点「确认」后 wxCode 才会出现，间隔太大容易错过兑换窗口。
        const intervalSec = s.pan === "p123" ? 1 : Math.max(2, Number(s.interval) || 2);
        if (s.last_poll_at && Date.now() - new Date(String(s.last_poll_at)).getTime() < intervalSec * 1000) {
          return ok({ status: "waiting", pan: s.pan });
        }

        // 迅雷：轮询 /v1/auth/token（device_code 模式）→ 拿到令牌即加密落库（服务端直接保存）
        if (s.pan === "xunlei") {
          await svc.from("pan_bind_sessions").update({ last_poll_at: new Date().toISOString() }).eq("id", s.id);
          let r: { status: number; json: Record<string, unknown> | null; text: string };
          try {
            r = await xlFetchJson(`${XL_AUTH}/v1/auth/token`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "User-Agent": UA },
              body: JSON.stringify({
                client_id: XL_OAUTH_CLIENT_ID,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                device_code: String(s.device_code ?? ""),
              }),
            });
          } catch {
            // 网络抖动：继续等，别把扫码流程判死
            return ok({ status: "waiting", pan: "xunlei" });
          }
          const d = r.json ?? {};
          const at = typeof d.access_token === "string" ? d.access_token.replace(/^Bearer\s+/i, "").trim() : "";
          if (r.status === 200 && at) {
            const expIn = Number(d.expires_in ?? 0);
            /**
             * 重新扫码时不能把已经调通的设备身份冲掉：
             * 设备 ID / client_id / 风控种子是「设备档案 + client info」的凭据，换掉就立刻
             * 回到 no client info found。所以已有就沿用，只有全新绑定时才生成随机设备号。
             */
            const prev = await loadPanCred(userId!, "xunlei").catch(() => null);
            const pt = prev?.xunlei;
            const tokens: XlTokens = {
              access_token: at,
              refresh_token: typeof d.refresh_token === "string" && d.refresh_token ? d.refresh_token : undefined,
              expires_at: expIn > 0 ? Date.now() + expIn * 1000 - 5 * 60_000 : undefined,
              open_id: typeof d.open_id === "string" ? d.open_id : undefined,
              device_id: pt?.device_id || xlNewDeviceId(),
              ...(pt?.client_id ? { client_id: pt.client_id } : {}),
              ...(pt?.client_version ? { client_version: pt.client_version } : {}),
              ...(pt?.client_secret ? { client_secret: pt.client_secret } : {}),
              ...(pt?.user_agent ? { user_agent: pt.user_agent } : {}),
              ...(pt?.captcha_seed ? { captcha_seed: pt.captcha_seed } : {}),
            };
            const displayName = tokens.open_id ? `迅雷 ${tokens.open_id.slice(0, 8)}` : "迅雷账号";
            // 先只读校验一次（失败也照存：令牌本身有效，只是 about 可能受风控）
            const chk = await xlAuthCheck({ kind: "oauth", userId: userId!, xunlei: tokens, rootDirId: null });
            const { error } = await svc.rpc("save_pan_oauth", {
              p_user_id: userId!,
              p_pan: "xunlei",
              p_username: displayName,
              p_token_json: JSON.stringify(tokens),
              p_root_dir_id: "",
              p_key: CRED_KEY,
            });
            if (error) {
              await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
              return ok({ status: "failed", pan: "xunlei", message: `保存迅雷凭据失败：${error.message}` });
            }
            await svc.from("pan_bind_sessions").update({ status: "success" }).eq("id", s.id);
            await resumePausedSubs(userId!, "xunlei");
            return ok({
              status: "success",
              pan: "xunlei",
              account: displayName,
              message: chk.ok
                ? "迅雷云盘已绑定（令牌已加密保存）"
                : `迅雷云盘已绑定，但登录态校验未通过：${chk.message}`,
            });
          }

          const errCode = String(d.error ?? "").toLowerCase();
          const desc = String(d.error_description ?? d.error ?? "");
          if (errCode.includes("authorization_pending") || errCode.includes("slow_down")) {
            return ok({ status: "waiting", pan: "xunlei" });
          }
          if (errCode.includes("access_denied")) {
            await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
            return ok({ status: "failed", pan: "xunlei", message: "你取消了授权" });
          }
          if (errCode.includes("expired") || /失效|过期|重新生成/.test(desc)) {
            await svc.from("pan_bind_sessions").update({ status: "expired" }).eq("id", s.id);
            return ok({ status: "expired", pan: "xunlei" });
          }
          await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
          return ok({
            status: "failed",
            pan: "xunlei",
            message: desc || `迅雷扫码接口异常（HTTP ${r.status}）`,
          });
        }

        // 123 云盘：轮询 uniID 扫码状态 → 换到 authorToken → 校验后加密落库
        if (s.pan === "p123") {
          let sess: { uniId?: string } = {};
          try {
            sess = JSON.parse(String(s.device_code)) as { uniId?: string };
          } catch { /* 脏数据 */ }
          const uniId = String(sess.uniId ?? "");
          if (!uniId) return fail("授权会话已损坏，请重新发起扫码", 400);

          // 先落 last_poll_at 再请求：密集轮询会在上面的间隔判断处直接回 waiting
          await svc.from("pan_bind_sessions").update({ last_poll_at: new Date().toISOString() }).eq("id", s.id);

          let p: Awaited<ReturnType<typeof p123QrPoll>>;
          try {
            p = await p123QrPoll(uniId);
          } catch {
            // 网络抖动：继续等，别把扫码流程判死
            return ok({ status: "waiting", pan: "p123" });
          }
          if (p.state === "waiting") return ok({ status: "waiting", pan: "p123", message: p.message });
          if (p.state === "expired") {
            await svc.from("pan_bind_sessions").update({ status: "expired" }).eq("id", s.id);
            return ok({ status: "expired", pan: "p123", message: p.message });
          }
          if (p.state !== "ok" || !p.token) {
            await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
            return ok({ status: "failed", pan: "p123", message: p.message ?? "扫码登录失败，请重试" });
          }

          const token = p.token;
          const chk = await p123AuthCheck(token);
          if (!chk.ok) {
            await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
            return ok({
              status: "failed",
              pan: "p123",
              message: `已换到登录令牌，但登录态校验未通过（${chk.message}），请重新扫码`,
            });
          }
          const nickname = (await p123AccountName(token)) || "123云盘账号";
          const { error } = await svc.rpc("save_pan_account", {
            p_user_id: userId!,
            p_pan: "p123",
            p_username: nickname,
            p_cookie: token,
            p_root_dir: "",
            p_key: CRED_KEY,
          });
          if (error) {
            await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
            return ok({ status: "failed", pan: "p123", message: `保存 123 云盘凭据失败：${error.message}` });
          }
          await svc.from("pan_bind_sessions").update({ status: "success" }).eq("id", s.id);
          await resumePausedSubs(userId!, "p123");
          return ok({
            status: "success",
            pan: "p123",
            account: nickname,
            message: "123云盘已绑定（登录令牌已加密保存）",
          });
        }

        // 夸克：轮询扫码状态 → 换 service_ticket → 换整串 Cookie → 校验后加密落库（服务端直接保存）
        if (s.pan === "quark") {
          let sess: { token?: string; requestId?: string; ticket?: string } = {};
          try {
            sess = JSON.parse(String(s.device_code)) as { token?: string; requestId?: string; ticket?: string };
          } catch { /* 脏数据 */ }
          const token = String(sess.token ?? "");
          const requestId = String(sess.requestId ?? "");
          if (!token) return fail("授权会话已损坏，请重新发起扫码", 400);

          // 先落 last_poll_at 再请求：密集轮询会在上面的间隔判断处直接回 waiting
          await svc.from("pan_bind_sessions").update({ last_poll_at: new Date().toISOString() }).eq("id", s.id);

          // 已经换过票（上次换 Cookie 失败）：直接用存下的 ticket 重试，ticket 一次性，不能重复轮询
          let ticket = String(sess.ticket ?? "");
          if (!ticket) {
            const p = await quarkQrPoll(token, requestId);
            if (p.state === "waiting") return ok({ status: "waiting", pan: "quark" });
            if (p.state === "expired") {
              await svc.from("pan_bind_sessions").update({ status: "expired" }).eq("id", s.id);
              return ok({ status: "expired", pan: "quark" });
            }
            if (p.state !== "ok" || !p.ticket) {
              await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
              return ok({ status: "failed", pan: "quark", message: p.message ?? "扫码登录失败，请重试" });
            }
            ticket = p.ticket;
            // 换票前先写回会话：即使后面换 Cookie 失败，也不会再拿同一张票去换（票是一次性的）
            await svc
              .from("pan_bind_sessions")
              .update({ device_code: JSON.stringify({ token, requestId, ticket }) })
              .eq("id", s.id);
          }

          try {
            const ex = await quarkCookieFromTicket(ticket);
            if (!ex.cookie) {
              await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
              return ok({
                status: "failed",
                pan: "quark",
                message: `扫码已通过，但未换到登录 Cookie（${ex.code || "无返回码"}${ex.msg ? `：${ex.msg}` : ""}），请重新扫码`,
              });
            }
            const chk = await quarkAuthCheck(ex.cookie);
            if (!chk.ok) {
              await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
              return ok({
                status: "failed",
                pan: "quark",
                message: `已换到 Cookie，但登录态校验未通过（${chk.message}），请重新扫码`,
              });
            }
            const nickname = ex.nickname || (await quarkAccountName(ex.cookie));
            const { error } = await svc.rpc("save_pan_account", {
              p_user_id: userId!,
              p_pan: "quark",
              p_username: nickname,
              p_cookie: ex.cookie,
              p_root_dir: "",
              p_key: CRED_KEY,
            });
            if (error) {
              await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
              return ok({ status: "failed", pan: "quark", message: `保存夸克凭据失败：${error.message}` });
            }
            await svc.from("pan_bind_sessions").update({ status: "success" }).eq("id", s.id);
            await resumePausedSubs(userId!, "quark");
            return ok({
              status: "success",
              pan: "quark",
              account: nickname || null,
              message: "夸克网盘已绑定（Cookie 已加密保存）",
            });
          } catch (e) {
            await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
            return ok({ status: "failed", pan: "quark", message: (e as Error).message });
          }
        }

        // UC：轮询二维码状态 → 换 service_ticket → 换整串 Cookie（含 __puus）→ 校验后加密落库
        if (s.pan === "uc") {
          let sess: { token?: string; requestId?: string; ticket?: string } = {};
          try {
            sess = JSON.parse(String(s.device_code)) as { token?: string; requestId?: string; ticket?: string };
          } catch { /* 脏数据 */ }
          const token = String(sess.token ?? "");
          const requestId = String(sess.requestId ?? "");
          if (!token) return fail("授权会话已损坏，请重新发起扫码", 400);

          // 先落 last_poll_at 再请求：密集轮询会在上面的间隔判断处直接回 waiting
          await svc.from("pan_bind_sessions").update({ last_poll_at: new Date().toISOString() }).eq("id", s.id);

          // 已经换过票（上次换 Cookie 失败）：直接用存下的 ticket 重试，ticket 一次性，不能重复轮询
          let ticket = String(sess.ticket ?? "");
          if (!ticket) {
            const p = await ucQrPoll(token, requestId);
            if (p.state === "waiting") return ok({ status: "waiting", pan: "uc" });
            if (p.state === "expired") {
              await svc.from("pan_bind_sessions").update({ status: "expired" }).eq("id", s.id);
              return ok({ status: "expired", pan: "uc" });
            }
            if (p.state !== "ok" || !p.ticket) {
              await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
              return ok({ status: "failed", pan: "uc", message: p.message ?? "扫码登录失败，请重试" });
            }
            ticket = p.ticket;
            // 换票前先写回会话：即使后面换 Cookie 失败，也不会再拿同一张票去换（票是一次性的）
            await svc
              .from("pan_bind_sessions")
              .update({ device_code: JSON.stringify({ token, requestId, ticket }) })
              .eq("id", s.id);
          }

          try {
            const ex = await ucCookieFromTicket(ticket);
            if (!ex.cookie) {
              await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
              return ok({
                status: "failed",
                pan: "uc",
                message: `扫码已通过，但未换到登录 Cookie（${ex.code || "无返回码"}${ex.msg ? `：${ex.msg}` : ""}），请重新扫码`,
              });
            }
            const chk = await quarkAuthCheck(ex.cookie, CD_UC);
            if (!chk.ok) {
              await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
              /**
               * 把现场信息带出来（只有状态码、Set-Cookie 字段名，绝不含任何 Cookie 值）：
               * 阿里这套在票据换不到登录态时不给可读原因，只能靠这些现场判断是哪一跳失效。
               */
              const diag = [
                ex.hops?.length ? ex.hops.join("；") : "",
                ex.hasPus === false
                  ? `未拿到 __pus，已拿到字段：${(ex.cookieKeys ?? []).join(",")}`
                  : "",
                ex.probeStatus
                  ? `file/sort=${ex.probeStatus}${ex.probeMsg ? `（${ex.probeMsg}）` : ""}`
                  : "",
              ].filter(Boolean).join(" ｜ ");
              return ok({
                status: "failed",
                pan: "uc",
                message: `已换到 Cookie，但登录态校验未通过（${chk.message}）`
                  + `${diag ? `。${diag}` : ""}。请重新扫码，或改用「绑定 Cookie」粘贴浏览器登录态`,
              });
            }
            const nickname = ex.nickname || (await quarkAccountName(ex.cookie, CD_UC));
            const { error } = await svc.rpc("save_pan_account", {
              p_user_id: userId!,
              p_pan: "uc",
              p_username: nickname,
              p_cookie: ex.cookie,
              p_root_dir: "",
              p_key: CRED_KEY,
            });
            if (error) {
              await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
              return ok({ status: "failed", pan: "uc", message: `保存 UC 凭据失败：${error.message}` });
            }
            await svc.from("pan_bind_sessions").update({ status: "success" }).eq("id", s.id);
            await resumePausedSubs(userId!, "uc");
            return ok({
              status: "success",
              pan: "uc",
              account: nickname || null,
              message: "UC 网盘已绑定（Cookie 已加密保存）",
            });
          } catch (e) {
            await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
            return ok({ status: "failed", pan: "uc", message: (e as Error).message });
          }
        }

        // 百度：passport 长轮询 → 拿到 BDUSS → 换整串 Cookie → 校验后加密落库（服务端直接保存）
        if (s.pan === "baidu") {
          let sess: { sign?: string; cookie?: string; bduss?: string } = {};
          try {
            sess = JSON.parse(String(s.device_code)) as { sign?: string; cookie?: string; bduss?: string };
          } catch { /* 脏数据 */ }
          const sign = String(sess.sign ?? "");
          if (!sign) return fail("授权会话已损坏，请重新发起扫码", 400);

          // 先落 last_poll_at 再长轮询：这样并发/密集的请求会在上面的间隔判断处直接回 waiting
          await svc.from("pan_bind_sessions").update({ last_poll_at: new Date().toISOString() }).eq("id", s.id);

          // 已经扫过码（上次换 Cookie 失败但 BDUSS 已存下）：直接重试换取，不用重新扫
          let bduss = String(sess.bduss ?? "");
          let pollSets: string[] = [];
          let pollKeys: string[] = [];
          if (!bduss) {
            const p = await baiduQrPoll(sign, String(sess.cookie ?? ""));
            if (p.state === "waiting") return ok({ status: "waiting", pan: "baidu" });
            if (p.state === "scanned") {
              return ok({ status: "waiting", pan: "baidu", message: "已扫码，请在手机上点「确认登录」" });
            }
            if (p.state === "expired") {
              await svc.from("pan_bind_sessions").update({ status: "expired" }).eq("id", s.id);
              return ok({ status: "expired", pan: "baidu" });
            }
            if (p.state !== "ok" || !p.bduss) {
              await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
              return ok({ status: "failed", pan: "baidu", message: p.message ?? "扫码登录失败，请重试" });
            }
            bduss = p.bduss;
            try { bduss = decodeURIComponent(bduss); } catch { /* 原样用 */ }
            pollSets = p.setCookies ?? [];
            pollKeys = p.channelKeys ?? [];
            // 扫码确认时百度通常会在 unicast 的响应头里下发完整 BDUSS（190+ 位）+ STOKEN；
            // channel_v.v 只是 32 位的短票，直接拿它当 Cookie 会被判未登录（errno=-6）。
            const merged = cookieMerge(String(sess.cookie ?? ""), pollSets);
            const fullBduss = /(?:^|;\s*)BDUSS=([^;]+)/.exec(merged)?.[1] ?? "";
            if (fullBduss.length > bduss.length) bduss = fullBduss;
            sess.cookie = merged;
            // 存回会话：换 Cookie 失败时能原地重试，不用重新扫
            await svc
              .from("pan_bind_sessions")
              .update({ device_code: JSON.stringify({ sign, cookie: merged, bduss }) })
              .eq("id", s.id);
          }
          try {
            // 短票 → 完整登录态（一次性）；失败就退回「把短票当 BDUSS 用」的老路，让诊断说话
            const exchanged = await baiduBdussExchange(bduss, String(sess.cookie ?? ""));
            const pickNo = (ck: string, n: string) => (new RegExp(`(?:^|;\\s*)${n}=([^;]+)`).exec(ck)?.[1] ?? "");
            const exchangedBduss = pickNo(exchanged, "BDUSS");
            const realBduss = exchangedBduss.length >= 100 ? exchangedBduss : bduss;
            let cookie = await baiduCookieFromBduss(realBduss, exchanged);
            // 兜底：短票场景下若网盘回头下发了完整 BDUSS_BFESS，就换用它
            if (pickNo(cookie, "BDUSS").length < 100 && pickNo(cookie, "BDUSS_BFESS").length >= 100) {
              cookie = cookieMerge(cookie, [`BDUSS=${pickNo(cookie, "BDUSS_BFESS")}`]);
            }
            const probe = await baiduBdstokenProbe(cookie);
            let bdstoken = probe.bdstoken;
            // 兜底：网盘首页 HTML 里也可能直接带 bdstoken
            if (!bdstoken) bdstoken = await baiduBdstokenFromHtml({ cookie, bdstoken: "", uk: "" });
            if (!bdstoken) {
              const lenOf = (n: string) => (new RegExp(`(?:^|;\\s*)${n}=([^;]*)`).exec(cookie)?.[1] ?? "").length;
              const names = cookie.split(";").map((x) => x.split("=")[0].trim()).filter(Boolean);
              await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
              return ok({
                status: "failed",
                pan: "baidu",
                message:
                  `扫码登录已通过，但换 bdstoken 失败（errno=${probe.errno}`
                  + `${probe.errmsg ? `：${probe.errmsg}` : ""}）。`
                  + `诊断：BDUSS ${lenOf("BDUSS")} 位 / BDUSS_BFESS ${lenOf("BDUSS_BFESS")} 位，`
                  + `Cookie 字段 ${names.join("/") || "无"}；`
                  + `unicast 下发 Set-Cookie ${pollSets.length} 条，channel_v 键 ${pollKeys.join("/") || "无"}`,
              });
            }
            const uk = await baiduTemplateVar({ cookie, bdstoken, uk: "" }, "uk");
            await baiduSaveCred(
              userId!,
              { cookie, bdstoken, uk },
              { displayName: uk || "百度扫码登录" }
            );
            await svc.from("pan_bind_sessions").update({ status: "success" }).eq("id", s.id);
            await resumePausedSubs(userId!, "baidu");
            return ok({
              status: "success",
              pan: "baidu",
              account: uk || null,
              message: "百度网盘已绑定（Cookie 已加密保存）",
            });
          } catch (e) {
            await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
            return ok({ status: "failed", pan: "baidu", message: (e as Error).message });
          }
        }

        const r = await gyAccountPost(
          "/v1/auth/token",
          {
            client_id: GY_CLIENT_ID,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: String(s.device_code),
          },
          {},
          { clientId: GY_CLIENT_ID }
        );
        const d = r.body;
        const at = typeof d.access_token === "string" ? d.access_token : "";
        if (r.status === 200 && at) {
          const rt = typeof d.refresh_token === "string" ? d.refresh_token : "";
          await svc.from("pan_bind_sessions").update({ status: "success" }).eq("id", s.id);
          // 不在服务端直接落库：把凭证返回给前端，自动填进「填入光鸭令牌」表单
          //（Refresh Token / Access Token 两栏），由用户确认后走 panBindTokens 保存——
          // 该路径带换新校验，是已验证稳定的保存方式。
          return ok({
            status: "success",
            accessToken: at.replace(/^Bearer\s+/i, "").trim(),
            refreshToken: rt,
            clientId: GY_CLIENT_ID,
          });
        }

        await svc.from("pan_bind_sessions").update({ last_poll_at: new Date().toISOString() }).eq("id", s.id);
        const errCode = String(d.error ?? "").toLowerCase();
        if (errCode.includes("slow_down")) {
          await svc
            .from("pan_bind_sessions")
            .update({ interval: Math.min(30, intervalSec * 2) })
            .eq("id", s.id);
          return ok({ status: "waiting" });
        }
        if (errCode.includes("authorization_pending")) return ok({ status: "waiting" });
        if (errCode.includes("access_denied")) {
          await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
          return ok({ status: "failed", message: "你取消了授权" });
        }
        if (errCode.includes("expired")) {
          await svc.from("pan_bind_sessions").update({ status: "expired" }).eq("id", s.id);
          return ok({ status: "expired" });
        }
        await svc.from("pan_bind_sessions").update({ status: "failed" }).eq("id", s.id);
        return ok({
          status: "failed",
          message: String(d.error_description ?? d.error ?? d.msg ?? `HTTP ${r.status}`),
        });
      }

      // ── 光鸭绑定（手动粘贴）：填入 Access Token / Refresh Token ──
      // 令牌取自光鸭官网登录后的本机存储：浏览器 localStorage 的 `credentials_<client_id>`。
      // 更推荐用「扫码授权」（panDeviceStart / panDevicePoll）：换回的凭证发给官方 client_id，
      // 之后能长期自动续期；粘贴浏览器那套令牌时 client_id 不是官方的，续期会被网关 404。
      case "panBindTokens": {
        if (isCron) return fail("定时任务不能绑定账号", 403);
        const pan = String(body.pan ?? "guangya");
        if (pan !== "guangya") return fail("仅光鸭使用令牌绑定，夸克请粘贴 Cookie", 400);

        const accessToken = String(body.accessToken ?? "").trim().replace(/^Bearer\s+/i, "");
        const refreshToken = String(body.refreshToken ?? "").trim();
        // client_id 固定用官方 SDK 那个（官方插件注明「勿改」）：光鸭账号网关按 client_id 路由，
        // 带浏览器那套 client_id 去续期会被判成未知客户端、返回 404 not_found，
        // 表现就是「令牌用着用着就续期失败」。
        const clientId = GY_CLIENT_ID;
        if (!accessToken && !refreshToken) {
          return fail("请至少填写 Refresh Token（光鸭官网本机存储里的 refresh_token）", 400);
        }

        // 校验策略与官方插件一致：有 refresh_token 就先用它换一次新令牌，
        // 既验证凭据有效，又顺便拿到最新 access_token（refresh_token 会轮换）。
        // 没有 refresh_token 时，才用 access_token 直接校验。
        // verified: true=可用 / false=明确无效 / null=无法校验（网络等原因）
        let verified: boolean | null = null;
        let username = "";
        let verifyMessage = "";
        let finalAccess = accessToken;
        let finalRefresh = refreshToken;

        if (refreshToken) {
          try {
            const r = await gyAccountPost(
              "/v1/auth/token",
              { client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken },
              {},
              { clientId, action: "401" }
            );
            const d = r.body;
            const at = typeof d.access_token === "string" ? d.access_token : "";
            if (r.status === 200 && at) {
              verified = true;
              finalAccess = at.replace(/^Bearer\s+/i, "").trim();
              if (typeof d.refresh_token === "string" && d.refresh_token) finalRefresh = d.refresh_token;
              username = String(d.sub ?? d.nickname ?? d.email ?? "");
            } else {
              verified = false;
              verifyMessage = `Refresh Token 校验失败：${String(
                d.error_description ?? d.error ?? d.msg ?? `HTTP ${r.status}`
              )}`;
            }
          } catch (e) {
            verified = null;
            verifyMessage = `换取令牌时网络异常：${(e as Error).message}`;
          }
        } else if (accessToken) {
          // 没有 refresh_token 时无法主动校验（官方插件也只用 refresh_token），
          // 直接存下 Access Token，实际可用性由后续调用反馈。
          verified = null;
          verifyMessage = "未提供 Refresh Token，跳过校验（Access Token 将直接使用）";
        }

        if (!finalAccess && !finalRefresh) {
          return fail(verifyMessage || "该凭据不可用，请重新复制", 400);
        }

        const { error } = await svc.rpc("save_pan_oauth", {
          p_user_id: userId!,
          p_pan: "guangya",
          p_username: username,
          p_token_json: JSON.stringify({
            access_token: finalAccess,
            refresh_token: finalRefresh,
            client_id: clientId,
          }),
          p_root_dir_id: null,
          p_key: CRED_KEY,
        });
        if (error) return fail(`保存光鸭凭据失败：${error.message}`, 500);
        await resumePausedSubs(userId!, "guangya");

        return ok({
          saved: true,
          verified,
          username: username || null,
          message:
            verified === true
              ? refreshToken
                ? "已用 Refresh Token 换取到新令牌，校验通过并加密保存"
                : "Access Token 校验通过，已加密保存"
              : verified === false
                ? `${verifyMessage || "令牌无效"}；已按原样保存，请确认复制的是当前登录会话的凭据`
                : `${verifyMessage || "已保存"}；未能联网校验，不影响后续使用`,
        });
      }

      /**
       * 迅雷令牌绑定（扫码之外的通道）
       *
       * 依据《迅雷网盘接口文档》(2026-10-17)：drive 业务接口放行需要「四件套」——
       * Authorization: Bearer + x-device-id + x-client-id + x-captcha-token。
       * 其中 device_id 取自浏览器 localStorage 的 deviceid（形如 wdi10.{40位hex}，
       * 去掉前缀取前 32 位），x-client-id 用 pan 主站的 Xqp0kJBXWhwaTpB6。
       * 扫码换来的令牌本身可用，但必须配同一个设备的 device_id 才有 client info，
       * 否则报 captcha_invalid（detail: "no client info found"）。
       */
      case "panBindXunleiToken": {
        if (isCron) return fail("定时任务不能绑定账号", 403);
        if (XUNLEI_LOCKED) return fail(XUNLEI_LOCKED_MSG, 403, "PAN_LOCKED");
        const at = String(body.accessToken ?? "").trim().replace(/^Bearer\s+/i, "");
        const rt = String(body.refreshToken ?? "").trim();
        const rawDev = String(body.deviceId ?? "").trim().toLowerCase();
        const clientId = String(body.clientId ?? "").trim() || XL_DRIVE_CLIENT_ID;
        const clientVersion = String(body.clientVersion ?? "").trim();
        const clientSecret = String(body.clientSecret ?? "").trim();
        const userAgent = String(body.userAgent ?? "").trim();
        /** 用户自带的 x-captcha-token（localStorage 的 captcha_{client_id}）；只用于本次校验，不入库 */
        const manualCaptcha = String(body.captchaToken ?? "").trim();

        // 设备号归一化：兼容 wdi10.xxx（40 位 hex 的设备签名）与原始 32 位 hex
        const devHex = rawDev.replace(/^wdi10\.?/, "");
        const deviceId = /^[0-9a-f]{32}/.test(devHex) ? devHex.slice(0, 32) : "";
        if (!at) return fail("请填写 Access Token（自己迅雷客户端请求头 Authorization 里那串）", 400);
        if (!deviceId) {
          return fail(
            "设备 ID 取不到：粘贴浏览器 localStorage 的 deviceid（形如 wdi10.xxxx…40位）或请求头 x-device-id（32 位 hex）",
            400
          );
        }

        // 种子优先用这次填的浏览器票；没填就沿用库里已有的（重新保存时不必再抓一次）
        let seed = manualCaptcha;
        if (!seed) {
          try {
            const prev = await loadPanCred(userId!, "xunlei");
            seed = prev?.xunlei?.captcha_seed?.trim() ?? "";
          } catch { /* 读旧凭据失败就当没有种子 */ }
        }

        const tokens: XlTokens = {
          access_token: at,
          ...(rt ? { refresh_token: rt } : {}),
          device_id: deviceId,
          client_id: clientId,
          ...(clientVersion ? { client_version: clientVersion } : {}),
          ...(clientSecret ? { client_secret: clientSecret } : {}),
          ...(userAgent ? { user_agent: userAgent } : {}),
          ...(seed ? { captcha_seed: seed } : {}),
        };

        // 1) 令牌本身是否有效：能取到昵称才说明是账号令牌（匿名/过期令牌这里就拦下）
        const me = await xlFetchJson(`${XL_AUTH}/v1/user/me`, {
          method: "GET",
          headers: { "User-Agent": tokens.user_agent ?? UA, Authorization: `Bearer ${at}` },
        });
        const nickname = String(me.json?.name ?? me.json?.nickname ?? "").trim();
        if (me.status !== 200 || !nickname) {
          const why = String(me.json?.error_description ?? me.json?.error ?? `HTTP ${me.status}`);
          return fail(`Access Token 校验失败：${why}`, 400);
        }

        // 2) 用这套身份真打一次列表：能过才说明设备档案存在（这是绑定的核心价值）
        const probeOnce = async (cap: string) => {
          const r = await xlFetchJson(
            `${XL_DRIVE}/files?parent_id=&page_size=1&with_audit=true&filters=${encodeURIComponent('{"trashed":{"eq":false}}')}`,
            { method: "GET", headers: { ...xlHeaders(tokens), ...(cap ? { "x-captcha-token": cap } : {}) } }
          );
          const detail = String(
            ((r.json?.error_details as Array<{ detail?: string }> | undefined) ?? [])[0]?.detail ?? ""
          );
          const desc = String(r.json?.error_description ?? r.json?.error ?? `HTTP ${r.status}`);
          return {
            ok: r.status === 200,
            detail,
            message: r.status === 200 ? "设备档案校验通过" : `${desc}${detail ? `（${detail}）` : ""}`,
          };
        };

        // 两条路都试，并分别回报：服务端自签风控票（长期自动运行靠这个）
        // 与用户会话里那枚（localStorage，会过期，只能救急）
        let minted = { ok: false, detail: "", message: "未执行" };
        let manual: { ok: boolean; detail: string; message: string } | null = null;
        try {
          minted = await probeOnce(await xlCaptchaToken(tokens, "GET:/drive/v1/files"));
          if (!minted.ok && manualCaptcha) manual = await probeOnce(manualCaptcha);
        } catch (e) {
          minted = { ok: false, detail: "", message: `列表接口校验异常：${(e as Error).message}` };
        }
        const probe = { ok: minted.ok || !!manual?.ok, detail: minted.detail, message: minted.message };
        const via = minted.ok ? "风控票（服务端自签）" : manual?.ok ? "风控票（你填的那枚）" : "";

        // 3) 加密落库（校验没过也存：用户可能只是设备号填错，就地改完再试更省事）
        const { error } = await svc.rpc("save_pan_oauth", {
          p_user_id: userId!,
          p_pan: "xunlei",
          p_username: nickname,
          p_token_json: JSON.stringify(tokens),
          p_root_dir_id: "",
          p_key: CRED_KEY,
        });
        if (error) return fail(`保存迅雷凭据失败：${error.message}`, 500);

        const hint =
          !probe.ok && /client info/i.test(probe.detail)
            ? "；这个设备号在迅雷侧没有档案，请改成浏览器 localStorage 里 deviceid 去掉 wdi10. 后的前 32 位"
            : !probe.ok && /captcha/i.test(probe.detail)
              ? "；可在下方补填浏览器 localStorage 里 captcha_<client_id> 的 token 再保存一次"
              : "";
        return ok({
          saved: true,
          verified: probe.ok,
          via,
          username: nickname,
          message: probe.ok
            ? `迅雷令牌已加密保存（${nickname}），四件套校验通过（${via}）`
            : `令牌已保存（${nickname}），但列表校验未通过：${probe.message}${hint}`,
        });
      }

      /**
       * 扫码后回填：把已保存的令牌交给前端预填「填入迅雷令牌」表单。
       *
       * 能回填：access_token、refresh_token、client_id（pan 主站固定 Xqp0kJBXWhwaTpB6）。
       * 不能回填：device_id —— 令牌是 JWT，声明只有 iss/sub/aud/exp/iat/at_hash/scope/meta，
       * 没有设备字段；设备号必须用浏览器 localStorage 里 deviceid（wdi10.xxx 取前 32 位），
       * 否则迅雷查不到 client info，就是 captcha_invalid 的成因。
       */
      case "panXunleiPrefill": {
        if (isCron) return fail("定时任务不能读取凭据", 403);
        const cred = await loadPanCred(userId!, "xunlei");
        if (!cred?.xunlei) return fail("还没有迅雷令牌，请先扫码登录", 400);
        const t = cred.xunlei;
        return ok({
          accessToken: t.access_token,
          refreshToken: t.refresh_token ?? "",
          // pan 主站 client（文档 1.4：x-client-id 固定 Xqp0kJBXWhwaTpB6）
          clientId: t.client_id?.trim() || XL_DRIVE_CLIENT_ID,
          clientVersion: t.client_version?.trim() ?? "",
          /**
           * 已有可用档案（带风控种子）就把设备号带回，重新扫码后不必再抓一次；
           * 从没绑过令牌的老数据（随机设备号、无种子）留空，等用户从浏览器补。
           */
          deviceId: t.captcha_seed ? (t.device_id ?? "") : "",
        });
      }

      // 网盘自检：光鸭/百度校验 OAuth 令牌是否可用；夸克用一条分享链接试跑转存
      case "panProbe": {
        if (isCron) return fail("定时任务不能探测", 403);
        const pan = String(body.pan ?? "guangya");

        if (pan === "baidu") {
          const cred = await loadPanCred(userId!, "baidu");
          if (!cred) return fail("未绑定百度网盘账号，请先在「网盘账号」里粘贴登录 Cookie", 400);
          // 只读探测：登录态校验 → 账号信息 → 列根目录，三项全通才说明 Cookie/bdstoken 都可用
          let authProbe: unknown;
          try {
            await baiduAuthCheck(cred);
            authProbe = { ok: true };
          } catch (e) {
            authProbe = { ok: false, error: (e as Error).message };
          }
          let accountProbe: unknown;
          try {
            const a = await baiduAccountInfo(cred);
            accountProbe = { ok: true, uk: a.uk, quota: a.quota };
          } catch (e) {
            accountProbe = { ok: false, error: (e as Error).message };
          }
          let dirsProbe: unknown;
          try {
            const dirs = await baiduListDirs(cred, "/");
            dirsProbe = {
              ok: true,
              dirCount: dirs.length,
              sample: dirs.slice(0, 5).map((d) => ({ path: d.id, name: d.name })),
            };
          } catch (e) {
            dirsProbe = { ok: false, error: (e as Error).message };
          }
          return ok({
            pan: "baidu",
            probe: {
              hint: "登录态校验、账号信息、根目录三项都成功即说明 Cookie 与 bdstoken 可用（只读，不写入任何数据）；失败原因见对应 error。",
              authCheck: authProbe,
              account: accountProbe,
              dirsProbe,
            },
          });
        }

        if (pan === "uc") {
          const cred = await loadPanCred(userId!, "uc");
          if (!cred) return fail("未绑定 UC 网盘账号，请先在「网盘账号」里粘贴登录 Cookie", 400);
          let authProbe: unknown;
          try {
            const chk = await quarkAuthCheck(cred.cookie ?? "", CD_UC);
            authProbe = chk.ok ? { ok: true } : { ok: false, error: chk.message };
          } catch (e) {
            authProbe = { ok: false, error: (e as Error).message };
          }
          let dirsProbe: unknown;
          try {
            const dirs = await quarkListDirs(cred.cookie ?? "", "", CD_UC);
            dirsProbe = { ok: true, dirCount: dirs.length, sample: dirs.slice(0, 5) };
          } catch (e) {
            dirsProbe = { ok: false, error: (e as Error).message };
          }
          return ok({
            pan: "uc",
            probe: {
              hint: "登录态校验与根目录读取都成功即说明 UC Cookie 可用（只读，不写入任何数据）；失败原因见对应 error。",
              authCheck: authProbe,
              dirsProbe,
            },
          });
        }

        if (pan === "p123") {
          const cred = await loadPanCred(userId!, "p123");
          if (!cred) return fail("未绑定 123 云盘账号，请先粘贴登录令牌（localStorage 的 authorToken）", 400);
          let authProbe: unknown;
          try {
            const chk = await p123AuthCheck(cred.token ?? "");
            authProbe = chk.ok ? { ok: true } : { ok: false, error: chk.message };
          } catch (e) {
            authProbe = { ok: false, error: (e as Error).message };
          }
          let dirsProbe: unknown;
          try {
            const dirs = await p123ListDirs(cred.token ?? "", "0");
            dirsProbe = { ok: true, dirCount: dirs.length, sample: dirs.slice(0, 5) };
          } catch (e) {
            dirsProbe = { ok: false, error: (e as Error).message };
          }
          return ok({
            pan: "p123",
            probe: {
              hint: "令牌校验与根目录读取都成功即说明 authorToken 可用（只读，不写入任何数据）；失败原因见对应 error。",
              authCheck: authProbe,
              dirsProbe,
            },
          });
        }

        if (pan === "xunlei") {
          const cred = await loadPanCred(userId!, "xunlei");
          if (!cred) return fail("未绑定迅雷账号，请先在「网盘账号」扫码登录", 400);
          let authProbe: unknown;
          try {
            const chk = await xlAuthCheck(cred);
            authProbe = chk.ok ? { ok: true, quota: chk.quota ?? null } : { ok: false, error: chk.message };
          } catch (e) {
            authProbe = { ok: false, error: (e as Error).message };
          }
          let dirsProbe: unknown;
          try {
            const dirs = await xlListDirs(cred, "");
            dirsProbe = { ok: true, dirCount: dirs.length, sample: dirs.slice(0, 5).map((d) => ({ id: d.id, name: d.name })) };
          } catch (e) {
            dirsProbe = { ok: false, error: (e as Error).message };
          }
          return ok({
            pan: "xunlei",
            probe: {
              hint: "登录态校验（/about）与根目录读取都成功即说明令牌可用；失败原因见对应 error（只读，不写入任何数据）。",
              authCheck: authProbe,
              dirsProbe,
            },
          });
        }

        if (pan === "guangya") {
          const cred = await loadPanCred(userId!, "guangya");
          if (!cred) return fail("未绑定光鸭账号，请先在「网盘账号」填入令牌", 400);

          // 只读探测：实际读一遍根目录，验证令牌与目录接口是否都可用
          let dirsProbe: unknown;
          try {
            const dirs = await gyListDirs(cred, "");
            dirsProbe = {
              ok: true,
              dirCount: dirs.length,
              sample: dirs.slice(0, 5).map((d) => ({ fileId: d.id, fileName: d.name })),
            };
          } catch (e) {
            dirsProbe = { ok: false, error: (e as Error).message };
          }

          return ok({
            pan: "guangya",
            probe: {
              hint: "读取根目录成功即说明令牌与目录接口都可用；失败原因见 dirsProbe.error。",
              dirsProbe,
            },
          });
        }

        const sample = String(body.shareUrl ?? "").trim();
        const cred = await loadPanCred(userId!, "quark");
        if (!cred) return fail("未绑定夸克账号", 400);
        if (!sample) return fail("请提供一个夸克分享链接作为样本", 400);
        // 自检必须只读：以前这里真的调了一次转存（dir=null → 直接落到网盘根目录），
        // 会把样本分享里的文件留在用户根目录里（历史事故：根目录出现 S01E11 这类文件）。
        // 现在只「打开分享 + 列目录」验证 Cookie，不做任何写操作。
        const probe = await quarkProbeShare(cred.cookie ?? "", sample, null);
        return ok({ pan: "quark", probe });
      }

      // ── 解析预览（不写库，用于调源） ──
      case "preview": {
        if (isCron) return fail("定时任务不支持 preview", 403);
        const sourceUrl = String(body.url ?? "").trim();
        if (!sourceUrl) return fail("请填写订阅源地址", 400);
        const keyword = String(body.keyword ?? "").trim() || null;
        const passcode = String(body.passcode ?? "").trim() || null;
        /** 文件名清洗模式：预览里顺带给出「清洗后」的名字（清洗后重名的，体积大的带「高码」） */
        const previewCleanMode = ["none", "episode"].includes(String(body.cleanMode))
          ? String(body.cleanMode)
          : "episode";

        // 源地址本身就是网盘分享链接 → 按「分享目录监控」解析：列出顶层条目
        const previewPan = detectPan(sourceUrl);
        if (previewPan) {
          const label = PAN_LABELS[previewPan] ?? previewPan;
          const cred = await loadPanCred(userId!, previewPan);
          if (!cred) {
            return fail(
              `这是${label}分享链接，需要先绑定${label}账号才能读取分享目录（到「网盘账号」绑定后重试）`,
              400,
              "PAN_NOT_BOUND"
            );
          }
          try {
            const entries = await listPanShareEntries(previewPan, cred, sourceUrl, passcode);
            const hit = entries.filter((e) => matchKeyword(e.title, keyword));
            const filesTotal = entries.reduce((n, e) => n + e.files.length, 0);
            return ok({
              contentType: "pan_share",
              isFeed: false,
              mode: "pan_share",
              pan: previewPan,
              total: entries.length,
              filtered: hit.length,
              hint: entries.length === 0
                ? "这个分享里没读到任何文件（分享可能已失效或目录为空）"
                : hit.length === 0
                  ? "分享里的条目全被「关键字过滤」排除了，请检查关键字"
                  : null,
              meta: {
                mode: "pan_share",
                pan: previewPan,
                anchorCount: 0,
                scriptLinks: 0,
                directLinks: entries.length,
                detailCandidates: entries.length,
                detailFollowed: entries.length,
                detailFailed: 0,
                detailLinks: filesTotal,
                sampleLinks: entries.slice(0, 8).map((e) => e.title),
              },
              items: hit.slice(0, 20).map((e) => {
                // 顺带算出「清洗后」的名字：清洗后重名的，体积大的那个带「高码」
                // （例：两个文件都清洗成 S01E12 → 大的叫 S01E12高码），
                // 让用户点「解析测试」时就能确认最终会写成什么名字。
                // 只回前几个：解析结果不需要全量展示，回太多前端一行放不下。
                const plan = planCleanedNames(e.files, previewCleanMode);
                return {
                  title: e.title,
                  shareUrl: sourceUrl,
                  sharePasscode: null,
                  pan: previewPan,
                  sourceUrl,
                  fileCount: e.files.length,
                  fileNames: e.files.slice(0, 3).map((f) => f.name),
                  cleanedNames: e.files
                    .slice(0, 3)
                    .map((f) => plan.get(f.name) ?? cleanFileFullName(f.name, previewCleanMode)),
                };
              }),
              /** 字段探测：条目名若显示异常，把这些字段名发我即可定位 */
              probe: entries[0]?.rawKeys ?? [],
            });
          } catch (e) {
            return fail(`读取分享目录失败：${(e as Error).message}`, 502);
          }
        }

        try {
          const { text, contentType } = await fetchSource(sourceUrl);
          const parsed = await parseSource(text, contentType, sourceUrl, String(body.sourceType ?? "auto"));
          const filtered = parsed.candidates.filter((c) => matchKeyword(c.title, keyword));
          const shown = filtered
            .slice(0, 20)
            .map((c) => ({ ...c, normalized: normalizeShareUrl(c.shareUrl) }));
          return ok({
            contentType,
            isFeed: parsed.meta.isFeed,
            total: parsed.candidates.length,
            filtered: filtered.length,
            hint: parseHint(parsed.meta, parsed.candidates.length, filtered.length),
            meta: parsed.meta,
            items: shown,
          });
        } catch (e) {
          return fail(`抓取失败：${(e as Error).message}`, 502);
        }
      }

      // ── 执行 ──
      case "run": {
        /**
         * 定时任务：按 id 执行单条，专供 `?mode=fanout` 的扇出调用。
         * 为什么要这样：自建 edge-runtime 上「长轮 + 轮内并发」（RUN_CONCURRENCY>1）跑几十秒后
         * 会被运行时停掉（心跳中断、在途锁泄漏、轮永不结算，实测 c=8/10/12/20 全中招）；
         * 而独立请求是真并行（实测 20 并发 ≈ 4.8 条/秒）。所以把并发单位从「轮内 worker」
         * 换成「独立 isolate」，每条请求只干一条订阅的活。
         */
        if (isCron) {
          const cronId = String(body.id ?? url.searchParams.get("id") ?? "").trim();
          if (!cronId) return fail("缺少 id", 400);
          const { data: row } = await svc
            .from("subscriptions")
            .select("id, enabled, run_lock_at")
            .eq("id", cronId)
            .maybeSingle<{ id: string; enabled: boolean | null; run_lock_at: string | null }>();
          if (!row || row.enabled !== true) return ok({ skipped: true, reason: "订阅不存在或未启用" });
          // 别人正在跑（锁还新鲜）就跳过；只有死锁残留才抢，避免同一条被转存两次
          if (row.run_lock_at && Date.now() - new Date(row.run_lock_at).getTime() < SUB_LOCK_TAKEOVER_MS) {
            return ok({ skipped: true, reason: "该订阅正在执行中" });
          }
          const startedAtCron = new Date().toISOString();
          let claim = svc.from("subscriptions").update({ run_lock_at: startedAtCron }).eq("id", cronId);
          claim = row.run_lock_at ? claim.eq("run_lock_at", row.run_lock_at) : claim.is("run_lock_at", null);
          const { data: claimedRow } = await claim.select("*").maybeSingle<SubRow>();
          if (!claimedRow) return ok({ skipped: true, reason: "并发抢占失败" });
          /**
           * 解锁必须挂在「真正在跑的那份」上：看门狗让位后我们提前返回了，但后台还在跑，
           * 这时候若立刻解锁，下一轮又会挑中同一条 → 同一批文件被转存两次。
           */
          const work = runSubscription(claimedRow, startedAtCron);
          void work
            .then(() => undefined, () => undefined)
            .finally(() =>
              svc
                .from("subscriptions")
                .update({ run_lock_at: null })
                .eq("id", cronId)
                .then(() => undefined, () => undefined)
            );

          // 单条看门狗：大订阅 / 网盘偏慢时不让调度器一直等（否则一波就吃掉整个预算）
          let timer: ReturnType<typeof setTimeout> | undefined;
          const watchdog = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), SUB_DEADLINE_MS);
          });
          try {
            const res = await Promise.race([work, watchdog]);
            if (res === null) {
              return ok({
                id: claimedRow.id,
                name: claimedRow.name,
                watchdog: true,
                message: `超过 ${Math.round(SUB_DEADLINE_MS / 1000)}s 未结束，已让位（后台会自己跑完并解锁）`,
              });
            }
            return ok({ id: claimedRow.id, name: claimedRow.name, ...res });
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }

        const { data: sub } = await svc
          .from("subscriptions")
          .select("*")
          .eq("id", String(body.id))
          .eq("user_id", userId!)
          .maybeSingle<SubRow>();
        if (!sub) return fail("订阅不存在", 404);
        const res = await runSubscription(sub);
        // 手动「执行」= 用户重新绑定凭证后的激活动作：本次不再是凭据问题就自动恢复检测
        if (sub.paused_reason === "credential" && !isCredentialIssue(res.message)) {
          await svc.from("subscriptions").update({
            enabled: true,
            paused_reason: null,
            cred_fail_count: 0,
            cred_fail_at: null,
            last_message: `${res.message}。【已恢复】凭证已可用，订阅已自动重新启用`,
          }).eq("id", sub.id);
        }
        return ok(res);
      }

      case "runAll": {
        const now = Date.now();
        // 定时任务每分钟触发一次，这里按每个订阅的「检查时间」判断是否到点（手动触发用 force 忽略）
        const force = body.force === true;
        /** 定时任务的「一轮」：单轮互斥 + 轮转公平；手动触发（force）不参与限流 */
        const isRound = isCron && !force;

        if (isRound) {
          const { data: got, error: lockErr } = await svc.rpc("claim_subscription_round", {
            p_stale_seconds: ROUND_STALE_SECONDS,
          });
          if (lockErr) return fail(`获取调度锁失败：${lockErr.message}`, 500);
          if (got !== true) {
            // 上一轮还在跑：直接跳过，避免每分钟新起一轮、几十个订阅同时抢光鸭代理
            return ok({ accepted: false, mode: "busy", message: "上一轮订阅检查仍在执行，本次触发已跳过" });
          }
        }

        let q = svc.from("subscriptions").select("*").eq("enabled", true);
        if (!isCron) q = q.eq("user_id", userId!);
        // 公平轮转：最久没检查的排最前（从未跑过的最优先），保证每个订阅都能轮到
        const { data: subs, error } = await q
          .order("last_run_at", { ascending: true, nullsFirst: true })
          .limit(600);
        if (error) {
          if (isRound) {
            try {
              await svc.rpc("finish_subscription_round", { p_ran: 0, p_due: 0, p_note: `读取订阅失败：${error.message}` });
            } catch { /* 释放失败不影响返回 */ }
          }
          return fail(`读取订阅失败：${error.message}`, 500);
        }

        const all = (subs ?? []) as Array<
          SubRow & { interval_minutes: number; last_run_at: string | null; run_lock_at: string | null }
        >;
        const due = all.filter((s) => {
          // 上一轮还在跑（或被平台中途杀掉留下标记）→ 跳过，避免同一批文件被转存两次
          if (s.run_lock_at && now - new Date(s.run_lock_at).getTime() < RUN_LOCK_TTL_MS) return false;
          if (force) return true;
          // 深夜静默（北京 01:00-07:00）：所有账号（含管理员）一律 2 小时一次。
          // 放在固定节奏 / 智能检测 next_check_at / 严格间隔之前，确保夜间不会更频繁。
          if (inQuietNight(now)) {
            if (!s.last_run_at) return true;
            return now - new Date(s.last_run_at).getTime() >= QUIET_NIGHT_MINUTES * 60_000 - DUE_TOLERANCE_MS;
          }
          // 账号级固定节奏策略（特殊码账号）：北京 07:00-24:00 每 15 分钟，00:00-07:00 每 60 分钟。
          // 动态判定（不是静态 interval_minutes），所以跨 0 点/早上 7 点会自动切换，无需定时任务改字段。
          const policyMin = policyIntervalMinutes(s.schedule_policy, now);
          if (policyMin !== null) {
            if (!s.last_run_at) return true;
            return now - new Date(s.last_run_at).getTime() >= policyMin * 60_000 - DUE_TOLERANCE_MS;
          }
          // 智能检测：按服务端算好的「下次检查时间」到点与否判断（每次执行结束都会重算）
          if (s.adaptive_enabled !== false && s.next_check_at) {
            return now >= new Date(s.next_check_at).getTime() - DUE_TOLERANCE_MS;
          }
          if (!s.last_run_at) return true;
          const intervalMs = Math.max(1, Math.min(1440, s.interval_minutes ?? 1)) * 60_000;
          return now - new Date(s.last_run_at).getTime() >= intervalMs - DUE_TOLERANCE_MS;
        });

        // 定时任务走共享密钥、无法判定单用户：这里在已算好的 due（已含「到点/执行锁」判断）
        // 之上，再按订阅归属用户的「订阅功能权限」过滤——未开通的用户其订阅一律跳过
        // （管理员始终可运行）。用户态（非 cron）已在入口处硬性拒绝。
        if (isCron) {
          const { data: allowed } = await svc
            .from("profiles")
            .select("id")
            .or(`subscriptions_enabled.eq.true,role.eq.admin`);
          const allowedIds = new Set((allowed ?? []).map((p: { id: string }) => p.id));
          const filtered = due.filter((s) => allowedIds.has(s.user_id));
          due.length = 0;
          due.push(...filtered);
        }

        // 定时任务每轮最多开始 MAX_SUBS_PER_ROUND 个（跑不完的按 last_run_at 顺序留给下一轮）
        const targets = isRound ? due.slice(0, MAX_SUBS_PER_ROUND) : due;

        /**
         * ── 扇出模式（`?action=runAll&mode=fanout`）──
         * 用「一波 N 个独立 isolate 的短请求」替代「一轮内的并发 worker」：
         *   · 轮内并发在自建 edge-runtime 上跑几十秒就会被停掉（心跳中断 + 锁泄漏 + 轮不结算）；
         *   · 独立请求是真并行（实测 20 并发 ≈ 4.8 条/秒，116~287 条/分钟）。
         * 自己只负责按时序发请求并把结果等回来（每条的工作在它自己的 isolate 里跑），
         * 这样单轮处理量由「波次 × 每波并发」决定，不再受单核串行 46 条/分钟的天花板限制。
         * 参数：RUN_FANOUT（每波条数，默认 16）、RUN_FANOUT_BUDGET_MS（本轮时间预算，默认同 ROUND_BUDGET_MS）。
         */
        const fanMode = (url.searchParams.get("mode") ?? String(body.mode ?? "")).trim() === "fanout";
        if (isRound && fanMode) {
          const waveSize = Math.max(1, Math.min(64, Number(Deno.env.get("RUN_FANOUT") ?? 16)));
          /**
           * 预算要留出安全边际：运行时对 isolate 有墙钟配额，超了会先警告再 early termination
           * （实测后台轮跑到 60s 上下就被杀掉，留下的锁要等下一轮接管）。所以调度器自己
           * 控制在 40s 内收工并正常 finish，比被硬杀干净得多。
           */
          const fanBudgetMs = Math.max(10_000, Math.min(120_000, Number(Deno.env.get("RUN_FANOUT_BUDGET_MS") ?? 40_000)));
          /**
           * 单次自调用的超时。为什么不是「看门狗 + 3s」：慢 callee 会把最后一波拖到 20s，
           * 把调度器 isolate 的总墙钟顶到运行时上限（~50s）而被 early termination 杀掉，
           * 结果轮不结算、锁泄漏。改成 9s：卡住的调用直接放弃（被调度方仍在后台跑，
           * 它的锁会在 SUB_LOCK_TAKEOVER_MS 后被接管），一波最多拖 9s，整轮稳在预算内。
           */
          const callTimeoutMs = Math.max(3_000, Math.min(SUB_DEADLINE_MS + 3_000, Number(Deno.env.get("RUN_FANOUT_CALL_MS") ?? 9_000)));
          const startedAtFan = Date.now();
          // 自调用走 Kong（cron 也是从这个地址进来的），去掉原有 query 后只留 action=run
          const selfUrl = new URL(req.url);
          selfUrl.search = "";
          selfUrl.searchParams.set("action", "run");

          const beat = setInterval(() => {
            void svc.rpc("touch_subscription_round").then(() => undefined, () => undefined);
          }, ROUND_HEARTBEAT_MS);

          let dispatched = 0;
          let httpBad = 0;
          const job = (async () => {
            for (let c = 0; c < targets.length; c += waveSize) {
              if (Date.now() - startedAtFan > fanBudgetMs) break;
              const wave = targets.slice(c, c + waveSize);
              const codes = await Promise.all(
                wave.map((s) =>
                  fetch(selfUrl.toString(), {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      "x-subscription-secret": CRON_SECRET,
                    },
                    body: JSON.stringify({ id: s.id }),
                    // 卡死的自调用到点就放弃（它的锁会在 SUB_LOCK_TAKEOVER_MS 后被接管），
                    // 否则一波里只要有一条不回，整轮就停在那里等着被运行时杀掉
                    signal: AbortSignal.timeout(callTimeoutMs),
                  })
                    .then((r) => r.status)
                    .catch(() => 0)
                )
              );
              dispatched += wave.length;
              httpBad += codes.filter((x) => x !== 200).length;
            }
            try {
              await svc.rpc("finish_subscription_round", {
                p_ran: dispatched,
                p_due: due.length,
                p_note:
                  `扇出 ${dispatched} 条（每波 ${waveSize}，耗时 ${Math.round((Date.now() - startedAtFan) / 1000)}s）` +
                  (httpBad > 0 ? `；${httpBad} 次自调用未成功` : ""),
              });
            } catch { /* 释放失败：等心跳超时后由下一轮接管 */ }
          })()
            .catch((e) => console.error("[runAll] 扇出执行异常", e))
            .finally(() => clearInterval(beat));

          if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime?.waitUntil === "function") {
            EdgeRuntime.waitUntil(job);
          } else {
            await job;
          }
          return ok({
            accepted: true,
            mode: "fanout",
            due: due.length,
            planned: targets.length,
            wave: waveSize,
            budgetMs: fanBudgetMs,
          });
        }

        const runDue = async (): Promise<unknown[]> => {
          const results: unknown[] = [];
          const roundStart = Date.now();
          let stoppedByBudget = false;
          /** 本轮有多少条订阅触发看门狗（超时让位） */
          let watchdogs = 0;
          /**
           * 轮内并发度：以前是 1（串行），因为光鸭请求要走 pg_net 那条单 worker 队列，
           * 并发只会让大家一起排队、撞超时。现在光鸭已改走自建中继（单请求 130~280ms），
           * 并发才真正有意义 —— 定时任务默认 5，可用 RUN_CONCURRENCY 调（1~100）；
           * 手动触发（用户点「全部执行」）保持串行，避免一次点爆。
           * 注意：并发过高的风险在光鸭侧（是否限流未知），出问题就把它调小。
           */
          const parallelism = isRound
            ? Math.max(1, Math.min(100, Number(Deno.env.get("RUN_CONCURRENCY") ?? 5)))
            : 1;

          let cursor = 0;
          const worker = async (): Promise<void> => {
            for (;;) {
              // 时间预算：到点就不再开始新订阅（在途的跑完），避免被平台硬杀在半路
              if (isRound && Date.now() - roundStart > ROUND_BUDGET_MS) {
                stoppedByBudget = true;
                return;
              }
              const s = targets[cursor++];
              if (!s) return;

              // 抢占执行权：并发触发时只有一个 isolate 能改成功（CAS），避免重复转存
              const startedAt = new Date().toISOString();
              let claim = svc.from("subscriptions").update({ run_lock_at: startedAt }).eq("id", s.id);
              claim = s.run_lock_at ? claim.eq("run_lock_at", s.run_lock_at) : claim.is("run_lock_at", null);
              const { data: claimed } = await claim.select("id").maybeSingle();
              if (!claimed) continue;

              try {
                // 单订阅看门狗：到点就让位。后台那份**不取消** —— 它会把已开始的批次跑完并正常写库/解锁，
                // 所以这里绝不能走下面的失败分支（那会解锁 → 下一轮与它重复转存）。
                let watchdog: ReturnType<typeof setTimeout> | undefined;
                const deadline = new Promise<never>((_, reject) => {
                  watchdog = setTimeout(
                    () =>
                      reject(
                        new Error(
                          `${WATCHDOG_PREFIX}本轮超过 ${Math.round(SUB_DEADLINE_MS / 1000)} 秒仍未结束（大订阅 / 网盘偏慢），本轮先让位`
                        )
                      ),
                    SUB_DEADLINE_MS
                  );
                });
                let res: Awaited<ReturnType<typeof runSubscription>>;
                try {
                  res = await Promise.race([runSubscription(s, startedAt), deadline]);
                } catch (e) {
                  const m = (e as Error).message ?? "";
                  if (!m.startsWith(WATCHDOG_PREFIX)) throw e;
                  watchdogs++;
                  const note = m.slice(WATCHDOG_PREFIX.length);
                  results.push({ id: s.id, name: s.name, watchdog: true, message: note });
                  continue;
                } finally {
                  if (watchdog !== undefined) clearTimeout(watchdog);
                }
                results.push({ id: s.id, name: s.name, ...res });
                continue;
              } catch (e) {
                // 异常兜底：解锁 + 把原因写进 last_message（否则界面上什么都看不到），
                // 并把下次检查推到 10 分钟后 —— 持续失败的订阅不能每一轮都占着队首，
                // 否则按「最久没检查的优先」排序时会饿死其它订阅。
                const msg = `执行异常：${(e as Error).message}`;
                await svc
                  .from("subscriptions")
                  .update({
                    run_lock_at: null,
                    last_status: "failed",
                    last_message: msg,
                    next_check_at: new Date(Date.now() + 10 * 60_000).toISOString(),
                    checks_since_update: Number(s.checks_since_update ?? 0) + 1,
                  })
                  .eq("id", s.id);
                results.push({ id: s.id, name: s.name, message: msg });
              }
            }
          };

          // 并发跑（每个 worker 依次从 targets 里取下一个，claim 用 CAS 保证不重复）
          const workers = Math.max(1, Math.min(parallelism, targets.length || 1));
          await Promise.all(Array.from({ length: workers }, () => worker()));

          if (isRound) {
            try {
              await svc.rpc("finish_subscription_round", {
                p_ran: results.length,
                p_due: due.length,
                p_note: [
                  stoppedByBudget ? `达到本轮时间上限（${Math.round(ROUND_BUDGET_MS / 1000)}s），剩余留给下一轮` : "",
                  watchdogs > 0
                    ? `${watchdogs} 条订阅超过 ${Math.round(SUB_DEADLINE_MS / 1000)}s 未结束，已让位给下一轮（后台会自己跑完并解锁）`
                    : "",
                ].filter(Boolean).join("；") || null,
              });
            } catch { /* 释放失败：等心跳超时后由下一轮接管 */ }
          }
          return results;
        };

        // 定时任务：先返回，再在后台跑（waitUntil）。
        // 必须这么做：pg_cron 是用 net.http_post 调进来的，若让这次请求一直挂着等函数跑完，
        // pg_net 唯一的工作线程就被它独占——函数运行中发往光鸭的请求只能排队等它先发出去，
        // 实测排队 36.6 秒才真正发出（而调用方只等 12 秒），于是每一轮订阅都必然失败、
        // 永远走不到「列目录 → 转存」。立刻返回即可让那些请求马上被处理。
        if (isRound) {
          // 心跳：跑的过程中定期续期，函数被平台中途杀掉后锁能在 ROUND_STALE_SECONDS 后自动失效
          const beat = setInterval(() => {
            void svc.rpc("touch_subscription_round").then(() => undefined, () => undefined);
          }, ROUND_HEARTBEAT_MS);
          const job = runDue()
            .catch((e) => console.error("[runAll] 后台执行异常", e))
            .finally(() => clearInterval(beat));
          if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime?.waitUntil === "function") {
            EdgeRuntime.waitUntil(job);
          } else {
            await job; // 兜底：运行时不支持 waitUntil 时退回同步执行
          }
          return ok({
            accepted: true,
            mode: "background",
            due: due.length,
            running: targets.length,
            skipped: (subs ?? []).length - due.length,
          });
        }

        const results = await runDue();
        return ok({ ran: results.length, skipped: (subs ?? []).length - results.length, results });
      }

      // ── 条目 ──
      case "items": {
        let q = svc
          .from("subscription_items")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(Math.min(200, Number(body.limit) || 50));
        if (!isCron) q = q.eq("user_id", userId!);
        if (body.subscriptionId) q = q.eq("subscription_id", String(body.subscriptionId));
        if (body.status) q = q.eq("status", String(body.status));
        const { data, error } = await q;
        if (error) return fail(`读取条目失败：${error.message}`, 500);
        return ok({ items: data ?? [] });
      }

      case "retryItem": {
        if (isCron) return fail("定时任务不支持 retryItem", 403);
        const { data: item } = await svc
          .from("subscription_items")
          .select("*")
          .eq("id", String(body.id))
          .eq("user_id", userId!)
          .maybeSingle();
        if (!item) return fail("条目不存在", 404);
        const { data: sub } = await svc.from("subscriptions").select("*").eq("id", item.subscription_id).maybeSingle<SubRow>();
        if (!sub) return fail("订阅不存在", 404);
        // 重置为 pending 后重跑该订阅的未完成条目
        await svc.from("subscription_items").update({ status: "pending", error: null }).eq("id", item.id);
        return ok(await runSubscription(sub));
      }

      /**
       * 一次性维护：清理「历史上被订阅转存进来的文本文件」。
       *   · 光鸭：列目标目录 → 按文件名匹配 → 批量删除网盘文件 → 删掉对应转存记录
       *   · 夸克：没有删除接口，只清记录（文件需用户在网盘里自行删除）
       * 默认 dry_run=true（只报告将删什么，不动网盘）；dry_run=false 才真正删除。
       */
      /**
       * 一次性维护：把「某份内容」放进「指定目录下的每个子文件夹」各一份。
       * 两种来源：
       *   · mode=share（默认）：从分享转存 —— 只能用于「别人的分享」；自己的分享会被站点拒绝
       *     （restore_share 报「不能转存自己的分享」）。
       *   · mode=copy：盘内复制（/userres/v1/file/copy_file，未公开接口，由探测确认存在）——
       *     用于「文件本来就在自己网盘里」的场景，传 file_ids 即可，无需分享。
       * dry_run=true（默认）只报告将写入哪些目录；dry_run=false 才真正写入。
       * 目录多时可分批：dir_offset + max_dirs，直到 next_offset 为 null。
       */
      case "oneoff_share_to_subdirs": {
        const uid = String(body.userId ?? "").trim();
        if (!uid) return fail("需要 userId", 400);
        const rawMode = String(body.mode ?? "share");
        const mode = rawMode === "copy" ? "copy" : rawMode === "verify" ? "verify" : "share";
        const shareUrl = String(body.share_url ?? "").trim();
        const shareId = mode === "share" ? gyParseShareId(shareUrl) : null;
        if (mode === "share" && !shareId) {
          return fail("分享链接无法解析（需 guangyapan.com/s/… 形式）", 400);
        }
        const givenIds = Array.isArray(body.file_ids)
          ? (body.file_ids as unknown[]).map((x) => String(x)).filter(Boolean)
          : [];
        if (mode === "copy" && givenIds.length === 0) {
          return fail("mode=copy 需要 file_ids（要复制的盘内文件 id）", 400);
        }
        const dirName = String(body.parent_dir ?? "").trim();
        if (!dirName) return fail("需要 parent_dir（父目录名，如 日-更）", 400);
        const dryRun = body.dry_run !== false;
        const maxDirs = Math.min(500, Math.max(1, Number(body.max_dirs) || 20));
        const offset = Math.max(0, Number(body.dir_offset) || 0);
        const searchDepth = Math.min(4, Math.max(0, Number(body.search_depth) ?? 2));

        const cred = await loadPanCred(uid, "guangya");
        if (!cred) return fail("该用户未绑定光鸭账号", 400, "PAN_NOT_BOUND");

        // 手动一次性任务：可以显式带上「非剧集内容」（如 .docx 说明文档、图片）——
        // 订阅转存的那套过滤规则仍然照旧生效，这里只在带 include_non_content 时放开。
        const keepAll = body.include_non_content === true;

        // 1) 来源文件清单（verify 模式只需要目录，不需要来源）
        let files: ShareFile[] = [];
        let skippedContent = 0;
        if (mode === "verify") {
          files = [];
        } else if (mode === "copy") {
          files = givenIds.map((id) => ({ id, name: `file:${id}`, size: null }));
        } else {
          try {
            const sat = await gyShareAccessToken(cred, shareId!);
            const all: ShareFile[] = [];
            await gyCollectLeafFilesNamed(cred, sat, "", all);
            const filtered = dropNonContent(all);
            skippedContent = filtered.skipped;
            files = keepAll ? all : filtered.files;
          } catch (e) {
            return fail(`读取分享内容失败：${(e as Error).message}`, 502);
          }
        }
        if (mode !== "verify" && files.length === 0) {
          return fail(
            `分享里没有可转存的文件${skippedContent > 0 ? `（${skippedContent} 个图片/文档已被过滤，如需强制转存请带 include_non_content）` : ""}`,
            400
          );
        }

        // 2) 找父目录（名字相等或包含），并递归其下级
        const parents: Array<{ id: string; name: string; path: string }> = [];
        const walk = async (parentId: string, path: string, depth: number): Promise<void> => {
          const dirs = await gyListDirs(cred, parentId);
          for (const d of dirs) {
            const p = path ? `${path}/${d.name}` : d.name;
            if (d.name === dirName || d.name.includes(dirName)) parents.push({ ...d, path: p });
            if (depth < searchDepth) await walk(d.id, p, depth + 1);
          }
        };
        try {
          await walk(cred.rootDirId ?? "", "", 0);
        } catch (e) {
          return fail(`遍历目录失败：${(e as Error).message}`, 502);
        }
        if (parents.length === 0) return fail(`没找到名为「${dirName}」的目录`, 404);

        // 3) 父目录下的所有子文件夹（去重 + 稳定排序 + 取本批）
        const seen = new Set<string>();
        const targets: Array<{ id: string; name: string; parent: string }> = [];
        for (const p of parents) {
          const subs = await gyListFolder(cred, p.id, { maxPages: 50 });
          for (const it of subs) {
            const id = String(it.fileId ?? "");
            if (!id || Number(it.resType ?? 2) !== 2 || seen.has(id)) continue;
            seen.add(id);
            targets.push({ id, name: gyFieldName(it), parent: p.path });
          }
        }
        targets.sort(
          (a, b) => a.parent.localeCompare(b.parent, "zh-CN") || a.name.localeCompare(b.name, "zh-CN")
        );
        const batch = targets.slice(offset, offset + maxDirs);

        // verify：逐个目录检查是否已存在指定文件名（用于确认复制是否落地 / 找漏网目录）
        if (mode === "verify") {
          const matchName = String(body.match_name ?? "").trim();
          if (!matchName) return fail("verify 模式需要 match_name（要检查的文件名）", 400);
          const out: Array<Record<string, unknown>> = [];
          for (const t of batch) {
            try {
              const list = await gyListFolder(cred, t.id, { files: true, maxPages: 10, refresh: true });
              const hit = list.some((it) => gyFieldName(it) === matchName);
              out.push({ dir: `${t.parent}/${t.name}`, id: t.id, has: hit });
            } catch (e) {
              out.push({ dir: `${t.parent}/${t.name}`, id: t.id, error: (e as Error).message });
            }
          }
          return ok({
            mode: "verify",
            match_name: matchName,
            target_total: targets.length,
            offset,
            checked: out.length,
            has: out.filter((o) => o.has === true).length,
            missing: out.filter((o) => o.has === false).map((o) => o.dir),
            errors: out.filter((o) => o.error).map((o) => ({ dir: o.dir, error: o.error })),
            next_offset: offset + batch.length < targets.length ? offset + batch.length : null,
          });
        }

        if (dryRun) {
          return ok({
            dry_run: true,
            share_id: shareId,
            file_count: files.length,
            files: files.map((f) => f.name),
            parents: parents.map((p) => p.path),
            target_total: targets.length,
            offset,
            this_batch: batch.length,
            targets: batch.map((t) => `${t.parent}/${t.name}`),
          });
        }

        // 4) 逐个子文件夹写入
        //    · copy 模式：走未公开接口 /userres/v1/file/copy_file（盘内复制，秒级、不走流量）
        //    · share 模式：走 gyTransferFiles（分享转存，单目录超 50 个 fileId 会内部分批）
        const results: Array<Record<string, unknown>> = [];
        for (const t of batch) {
          if (mode === "copy") {
            try {
              await gyCall(
                cred,
                "/userres/v1/file/copy_file",
                { fileIds: files.map((f) => f.id), parentId: t.id },
                { retryTransient: false }
              );
              results.push({ dir: `${t.parent}/${t.name}`, ok: true, message: "已复制" });
            } catch (e) {
              results.push({ dir: `${t.parent}/${t.name}`, ok: false, message: (e as Error).message });
            }
            continue;
          }
          const r = await gyTransferFiles(cred, shareUrl, files, t.id);
          results.push({
            dir: `${t.parent}/${t.name}`,
            ok: r.ok,
            transferred: r.transferred ?? 0,
            message: r.message,
          });
        }
        return ok({
          dry_run: false,
          mode,
          file_count: files.length,
          target_total: targets.length,
          offset,
          done: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          next_offset: offset + batch.length < targets.length ? offset + batch.length : null,
          results,
        });
      }

      /**
       * 一次性排查：通用 HTTP 探测（在本 Edge 网络里发请求，返回状态码 + 前若干字符）。
       * 用于确认「某个站点接口在服务端是否可达、返回的是 JSON 还是 SPA 页面」。
       */
      case "oneoff_http_probe": {
        const calls = Array.isArray(body.calls) ? (body.calls as Array<Record<string, unknown>>) : [];
        if (calls.length === 0) return fail("需要 calls", 400);
        const out: Array<Record<string, unknown>> = [];
        for (const c of calls.slice(0, 20)) {
          const url = String(c.url ?? "");
          const method = String(c.method ?? "GET").toUpperCase();
          const headers = (c.headers ?? {}) as Record<string, string>;
          const limit = Math.min(6000, Math.max(100, Number(c.limit) || 800));
          try {
            const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(20000), redirect: 'manual' });
            const text = await res.text();
            const heads: Record<string, string> = {};
            res.headers.forEach((v, k) => { if (k !== 'set-cookie') heads[k] = v.slice(0, 200); });
            out.push({ url, status: res.status, len: text.length, headers: heads, body: text.slice(0, limit) });
          } catch (e) {
            out.push({ url, error: (e as Error).message });
          }
        }
        return ok({ results: out });
      }

      /**
       * 一次性排查：找出「同一个文件出现两份」的目录。
       * 检查三种重复形态（文件夹模式最容易踩前两种）：
       *   ① 同一目录内重名文件（同名两份）；
       *   ② 根目录文件 与 某个子文件夹内文件 同名（整目录转存后又在根目录平铺了一份）；
       *   ③ 同名子文件夹出现多次（整目录被重复转存）。
       */
      case "oneoff_scan_dupes": {
        const uid = String(body.userId ?? "").trim();
        let folders = Array.isArray(body.folders)
          ? (body.folders as Array<Record<string, unknown>>).map((f) => ({
              id: String(f.id ?? ""),
              label: String(f.label ?? f.id ?? ""),
            })).filter((f) => f.id)
          : [];
        if (!uid) return fail("需要 userId", 400);
        const cred = await loadPanCred(uid, "guangya");
        if (!cred) return fail("该用户未绑定光鸭账号", 400);

        // 也可以给 parent_dir：直接把它的所有子文件夹作为扫描对象（分批：dir_offset + max_dirs）
        const parentDirName = String(body.parent_dir ?? "").trim();
        if (folders.length === 0 && parentDirName) {
          const depthLimit = Math.min(3, Math.max(0, Number(body.search_depth) ?? 0));
          const offset = Math.max(0, Number(body.dir_offset) || 0);
          const maxDirs = Math.min(60, Math.max(1, Number(body.max_dirs) || 40));
          const hits: Array<{ id: string; path: string }> = [];
          const walk = async (parentId: string, path: string, depth: number): Promise<void> => {
            const dirs = await gyListDirs(cred, parentId);
            for (const d of dirs) {
              const p = path ? `${path}/${d.name}` : d.name;
              if (d.name.includes(parentDirName)) hits.push({ id: d.id, path: p });
              if (depth < depthLimit) await walk(d.id, p, depth + 1);
            }
          };
          await walk(cred.rootDirId ?? "", "", 0);
          const subs: Array<{ id: string; label: string }> = [];
          for (const h of hits) {
            for (const d of await gyListDirs(cred, h.id)) subs.push({ id: d.id, label: `${h.path}/${d.name}` });
          }
          subs.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
          folders = subs.slice(offset, offset + maxDirs);
          if (folders.length === 0) return ok({ note: "没有匹配的目录", total: subs.length, offset });
        }
        if (folders.length === 0) return fail("需要 folders 或 parent_dir", 400);
        const nameOf = (x: Record<string, unknown>) => String(x.fileName ?? "");
        const out: Array<Record<string, unknown>> = [];

        for (const f of folders.slice(0, 60)) {
          try {
            const rootFiles = await gyListFolder(cred, f.id, { files: true, maxPages: 20, refresh: true });
            const dirs = await gyListFolder(cred, f.id, { maxPages: 20, refresh: true });
            const rootNames = rootFiles.map(nameOf).filter(Boolean);
            const dirNames = dirs.map(nameOf).filter(Boolean);
            const count = (arr: string[]) => {
              const m = new Map<string, number>();
              for (const n of arr) m.set(n, (m.get(n) ?? 0) + 1);
              return [...m.entries()].filter(([, c]) => c > 1).map(([n, c]) => `${n} ×${c}`);
            };

            const subs: Array<Record<string, unknown>> = [];
            for (const d of dirs.slice(0, 30)) {
              const did = String(d.fileId ?? "");
              const dn = nameOf(d);
              if (!did) continue;
              const sf = await gyListFolder(cred, did, { files: true, maxPages: 10, refresh: true });
              const sNames = sf.map(nameOf).filter(Boolean);
              const cross = sNames.filter((n) => rootNames.includes(n));
              const innerDup = count(sNames);
              if (cross.length || innerDup.length) {
                subs.push({
                  dir: dn,
                  files: sNames.length,
                  与根目录同名: cross.slice(0, 10),
                  目录内重名: innerDup.slice(0, 10),
                });
              }
            }
            out.push({
              label: f.label,
              id: f.id,
              根目录文件数: rootNames.length,
              根目录重名: count(rootNames).slice(0, 15),
              根目录同名子文件夹: count(dirNames).slice(0, 10),
              子文件夹名样本: dirNames.slice(0, 12),
              有重复的子文件夹: subs,
            });
          } catch (e) {
            out.push({ label: f.label, id: f.id, error: (e as Error).message });
          }
        }
        const scanned = folders.slice(0, 60).length;
        const next = Number(body.dir_offset || 0) + scanned;
        return ok({
          folders: out,
          scanned,
          next_offset: next,
        });
      }

      /**
       * 扫描（并可选清理）某用户光鸭订阅目标目录里的重复内容。
       *
       * 背景：重复转存留下的垃圾有好几种形态，oneoff_scan_dupes 只查「同名重名」，
       * 覆盖不到下面这些真正常见的：
       *   · 内部名条目：光鸭转存落地时先给一个乱名（无扩展名）副本，内容就是那一集；
       *   · `剧名 (1)` 这类重复文件夹：整目录转存/重试留下的；
       *   · 同体积多份：同集被转了两次、文件名不同但内容一样；
       *   · 同名多份（含 `(1)` 后缀）。
       * 默认 dry_run=true 只报告；确认后再传 dry_run=false + 明确的 fileIds 才真删。
       */
      case "scan_duplicates": {
        const uid = String(body.userId ?? "").trim();
        if (!uid) return fail("需要 userId", 400);
        const dryRun = body.dry_run !== false;
        const onlySub = typeof body.subscriptionId === "string" ? String(body.subscriptionId) : null;
        const maxDirs = Math.min(200, Math.max(1, Number(body.max_dirs) || 60));
        const dirOffset = Math.max(0, Number(body.dir_offset) || 0);
        const cred = await loadPanCred(uid, "guangya");
        if (!cred) return fail("该用户未绑定光鸭账号", 400, "PAN_NOT_BOUND");

        // 递归列目录下的全部文件（带 fileId/体积/**gcid 内容哈希**），带深度上限
        const listDeep = async (
          folderId: string,
          selfName: string,
          depth = 0
        ): Promise<Array<{ id: string; name: string; size: number; gcid: string; dirId: string; dirName: string; createdAt: string }>> => {
          if (!folderId || depth > 6) return [];
          const out: Array<{ id: string; name: string; size: number; gcid: string; dirId: string; dirName: string; createdAt: string }> = [];
          let items: Array<Record<string, unknown>> = [];
          try {
            items = await gyListFolder(cred, folderId, { files: true, maxPages: 100, refresh: true, strict: true });
          } catch { return []; }
          for (const it of items) {
            const id = String(it.fileId ?? "");
            if (!id) continue;
            if (Number(it.resType ?? 1) === 2) {
              // 子目录：把自己的名字传下去，文件才能标明「自己在哪个文件夹里」
              out.push(...(await listDeep(id, gyFieldName(it), depth + 1)));
            } else {
              // 光鸭的创建时间字段名不固定，按常见几个都取一次（排查「这批文件什么时候进来的」要用）
              const ts = it.createTime ?? it.create_time ?? it.createdAt ?? it.created_at ?? it.updateTime ?? it.modifyTime;
              const numTs = Number(ts);
              out.push({
                id,
                name: String(it.fileName ?? ""),
                size: Number(it.fileSize ?? 0) || 0,
                // gcid = 内容哈希，只有它相同才是「真重复」；仅体积相同不能作为删除依据
                gcid: String(it.gcid ?? ""),
                dirId: folderId,
                dirName: selfName || "（根目录）",
                createdAt: Number.isFinite(numTs) && numTs > 0 ? new Date(numTs).toISOString() : "",
              });
            }
          }
          return out;
        };

        let sq = svc.from("subscriptions").select("id,name,target_dir,folder_mode").eq("user_id", uid).eq("pan", "guangya");
        if (onlySub) sq = sq.eq("id", onlySub);
        const { data: subs, error: sErr } = await sq;
        if (sErr) return fail(`查询订阅失败：${sErr.message}`, 500);

        const report: Array<Record<string, unknown>> = [];
        let toDelete = 0;
        for (const sub of ((subs ?? []) as Array<Record<string, unknown>>).slice(dirOffset, dirOffset + maxDirs)) {
          const dirId = sub.target_dir != null ? String(sub.target_dir) : (cred.rootDirId ?? "");
          if (!dirId) continue;
          try {
            const files = await listDeep(dirId, "（根目录）");
            // 1) 内部名条目（无扩展名）
            const strays = files.filter((f) => f.name && !/\.[A-Za-z0-9]{2,5}$/.test(f.name));
            // 2) 同名多份（含 (1)/(2) 后缀归一化后同名）
            const norm = (n: string) => n.replace(/\s*\(\d+\)(?=\.[A-Za-z0-9]{2,5}$|$)/, "").trim();
            const byName = new Map<string, typeof files>();
            for (const f of files) {
              const k = norm(f.name).toLowerCase();
              byName.set(k, [...(byName.get(k) ?? []), f]);
            }
            const sameName = [...byName.entries()].filter(([, v]) => v.length > 1)
              .map(([k, v]) => ({ key: k, files: v.map((f) => ({ id: f.id, name: f.name, size: f.size, gcid: f.gcid })) }));
            // 3) 【真重复】gcid 相同 = 内容完全一样，才是可安全删除的重复副本。
            //    注意：只用「体积相同」判断会误伤 `S01E01.mp4` + `S01E01高码.mp4` 这类
            //    订阅自身的「高码」版本配对（同体积但属于不同版本命名），绝不能按体积删。
            const byGcid = new Map<string, typeof files>();
            for (const f of files) {
              if (!f.gcid) continue;
              byGcid.set(f.gcid, [...(byGcid.get(f.gcid) ?? []), f]);
            }
            const trueDupes = [...byGcid.entries()].filter(([, v]) => v.length > 1)
              .map(([g, v]) => ({
                gcid: g,
                size: v[0].size,
                // 同一文件夹内的重复 = 可安全删除的重复转存副本；
                // 跨文件夹的同内容文件 = 多半是「整目录转存 + 根下平铺副本」，只报告不动手
                sameFolder: new Set(v.map((f) => f.dirName)).size === 1,
                files: v.map((f) => ({ id: f.id, name: f.name, size: f.size, dir: f.dirName })),
              }));
            // 4) `剧名 (1)` 重复文件夹
            let dirs: Array<Record<string, unknown>> = [];
            try {
              dirs = await gyListFolder(cred, dirId, { maxPages: 100, refresh: true, strict: true });
            } catch { /* 忽略 */ }
            const dirDup = dirs.map((d) => ({ id: String(d.fileId ?? ""), name: gyFieldName(d) }))
              .filter((d) => /\(\d+\)$/.test(d.name));

            if (strays.length || sameName.length || trueDupes.length || dirDup.length || body.dump_files === true) {
              report.push({
                subscription: String(sub.name ?? ""),
                dir: dirId,
                folderMode: sub.folder_mode === true,
                totalFiles: files.length,
                strays,
                sameName,
                trueDupes,
                dirDup,
                // 明细：排查「明明看到多了一份」这类问题时需要看到真实文件名/体积/内容哈希
                ...(body.dump_files === true
                  ? {
                      files: files.map((f) => ({
                        id: f.id,
                        name: f.name,
                        size: f.size,
                        gcid: f.gcid,
                        dir: f.dirName,
                        createdAt: f.createdAt,
                      })),
                    }
                  : {}),
              });
              if (!dryRun && trueDupes.length) {
                // 安全阀：**只在同一个文件夹内部**判重复并删除。
                // 跨文件夹的同内容文件可能是「整目录转存 + 根下平铺副本」那种结构，
                // 删错会让某个文件夹少内容，属于破坏性操作，这里一律只报告不动手
                // （那类由 cleanup_flat_duplicates 单独处理）。
                const rank = (n: string) =>
                  (/高码/.test(n) ? 2 : 0) + (/\(\d+\)/.test(n) ? 1 : 0);
                const delIds = new Set<string>();
                for (const g of trueDupes) {
                  if (!g.sameFolder) continue;
                  const sorted = [...g.files].sort((a, b) => rank(a.name) - rank(b.name) || a.id.localeCompare(b.id));
                  for (const f of sorted.slice(1)) delIds.add(f.id);
                }
                const ids = [...delIds];
                if (ids.length) await gyDeleteFiles(cred, ids);
                toDelete += ids.length;
              }
            }
          } catch (e) {
            report.push({ subscription: String(sub.name ?? ""), error: e instanceof Error ? e.message : String(e) });
          }
        }
        return ok({ dry_run: dryRun, deleted: toDelete, count: report.length, report });
      }

      /**
       * 按 fileId 批量删除光鸭文件（人工清理用）。
       * 删除不可逆，因此必须显式 confirm=true 才会真正执行，否则只回报将要删除的清单。
       */
      /**
       * 一次性工具：把某个订阅目标目录里**当前已有的文件**登记为「本订阅转存过的」。
       *
       * 为什么需要：pan_file_id 是新加的列，历史转存的文件在这一列上是空的，
       * 于是「同集旧版本清理」的归属校验不通过 —— 明明是订阅自己转存上去的旧版本，
       * 也会因为「分不清是不是用户的文件」而不敢删，清理功能等于对老数据失效。
       * 这个动作把「归属」补记上来，清理才能认得出该删谁。
       *
       * 谨慎：会把目录里**所有**文件都标成该订阅的，包括用户自己放进去的。
       * 因此只做一次性人工使用（需 confirm=true），不做成自动流程。
       */
      case "claim_owned_files": {
        const uid = String(body.userId ?? "").trim();
        const subId = String(body.subscriptionId ?? "").trim();
        if (!uid || !subId) return fail("需要 userId 与 subscriptionId", 400);
        const { data: sub, error: sErr } = await svc
          .from("subscriptions")
          .select("id,user_id,pan,target_dir,name")
          .eq("id", subId)
          .eq("user_id", uid)
          .maybeSingle();
        if (sErr) return fail(`查询订阅失败：${sErr.message}`, 500);
        if (!sub) return fail("订阅不存在或不属于该用户", 404);
        const pan = String(sub.pan ?? "guangya");
        if (pan !== "guangya") return fail(`目前只支持光鸭（当前：${pan}）`, 400);
        const cred = await loadPanCred(uid, pan);
        if (!cred) return fail("该用户未绑定光鸭账号", 400, "PAN_NOT_BOUND");

        const dirId = sub.target_dir != null ? String(sub.target_dir) : (cred.rootDirId ?? "");
        if (!dirId) return fail("该订阅没有转存目录", 400);
        let items: Array<Record<string, unknown>> = [];
        try {
          items = await gyListFolder(cred, dirId, { files: true, maxPages: 200, refresh: true, strict: true });
        } catch (e) {
          return fail(`读取目录失败：${(e as Error).message}`, 502);
        }
        const files = items
          .filter((x) => Number(x.resType ?? 1) !== 2)
          .map((x) => ({ id: String(x.fileId ?? ""), name: gyFieldName(x) }))
          .filter((x) => x.id && x.name);

        if (body.confirm !== true) {
          return ok({ dry_run: true, subscription: sub.name, dir: dirId, files: files.length, sample: files.slice(0, 10) });
        }

        // 用独立前缀存成基线行：只用来登记「归属」，不参与去重判定（去重看 file_key）
        const rows = files.map((f) => ({
          subscription_id: subId,
          user_id: uid,
          file_key: `claimed::${f.id}`,
          file_name: f.name,
          pan_file_id: f.id,
        }));
        for (let i = 0; i < rows.length; i += 200) {
          const { error } = await svc
            .from("subscription_transferred")
            .upsert(rows.slice(i, i + 200), { onConflict: "subscription_id,file_key" });
          if (error) return fail(`登记归属失败：${error.message}`, 500);
        }
        return ok({ dry_run: false, subscription: sub.name, claimed: rows.length });
      }

      case "delete_pan_files": {
        const uid = String(body.userId ?? "").trim();
        if (!uid) return fail("需要 userId", 400);
        const pan = String(body.pan ?? "guangya");
        const ids = Array.isArray(body.file_ids) ? (body.file_ids as unknown[]).map((x) => String(x)).filter(Boolean) : [];
        if (ids.length === 0) return fail("需要 file_ids（要删除的文件 id 数组）", 400);
        if (body.confirm !== true) return ok({ dry_run: true, would_delete: ids.length, file_ids: ids });

        const deleted = await deletePanFilesByIds(uid, pan, ids);
        return ok({ dry_run: false, deleted, requested: ids.length });
      }
      /** 一次性排查：按候选路径逐个探测光鸭接口（原样返回 status/body，用于发现未文档化的接口） */
      case "oneoff_gy_probe": {
        const uid = String(body.userId ?? "").trim();
        const calls = Array.isArray(body.calls) ? (body.calls as Array<Record<string, unknown>>) : [];
        if (!uid || calls.length === 0) return fail("需要 userId 与 calls", 400);
        const cred = await loadPanCred(uid, "guangya");
        if (!cred) return fail("该用户未绑定光鸭账号", 400);
        const out: Array<Record<string, unknown>> = [];
        for (const c of calls.slice(0, 40)) {
          const path = String(c.path ?? "");
          const cbody = (c.body ?? {}) as Record<string, unknown>;
          try {
            const r = await gyHttp("api", path, cbody, {
              bearer: cred.tokens?.access_token ?? "",
              clientId: cred.tokens?.client_id ?? GY_CLIENT_ID,
              timeoutMs: 15000,
            });
            out.push({ path, status: r.status, body: r.body });
          } catch (e) {
            out.push({ path, error: (e as Error).message });
          }
        }
        return ok({ results: out });
      }

      /** 一次性维护：删除夸克网盘里的文件/目录（进回收站，可恢复）；传 fids，或用 parent_dir + names 按名字删 */
      case "oneoff_quark_delete": {
        const uid = String(body.userId ?? "").trim();
        if (!uid) return fail("需要 userId", 400);
        const cred = await loadPanCred(uid, "quark");
        if (!cred?.cookie) return fail("该用户未绑定夸克账号", 400, "PAN_NOT_BOUND");
        let fids = Array.isArray(body.fids) ? (body.fids as unknown[]).map((x) => String(x)).filter(Boolean) : [];
        const parentDir = String(body.parent_dir ?? "").trim();
        const names = Array.isArray(body.names) ? (body.names as unknown[]).map((x) => String(x)) : [];
        if (fids.length === 0 && parentDir && names.length > 0) {
          const res = await fetch(
            `${QUARK_BASE}/file/sort?${QUARK_QS}&pdir_fid=${parentDir}&_page=1&_size=200&_fetch_total=1&_sort=file_type:asc,updated_at:desc`,
            {
              headers: { Cookie: cred.cookie, "User-Agent": UA, Referer: "https://pan.quark.cn/" },
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            }
          );
          const j = await res.json().catch(() => null);
          const list = (j?.data?.list ?? []) as Array<Record<string, unknown>>;
          fids = list
            .filter((it) => names.includes(String(it.file_name ?? "")))
            .map((it) => String(it.fid ?? ""))
            .filter(Boolean);
        }
        if (fids.length === 0) return fail("没有找到要删除的条目（检查 fids 或 parent_dir+names）", 404);
        const deleted = await quarkDeleteFiles(cred.cookie, fids);
        return ok({ deleted, fids });
      }

      /** 一次性排查：列出某夸克分享的目录结构（只读；用于确认链接可读、目录/文件构成、目录是否带 token） */
      case "oneoff_quark_share_ls": {
        const uid = String(body.userId ?? "").trim();
        const shareUrl = String(body.share_url ?? "").trim();
        if (!uid || !shareUrl) return fail("需要 userId 与 share_url", 400);
        const cred = await loadPanCred(uid, "quark");
        if (!cred?.cookie) return fail("该用户未绑定夸克账号", 400, "PAN_NOT_BOUND");
        const maxDepth = Math.min(3, Math.max(0, Number(body.max_depth) || 1));
        const sess = await quarkOpenShare(cred.cookie, shareUrl, String(body.passcode ?? "") || null);
        if ("error" in sess) return fail(`打开分享失败：${sess.error}`, 502);
        const walk = async (pdirFid: string, depth: number): Promise<Array<Record<string, unknown>>> => {
          const list = await quarkListDir(sess, pdirFid);
          const out: Array<Record<string, unknown>> = [];
          for (const it of list) {
            const fid = String(it.fid ?? "");
            const isDir = it.dir === true;
            const node: Record<string, unknown> = {
              fid,
              name: String(it.file_name ?? ""),
              dir: isDir,
              size: Number(it.size ?? it.file_size ?? 0) || null,
              // 关键：目录自身有没有 share_fid_token（决定能否「按目录整存」）
              has_token: !!it.share_fid_token,
            };
            if (isDir && depth < maxDepth) node.children = await walk(fid, depth + 1);
            out.push(node);
          }
          return out;
        };
        const countNodes = (nodes: Array<Record<string, unknown>>): { dirs: number; files: number } => {
          let dirs = 0;
          let files = 0;
          for (const n of nodes) {
            if (n.dir === true) {
              dirs++;
              const c = countNodes((n.children as Array<Record<string, unknown>>) ?? []);
              dirs += c.dirs;
              files += c.files;
            } else {
              files++;
            }
          }
          return { dirs, files };
        };
        const top = await walk("0", 0);
        const base = {
          share_id: sess.shareId,
          top_count: top.length,
          total: countNodes(top),
          tree: top.slice(0, 60),
        };
        // save_test=true：真跑一次「按目录整存」，验证夸克是否保留子目录（写入测试目录，可手动删除）
        if (body.save_test !== true) return ok(base);
        const rawTop = await quarkListDir(sess, "0");
        const wantFid = String(body.fid ?? "").trim();
        const picked = wantFid
          ? rawTop.find((x) => String(x.fid ?? "") === wantFid)
          : (rawTop.find((x) => x.dir === true) ?? rawTop[0]);
        if (!picked) return fail("分享里没有条目", 404);
        const pFid = String(picked.fid ?? "");
        const pName = String(picked.file_name ?? "");
        const pToken = (picked.share_fid_token as string) ?? null;
        const qHeaders = {
          Cookie: cred.cookie,
          "Content-Type": "application/json",
          "User-Agent": UA,
          Referer: "https://pan.quark.cn/",
        };
        // 1) 目标目录：用传入的，或自建一个测试目录
        let targetDir = String(body.target_dir ?? "").trim();
        let createdTestDir: string | null = null;
        if (!targetDir) {
          const testName = String(body.test_dir_name ?? "").trim() || `_文件夹模式测试${Date.now().toString().slice(-6)}`;
          const cRes = await fetch(`${QUARK_BASE}/file?${QUARK_QS}`, {
            method: "POST",
            headers: qHeaders,
            body: JSON.stringify({ pdir_fid: "0", file_name: testName, dir_path: "", dir_init_lock: false }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          const cj = await cRes.json().catch(() => null);
          targetDir = String(cj?.data?.fid ?? "");
          createdTestDir = targetDir || null;
          if (!targetDir) return fail(`创建测试目录失败：${cj?.message ?? cRes.status}`, 502);
        }
        // 2) 关键实验：把「目录」本身交给 sharepage/save
        const sRes = await fetch(`${QUARK_BASE}/share/sharepage/save?${QUARK_QS}`, {
          method: "POST",
          headers: qHeaders,
          body: JSON.stringify({
            fid_list: [pFid],
            fid_token_list: [pToken],
            to_pdir_fid: targetDir,
            pwd_id: sess.shareId,
            stoken: sess.stoken,
            pdir_fid: "0",
            scene: "link",
            create_new_folder: false,
          }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const sj = await sRes.json().catch(() => null);
        const taskId = sj?.data?.task_id as string | undefined;
        let taskStatus: number | null = null;
        for (let i = 0; i < 10 && taskId; i++) {
          await wait(1500);
          const tRes = await fetch(`${QUARK_BASE}/task?${QUARK_QS}&task_id=${taskId}&retry_index=${i}`, {
            headers: qHeaders,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          const tJson = await tRes.json().catch(() => null);
          taskStatus = Number(tJson?.data?.status ?? 0) || null;
          if (taskStatus === 2 || taskStatus === 3) break;
        }
        // 3) 回读目标目录，判断落地形态
        const listDirWithIds = async (parentFid: string) => {
          const res = await fetch(
            `${QUARK_BASE}/file/sort?${QUARK_QS}&pdir_fid=${parentFid}&_page=1&_size=200&_fetch_total=1&_sort=file_type:asc,updated_at:desc`,
            { headers: qHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
          );
          const j = await res.json().catch(() => null);
          return ((j?.data?.list ?? []) as Array<Record<string, unknown>>).map((it) => ({
            id: String(it.fid ?? ""),
            name: String(it.file_name ?? ""),
            dir: it.dir === true,
          }));
        };
        const landed = await listDirWithIds(targetDir).catch(() => []);
        const hitDir = landed.find((x) => x.dir && x.name.trim() === pName.trim());
        let inside: Array<{ name: string; dir: boolean }> = [];
        if (hitDir) {
          inside = (await listDirWithIds(hitDir.id).catch(() => [])).slice(0, 40).map((x) => ({ name: x.name, dir: x.dir }));
        }
        return ok({
          ...base,
          save_test: {
            picked: { fid: pFid, name: pName, dir: picked.dir === true, has_token: !!pToken },
            save_status: sj?.status ?? null,
            save_message: sj?.message ?? null,
            task_status: taskStatus,
            target_dir: targetDir,
            created_test_dir: createdTestDir,
            landed_dirs: landed.filter((x) => x.dir).map((x) => x.name),
            landed_files: landed.filter((x) => !x.dir).map((x) => x.name).slice(0, 40),
            folder_preserved: !!hitDir,
            inside_sample: inside,
          },
        });
      }

      /** 一次性排查：原样列出某光鸭分享的顶层内容（含字段名），用于确认链接是否可读 */
      case "oneoff_share_ls": {
        const uid = String(body.userId ?? "").trim();
        const shareUrl = String(body.share_url ?? "").trim();
        const shareId = gyParseShareId(shareUrl);
        if (!uid || !shareId) return fail("需要 userId 与可解析的分享链接", 400);
        const cred = await loadPanCred(uid, "guangya");
        if (!cred) return fail("该用户未绑定光鸭账号", 400);
        try {
          const sat = await gyShareAccessToken(cred, shareId);
          const top = await gyListShareFiles(cred, sat, "");
          const leaves: ShareFile[] = [];
          await gyCollectLeafFilesNamed(cred, sat, "", leaves);
          return ok({
            share_id: shareId,
            sat_prefix: sat.slice(0, 8),
            top_count: top.length,
            top: top.slice(0, 30).map((it) => ({
              fileId: String(it.fileId ?? ""),
              name: gyFieldName(it),
              resType: it.resType ?? null,
              size: it.fileSize ?? null,
              keys: Object.keys(it),
            })),
            leaf_count: leaves.length,
            leaf_sample: leaves.slice(0, 30).map((f) => f.name),
          });
        } catch (e) {
          return fail(`读取分享失败：${(e as Error).message}`, 502);
        }
      }

      case "cleanup_text_transfers": {
        const dryRun = body.dry_run !== false;
        const limit = Math.min(5000, Math.max(1, Number(body.limit) || 2000));
        const onlyUser = typeof body.userId === "string" ? String(body.userId) : null;
        // 由 TEXT_EXTENSIONS 生成正则，避免两处规则不一致
        const textRe = `\\.(${[...TEXT_EXTENSIONS].join("|")})$`;

        let q = svc
          .from("subscription_transferred")
          .select("id, subscription_id, user_id, file_name, subscriptions!inner(id, pan, user_id, target_dir)")
          .filter("file_name", "imatch", textRe)
          .limit(limit);
        if (onlyUser) q = q.eq("user_id", onlyUser);
        const { data: rows, error } = await q;
        if (error) return fail(`查询转存记录失败：${error.message}`, 500);

        const textRows = (rows ?? []) as Array<Record<string, unknown>>;
        // 按「用户 + 网盘 + 目标目录」分组：同目录只列一次目录
        const groups = new Map<string, { pan: string; userId: string; dir: string | null; rows: Array<Record<string, unknown>> }>();
        for (const r of textRows) {
          const sub = (r.subscriptions ?? {}) as Record<string, unknown>;
          const pan = String(sub.pan ?? "");
          const uid = String(sub.user_id ?? r.user_id ?? "");
          const dir = sub.target_dir != null ? String(sub.target_dir) : null;
          const key = `${uid}|${pan}|${dir ?? ""}`;
          const g = groups.get(key) ?? { pan, userId: uid, dir, rows: [] };
          g.rows.push(r);
          groups.set(key, g);
        }

        const report: Array<Record<string, unknown>> = [];
        let deletedFiles = 0;
        let removedRecords = 0;
        for (const g of groups.values()) {
          const names = new Set(g.rows.map((r) => String(r.file_name)));
          const recordIds = g.rows.map((r) => String(r.id));
          if (g.pan !== "guangya") {
            report.push({ pan: g.pan, dir: g.dir, files: [...names], note: "该网盘没有删除接口，仅清记录（文件请手动删除）" });
            if (!dryRun) {
              const { error: e2 } = await svc.from("subscription_transferred").delete().in("id", recordIds);
              if (!e2) removedRecords += recordIds.length;
            }
            continue;
          }
          try {
            const cred = await loadPanCred(g.userId, "guangya");
            if (!cred) throw new Error("没有可用的光鸭凭据（账号可能未绑定或已失效）");
            const list = await gyListFolder(cred, g.dir ?? "", { files: true, maxPages: 100, refresh: true });
            const hits = list
              .map((x) => ({ id: String(x.fileId ?? ""), name: String(x.fileName ?? "") }))
              .filter((x) => x.id && names.has(x.name));
            const hitNames = new Set(hits.map((h) => h.name));
            report.push({
              pan: "guangya",
              dir: g.dir,
              matched: [...hitNames],
              not_found: [...names].filter((n) => !hitNames.has(n)),
            });
            if (!dryRun && hits.length > 0) {
              deletedFiles += await gyDeleteFiles(cred, hits.map((h) => h.id));
              const { error: e3 } = await svc.from("subscription_transferred").delete().in("id", recordIds);
              if (!e3) removedRecords += recordIds.length;
            }
          } catch (e) {
            report.push({ pan: "guangya", dir: g.dir, files: [...names], error: (e as Error).message });
          }
        }

        return ok({
          dry_run: dryRun,
          text_records: textRows.length,
          deleted_files: deletedFiles,
          removed_records: removedRecords,
          groups: report,
        });
      }

      /**
       * 一次性维护：清掉「文件夹模式」转存时被光鸭平铺到目标目录的重复副本。
       *  判据：目标目录**根下**的文件，若在它的某个子文件夹里存在「同名 + 同体积」的一份 →
       *        根下那份是平铺副本，删掉（文件夹里那份保留）。
       *  默认 dry_run=true 只报告；body.dry_run=false 才真正删除。可只传 subscriptionId。
       */
      case "cleanup_flat_duplicates": {
        const dryRun = body.dry_run !== false;
        const onlySub = typeof body.subscriptionId === "string" ? String(body.subscriptionId) : null;

        interface FlatFile { id: string; name: string; size: number }
        const listDeep = async (cred: PanCred, folderId: string, depth = 0): Promise<FlatFile[]> => {
          // 同上：维护/核对用的递归也放宽到 6 层，避免深层文件被漏掉
          if (!folderId || depth > 6) return [];
          const out: FlatFile[] = [];
          let items: Array<Record<string, unknown>> = [];
          try {
            items = await gyListFolder(cred, folderId, { files: true, maxPages: 100, refresh: true });
          } catch { return []; }
          for (const it of items) {
            const id = String(it.fileId ?? "");
            if (!id) continue;
            if (Number(it.resType ?? 1) === 2) {
              out.push(...(await listDeep(cred, id, depth + 1)));
            } else {
              out.push({ id, name: String(it.fileName ?? ""), size: Number(it.fileSize ?? 0) || 0 });
            }
          }
          return out;
        };

        let q = svc
          .from("subscriptions")
          .select("id, name, user_id, target_dir")
          .eq("folder_mode", true)
          .eq("pan", "guangya");
        if (onlySub) q = q.eq("id", onlySub);
        const { data: subs, error } = await q;
        if (error) return fail(`查询订阅失败：${error.message}`, 500);

        const report: Array<Record<string, unknown>> = [];
        let deleted = 0;
        for (const sub of (subs ?? []) as Array<Record<string, unknown>>) {
          try {
            const cred = await loadPanCred(String(sub.user_id), "guangya");
            if (!cred) { report.push({ subscription: sub.name, error: "没有可用的光鸭凭据" }); continue; }
            const dirId = sub.target_dir != null ? String(sub.target_dir) : (cred.rootDirId ?? "");
            // 根下文件夹 + 根下文件：两份列表（files:true 不含文件夹）
            const rootDirs = await gyListFolder(cred, dirId, { maxPages: 20, refresh: true });
            const rootFiles = await gyListFolder(cred, dirId, { files: true, maxPages: 20, refresh: true });
            const root: Array<Record<string, unknown>> = [
              ...rootDirs.map((x) => ({ ...x, resType: 2 })),
              ...rootFiles.map((x) => ({ ...x, resType: 1 })),
            ];
            const dirs = root
              .filter((x) => Number(x.resType ?? 1) === 2)
              .map((x) => ({ id: String(x.fileId ?? ""), name: String(x.fileName ?? "") }));
            // 关键：文件夹内那份保留分享原名，根下那份可能已被清洗成 S01E01 →
            // 不能按文件名比，改按「体积」比对（同体积 + 该体积存在于某个子文件夹里 = 平铺副本）；
            // 拿不到体积时退回「同名」比对，避免误判。
            const keyOf = (name: string, size: number): string => (size > 0 ? `s:${size}` : `n:${name}`);
            const inside = new Map<string, string>();
            for (const d of dirs) {
              for (const f of await listDeep(cred, d.id)) inside.set(keyOf(f.name, f.size), f.id);
            }
            const dupes = root
              .filter((x) => Number(x.resType ?? 1) !== 2)
              .map((x) => ({
                id: String(x.fileId ?? ""),
                key: keyOf(String(x.fileName ?? ""), Number(x.fileSize ?? 0) || 0),
                name: String(x.fileName ?? ""),
              }))
              .filter((x) => x.id && inside.has(x.key) && inside.get(x.key) !== x.id);
            report.push({
              subscription: String(sub.name ?? ""),
              dir: dirId,
              folders: dirs.map((d) => d.name),
              duplicates: dupes.map((d) => d.key),
            });
            if (!dryRun && dupes.length > 0) {
              deleted += await gyDeleteFiles(cred, dupes.map((d) => d.id));
            }
          } catch (e) {
            report.push({ subscription: String(sub.name ?? ""), error: e instanceof Error ? e.message : String(e) });
          }
        }
        return ok({ dry_run: dryRun, deleted, subscriptions: report });
      }

      // 特殊账号不活跃状态（7 天无转存 → 冻结；14 天 → 禁用）：前端提示 + 一次性解冻
      case "inactivityStatus": {
        const { data: prof } = await svc
          .from("profiles")
          .select("frozen_at, frozen_reason, unfreeze_used, disabled_at")
          .eq("id", userId!)
          .maybeSingle();
        return ok({ state: prof ?? null });
      }

      case "unfreezeAccount": {
        const { data: prof } = await svc
          .from("profiles")
          .select("frozen_at, unfreeze_used, disabled_at")
          .eq("id", userId!)
          .maybeSingle();
        if (!prof) return fail("账号不存在", 404);
        if (prof.disabled_at) {
          return fail("账号已被禁用（14 天无转存记录），无法自助解冻，请联系管理员", 400);
        }
        if (!prof.frozen_at) return fail("账号当前未被冻结", 400);
        if (prof.unfreeze_used) return fail("解冻机会已使用过（每人仅一次）", 400);

        await svc
          .from("profiles")
          .update({ frozen_at: null, frozen_reason: null, unfreeze_used: true })
          .eq("id", userId!);
        const { data: rows } = await svc
          .from("subscriptions")
          .update({ enabled: true, paused_reason: null, next_check_at: new Date().toISOString() })
          .eq("user_id", userId!)
          .eq("paused_reason", "inactive_freeze")
          .select("id");
        const restored = rows?.length ?? 0;
        return ok({ restored, message: `解冻成功，已恢复 ${restored} 个订阅的检测（解冻机会已用完）` });
      }

      case "clearItems": {
        if (isCron) return fail("定时任务不支持 clearItems", 403);
        let q = svc.from("subscription_items").delete().eq("user_id", userId!);
        if (body.subscriptionId) q = q.eq("subscription_id", String(body.subscriptionId));
        if (body.onlyFailed === true) q = q.eq("status", "failed");
        const { error } = await q;
        if (error) return fail(`清理失败：${error.message}`, 500);
        // 连同转存基线一起清空（清成功条目才清基线；「只清失败条目」时基线不动），
        // 否则「清空重跑」会被基线挡住、无法重新转存缺失的文件。
        if (body.onlyFailed !== true) {
          let bq = svc.from("subscription_transferred").delete().eq("user_id", userId!);
          if (body.subscriptionId) bq = bq.eq("subscription_id", String(body.subscriptionId));
          await bq;
        }
        return ok({ cleared: true });
      }

      default:
        // 常见于「前端已更新、Edge Function 还没重新部署」——把处置方式写进报错里
        return fail(
          `不支持的 action: ${action}。若该功能是刚加的，说明线上还是旧版本：` +
            `请在项目目录执行 supabase functions deploy subscription-run --no-verify-jwt`,
          400
        );
    }
  } catch (e) {
    return fail((e as Error).message || "订阅转存服务异常", 500);
  }
});

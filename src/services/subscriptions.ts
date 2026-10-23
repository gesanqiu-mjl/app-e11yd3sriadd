/**
 * 订阅转存（RSS / 网页更新页 → 网盘转存 → 自动入库）
 *
 * 所有写操作都走边缘函数 subscription-run：
 *   - 网盘 Cookie 在服务端加密存储，前端拿不到明文
 *   - 抓取 / 解析 / 去重 / 转存 / 入库 全在服务端完成
 */
import { supabase } from '@/db/supabase';

export type PanKey = 'guangya' | 'quark' | 'baidu' | 'xunlei' | 'uc' | 'p123';

export const PAN_LABELS: Record<PanKey, string> = {
  guangya: '光鸭云盘',
  quark: '夸克网盘',
  baidu: '百度网盘',
  xunlei: '迅雷云盘',
  uc: 'UC网盘',
  p123: '123云盘',
};

/** 网盘账号（凭据已加密，前端只看得到元信息） */
export interface PanAccount {
  pan: PanKey;
  username: string | null;
  root_dir: string | null;
  /** 光鸭 / 迅雷为 oauth（扫码或令牌），夸克 / 百度为 cookie */
  credential_type?: 'oauth' | 'cookie';
  root_dir_id?: string | null;
  status: 'active' | 'expired';
  last_check_at: string | null;
  last_error: string | null;
}

/** 光鸭令牌绑定结果 */
export interface PanTokenBindResult {
  saved: boolean;
  /** true=令牌可用 / false=光鸭判定无效 / null=未能联网校验 */
  verified: boolean | null;
  username: string | null;
  message: string;
}

export interface Subscription {
  id: string;
  user_id: string;
  name: string;
  source_url: string;
  source_type: 'auto' | 'rss' | 'page' | 'pan_share';
  /** 分享目录订阅的提取码（夸克分享常用） */
  source_passcode: string | null;
  keyword: string | null;
  /** 转存后文件名清洗：none 不处理 / episode 精简为 S01E01 */
  clean_mode: string;
  /** 文件夹模式（光鸭 / 夸克）：true = 整目录转存 + 转后清理文档/图片 + 不加重码；false = 逐文件只转视频 */
  folder_mode: boolean;
  pan: PanKey;
  /** 转存目录 ID（改名不影响） */
  target_dir: string | null;
  /** 转存目录显示名（仅展示） */
  target_dir_name: string | null;
  auto_publish: boolean;
  enabled: boolean;
  /** 手动绑定的资源（资源管理）；为空则按剧名自动匹配 */
  resource_id: string | null;
  interval_minutes: number;
  /** 智能检测（自适应调度）：开启后按学习到的更新时段加密/放宽检查；关闭则严格按 interval_minutes */
  adaptive_enabled?: boolean;
  /** 下次检查时间（智能检测开启时生效）；服务端每次执行结束都会重算 */
  next_check_at?: string | null;
  /** 账号级调度策略（由管理员在账号上设定，服务端强制）：day15_night60 = 固定节奏 */
  schedule_policy?: string | null;
  /** 连续「凭据失效」次数：成功清零，达到 3 次自动停止检测 */
  cred_fail_count?: number;
  /** 系统暂停原因：credential = 凭据失效（重新绑定后手动点「执行」自动恢复） */
  paused_reason?: string | null;
  /** 学到的典型更新时段（北京时间小时，0-23）；null/空 = 冷启动（样本不足） */
  update_hours?: number[] | null;
  /** 更新画像原始数据：{batches,hours,gap_min,last_found_at,computed_at} */
  update_profile?: {
    batches?: number;
    gap_min?: number | null;
    last_found_at?: string | null;
    computed_at?: string;
  } | null;
  /** 连续多少次检查没抓到新增（抓到即清零） */
  checks_since_update?: number;
  /** 最近一次抓到新增文件的时间（全历史） */
  last_found_at?: string | null;
  /** 全集数（用户填写的，选填）：同步到的集数达到该值即判定完结；null = 不自动完结 */
  total_episodes?: number | null;
  /** 判定为已完结的时间（达到全集数时写入） */
  finished_at?: string | null;
  /** 自动删除时间（完结时 = 判定时间 + 1 小时，由定时任务清理） */
  delete_after?: string | null;
  last_run_at: string | null;
  /** retry = 上游网盘接口临时拥塞，已安排短间隔自动重试（不是链接失效） */
  last_status: 'ok' | 'partial' | 'failed' | 'retry' | null;
  last_message: string | null;
  /** 执行占用时间：有值时表示服务端正在跑这次订阅（用于显示「运行中」） */
  run_lock_at: string | null;
  stats: { found?: number; created?: number; updated?: number; transferred?: number; imported?: number; failed?: number };
  created_at: string;
  updated_at: string;
}

export type ItemStatus = 'pending' | 'transferred' | 'imported' | 'failed' | 'skipped';

export interface SubscriptionItem {
  id: string;
  subscription_id: string;
  title: string;
  source_url: string | null;
  share_url: string | null;
  share_passcode: string | null;
  pan: string | null;
  status: ItemStatus;
  transfer_url: string | null;
  resource_id: string | null;
  error: string | null;
  created_at: string;
}

export interface PreviewItem {
  title: string;
  shareUrl: string;
  sharePasscode: string | null;
  pan: string | null;
  sourceUrl: string | null;
  /** 分享目录模式：该条目下的文件数 */
  fileCount?: number;
  /** 分享目录模式：前几个文件名（便于确认文件是不是新集） */
  fileNames?: string[];
  /**
   * 分享目录模式：清洗后的文件名（前几个）。
   * 清洗后重名的，体积大的那个会带「高码」（例：两个 S01E12 → 大的叫 S01E12高码）
   */
  cleanedNames?: string[];
}

export interface PreviewMeta {
  isFeed: boolean;
  pageTitle: string | null;
  /** 页面里的链接总数 */
  anchorCount: number;
  /** <script> JS 数据里的分享链接数（>0 = 链接藏在 JS 里） */
  scriptLinks: number;
  /** 清单页直接命中的分享链接数 */
  directLinks: number;
  /** 疑似详情页数量 */
  detailCandidates: number;
  /** 实际成功跟进的详情页数 */
  detailFollowed: number;
  detailFailed: number;
  /** 详情页里命中的分享链接数 */
  detailLinks: number;
  sampleLinks: string[];
}

export interface PreviewResult {
  contentType: string;
  isFeed: boolean;
  /** pan_share = 源地址是网盘分享链接，按「分享目录监控」解析 */
  mode?: 'pan_share' | string;
  /** 分享目录模式：分享所属网盘 */
  pan?: string;
  total: number;
  filtered: number;
  /** 解析诊断：为什么没抓到 / 为什么被关键字过滤掉 */
  hint?: string | null;
  meta?: PreviewMeta;
  /** 分享目录模式：接口返回的字段名（条目名异常时用于定位） */
  probe?: string[];
  items: PreviewItem[];
}

export interface RunResult {
  found: number;
  created: number;
  updated?: number;
  transferred: number;
  imported: number;
  failed: number;
  message: string;
}

export interface RunAllResult {
  ran: number;
  skipped: number;
  results: Array<{ id: string; name: string; message?: string }>;
}

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/subscription-run`;

export async function callSubscriptionFn<T>(action: string, body: Record<string, unknown> = {}, timeoutMs = 120000): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error('请先登录');

  const res = await fetch(`${FN_URL}?action=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  let parsed: { success?: boolean; data?: T; message?: string } | null = null;
  try {
    parsed = JSON.parse(text) as { success?: boolean; data?: T; message?: string };
  } catch {
    throw new Error(`订阅转存服务返回异常（HTTP ${res.status}）`);
  }
  if (!res.ok || parsed?.success === false) {
    throw new Error(parsed?.message || `订阅转存服务异常（HTTP ${res.status}）`);
  }
  return parsed.data as T;
}

// ───────── 订阅配置 ─────────

export async function listSubscriptions(): Promise<Subscription[]> {
  const data = await callSubscriptionFn<{ items: Subscription[] }>('listSubscriptions');
  return data.items ?? [];
}

export async function saveSubscription(payload: {
  id?: string;
  name: string;
  sourceUrl: string;
  sourceType: 'auto' | 'rss' | 'page' | 'pan_share';
  sourcePasscode?: string;
  keyword?: string;
  /** 转存后文件名清洗：none / episode（默认 none） */
  cleanMode?: 'none' | 'episode';
  /** 文件夹模式（光鸭 / 夸克，默认 false）：其它网盘会被数据库触发器强制关闭 */
  folderMode?: boolean;
  pan: PanKey;
  /** 转存目录 ID（从目录浏览器选） */
  targetDir?: string;
  /** 转存目录显示名（仅展示） */
  targetDirName?: string;
  autoPublish?: boolean;
  /**
   * 手动绑定「资源管理」里的某条资源（不传则按剧名自动匹配）。
   * 绑定后：转存的新文件会并入该资源，集数按新文件最大集号更新，并排队同步到各站点。
   */
  resourceId?: string | null;
  enabled?: boolean;
  intervalMinutes: number;
  /** 智能检测（自适应调度）：默认开；关闭则严格按 intervalMinutes 检查 */
  adaptiveEnabled?: boolean;
  /**
   * 全集数（选填）：填了就启用「自动完结」—— 订阅同步到的集数达到该值时，
   * 资源名改为「已完结全N集」、移入「已完结」，订阅被取消并在 1 小时后自动删除。
   * 不传 / 传 0 = 不自动完结。
   */
  totalEpisodes?: number | null;
}): Promise<{ subscription: Subscription | null; updatedExisting: boolean }> {
  const data = await callSubscriptionFn<{
    subscription: Subscription | null;
    updatedExisting?: boolean;
  }>('saveSubscription', payload);
  return { subscription: data.subscription ?? null, updatedExisting: data.updatedExisting === true };
}

export async function removeSubscription(id: string): Promise<void> {
  await callSubscriptionFn('removeSubscription', { id });
}

export async function toggleSubscription(id: string, enabled: boolean): Promise<void> {
  await callSubscriptionFn('toggleSubscription', { id, enabled });
}

/** 解析订阅源（不写库），用于保存前确认能抓到东西 */
export interface PanDir {
  id: string;
  name: string;
}

/**
 * 浏览网盘目录，用于选择转存位置（parentId 传空 = 根目录）。
 * 返回的是目录 ID：光鸭 / 夸克用数字 ID，百度用「绝对路径」——统一当 ID 用即可，
 * 只是百度改名后路径会变，需要在界面里提醒用户重选。
 */
export async function fetchPanDirs(payload: { pan: PanKey; parentId?: string }): Promise<PanDir[]> {
  // 光鸭目录接口认证后要在服务端盘点，偏慢：服务端单次 30s，这里给 90s 余量
  const r = await callSubscriptionFn<{ dirs: PanDir[] }>('panDirs', payload, 90000);
  return r.dirs ?? [];
}

/** 特殊账号不活跃状态：7 天无转存 → 冻结；14 天 → 禁用 */
export interface InactivityState {
  frozen_at: string | null;
  frozen_reason: string | null;
  unfreeze_used: boolean;
  disabled_at: string | null;
}

export async function fetchMyInactivityState(): Promise<InactivityState | null> {
  const r = await callSubscriptionFn<{ state: InactivityState | null }>('inactivityStatus');
  return r.state ?? null;
}

/** 自助解冻（每人仅一次；14 天禁用的账号不可自助） */
export async function unfreezeMyAccount(): Promise<{ restored: number; message: string }> {
  const r = await callSubscriptionFn<{ restored: number; message: string }>('unfreezeAccount');
  return { restored: r.restored ?? 0, message: r.message ?? '已解冻' };
}

export async function previewSubscriptionSource(payload: {
  url: string;
  sourceType?: 'auto' | 'rss' | 'page' | 'pan_share';
  keyword?: string;
  /** 分享目录（夸克分享可能需要提取码） */
  passcode?: string;
  /** 文件名清洗模式：用于预览「清洗后」的名字（重名的体积大的会带「高码」） */
  cleanMode?: 'none' | 'episode';
}): Promise<PreviewResult> {
  // 分享目录要「拿分享令牌 → 逐页列目录」，光鸭侧偏慢，给 150s
  return callSubscriptionFn<PreviewResult>('preview', payload, 150000);
}

// ───────── 扫码授权（光鸭 / 迅雷设备码；百度 passport 二维码；夸克 uop 二维码）─────────

/** 支持扫码授权的网盘 */
export type PanScanKey = PanKey;

/** 扫码授权会话：展示二维码并轮询结果 */
export interface PanDeviceSession {
  sessionId: string;
  /** 会话所属网盘 */
  pan?: PanScanKey;
  /** 光鸭：授权页地址（手机浏览器可直接打开）；百度：二维码图片地址；夸克：二维码内容（扫码页 URL） */
  verifyUrl: string;
  /** 百度：服务端直接给的二维码图片，前端 <img> 展示即可 */
  qrImageUrl?: string;
  /** 服务端附带的扫码提示 */
  hint?: string;
  /** 需要手输的验证码（光鸭有，百度/夸克没有） */
  userCode: string | null;
  /** 服务端要求的轮询间隔（秒） */
  interval: number;
  /** 有效期（秒） */
  expiresIn: number;
}

/**
 * 申请扫码授权：
 *  · 光鸭 / 迅雷 = OAuth 设备码流程，换回的凭证能长期自动续期
 *  · 百度 = passport 二维码，扫码后服务端直接换 BDUSS → 整串 Cookie 并加密落库
 *  · 夸克 = uop CAS 二维码，扫码后服务端直接换 service_ticket → 整串 Cookie 并加密落库
 */
export async function startPanDeviceAuth(pan: PanScanKey = 'guangya'): Promise<PanDeviceSession> {
  return callSubscriptionFn<PanDeviceSession>('panDeviceStart', { pan }, 60000);
}

// ───────── 百度网盘 ─────────
//
// 百度走 Web 接口（见《百度网盘登录转存凭证接口清单》）：凭证就是「登录 Cookie（含 BDUSS）」，
// 因此复用 bindPanAccount 粘贴 Cookie，服务端会用它对百度换 bdstoken 再一起加密保存。
// 前端无需额外接口 —— 绑定、自检都走上面已有的 bindPanAccount / probePanAccount。

/** 扫码授权轮询结果：waiting 继续等 / success 成功 / expired 过期 / failed 被拒绝 */
export type PanDeviceStatus = 'waiting' | 'success' | 'expired' | 'failed';

/** 扫码授权：轮询结果（光鸭 success 时带凭证；百度/夸克 success 时服务端已直接落库） */
export async function pollPanDeviceAuth(
  sessionId: string
): Promise<{
  status: PanDeviceStatus;
  pan?: PanScanKey;
  message?: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  /** 百度：绑定成功的账号（uk）；夸克：昵称 */
  account?: string | null;
}> {
  return callSubscriptionFn<{
    status: PanDeviceStatus;
    pan?: PanScanKey;
    message?: string;
    accessToken?: string;
    refreshToken?: string;
    clientId?: string;
    account?: string | null;
  }>(
    'panDevicePoll',
    { sessionId },
    60000
  );
}

// ───────── 执行 ─────────

export async function runSubscriptionOnce(id: string): Promise<RunResult> {
  return callSubscriptionFn<RunResult>('run', { id }, 300000);
}

export async function runAllSubscriptions(force = true): Promise<RunAllResult> {
  return callSubscriptionFn<RunAllResult>('runAll', { force }, 300000);
}

// ───────── 抓取记录 ─────────

export async function listSubscriptionItems(params: {
  subscriptionId?: string;
  status?: ItemStatus;
  limit?: number;
} = {}): Promise<SubscriptionItem[]> {
  const data = await callSubscriptionFn<{ items: SubscriptionItem[] }>('items', params);
  return data.items ?? [];
}

export async function clearSubscriptionItems(params: { subscriptionId?: string; onlyFailed?: boolean }): Promise<void> {
  await callSubscriptionFn('clearItems', params);
}

// ───────── 网盘账号 ─────────

export async function listPanAccounts(): Promise<PanAccount[]> {
  const data = await callSubscriptionFn<{ items: PanAccount[] }>('panList');
  return data.items ?? [];
}

/** 绑定网盘账号：cookie 为浏览器登录后的整串 Cookie，服务端加密存储 */
export async function bindPanAccount(payload: {
  pan: PanKey;
  cookie: string;
  username?: string;
  rootDir?: string;
}): Promise<void> {
  await callSubscriptionFn('bindPan', payload);
}

export async function removePanAccount(pan: PanKey): Promise<void> {
  await callSubscriptionFn('removePan', { pan });
}

/**
 * 网盘自检（只读，不写任何文件）：
 * 光鸭校验 OAuth 令牌；百度校验登录态 + 账号信息 + 根目录（验证 Cookie/bdstoken）；
 * 夸克用一条分享链接校验读取能力。
 */
export async function probePanAccount(pan: PanKey, shareUrl = ''): Promise<unknown> {
  const data = await callSubscriptionFn<{ probe: unknown }>('panProbe', { pan, shareUrl }, 90000);
  return data.probe;
}

/**
 * 光鸭绑定：填入令牌（Access Token + Refresh Token + Client ID）。
 * 令牌取自光鸭官网登录后浏览器本机存储（localStorage 的 `credentials_<client_id>`）。
 * 服务端加密保存，前端只能看到元信息。
 */
export async function bindPanTokens(payload: {
  pan?: PanKey;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
}): Promise<PanTokenBindResult> {
  return callSubscriptionFn<PanTokenBindResult>(
    'panBindTokens',
    {
      pan: payload.pan ?? 'guangya',
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken ?? '',
      clientId: payload.clientId ?? '',
    },
    90000
  );
}

/**
 * 迅雷绑定：填入自己客户端会话里的 Access Token + 设备 ID。
 *
 * 为什么不能只靠扫码：迅雷 drive 接口按「client_id + device_id」查设备档案，档案只在客户端
 * 登录时建立；服务端扫码换来的令牌没有档案，会一律 400 captcha_invalid
 * （error_details: "no client info found"）。用自己客户端的这套身份才能过。
 */
export async function bindXunleiToken(payload: {
  accessToken: string;
  refreshToken?: string;
  deviceId: string;
  clientId?: string;
  clientVersion?: string;
  clientSecret?: string;
  userAgent?: string;
  /** 可选：浏览器 localStorage 的 captcha_<client_id>.token，用于一次性校验 */
  captchaToken?: string;
}): Promise<PanTokenBindResult> {
  return callSubscriptionFn<PanTokenBindResult>(
    'panBindXunleiToken',
    {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken ?? '',
      deviceId: payload.deviceId,
      clientId: payload.clientId ?? '',
      clientVersion: payload.clientVersion ?? '',
      clientSecret: payload.clientSecret ?? '',
      userAgent: payload.userAgent ?? '',
      captchaToken: payload.captchaToken ?? '',
    },
    90000
  );
}

/**
 * 扫码成功后取回可预填的凭证（access_token / refresh_token / client_id）。
 * device_id 恒为空：迅雷令牌 JWT 里没有设备字段，扫码链路的设备号在迅雷侧没有档案，
 * 只能由用户从自己客户端请求头补。
 */
export async function prefillXunleiToken(): Promise<{
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientVersion: string;
  deviceId: string;
}> {
  return callSubscriptionFn(
    'panXunleiPrefill',
    {},
    30000
  );
}

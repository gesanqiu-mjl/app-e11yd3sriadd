/**
 * 中转短链 + 点击统计（对应 supabase/functions/go 与 00058_short_links.sql）
 *
 * 用法：为一条网盘链接生成短链 → 分享短链 → 别人点开时服务端记一次点击并 302 跳转。
 * 所有读写都受 RLS 限制，只能看到自己的短链与点击明细。
 */
import { supabase } from '@/db/supabase';

export interface ShortLink {
  id: string;
  user_id: string;
  code: string;
  title: string;
  target_url: string;
  extract_code: string | null;
  pan_name: string | null;
  resource_id: string | null;
  channel: string | null;
  enabled: boolean;
  expires_at: string | null;
  click_count: number;
  unique_count: number;
  last_click_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShortLinkStat {
  link_id: string;
  clicks_total: number;
  clicks_range: number;
  uniques_range: number;
  clicks_today: number;
  last_click_at: string | null;
}

export interface ShortLinkDaily {
  day: string;
  clicks: number;
  uniques: number;
  bots: number;
}

export interface ShortLinkChannel {
  channel: string;
  clicks: number;
  uniques: number;
}

export interface ShortLinkClick {
  id: number;
  clicked_at: string;
  channel: string | null;
  referer: string | null;
  ua: string | null;
  ip_hash: string | null;
  is_bot: boolean;
  is_unique: boolean;
}

/** 短链前缀：默认走 Supabase Edge Function；配了 VITE_SHORTLINK_BASE 可用自有域名 */
export function shortLinkBase(): string {
  const custom = (import.meta.env.VITE_SHORTLINK_BASE as string | undefined)?.trim();
  const base = custom || `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/go`;
  return base.replace(/\/+$/, '');
}

/**
 * 拼出可分享的完整短链。
 *   · 「原链接路径」短码（含 /，如 s/1956…）→ https://域名/s/1956…
 *   · 随机短码（如 abc123）             → https://域名/go/abc123
 * 渠道（channel）保存在短链行上，跳转打点会自动带上 —— **默认不再拼 ?c=**，
 * 分享出去就是最短形态：https://guangya.xyz.hr/go/rb8f33
 * （中文渠道名被 URL 编码后会占 40+ 字符，比短链本身还长）
 * 需要临时换渠道 / 想把渠道写进 URL 时，传 opts.channelInUrl = true。
 * 域名没配 VITE_SHORTLINK_BASE 时退回 Supabase 函数地址（…/functions/v1/go/…）。
 */
export function shortLinkUrl(
  code: string,
  channel?: string | null,
  opts?: { channelInUrl?: boolean }
): string {
  const base = shortLinkBase();
  const isPathCode = code.includes('/');
  const path = isPathCode || base.endsWith('/go') ? `/${code}` : `/go/${code}`;
  const ch = opts?.channelInUrl ? (channel ?? '').trim() : '';
  return `${base}${path}${ch ? `?c=${encodeURIComponent(ch)}` : ''}`;
}

/** 只展示用的短链（不带域名，便于列表里紧凑展示） */
export function shortLinkDisplay(code: string): string {
  return code.includes('/') ? `…/${code}` : `…/go/${code}`;
}

// 短码字符集：去掉 0/o/1/l/i 等易混字符
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomCode(len = 6, prefix = ''): string {
  const n = Math.max(1, len - prefix.length);
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes).map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * 短码的网盘前缀：让光鸭/夸克的短码一眼可区分（避免两条短链混淆）。
 * 总长度不变（前缀占用一位，随机部分相应少一位）。
 */
export function panPrefixOf(panName?: string | null): string {
  const n = (panName ?? '').toLowerCase();
  if (n.includes('光鸭') || n.includes('guangya') || n.includes('gy')) return 'g';
  if (n.includes('夸克') || n.includes('quark')) return 'q';
  return 'x';
}

/** 生成一个没被占用的短码（极小概率重复 → 重试） */
async function uniqueCode(prefix = ''): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = randomCode(6, prefix);
    const { data } = await supabase.from('short_links').select('id').eq('code', code).maybeSingle();
    if (!data) return code;
  }
  return randomCode(8, prefix);
}

/** 网盘域名 → 短码前缀（用于「原链接路径」形态，保证不同网盘不会撞车） */
function hostTag(url: URL): string {
  const h = url.hostname.toLowerCase();
  if (h.includes('guangyapan')) return 'gy';
  if (h.includes('quark')) return 'qk';
  if (h.includes('xunlei')) return 'xl';
  if (h.includes('baidu')) return 'bd';
  if (h.includes('aliyundrive') || h.includes('alipan')) return 'ali';
  if (h.includes('123pan')) return '123';
  if (h.includes('uc.cn')) return 'uc';
  return (h.split('.').filter((x) => x && x !== 'www')[0] ?? 'pan').slice(0, 4);
}

/**
 * 由目标链接推导「原链接路径」形态的短码：例如
 *   https://www.guangyapan.com/s/1956421372229992464_aeZIFqDoqz15G-J_
 *   → s/1956421372229992464_aeZIFqDoqz15G-J_
 * 这样分享出去的短链**只有域名不同、路径与原链接一模一样**（“在原链接基础上做短链”）。
 * 非分享路径（如根路径 /）返回 null，由调用方退回随机短码。
 */
export function derivePathCode(targetUrl: string): string | null {
  try {
    const u = new URL(targetUrl.trim());
    const path = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!path) return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * 带网盘标识的同路径短码（`gy/s/…`）：仅当“纯路径短码”已被别的目标占用时才用，
 * 好处是不同网盘的同名路径不会互相覆盖。
 */
export function deriveTaggedPathCode(targetUrl: string): string | null {
  try {
    const u = new URL(targetUrl.trim());
    const path = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!path) return null;
    return `${hostTag(u)}/${path}`;
  } catch {
    return null;
  }
}

export async function createShortLink(params: {
  title: string;
  targetUrl: string;
  extractCode?: string | null;
  panName?: string | null;
  resourceId?: string | null;
  channel?: string | null;
  expiresAt?: string | null;
  /** 短码形态：path = 沿用原链接路径（分享出去只有域名不同）；short = 随机短码 */
  codeMode?: 'short' | 'path';
  /** 短码前缀（如 g=光鸭 / q=夸克）：让不同网盘的短链一眼可区分 */
  codePrefix?: string;
}): Promise<ShortLink> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const target = params.targetUrl.trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('目标链接需要以 http(s):// 开头');

  const pathCode = params.codeMode === 'path' ? derivePathCode(target) : null;
  const taggedCode = params.codeMode === 'path' ? deriveTaggedPathCode(target) : null;

  for (let attempt = 0; attempt < 3; attempt++) {
    // 首次用「原链接路径」短码；被别的目标占用则退化为带网盘标识的同路径，最后才用随机短码
    const code = attempt === 0
      ? (pathCode ?? await uniqueCode(params.codePrefix))
      : attempt === 1
        ? (taggedCode ?? await uniqueCode(params.codePrefix))
        : await uniqueCode(params.codePrefix);

    const { data, error } = await supabase
      .from('short_links')
      .insert({
        user_id: userData.user.id,
        code,
        title: params.title.trim() || target,
        target_url: target,
        extract_code: params.extractCode?.trim() || null,
        pan_name: params.panName?.trim() || null,
        resource_id: params.resourceId || null,
        channel: params.channel?.trim() || null,
        expires_at: params.expiresAt || null,
      })
      .select('*')
      .single();
    if (!error) return data as ShortLink;
    // 23505 = 短码已存在 → 换一个再试
    if ((error as { code?: string }).code === '23505') continue;
    throw error;
  }
  throw new Error('短码生成失败，请重试');
}

/**
 * 取「这条网盘链接」的短链：同账号 + 同目标已存在就直接复用，没有才新建（6 位短码，带网盘前缀）。
 * 发帖/同步等自动化场景统一用它，避免同一链接生成多条短链。
 */
export async function getOrCreateShortLink(params: {
  targetUrl: string;
  title?: string;
  panName?: string | null;
  resourceId?: string | null;
  channel?: string | null;
}): Promise<ShortLink | null> {
  const target = (params.targetUrl ?? '').trim();
  if (!/^https?:\/\//i.test(target)) return null;
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return null;

  const { data: existing } = await supabase
    .from('short_links')
    .select('*')
    .eq('user_id', uid)
    .eq('target_url', target)
    .limit(1)
    .maybeSingle();
  if (existing) return existing as ShortLink;

  return await createShortLink({
    title: params.title?.trim() || target,
    targetUrl: target,
    panName: params.panName ?? null,
    resourceId: params.resourceId ?? null,
    channel: params.channel ?? null,
    codeMode: 'short',
    codePrefix: panPrefixOf(params.panName),
  });
}

export interface BulkCreateItem {
  title: string;
  targetUrl: string;
  panName?: string | null;
  resourceId?: string | null;
  channel?: string | null;
  codeMode?: 'short' | 'path';
}

/**
 * 批量创建短链：按批（40 条/请求）插入，比逐条快一个数量级。
 * 某一批里若有短码撞车（23505）→ 该批改为逐条重试，撞车的那条自动加随机后缀。
 */
export async function createShortLinksBulk(
  items: BulkCreateItem[],
  onProgress?: (done: number, total: number) => void
): Promise<{ created: ShortLink[]; failed: Array<{ target: string; reason: string }> }> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const uid = userData.user.id;
  const created: ShortLink[] = [];
  const failed: Array<{ target: string; reason: string }> = [];
  const CHUNK = 40;

  const buildRow = (it: BulkCreateItem, suffix?: string) => {
    const target = it.targetUrl.trim();
    const base = it.codeMode === 'path' ? (derivePathCode(target) ?? randomCode(6)) : randomCode(6);
    return {
      user_id: uid,
      code: suffix ? `${base}-${suffix}` : base,
      title: it.title.trim() || target,
      target_url: target,
      extract_code: null as string | null,
      pan_name: it.panName?.trim() || null,
      resource_id: it.resourceId || null,
      channel: it.channel?.trim() || null,
    };
  };

  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const rows = chunk.map((it) => buildRow(it));
    const { data, error } = await supabase.from('short_links').insert(rows).select('*');
    if (!error) {
      created.push(...((data ?? []) as ShortLink[]));
    } else {
      // 批里有撞车/非法行 → 逐条重试
      for (const it of chunk) {
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          const row = buildRow(it, attempt === 0 ? undefined : randomCode(3));
          const res = await supabase.from('short_links').insert(row).select('*').single();
          if (!res.error) {
            created.push(res.data as ShortLink);
            ok = true;
            break;
          }
          if ((res.error as { code?: string }).code !== '23505') {
            failed.push({ target: it.targetUrl, reason: res.error.message });
            break;
          }
        }
        if (!ok && !failed.some((f) => f.target === it.targetUrl)) {
          failed.push({ target: it.targetUrl, reason: '短码重复，重试多次仍失败' });
        }
      }
    }
    onProgress?.(Math.min(i + CHUNK, items.length), items.length);
  }
  return { created, failed };
}

/**
 * 读取短链列表：**只取当前账号自己的**。
 * 注意：RLS 里管理员有一条 admin_read 策略，会放开全部用户的短链；
 * 短链页是「每个账号只看自己」的统计面板，所以这里显式按 user_id 收口，
 * 避免站长（管理员）在页面上看到别的账号的短链与点击数据。
 */
export async function listShortLinks(): Promise<ShortLink[]> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) throw new Error('请先登录');
  const { data, error } = await supabase
    .from('short_links')
    .select('*')
    .eq('user_id', uid)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ShortLink[];
}

export async function updateShortLink(
  id: string,
  patch: Partial<Pick<ShortLink, 'title' | 'target_url' | 'extract_code' | 'channel' | 'enabled' | 'expires_at'>>
): Promise<void> {
  const { error } = await supabase
    .from('short_links')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteShortLink(id: string): Promise<void> {
  const { error } = await supabase.from('short_links').delete().eq('id', id);
  if (error) throw error;
}

/** 列表页聚合：各短链的总点击 / 区间点击 / 区间独立访客 / 今日点击 */
export async function fetchShortLinkStats(days = 7): Promise<Record<string, ShortLinkStat>> {
  const { data, error } = await supabase.rpc('short_link_stats', { p_days: days });
  if (error) throw error;
  const map: Record<string, ShortLinkStat> = {};
  for (const row of (data ?? []) as ShortLinkStat[]) map[row.link_id] = row;
  return map;
}

export async function fetchShortLinkDaily(linkId: string, days = 30): Promise<ShortLinkDaily[]> {
  const { data, error } = await supabase.rpc('short_link_daily', { p_link_id: linkId, p_days: days });
  if (error) throw error;
  return (data ?? []) as ShortLinkDaily[];
}

/** 全部短链的按天聚合（一次拿全，用于总趋势图 / 列表迷你走势 / 环比） */
export interface ShortLinkDailyAll extends ShortLinkDaily {
  link_id: string;
}

export async function fetchDailyAll(days = 30): Promise<ShortLinkDailyAll[]> {
  const { data, error } = await supabase.rpc('short_link_daily_all', { p_days: days });
  if (error) throw error;
  return (data ?? []) as ShortLinkDailyAll[];
}

/** 按天汇总（把多条短链的同一天加在一起） */
export function sumByDay(rows: ShortLinkDailyAll[]): ShortLinkDaily[] {
  const map = new Map<string, ShortLinkDaily>();
  for (const r of rows) {
    const cur = map.get(r.day) ?? { day: r.day, clicks: 0, uniques: 0, bots: 0 };
    cur.clicks += Number(r.clicks) || 0;
    cur.uniques += Number(r.uniques) || 0;
    cur.bots += Number(r.bots) || 0;
    map.set(r.day, cur);
  }
  return [...map.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

/** 某条短链的按天序列（补齐没有点击的日子，便于画走势） */
export function dailyOf(rows: ShortLinkDailyAll[], linkId: string, days: number): ShortLinkDaily[] {
  const map = new Map(rows.filter((r) => r.link_id === linkId).map((r) => [r.day, r]));
  const out: ShortLinkDaily[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hit = map.get(key);
    out.push({ day: key, clicks: Number(hit?.clicks ?? 0), uniques: Number(hit?.uniques ?? 0), bots: Number(hit?.bots ?? 0) });
  }
  return out;
}

/** 近 N 天 vs 前 N 天的点击汇总（环比） */
export function rangeCompare(rows: ShortLinkDailyAll[], days: number) {
  const all = sumByDay(rows);
  if (all.length < 2) return { current: 0, previous: 0, delta: 0 };
  const mid = all.length / 2;
  const prev = all.slice(0, Math.floor(mid));
  const cur = all.slice(Math.floor(mid));
  const sum = (arr: ShortLinkDaily[]) => arr.reduce((a, b) => a + b.clicks, 0);
  const current = sum(cur);
  const previous = sum(prev);
  return { current, previous, delta: current - previous };
}

export async function fetchShortLinkChannels(linkId: string, days = 30): Promise<ShortLinkChannel[]> {
  const { data, error } = await supabase.rpc('short_link_channels', { p_link_id: linkId, p_days: days });
  if (error) throw error;
  return (data ?? []) as ShortLinkChannel[];
}

export async function fetchRecentClicks(linkId: string, limit = 30): Promise<ShortLinkClick[]> {
  const { data, error } = await supabase
    .from('short_link_clicks')
    .select('id, clicked_at, channel, referer, ua, ip_hash, is_bot, is_unique')
    .eq('link_id', linkId)
    .order('clicked_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ShortLinkClick[];
}

/** 汇总多个短链的合计（列表页顶部卡片用） */
export function sumStats(stats: Record<string, ShortLinkStat>, ids: string[]) {
  let total = 0, today = 0, range = 0, uniques = 0;
  for (const id of ids) {
    const s = stats[id];
    if (!s) continue;
    total += Number(s.clicks_total) || 0;
    today += Number(s.clicks_today) || 0;
    range += Number(s.clicks_range) || 0;
    uniques += Number(s.uniques_range) || 0;
  }
  return { total, today, range, uniques };
}

/** UA 简写：列表里只显示「设备 + 浏览器」 */
export function briefUa(ua: string | null): string {
  const s = (ua ?? '').trim();
  if (!s) return '未知';
  const os = /iPhone|iPad|iOS/i.test(s) ? 'iOS'
    : /Android/i.test(s) ? 'Android'
    : /Windows/i.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(s) ? 'macOS'
    : /Linux/i.test(s) ? 'Linux'
    : '其它';
  const br = /Edg\//i.test(s) ? 'Edge'
    : /MicroMessenger/i.test(s) ? '微信'
    : /QQ\//i.test(s) ? 'QQ'
    : /Chrome\//i.test(s) ? 'Chrome'
    : /Safari\//i.test(s) ? 'Safari'
    : /Firefox\//i.test(s) ? 'Firefox'
    : /curl|python|bot/i.test(s) ? '程序'
    : '其它';
  return `${os} · ${br}`;
}

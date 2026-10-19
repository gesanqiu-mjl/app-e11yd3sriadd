/**
 * 站点登录凭据与自动巡检
 *
 * 作用：
 *   1. 把各站点的「账号密码 / Cookie」加密存到云端（Edge Function site-credential）；
 *   2. 用户登录本应用后自动巡检已绑定站点，会话失效时用云端凭据自动重新登录；
 *   3. 提供统一的站点失效错误码判定，供同步流程做「自动重登 + 重试」兜底。
 *
 * 安全：密码/Cookie 一律在服务端加密后落库，前端只读得到元信息（账号名、失败次数等）。
 */
import { supabase } from '@/db/supabase';

export type SiteKey = 'ya' | 'jying' | 'hdhaven' | 'framehdr' | 'mukaku' | 'pinglian' | 'panfx' | 'xn' | 'st1';

export const SITE_LABELS: Record<SiteKey, string> = {
  ya: '鸭影臻藏',
  jying: '聚影',
  hdhaven: '栖影 HDHaven',
  framehdr: '帧影',
  mukaku: '不太灵',
  pinglian: '盘链',
  panfx: '123社区',
  xn: '观影站点',
  st1: '1号站点',
};

/**
 * 各站点的真实网址（用于在「站点账号绑定」标题后展示，方便用户知道要开哪个站）。
 * 来源：各 proxy 边缘函数顶部的上游 BASE 常量，逐个核对过：
 *   jying-proxy:37 / hdhaven-proxy:49 / framehdr-proxy:30 / mukaku-proxy:30
 *   panlinks-proxy:52 / panfx-proxy:24 / xnshare-proxy:51 / st1-proxy:43(BUILTIN_BASE)
 *   ya 是 Supabase 应用，没有独立官网域名，填它自己的 supabase 地址。
 * 注意别和 proxy 里的 SITE_URL 环境变量搞混——那个是 CORS 白名单，不是站点地址。
 */
export const SITE_URLS: Record<SiteKey, string> = {
  ya: 'https://houhvngggkkcqcjmzafx.supabase.co',
  jying: 'https://www.jying.top',
  hdhaven: 'https://hdhaven.com',
  framehdr: 'https://framehdr.com',
  mukaku: 'https://web3.mukaku.com',
  pinglian: 'https://pinglian.lol',
  panfx: 'https://123panfx.com',
  xn: 'https://www.xn--wcv59z.com',
  st1: 'http://zy.beida.pw',
};

/** 只取域名部分（去掉协议与 www.），标题后展示用，更短更好读 */
export function siteHost(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

/**
 * 能自动重登的站点（有账号密码登录通道，且登录不需要图形验证码）。
 * 栖影已改走官方 OAuth：access_token 长期有效，失效只能重新授权，没有「自动重登」概念。
 */
export const AUTO_RELOGIN_SITES: SiteKey[] = ['ya', 'jying', 'framehdr'];

/** 各站点「会话失效」错误码（与各 proxy / api.ts 常量保持一致） */
export const SITE_EXPIRED_CODES: Record<SiteKey, string[]> = {
  ya: ['YA_EXPIRED', 'YA_NOT_BOUND'],
  jying: ['JYING_COOKIE_EXPIRED', 'JYING_NOT_BOUND'],
  hdhaven: ['HDHAVEN_TOKEN_EXPIRED', 'HDHAVEN_NOT_BOUND'],
  framehdr: ['COOKIE_EXPIRED'],
  mukaku: ['MUKAKU_TOKEN_EXPIRED', 'MUKAKU_NOT_BOUND'],
  pinglian: ['PINGLIAN_COOKIE_EXPIRED'],
  panfx: ['COOKIE_EXPIRED'],
  xn: ['COOKIE_EXPIRED', 'XN_COOKIE_EXPIRED'],
  st1: ['ST1_TOKEN_EXPIRED', 'ST1_NOT_BOUND'],
};

/** 扁平码集合：任何站点命中即视为「会话失效」 */
const EXPIRED_CODE_SET = new Set(Object.values(SITE_EXPIRED_CODES).flat());

/** 判断错误码是否代表站点会话失效 */
export function isExpiredCode(code?: string | null): boolean {
  return !!code && EXPIRED_CODE_SET.has(code);
}

/** 判断错误对象是否代表站点会话失效（同步失败时用它决定要不要自动重登重试） */
export function isSiteSessionExpired(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string };
  if (isExpiredCode(e.code)) return true;
  const msg = e.message ?? '';
  return /(登录已过期|登录态失效|Cookie 已失效|凭证已过期|凭证已失效|请先到「站点同步」页|重新绑定)/.test(msg);
}

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/site-credential`;

export type SiteCheckStatus = 'ok' | 'relogged' | 'manual' | 'failed' | 'unbound';

export interface SiteCheckResult {
  site: SiteKey;
  label: string;
  status: SiteCheckStatus;
  reason: string;
  account?: string | null;
}

export interface EnsureAllResult {
  checkedAt: string;
  results: SiteCheckResult[];
  /** 需要用户手动处理的站点（自动重登失败 / 仅 Cookie 需更新） */
  needsAttention: SiteCheckResult[];
  summary: { checked: number; ok: number; relogged: number; manual: number; failed: number };
}

/** 调用站点凭据边缘函数（带本应用登录态） */
async function callCredentialFn<T>(action: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
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
    throw new Error(`站点凭据服务返回异常（HTTP ${res.status}）`);
  }
  if (!res.ok || parsed?.success === false) {
    throw new Error(parsed?.message || `站点凭据服务异常（HTTP ${res.status}）`);
  }
  return parsed.data as T;
}

/**
 * 保存站点凭据到云端（供会话失效时自动重登）。
 * 失败不抛出——凭据保存属于增强能力，不能影响用户正常的绑定流程。
 */
export async function saveSiteCredential(params: {
  site: SiteKey;
  username?: string | null;
  password?: string | null;
  cookie?: string | null;
  /** API 令牌型站点（1号站点 pat_…） */
  token?: string | null;
  autoLogin?: boolean;
}): Promise<boolean> {
  try {
    await callCredentialFn('save', {
      site: params.site,
      username: params.username ?? '',
      password: params.password ?? '',
      cookie: params.cookie ?? '',
      token: params.token ?? '',
      autoLogin: params.autoLogin !== false,
    }, 20000);
    return true;
  } catch (e) {
    console.warn('[site-credential] 保存站点凭据失败：', (e as Error).message);
    return false;
  }
}

/** 巡检单个站点：有效则返回 ok，失效则尝试用云端凭据自动重登 */
export async function ensureSiteSession(site: SiteKey): Promise<SiteCheckResult> {
  return callCredentialFn<SiteCheckResult>('ensure', { site }, 45000);
}

/** 巡检所有已绑定站点（登录后自动调用） */
export async function ensureAllSiteSessions(sites?: SiteKey[]): Promise<EnsureAllResult> {
  return callCredentialFn<EnsureAllResult>('ensureAll', sites ? { sites } : {}, 90000);
}

/** 删除云端凭据（不再自动重登） */
export async function forgetSiteCredential(site: SiteKey): Promise<void> {
  await callCredentialFn('forget', { site }, 20000);
}

/** 读取本人凭据元信息（不含密文） */
export interface SiteCredentialMeta {
  site: SiteKey;
  label: string;
  username: string | null;
  secret_kind: 'password' | 'cookie' | 'token';
  auto_login: boolean;
  last_success_at: string | null;
  last_error: string | null;
  fail_count: number;
  created_at: string;
  updated_at: string;
}

export async function listSiteCredentials(): Promise<SiteCredentialMeta[]> {
  const data = await callCredentialFn<{ items: SiteCredentialMeta[] }>('list', {}, 20000);
  return data.items ?? [];
}

/** 生成巡检结果的简要文案（用于 toast） */
export function describeEnsureResult(result: EnsureAllResult): { auto: string | null; attention: string | null } {
  const relogged = result.results.filter((r) => r.status === 'relogged');
  const attention = result.needsAttention ?? [];
  return {
    auto: relogged.length
      ? `已自动重新登录：${relogged.map((r) => SITE_LABELS[r.site] ?? r.site).join('、')}`
      : null,
    attention: attention.length
      ? attention
          .slice(0, 3)
          .map((r) => `${SITE_LABELS[r.site] ?? r.site}：${r.reason}`)
          .join('；') + (attention.length > 3 ? ` 等 ${attention.length} 个站点` : '')
      : null,
  };
}

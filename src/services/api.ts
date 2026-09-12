import { supabase } from '@/db/supabase';
import { detectPanName } from '@/lib/panUtils';
import {
  Resource,
  ChangeHistory,
  Profile,
  AdminResource,
  AdminHistory,
  UserRole,
  InviteCode,
  PinglianBinding,
  PinglianLink,
  ResourceBinding,
  UpdatedItem,
  LoginConfig,
  LOGIN_CONFIG_DEFAULTS,
} from '@/types/index';

export async function fetchResources(): Promise<Resource[]> {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('resources')
    .select('*')
    .eq('owner_id', user?.id ?? '')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function updateResourceSortOrders(
  items: Array<{ id: string; sort_order: number }>
): Promise<void> {
  if (items.length === 0) return;
  const { error } = await supabase.rpc('update_resource_sort_orders', {
    p_items: items,
  });
  if (error) throw error;
}


export async function updateResourceCover(
  id: string,
  cover_url: string | null
): Promise<Resource | null> {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('resources')
    .update({ cover_url })
    .eq('id', id)
    .eq('owner_id', user?.id ?? '')
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateResourceField(
  id: string,
  field: string,
  value: string | number | object
): Promise<Resource | null> {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('resources')
    .update({ [field]: value })
    .eq('id', id)
    .eq('owner_id', user?.id ?? '')
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertResource(
  resource: Omit<Resource, 'id' | 'created_at' | 'updated_at' | 'owner_id' | 'link_status' | 'link_checked_at'>
): Promise<Resource | null> {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('resources')
    .insert({ ...resource, owner_id: user?.id })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertResources(
  items: Omit<Resource, 'id' | 'created_at' | 'updated_at' | 'owner_id' | 'link_status' | 'link_checked_at'>[]
): Promise<Resource[]> {
  if (items.length === 0) return [];
  const { data: { user } } = await supabase.auth.getUser();
  const withOwner = items.map((it) => ({ ...it, owner_id: user?.id }));
  const { data, error } = await supabase.from('resources').insert(withOwner).select();
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function deleteResource(id: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('resources')
    .delete()
    .eq('id', id)
    .eq('owner_id', user?.id ?? '');
  if (error) throw error;
}

/** 检测指定资源的链接是否失效，返回每个资源的检测结果 */
export async function checkLinks(
  resourceIds: string[]
): Promise<
  Array<{
    id: string;
    valid: boolean;
    status: 'valid' | 'partial' | 'invalid';
    checkedAt: string;
    linkResults: Array<{ url: string; valid: boolean }>;
  }>
> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) throw new Error('请先登录');
  const res = await fetchWithRetry(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/check-links`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionData.session.access_token}`,
      },
      body: JSON.stringify({ resource_ids: resourceIds }),
    },
    { retriable: true } // 链接检测为幂等读操作，可自动重试
  );
  const data = await parseJsonSafe(res);
  if (!res.ok || !data) throw new Error(data?.error || `链接检测失败（HTTP ${res.status}）`);
  return Array.isArray(data.results) ? data.results : [];
}

/** 设置/取消资源的已完结标记 */
export async function setResourceFinished(id: string, finished: boolean): Promise<void> {
  const { error } = await supabase
    .from('resources')
    .update({ is_finished: finished })
    .eq('id', id);
  if (error) throw error;
}

export async function recordChange(
  change: Omit<ChangeHistory, 'id' | 'changed_at' | 'user_id'>
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('change_history')
    .insert({ ...change, user_id: user?.id });
  if (error) throw error;
}

export async function fetchHistory(
  startDate?: string,
  endDate?: string
): Promise<ChangeHistory[]> {
  const { data: { user } } = await supabase.auth.getUser();
  let query = supabase
    .from('change_history')
    .select('*')
    .eq('user_id', user?.id ?? '')
    .order('changed_at', { ascending: false })
    .limit(500);

  if (startDate) {
    query = query.gte('changed_at', `${startDate}T00:00:00.000Z`);
  }
  if (endDate) {
    query = query.lte('changed_at', `${endDate}T23:59:59.999Z`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/**
 * 加载「已更新」记录（服务端持久化，跨浏览器同步）。
 * 基于当前用户在指定日期的 change_history，按 resource_id 去重取最新一条，
 * 并 JOIN resources 表获取完整资源信息用于格式化展示。
 * dayOffset: 0=今天, 1=昨天, 2=前天
 */
export async function fetchUpdatedItems(dayOffset = 0): Promise<UpdatedItem[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  // 计算所选日期的本地起止时间，转为 UTC ISO
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset, 23, 59, 59, 999);

  const { data, error } = await supabase
    .from('change_history')
    .select('*, resources!change_history_resource_id_fkey(*)')
    .eq('user_id', user.id)
    .gte('changed_at', start.toISOString())
    .lte('changed_at', end.toISOString())
    .order('changed_at', { ascending: false })
    .limit(500);

  if (error) throw error;
  if (!Array.isArray(data)) return [];

  // 按 resource_id 去重，保留最新一条（已按 changed_at desc 排序）
  const seen = new Set<string>();
  const items: UpdatedItem[] = [];
  for (const row of data as Array<ChangeHistory & { resources: Resource | null }>) {
    const rid = row.resource_id ?? '';
    if (!rid || seen.has(rid)) continue;
    seen.add(rid);
    if (!row.resources) continue; // 资源已删除则跳过
    items.push({
      resource: row.resources,
      changedAt: new Date(row.changed_at),
      changedFieldLabel: row.field_label || '资源',
    });
  }
  return items;
}

/** 清空当前用户在指定日期的已更新记录（删除对应 change_history） */
export async function clearUpdatedItems(dayOffset = 0): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset, 23, 59, 59, 999);
  const { error } = await supabase
    .from('change_history')
    .delete()
    .eq('user_id', user.id)
    .gte('changed_at', start.toISOString())
    .lte('changed_at', end.toISOString());
  if (error) throw error;
}

// 全部用户档案
export async function fetchAllProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

// 全部资源（含所属用户名）
export async function fetchAllResources(): Promise<AdminResource[]> {
  const { data, error } = await supabase
    .from('resources')
    .select('*, profiles!resources_owner_id_fkey(username)')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r: Record<string, unknown>) => {
    const { profiles, ...rest } = r as Record<string, unknown>;
    return {
      ...(rest as unknown as Resource),
      owner_name: (profiles as { username: string | null } | null)?.username ?? null,
    };
  });
}

// 全部修改历史（含用户名）
export async function fetchAllHistory(
  startDate?: string,
  endDate?: string
): Promise<AdminHistory[]> {
  let query = supabase
    .from('change_history')
    .select('*, profiles!change_history_user_id_fkey(username)')
    .order('changed_at', { ascending: false })
    .limit(1000);

  if (startDate) query = query.gte('changed_at', `${startDate}T00:00:00.000Z`);
  if (endDate) query = query.lte('changed_at', `${endDate}T23:59:59.999Z`);

  const { data, error } = await query;
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r: Record<string, unknown>) => {
    const { profiles, ...rest } = r as Record<string, unknown>;
    return {
      ...(rest as unknown as ChangeHistory),
      username: (profiles as { username: string | null } | null)?.username ?? null,
    };
  });
}

// 修改用户角色
export async function updateProfileRole(id: string, role: UserRole): Promise<void> {
  const { error } = await supabase.from('profiles').update({ role }).eq('id', id);
  if (error) throw error;
}

// 启用/禁用用户
export async function updateProfileStatus(
  id: string,
  status: 'active' | 'disabled'
): Promise<void> {
  const { error } = await supabase.from('profiles').update({ status }).eq('id', id);
  if (error) throw error;
}

// ============ 邀请码管理 ============

/** 生成随机 8 位大写字母+数字邀请码 */
function makeCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** 获取全部邀请码（管理员） */
export async function fetchInviteCodes(): Promise<InviteCode[]> {
  const { data, error } = await supabase
    .from('invite_codes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/** 管理员生成一个新邀请码 */
export async function createInviteCode(membershipDays: number): Promise<InviteCode | null> {
  const code = makeCode();
  const { data: session } = await supabase.auth.getSession();
  const createdBy = session?.session?.user?.id ?? null;
  const { data, error } = await supabase
    .from('invite_codes')
    .insert({ code, created_by: createdBy, membership_days: membershipDays })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** 撤销邀请码 */
export async function revokeInviteCode(id: string): Promise<void> {
  const { error } = await supabase
    .from('invite_codes')
    .update({ is_revoked: true })
    .eq('id', id);
  if (error) throw error;
}

/** 验证邀请码是否有效（注册前客户端乐观检查） */
export async function validateInviteCode(code: string): Promise<boolean> {
  const { data } = await supabase
    .from('invite_codes')
    .select('id')
    .eq('code', code.toUpperCase())
    .eq('is_revoked', false)
    .is('used_by', null)
    .maybeSingle();
  return !!data;
}

/** 原子消费邀请码（注册完成后调用，SECURITY DEFINER RPC） */
export async function consumeInviteCode(code: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('consume_invite_code', {
    p_code: code.toUpperCase(),
    p_user_id: userId,
  });
  if (error) throw error;
  return data === true;
}

// ============ 会员管理 ============

/** 管理员设置用户会员到期时间（days 天后到期，0 表示立即到期/清除） */
export async function updateProfileMembership(
  id: string,
  days: number
): Promise<void> {
  // days = -1 表示永久（membership_expires_at = null）
  const expiresAt = days === -1 || days === 0
    ? null
    : new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('profiles')
    .update({ membership_expires_at: expiresAt })
    .eq('id', id);
  if (error) throw error;
}

// ============ 登录页配置 ============

/** 获取登录页配置，未配置则返回默认值 */
export async function getLoginConfig(): Promise<LoginConfig> {
  const { data, error } = await supabase
    .from('login_config')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { id: 1, ...LOGIN_CONFIG_DEFAULTS, updated_at: new Date().toISOString() };
  }
  return data as LoginConfig;
}

/** 保存登录页配置（管理员专用） */
export async function saveLoginConfig(
  config: Partial<Omit<LoginConfig, 'id' | 'updated_at'>>
): Promise<void> {
  const { error } = await supabase
    .from('login_config')
    .update({ ...config, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) throw error;
}

// ============ 盘链站点同步 ============

export const COOKIE_EXPIRED_CODE = 'PINGLIAN_COOKIE_EXPIRED';
/** 盘链绑定在站点已失效（v4 改版后旧 link_id 不存在且无法自动迁移），需解绑重绑 */
export const PINGLIAN_LINK_NOT_FOUND_CODE = 'PINGLIAN_LINK_NOT_FOUND';

/** 查询当前用户盘链绑定信息 */
export async function getPinglianBinding(): Promise<PinglianBinding | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const { data, error } = await supabase
    .from('pinglian_sessions')
    .select('status, username, last_check_at, remark, updated_at')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** 账号密码登录并绑定盘链（服务端模拟登录，密码不落库） */
export async function loginPinglian(username: string, password: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const res = await fetchWithRetry(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/panlinks-proxy?action=login`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: username.trim(), password }),
    },
    { retriable: false } // 登录写操作不重试，仅带超时
  );
  const data = await parseJsonSafe(res);
  if (!res.ok || !data || data.success === false) {
    throw new Error(data?.message || data?.error || `盘链登录失败（HTTP ${res.status}），请检查账号密码`);
  }
}

/** 解绑盘链 */
export async function unbindPinglian(): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { error } = await supabase
    .from('pinglian_sessions')
    .delete()
    .eq('user_id', userData.user.id);
  if (error) throw error;
}

// ---------- 站点代理请求通用：超时 + 自动重试 ----------
// Edge Function 冷启动或上游站点响应慢时，单次请求易超时/失败；
// 对幂等读请求自动重试（含 5xx/429/网络错误），避免用户手动多次点刷新。

const PROXY_TIMEOUT_MS = 15000;

/** 带超时的 fetch，超时后主动中断 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = PROXY_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带重试的 fetch：仅幂等请求（retriable）在网络失败/超时/5xx/429 时自动重试 2 次。
 * 写操作（新增/编辑/删除）不重试，避免重复提交。
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { retriable?: boolean; timeoutMs?: number } = {}
): Promise<Response> {
  const retries = 2;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init, opts.timeoutMs);
      if (opts.retriable && (res.status >= 500 || res.status === 429) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (!opts.retriable || attempt >= retries) {
        throw new Error(
          e instanceof Error && e.name === 'AbortError'
            ? '请求超时，请稍后重试'
            : '网络连接异常，请稍后重试'
        );
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error('网络连接异常，请稍后重试');
}

/** 安全解析 JSON 响应体，非 JSON（如网关 HTML 错误页）时返回 null */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function parseJsonSafe(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** 统一调用盘链代理 Edge Function */
async function callPanlinksProxy<T = unknown>(
  action: string,
  body?: Record<string, unknown>,
  opts: { timeoutMs?: number; query?: Record<string, string> } = {}
): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) throw new Error('请先登录');

  const qs = new URLSearchParams({ action });
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) qs.set(k, v);
  }
  const init: RequestInit = {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${sessionData.session.access_token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetchWithRetry(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/panlinks-proxy?${qs.toString()}`,
    init,
    { retriable: !body, timeoutMs: opts.timeoutMs } // GET 读操作可安全重试
  );
  const data = await parseJsonSafe(res);
  if (!res.ok || !data || data.success === false) {
    if (data?.code === COOKIE_EXPIRED_CODE || data?.code === PINGLIAN_LINK_NOT_FOUND_CODE) {
      const err = new Error(data.message || '盘链请求失败');
      (err as Error & { code: string }).code = data.code;
      throw err;
    }
    throw new Error(data?.message || data?.error || `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

/** 获取盘链发布记录列表 */
export async function loadPanLinks(): Promise<PinglianLink[]> {
  const data = await callPanlinksProxy<{ data?: { list?: PinglianLink[] } }>('list');
  return data.data?.list ?? [];
}

/** 新增盘链资源 */
export async function addPanLink(params: {
  link_title: string;
  link_url: string;
  link_password?: string;
  pan_type?: string;
  vod_id?: number;
  note?: string;
}): Promise<void> {
  await callPanlinksProxy('add', {
    link_title: params.link_title,
    link_url: params.link_url,
    link_password: params.link_password ?? '',
    pan_type: params.pan_type ?? 'others',
    vod_id: params.vod_id ?? 0,
    note: params.note ?? '',
  });
}

/** 修改/更新盘链资源（返回站点响应；旧 ID 失效时服务端会自动迁移并返回新 ID） */
export async function updatePanLink(params: {
  link_id: number;
  link_title: string;
  link_url: string;
  link_password?: string;
  pan_type?: string;
  note?: string;
}): Promise<{ data?: { id?: number } }> {
  return callPanlinksProxy('update', {
    link_id: params.link_id,
    link_title: params.link_title,
    link_url: params.link_url,
    link_password: params.link_password ?? '',
    pan_type: params.pan_type ?? 'others',
    note: params.note ?? '',
  }, { timeoutMs: 60000 }); // 旧 ID 自动迁移需翻页扫描站点列表，放宽超时
}

/** 服务端搜索自己的盘链发布记录（突破 list 单页 200 条上限） */
export async function searchPanLinks(keyword: string): Promise<PinglianLink[]> {
  const data = await callPanlinksProxy<{ data?: { list?: PinglianLink[] } }>('search', undefined, {
    query: { keyword },
  });
  return data.data?.list ?? [];
}

/** 删除盘链资源 */
export async function deletePanLink(linkId: number): Promise<void> {
  await callPanlinksProxy('delete', { link_id: linkId });
}

// ============ 资源与站点剧集绑定 ============

/** 获取当前用户所有资源的绑定关系 */
export async function fetchResourceBindings(): Promise<ResourceBinding[]> {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('resource_bindings')
    .select('id, resource_id, link_id, link_title, vod_name, pan_type, link_password, created_at, resources!inner(owner_id)')
    .eq('resources.owner_id', user?.id ?? '');
  if (error) throw error;
  return (data ?? []) as unknown as ResourceBinding[];
}

/** 绑定资源到站点剧集（upsert 复合键 (resource_id, link_id)，一个资源可绑定多条网盘记录） */
export async function bindResourceToLink(
  resourceId: string,
  link: Pick<PinglianLink, 'id' | 'title' | 'video_title' | 'pan_type' | 'password'>
): Promise<void> {
  const { error } = await supabase
    .from('resource_bindings')
    .upsert(
      {
        resource_id: resourceId,
        link_id: link.id,
        link_title: link.title ?? null,
        vod_name: link.video_title ?? null,
        pan_type: link.pan_type ?? 'others',
        link_password: link.password ?? null,
      },
      { onConflict: 'resource_id,link_id' }
    );
  if (error) throw error;
}

/** 解绑资源（传 linkId 仅解绑该条站点记录，不传则解绑全部） */
export async function unbindResource(resourceId: string, linkId?: number): Promise<void> {
  let query = supabase
    .from('resource_bindings')
    .delete()
    .eq('resource_id', resourceId);
  if (linkId != null) query = query.eq('link_id', linkId);
  const { error } = await query;
  if (error) throw error;
}

/** 构建同步到站点的标题：名称含「第N集」则替换集数，否则返回原名称 */
export function buildSyncTitle(name: string, episodeCount: number): string {
  if (/第\s*\d+\s*集/.test(name)) {
    return name.replace(/第\s*\d+\s*集/, `第${episodeCount}集`);
  }
  return name;
}

// ============ 观影站点（xn--wcv59z.com）同步 ============

export const XN_COOKIE_EXPIRED_CODE = 'COOKIE_EXPIRED';

/** 查询当前用户观影站点绑定信息 */
export async function getXnBinding(): Promise<import('@/types/index').XnBinding | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const { data, error } = await supabase
    .from('xn_sessions')
    .select('status, last_check_at, remark')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** 绑定观影站点 Cookie */
export async function bindXnCookie(cookie: string, remark = ''): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { error } = await supabase.from('xn_sessions').upsert({
    user_id: userData.user.id,
    cookie,
    remark,
    status: 'active',
    last_check_at: null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

/** 解绑观影站点 */
export async function unbindXn(): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { error } = await supabase
    .from('xn_sessions')
    .delete()
    .eq('user_id', userData.user.id);
  if (error) throw error;
}

/** 统一调用观影站点代理 Edge Function */
async function callXnProxy<T = unknown>(
  action: string,
  query: Record<string, string> = {},
  body?: Record<string, unknown>
): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) throw new Error('请先登录');

  const params = new URLSearchParams({ action, ...query });
  const res = await fetchWithRetry(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/xnshare-proxy?${params.toString()}`,
    {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${sessionData.session.access_token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    { retriable: !body } // list 为 GET 读操作，可安全重试
  );
  const data = await parseJsonSafe(res);
  if (res.status === 401 && data?.code === XN_COOKIE_EXPIRED_CODE) {
    const err = new Error(data.message || '观影站点登录已过期，请重新绑定 Cookie');
    (err as Error & { code: string }).code = XN_COOKIE_EXPIRED_CODE;
    throw err;
  }
  if (!res.ok || !data) {
    throw new Error(data?.message || data?.error || `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

/** 列式数组 → 行式数组 */
function rowsFromColumns(cols: Record<string, unknown[]>): import('@/types/index').XnShare[] {
  if (!cols || !Array.isArray(cols.id)) return [];
  const keys = Object.keys(cols);
  return (cols.id as string[]).map((_, i) => {
    const row: Record<string, unknown> = {};
    for (const k of keys) row[k] = cols[k][i];
    return row as unknown as import('@/types/index').XnShare;
  });
}

/** 获取观影站点分享列表 */
export async function loadXnShares(opts: {
  page?: number;
  search?: string;
  pan?: string;
  dirid?: string;
} = {}): Promise<{ list: import('@/types/index').XnShare[]; page: number }> {
  const q: Record<string, string> = {};
  if (opts.page) q.page = String(opts.page);
  if (opts.search) q.search = opts.search;
  if (opts.pan) q.pan = opts.pan;
  if (opts.dirid) q.dirid = opts.dirid;
  const data = await callXnProxy<{ inlist?: Record<string, unknown[]>; page?: number }>('list', q);
  const list = data.inlist ? rowsFromColumns(data.inlist) : [];
  return { list, page: data.page ?? opts.page ?? 1 };
}

/** 修改观影站点分享 */
export async function editXnShare(params: {
  id: string;
  title: string;
  panurl: string;
  panpw?: string;
  is?: number;
  binds?: { dir: string; id: string }[];
}): Promise<void> {
  await callXnProxy('edit', {}, {
    id: params.id,
    title: params.title,
    panurl: params.panurl,
    panpw: params.panpw ?? '',
    is: params.is ?? 1,
    binds: params.binds ?? [],
  });
}

/** 删除观影站点分享 */
export async function delXnShare(id: string): Promise<void> {
  await callXnProxy('del', {}, { id });
}

// ============ 资源 × 观影站点绑定 ============

/** 查询当前用户所有资源的观影站点绑定 */
export async function fetchXnResourceBindings(): Promise<import('@/types/index').XnResourceBinding[]> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return [];
  const { data, error } = await supabase
    .from('xn_resource_bindings')
    .select('id, resource_id, share_id, share_title, share_url, pan_label, created_at, resources!inner(owner_id)')
    .eq('resources.owner_id', userData.user.id);
  if (error) throw error;
  return (data ?? []).map(({ resources: _r, ...rest }) => rest) as import('@/types/index').XnResourceBinding[];
}

/** 将资源绑定到观影站点分享（支持一个资源绑定多条，按分享短码去重） */
export async function bindResourceToXnShare(
  resourceId: string,
  share: import('@/types/index').XnShare
): Promise<void> {
  const { error } = await supabase.from('xn_resource_bindings').upsert({
    resource_id: resourceId,
    share_id: share.id,
    share_title: share.title,
    share_url: share.url,
    pan_label: detectPanName(share.url ?? ''),
  }, { onConflict: 'resource_id,share_id' });
  if (error) throw error;
}

/** 解除资源与观影站点的绑定（传 shareId 解绑单条，不传解绑全部） */
export async function unbindResourceFromXn(resourceId: string, shareId?: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  let q = supabase.from('xn_resource_bindings').delete().eq('resource_id', resourceId);
  if (shareId != null) q = q.eq('share_id', shareId);
  const { error } = await q;
  if (error) throw error;
}

/** 同步资源更新到观影站点（标题 + URL） */
export async function syncResourceToXn(params: {
  shareId: string;
  newTitle: string;
  panUrl: string;
}): Promise<void> {
  await editXnShare({
    id: params.shareId,
    title: params.newTitle,
    panurl: params.panUrl,
    is: 1,
  });
}

// ============ 鸭影臻藏站点同步 ============

export const YA_EXPIRED_CODE = 'YA_EXPIRED';

const YA_FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/resource-manager`;

/** 查询当前用户鸭影臻藏绑定信息 */
export async function getYaBinding(): Promise<import('@/types/index').YaBinding | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const { data, error } = await supabase
    .from('ya_sessions')
    .select('status, last_check_at, remark')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** 绑定鸭影臻藏账号（用户名/密码，服务端登录并存储 token） */
export async function bindYaAccount(
  username: string,
  password: string,
  remark = ''
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  if (!username.trim() || !password.trim()) throw new Error('请填写鸭影臻藏站点账号和密码');
  // 服务端用账号密码登录鸭影臻藏并写入 token
  await callYaFn<{ bound: boolean }>('login', { username: username.trim(), password: password.trim(), remark });
}

/** 解绑鸭影臻藏 */
export async function unbindYa(): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { error } = await supabase
    .from('ya_sessions')
    .delete()
    .eq('user_id', userData.user.id);
  if (error) throw error;
}

/** 统一调用鸭影臻藏 Edge Function */
async function callYaFn<T = unknown>(
  action: string,
  body: Record<string, unknown>
): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) throw new Error('请先登录');
  // searchVideos/accountStatus 为幂等读操作，失败可自动重试
  const retriable = action === 'searchVideos' || action === 'accountStatus';
  const res = await fetchWithRetry(YA_FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionData.session.access_token}`,
    },
    body: JSON.stringify({ action, ...body }),
  }, { retriable });
  const data = await parseJsonSafe(res);
  if (!res.ok || !data || data?.success === false) {
    const msg = data?.error || data?.message || `请求失败（HTTP ${res.status}）`;
    const err = new Error(msg);
    // 仅当 HTTP 401 或消息明确指示鸭影登录态失效时才标记为 YA_EXPIRED
    const isAuthErr = res.status === 401 ||
      /expired|JWT|token.*invalid|invalid.*token|unauthorized|过期|失效|重新登录/i.test(msg);
    if (isAuthErr) {
      (err as Error & { code?: string }).code = YA_EXPIRED_CODE;
    }
    throw err;
  }
  return (data?.data ?? data) as T;
}

/** 搜索鸭影臻藏片源（包含匹配，返回资源链接列表，每条附带所属剧集名 video_title；精确匹配结果置顶） */
export async function searchYaVideos(
  title: string,
  opts: { category?: string; limit?: number } = {}
): Promise<import('@/types/index').YaLink[]> {
  type RawLink = { id?: number; link_id?: number; name?: string | null; url?: string | null; extract_code?: string | null; drive_type?: string | null; drive_label?: string | null; updated_at?: string | null; created_at?: string | null };
  const data = await callYaFn<{
    found?: boolean;
    /** 旧结构：精确匹配单 video */
    video?: { id?: number; title?: string; category?: string };
    links?: RawLink[];
    /** 新结构：包含匹配多 video，精确匹配置顶 */
    videos?: { video?: { id?: number; title?: string; category?: string }; links?: RawLink[] }[];
  }>('searchVideos', {
    title,
    ...(opts.category ? { category: opts.category } : {}),
    limit: opts.limit ?? 20,
  });

  // 新结构：多 video 分组；旧结构兼容：单 video 包装成一组
  const groups = Array.isArray(data.videos)
    ? data.videos
    : (data.video ? [{ video: data.video, links: data.links }] : []);

  return groups.flatMap((g) => {
    const videoTitle = g.video?.title ?? null;
    const videoId = g.video?.id ?? 0;
    const videoCategory = g.video?.category ?? null;
    const rawLinks: RawLink[] = Array.isArray(g.links) ? g.links : [];
    return rawLinks.map((l) => ({
      id: l.link_id ?? l.id ?? 0,
      name: l.name ?? null,
      url: l.url ?? null,
      extract_code: l.extract_code ?? null,
      drive_type: l.drive_type ?? null,
      drive_label: l.drive_label ?? null,
      video_title: videoTitle,
      video_id: videoId,
      video_category: videoCategory,
      updated_at: l.updated_at ?? null,
      created_at: l.created_at ?? null,
    }));
  });
}

/** 修改鸭影臻藏本人已发布资源 */
export async function updateYaResource(params: {
  linkId: number;
  name?: string;
  url?: string;
  extractCode?: string;
}): Promise<void> {
  await callYaFn('updateResource', {
    linkId: params.linkId,
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.url !== undefined ? { url: params.url } : {}),
    ...(params.extractCode !== undefined ? { extractCode: params.extractCode } : {}),
  });
}

/** 查询当前用户所有资源的鸭影臻藏绑定 */
export async function fetchYaResourceBindings(): Promise<import('@/types/index').YaResourceBinding[]> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return [];
  const { data, error } = await supabase
    .from('ya_resource_bindings')
    .select('id, resource_id, link_id, link_title, vod_name, pan_label, created_at, resources!inner(owner_id)')
    .eq('resources.owner_id', userData.user.id);
  if (error) throw error;
  return (data ?? []).map(({ resources: _r, ...rest }) => rest) as import('@/types/index').YaResourceBinding[];
}

/** 获取当前用户已绑定到鸭影臻藏的分享记录（资源名称 + 链接） */
export async function fetchYaShareRecords(): Promise<{
  id: string;
  link_title: string | null;
  link_url: string | null;
  created_at: string;
}[]> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return [];
  const { data, error } = await supabase
    .from('ya_resource_bindings')
    .select('id, link_title, created_at, resources!inner(link)')
    .eq('resources.owner_id', userData.user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((row: {
    id: string; link_title: string | null; created_at: string;
    resources: { link: string | null } | { link: string | null }[];
  }) => ({
    id: row.id,
    link_title: row.link_title,
    link_url: Array.isArray(row.resources) ? (row.resources[0]?.link ?? null) : (row.resources?.link ?? null),
    created_at: row.created_at,
  }));
}

/** 将资源绑定到鸭影臻藏：直接绑定到搜索返回的已有片源（link.id），
 *  不新建资源，避免与站点已有资源重复。同步时对该 link_id 做编辑更新。
 *  支持一个资源绑定多条片源（每种网盘一条），按 link_id 去重。 */
export async function bindResourceToYa(
  resourceId: string,
  link: import('@/types/index').YaLink,
): Promise<{ link_id: number }> {
  const linkId = link.id;
  if (!linkId) throw new Error('未找到鸭影片源 ID，请重新选择片源绑定');
  const { error } = await supabase.from('ya_resource_bindings').upsert({
    resource_id: resourceId,
    link_id: linkId,
    link_title: link.name ?? null,
    vod_name: link.video_title ?? null,
    // 优先 drive_label，其次 URL 反查（避免 drive_type='others' 掩盖真实网盘类型），最后降级到 drive_type
    pan_label: link.drive_label || detectPanName(link.url ?? '') || link.drive_type || null,
  }, { onConflict: 'resource_id,link_id' });
  if (error) throw error;
  return { link_id: linkId };
}

/** 解除资源与鸭影臻藏的绑定（传 linkId 解绑单条，不传解绑全部） */
export async function unbindResourceFromYa(resourceId: string, linkId?: number): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  let q = supabase.from('ya_resource_bindings').delete().eq('resource_id', resourceId);
  if (linkId != null) q = q.eq('link_id', linkId);
  const { error } = await q;
  if (error) throw error;
}

/** 同步资源更新到鸭影臻藏（标题 + URL） */
export async function syncResourceToYa(params: {
  linkId: number;
  newTitle: string;
  panUrl: string;
}): Promise<void> {
  await updateYaResource({
    linkId: params.linkId,
    name: params.newTitle,
    url: params.panUrl,
  });
}

/** 每日签到 */
export async function yaCheckIn(): Promise<{ points_earned: number; consecutive: number }> {
  return callYaFn('checkIn', {});
}

/** 查看账号状态（含网盘统计、追更列表，formatted 字段可直接展示给用户） */
export async function yaGetAccountStatus(): Promise<import('@/types/index').YaAccountStatus> {
  return callYaFn('accountStatus', {});
}

/** 添加网盘资源到鸭影臻藏片源 */
export async function yaAddResource(params: {
  title: string;
  category: string;
  name: string;
  url: string;
  extractCode?: string;
}): Promise<{ success: boolean; link_id: number; video_id: number; drive_type: string }> {
  return callYaFn('addResource', {
    title: params.title,
    category: params.category,
    name: params.name,
    url: params.url,
    ...(params.extractCode ? { extractCode: params.extractCode } : {}),
  });
}

// ============ 帧影站点（framehdr.com）同步 ============

export const FRAMEHDR_COOKIE_EXPIRED_CODE = 'COOKIE_EXPIRED';

const FRAMEHDR_FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/framehdr-proxy`;

export async function getFramehdrBinding(): Promise<import('@/types/index').FramehdrBinding | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const { data, error } = await supabase
    .from('framehdr_sessions')
    .select('status, last_check_at, remark')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function bindFramehdrCookie(cookie: string, remark = ''): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { error } = await supabase.from('framehdr_sessions').upsert({
    user_id: userData.user.id,
    cookie: cookie.trim(),
    status: 'active',
    remark: remark.trim() || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function unbindFramehdr(): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { error } = await supabase
    .from('framehdr_sessions')
    .delete()
    .eq('user_id', userData.user.id);
  if (error) throw error;
}

async function callFramehdrProxy<T = unknown>(
  action: string,
  params: Record<string, string> = {},
  body: Record<string, unknown> = {}
): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) throw new Error('请先登录');
  const qs = new URLSearchParams({ action, ...params });
  // list 为幂等读操作，失败可自动重试
  const res = await fetchWithRetry(`${FRAMEHDR_FN_URL}?${qs}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionData.session.access_token}`,
    },
    body: JSON.stringify(body),
  }, { retriable: action === 'list' });
  const data = await parseJsonSafe(res);
  if (!res.ok || !data || data?.success === false) {
    const msg = data?.error || `请求失败（HTTP ${res.status}）`;
    const err = new Error(msg) as Error & { code?: string };
    // 仅当代理明确返回 COOKIE_EXPIRED 才标记过期（401 可能是本站登录态问题）
    if (data?.code === FRAMEHDR_COOKIE_EXPIRED_CODE) {
      err.code = FRAMEHDR_COOKIE_EXPIRED_CODE;
    }
    throw err;
  }
  return data as T;
}

export async function loadFramehdrLinks(
  page = 1,
  search = ''
): Promise<import('@/types/index').FramehdrLink[]> {
  const data = await callFramehdrProxy<{ links?: import('@/types/index').FramehdrLink[] }>(
    'list',
    { page: String(page), ...(search ? { search } : {}) }
  );
  return data.links ?? [];
}

export async function editFramehdrLink(params: {
  id: number;
  name?: string;
  url?: string;
  password?: string;
  description?: string;
}): Promise<void> {
  await callFramehdrProxy('edit', { id: String(params.id) }, {
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.url !== undefined ? { url: params.url } : {}),
    ...(params.password !== undefined ? { password: params.password } : {}),
    ...(params.description !== undefined ? { description: params.description } : {}),
  });
}

export async function deleteFramehdrLink(id: number): Promise<void> {
  await callFramehdrProxy('del', {}, { id });
}

/** 帧影账号密码登录绑定（推荐方式）：服务端模拟登录并保存会话，密码不落库 */
export async function loginFramehdr(username: string, password: string): Promise<void> {
  await callFramehdrProxy('login', {}, { username, password });
}

/** 查询当前用户所有资源的帧影站点绑定 */
export async function fetchFramehdrResourceBindings(): Promise<import('@/types/index').FramehdrResourceBinding[]> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return [];
  const { data, error } = await supabase
    .from('framehdr_resource_bindings')
    .select('id, resource_id, link_id, link_title, drive_name, created_at, resources!inner(owner_id)')
    .eq('resources.owner_id', userData.user.id);
  if (error) throw error;
  return (data ?? []).map(({ resources: _r, ...rest }) => rest) as import('@/types/index').FramehdrResourceBinding[];
}

/** 将资源绑定到帧影站点发布记录（仅本地记录关联，不改动站点数据） */
export async function bindResourceToFramehdr(
  resourceId: string,
  link: import('@/types/index').FramehdrLink
): Promise<void> {
  const { error } = await supabase.from('framehdr_resource_bindings').upsert({
    resource_id: resourceId,
    link_id: link.id,
    link_title: link.title ?? null,
    drive_name: link.drive_name ?? null,
  });
  if (error) throw error;
}

/** 解除资源与帧影站点的绑定 */
export async function unbindResourceFromFramehdr(resourceId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { error } = await supabase
    .from('framehdr_resource_bindings')
    .delete()
    .eq('resource_id', resourceId);
  if (error) throw error;
}

/** 同步资源更新到帧影站点：直接编辑更新已绑定的链接（edit_link.php?id={id} 的 POST 为更新语义）。
 *  帧影的 name 字段是「网盘名称」下拉选择（非标题），资源标题由 detail 页面管理、
 *  edit_link.php 无法修改。同步更新 url（网盘链接）和 description（资源介绍），
 *  回传原网盘名称以保持 name 不变。 */
export async function syncResourceToFramehdr(params: {
  linkId: number;
  panUrl: string;
  driveName?: string | null;
  description?: string | null;
}): Promise<void> {
  await editFramehdrLink({
    id: params.linkId,
    url: params.panUrl,
    ...(params.driveName ? { name: params.driveName } : {}),
    ...(params.description ? { description: params.description } : {}),
  });
}

// ============ 123社区（123panfx.com）同步 ============

export const PANFX_COOKIE_EXPIRED_CODE = 'COOKIE_EXPIRED';

const PANFX_FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/panfx-proxy`;

export async function getPanfxBinding(): Promise<import('@/types/index').PanfxBinding | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const { data, error } = await supabase
    .from('panfx_sessions')
    .select('status, last_check_at, remark')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function bindPanfxCookie(cookie: string, remark = ''): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { error } = await supabase.from('panfx_sessions').upsert({
    user_id: userData.user.id,
    cookie: cookie.trim(),
    status: 'active',
    remark: remark.trim() || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function unbindPanfx(): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { error } = await supabase
    .from('panfx_sessions')
    .delete()
    .eq('user_id', userData.user.id);
  if (error) throw error;
}

async function callPanfxProxy<T = unknown>(
  action: string,
  params: Record<string, string> = {},
  body: Record<string, unknown> = {}
): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) throw new Error('请先登录');
  const qs = new URLSearchParams({ action, ...params });
  // list/detail 为幂等读操作，失败可自动重试
  const res = await fetchWithRetry(`${PANFX_FN_URL}?${qs}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionData.session.access_token}`,
    },
    body: JSON.stringify(body),
  }, { retriable: action === 'list' || action === 'detail' });
  const data = await parseJsonSafe(res);
  if (!res.ok || !data) {
    const msg = data?.error || `请求失败（HTTP ${res.status}）`;
    const err = new Error(msg) as Error & { code?: string };
    if (data?.code === PANFX_COOKIE_EXPIRED_CODE) {
      err.code = PANFX_COOKIE_EXPIRED_CODE;
    }
    throw err;
  }
  return data as T;
}

export async function loadPanfxPosts(): Promise<import('@/types/index').PanfxPost[]> {
  const data = await callPanfxProxy<{ items?: import('@/types/index').PanfxPost[] }>('list');
  return data.items ?? [];
}

export async function fetchPanfxResourceBindings(): Promise<import('@/types/index').PanfxResourceBinding[]> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return [];
  const { data, error } = await supabase
    .from('panfx_resource_bindings')
    .select('id, resource_id, tid, firstpid, subject, fid, created_at, resources!inner(owner_id)')
    .eq('resources.owner_id', userData.user.id);
  if (error) throw error;
  return (data ?? []).map(({ resources: _r, ...rest }) => rest) as import('@/types/index').PanfxResourceBinding[];
}

export async function bindResourceToPanfx(
  resourceId: string,
  post: import('@/types/index').PanfxPost
): Promise<void> {
  const { error } = await supabase.from('panfx_resource_bindings').upsert({
    resource_id: resourceId,
    tid: post.tid,
    firstpid: post.firstpid ?? null,
    subject: post.subject ?? null,
    fid: post.fid ? String(post.fid) : null,
  }, { onConflict: 'resource_id' });
  if (error) throw error;
}

export async function unbindResourceFromPanfx(resourceId: string): Promise<void> {
  const { error } = await supabase
    .from('panfx_resource_bindings')
    .delete()
    .eq('resource_id', resourceId);
  if (error) throw error;
}

// 网盘链接正则（用于消息正文中替换旧链接）
const DRIVE_URL_RE = /https?:\/\/(?:www\.)?(?:[\w-]+\.)?(?:123pan(?:\.cn|\.com|fx\.com)|quark\.cn|pan\.quark\.cn|xunlei\.com|pan\.xunlei\.com|lanzou[a-z]*\.com|lanzn\.com|aliyundrive\.com|alipan\.com|uc\.cn|pan\.uc\.cn|115\.com|anxia\.com|pan\.baidu\.com|cloud\.189\.cn|guangyapan\.com|guangya[a-z]*\.com)(?:\/[^\s"'<>()）\]【】]*)?/gi;

/** 同步资源到 123社区：先拉取帖子详情，替换正文中的网盘链接并更新标题 */
export async function syncResourceToPanfx(params: {
  tid: number;
  panUrl: string;
  title: string;
  firstpid?: number | null;
  fid?: string | null;
}): Promise<void> {
  // 拉取当前帖子详情，获取正文内容和 firstpid
  const detail = await callPanfxProxy<{
    thread?: { firstpid?: number; fid?: string | number };
    message?: string;
    drive_links?: { url: string }[];
  }>('detail', { tid: String(params.tid) });

  const firstpid = detail.thread?.firstpid ?? params.firstpid;
  if (!firstpid) throw new Error('无法获取帖子 pid，请检查帖子是否存在');

  const fid = detail.thread?.fid
    ? String(detail.thread.fid)
    : (params.fid ?? '');

  // 替换正文中的网盘链接
  let message = detail.message ?? '';
  const driveLinks = detail.drive_links ?? [];
  if (driveLinks.length > 0) {
    // 精确替换第一个已知网盘链接
    const oldUrl = driveLinks[0].url;
    message = message.replace(oldUrl, params.panUrl);
  } else {
    // 尝试正则替换；无匹配则追加
    const newMsg = message.replace(DRIVE_URL_RE, params.panUrl);
    message = newMsg !== message ? newMsg : message + '\n' + params.panUrl;
  }

  await callPanfxProxy('edit', { tid: String(params.tid) }, {
    pid: String(firstpid),
    subject: params.title,
    message,
    fid,
  });
}

// ============ 公告管理 ============
export interface Announcement {
  id: string;
  content: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** 读取所有启用的公告（按 sort_order、创建时间倒序）—— 顶部滚动展示用 */
export async function fetchActiveAnnouncements(): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return Array.isArray(data) ? (data as Announcement[]) : [];
}

/** 管理员：读取全部公告 */
export async function fetchAllAnnouncements(): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return Array.isArray(data) ? (data as Announcement[]) : [];
}

/** 管理员：新增公告 */
export async function createAnnouncement(content: string): Promise<Announcement | null> {
  const { data, error } = await supabase
    .from('announcements')
    .insert({ content: content.trim() })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data as Announcement | null;
}

/** 管理员：更新公告 */
export async function updateAnnouncement(
  id: string,
  patch: Partial<Pick<Announcement, 'content' | 'is_active' | 'sort_order'>>
): Promise<void> {
  const { error } = await supabase
    .from('announcements')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/** 管理员：删除公告 */
export async function deleteAnnouncement(id: string): Promise<void> {
  const { error } = await supabase.from('announcements').delete().eq('id', id);
  if (error) throw error;
}


// ============ 不太灵站点（web3.mukaku.com / MUKAKU）同步 ============

export const MUKAKU_TOKEN_EXPIRED_CODE = 'MUKAKU_TOKEN_EXPIRED';
const MUKAKU_FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mukaku-proxy`;

async function callMukakuProxy<T = unknown>(
  action: string,
  params: Record<string, string | number | undefined> = {},
  body?: Record<string, unknown>
): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) throw new Error('请先登录');

  const qs = new URLSearchParams({ action });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }

  const isRead = !body && (action === 'captcha' || action === 'status' || action === 'list' || action === 'search' || action === 'videoDetail' || action === 'dict');

  const res = await fetchWithRetry(`${MUKAKU_FN_URL}?${qs.toString()}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionData.session.access_token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  }, { retriable: isRead });

  const data = await parseJsonSafe(res);
  if (!res.ok || !data) {
    const msg = data?.error || data?.message || `请求失败（HTTP ${res.status}）`;
    const err = new Error(msg) as Error & { code?: string };
    if (data?.code === MUKAKU_TOKEN_EXPIRED_CODE || data?.code === 10103 || data?.code === 10104) {
      err.code = MUKAKU_TOKEN_EXPIRED_CODE;
    }
    throw err;
  }
  if (data.success === false) {
    const msg = data?.message || data?.error || '操作失败';
    const err = new Error(msg) as Error & { code?: string };
    if (data?.code === MUKAKU_TOKEN_EXPIRED_CODE) {
      err.code = MUKAKU_TOKEN_EXPIRED_CODE;
    }
    throw err;
  }
  return data as T;
}

/** 获取不太灵站点验证码图片与密钥 */
export async function fetchMukakuCaptcha(): Promise<import('@/types/index').MukakuCaptcha> {
  const res = await callMukakuProxy<{ data: import('@/types/index').MukakuCaptcha }>('captcha');
  return res.data;
}

/** 绑定不太灵站点账号（账号+密码+验证码答案+key） */
export async function bindMukaku(params: {
  username: string;
  password: string;
  code: string;
  key: string;
}): Promise<void> {
  await callMukakuProxy('login', {}, params);
}

/** 解绑不太灵站点 */
export async function unbindMukaku(): Promise<void> {
  await callMukakuProxy('unbind', {}, {});
}

/** 获取不太灵站点绑定状态 */
export async function getMukakuStatus(): Promise<import('@/types/index').MukakuBinding | null> {
  try {
    const res = await callMukakuProxy<{ data: import('@/types/index').MukakuBinding }>('status');
    return res.data;
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === MUKAKU_TOKEN_EXPIRED_CODE) {
      return {
        username: '',
        valid: false,
        status: 'expired',
        token_expires_at: null,
      };
    }
    // 未绑定或返回错误
    return null;
  }
}

/** 获取不太灵站点我的发布列表 */
export async function fetchMukakuResources(params: {
  page?: number;
  type?: string;
  seed_name?: string;
} = {}): Promise<{
  items: import('@/types/index').MukakuWpResource[];
  total: number;
  page: number;
}> {
  const res = await callMukakuProxy<{
    data?: {
      items?: import('@/types/index').MukakuWpResource[];
      list?: import('@/types/index').MukakuWpResource[];
      total?: number;
      page?: number;
    } | import('@/types/index').MukakuWpResource[];
  }>('list', params);

  const d = res.data;
  if (Array.isArray(d)) {
    return { items: d, total: d.length, page: 1 };
  }
  const items = d?.items ?? d?.list ?? [];
  return {
    items,
    total: d?.total ?? items.length,
    page: d?.page ?? params.page ?? 1,
  };
}

/** 搜索不太灵站点片源 */
export async function searchMukakuMovies(keyword: string): Promise<import('@/types/index').MukakuMovie[]> {
  const kw = keyword.trim();
  if (!kw) return [];
  const res = await callMukakuProxy<{
    data?:
      | import('@/types/index').MukakuMovie[]
      | { data?: Array<Record<string, unknown>>; list?: Array<Record<string, unknown>> };
  }>('search', { sb: kw });

  let rawList: Array<Record<string, unknown>> = [];
  if (Array.isArray(res.data)) {
    rawList = res.data as unknown as Array<Record<string, unknown>>;
  } else if (Array.isArray((res.data as any)?.data)) {
    rawList = (res.data as any).data;
  } else if (Array.isArray((res.data as any)?.list)) {
    rawList = (res.data as any).list;
  }

  return rawList.map((item) => ({
    id: item.id ? Number(item.id) : undefined,
    doub_id: (item.doub_id ?? item.idcode ?? '') as string | number,
    title: String(item.title || item.seed_name || ''),
    pic: (item.image || item.pic || item.cover || '') as string,
    year: (item.years || item.year || '') as string | number,
    rate: (item.doub_score || item.rate || '') as string | number,
    actors: (item.performer || item.actors || '') as string,
    type: (item.class || item.type || '') as string,
  }));
}

/** 通过豆瓣 ID 获取不太灵站点影片站内主键 (movies_id) */
export async function getMukakuMovieDetail(doubId: string | number): Promise<{ movies_id: number; title: string }> {
  const res = await callMukakuProxy<{
    movies_id?: number;
    title?: string;
    data?: { id?: number; title?: string };
  }>('videoDetail', { id: doubId });

  const moviesId = res.movies_id ?? res.data?.id;
  if (!moviesId) throw new Error('未获取到影片站内主键 ID');
  return {
    movies_id: Number(moviesId),
    title: res.title ?? res.data?.title ?? '',
  };
}

/** 挂载发布新资源到不太灵站点 */
export async function addMukakuResource(params: {
  movies_id: number;
  seed_name: string;
  link: string;
  code?: string;
}): Promise<{ created_id: number | null; pan_type?: string }> {
  const res = await callMukakuProxy<{
    created_id?: number | null;
    pan_type?: string;
    data?: { id?: number };
  }>('add', {}, params);

  return {
    created_id: res.created_id ?? res.data?.id ?? null,
    pan_type: res.pan_type,
  };
}

/** 修改不太灵站点已发布资源 */
export async function updateMukakuResource(params: {
  id: number;
  movies_id: number;
  seed_name: string;
  link: string;
  code?: string;
}): Promise<void> {
  await callMukakuProxy('update', {}, params);
}

/** 删除不太灵站点已发布资源 */
export async function deleteMukakuResource(id: number): Promise<void> {
  await callMukakuProxy('delete', { id });
}

/** 查询当前用户所有资源的「不太灵站点」绑定关系 */
export async function fetchMukakuResourceBindings(): Promise<import('@/types/index').MukakuResourceBinding[]> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return [];
  const { data, error } = await supabase
    .from('mukaku_resource_bindings')
    .select('id, resource_id, link_id, movies_id, seed_name, vod_name, pan_type, share_code, created_at, resources!inner(owner_id)')
    .eq('resources.owner_id', userData.user.id);
  if (error) throw error;
  return (data ?? []).map(({ resources: _r, ...rest }) => rest) as import('@/types/index').MukakuResourceBinding[];
}

/** 将资源绑定到不太灵站点记录 */
export async function bindResourceToMukaku(
  resourceId: string,
  link: {
    id: number;
    movies_id: number;
    seed_name?: string | null;
    vod_name?: string | null;
    pan_type?: string | null;
    code?: string | null;
  }
): Promise<{ link_id: number }> {
  const linkId = link.id;
  if (!linkId) throw new Error('缺少不太灵站点资源 ID');
  if (!link.movies_id) throw new Error('缺少不太灵站点影片主键 ID');

  const { error } = await supabase.from('mukaku_resource_bindings').upsert({
    resource_id: resourceId,
    link_id: linkId,
    movies_id: link.movies_id,
    seed_name: link.seed_name ?? null,
    vod_name: link.vod_name ?? null,
    pan_type: link.pan_type ?? null,
    share_code: link.code ?? null,
  }, { onConflict: 'resource_id,link_id' });
  if (error) throw error;
  return { link_id: linkId };
}

/** 解除资源与不太灵站点的绑定 */
export async function unbindResourceFromMukaku(resourceId: string, linkId?: number): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  let q = supabase.from('mukaku_resource_bindings').delete().eq('resource_id', resourceId);
  if (linkId != null) q = q.eq('link_id', linkId);
  const { error } = await q;
  if (error) throw error;
}

/** 同步资源更新到不太灵站点（更新标题与链接） */
export async function syncResourceToMukaku(params: {
  linkId: number;
  moviesId: number;
  newTitle: string;
  panUrl: string;
  shareCode?: string;
}): Promise<void> {
  await updateMukakuResource({
    id: params.linkId,
    movies_id: params.moviesId,
    seed_name: params.newTitle,
    link: params.panUrl,
    code: params.shareCode ?? '',
  });
}


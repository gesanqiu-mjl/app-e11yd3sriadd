import { supabase } from '@/db/supabase';
import { detectPanName, PAN_TYPE_LABELS } from '@/lib/panUtils';
// 站点凭据云端留档（加密存储）：会话失效后可自动重新登录
import { saveSiteCredential } from '@/lib/siteCredentials';
import {
  Resource,
  ChangeHistory,
  Profile,
  AdminResource,
  AdminHistory,
  UserRole,
  InviteCode,
  ApiKey,
  UpdatedItem,
  LoginConfig,
  LOGIN_CONFIG_DEFAULTS,
  SubscriptionSource,
  SubscriptionSourceInput,
  AdminResourceSource,
  MySourceOwnerStatus,
  SourceOwner,
  SourceOwnerResource,
  SourceOwnerApplication,
  Tutorial,
} from '@/types/index';

/**
 * 取当前登录用户 id（读本地 session，**不发网络请求**）。
 *
 * 为什么不用 auth.getUser()：它会额外打一次 /auth/v1/user 网络请求 ——
 * 手机网络抖动、切后台再回来时，这一步就会抛 "Failed to fetch"，
 * 最终表现为整页「加载资源列表失败，请刷新重试」。
 * 改用本地 session 后不再依赖额外网络往返；权限不受影响：
 * 数据库 RLS 仍然只返回当前用户自己的数据。
 */
export async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? '';
}

export async function fetchResources(): Promise<Resource[]> {
  const uid = await currentUserId();
  if (!uid) return [];
  const { data, error } = await supabase
    .from('resources')
    .select('*')
    .eq('owner_id', uid)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/** 取单条资源的简要信息（订阅里回显「已绑定的资源」，避免拉全量资源） */
export async function fetchResourceBrief(
  id: string
): Promise<{ id: string; name: string; episode_count: number } | null> {
  const { data, error } = await supabase
    .from('resources')
    .select('id, name, episode_count')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string; name: string; episode_count: number } | null) ?? null;
}

/** 服务端（订阅转存）改了资源后登记的待推送任务 */
export interface ResourceSyncTask {
  id: string;
  resource_id: string;
  resource_name: string;
  reason: string;
  created_at: string;
}

/**
 * 取待推送任务：订阅在服务端更新了资源（集数等）后登记，
 * 服务端 worker（resource-sync-worker）每分钟会无人值守补推；
 * 这里作为兜底（worker 未部署/某站点失败时）在资源管理页打开时再补推一次。
 * 已被 worker 抢占（5 分钟内）的任务跳过，避免两边重复推送同一变更。
 */
export async function fetchResourceSyncQueue(): Promise<ResourceSyncTask[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) return [];
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data, error } = await supabase
    .from('resource_sync_queue')
    .select('id, resource_id, resource_name, reason, created_at')
    .eq('user_id', user.id)
    .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
    .order('created_at', { ascending: true })
    .limit(20);
  if (error) throw error;
  return Array.isArray(data) ? (data as ResourceSyncTask[]) : [];
}

/** 推送完成后清掉任务（失败的不要清，下次再补推） */
export async function clearResourceSyncQueue(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.from('resource_sync_queue').delete().in('id', ids);
  if (error) throw error;
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

const COVER_PUBLIC_MARKER = '/storage/v1/object/public/covers/';

/**
 * 把「任何来源的 covers 公开地址」重写为当前前端配置的公开地址。
 *
 * 边缘函数（cover-import）跑在容器网络里，它的 SUPABASE_URL 是内网地址
 * （如 http://kong:8000），直接存进库浏览器根本打不开；自建环境下还会因为
 * http/https 不一致被 Mixed Content 拦截。这里统一按 key 重新拼一次，
 * 保证入库的始终是可访问的公开地址（由 VITE_SUPABASE_URL 决定协议与域名）。
 */
function normalizeCoverUrl(url: string): string | null {
  const idx = url.indexOf(COVER_PUBLIC_MARKER);
  if (idx === -1) return null;
  const key = decodeURIComponent(url.slice(idx + COVER_PUBLIC_MARKER.length));
  return supabase.storage.from('covers').getPublicUrl(key).data.publicUrl;
}

/**
 * 将外站封面下载后导入本应用 covers 存储桶，返回本应用自有公开 URL。
 * 站点片库返回的封面多为外站绝对地址，其中一部分不返回 CORS 头，
 * 浏览器端无法直接下载，且绘制到 canvas 合成分享卡片时会被污染。
 * 因此统一交给 cover-import 边缘函数在服务端抓取落桶。
 * 导入失败时返回 null，调用方回退为原始外站 URL。
 */
export async function importCoverFromUrl(
  resourceId: string,
  remoteUrl: string
): Promise<string | null> {
  try {
    // 已是自有存储桶地址，无需重复导入（原样返回，历史数据由回填脚本统一迁移）
    if (remoteUrl.includes(COVER_PUBLIC_MARKER)) return remoteUrl;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;

    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cover-import`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ url: remoteUrl, resourceId }),
      }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.success === false || !data?.url) return null;
    // 函数返回的是内网地址，按 key 重拼为前端可访问的公开地址
    return normalizeCoverUrl(data.url as string) ?? (data.url as string);
  } catch {
    return null;
  }
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

// ============ 资源配额（非管理员上限，可被管理员按账号调整） ============

/** 非管理员账号的「默认」资源条数上限；管理员可在「用户管理 → 额度设置」按账号单独调整 */
export const MAX_RESOURCES_PER_USER = 200;

/** 超出资源配额时抛出的错误码，前端据此给出明确提示 */
export const RESOURCE_QUOTA_EXCEEDED_CODE = 'RESOURCE_QUOTA_EXCEEDED';

/** 按账号解析资源上限：profiles.max_resources 是正数就用它，否则回落到默认值 */
export function resolveResourceLimit(maxResources: number | null | undefined): number {
  return typeof maxResources === 'number' && maxResources > 0 ? maxResources : MAX_RESOURCES_PER_USER;
}

/** 资源配额不足的错误（带 code，便于调用方区别于其他失败原因） */
function resourceQuotaError(limit: number, used: number, incoming: number): Error & { code: string } {
  const remain = Math.max(limit - used, 0);
  const err = new Error(
    `该账号最多可持有 ${limit} 条资源：当前已有 ${used} 条，本次新增 ${incoming} 条，仅可再添加 ${remain} 条`
  ) as Error & { code: string };
  err.code = RESOURCE_QUOTA_EXCEEDED_CODE;
  return err;
}

/**
 * 校验资源配额：管理员不限；非管理员按「已持有条数 + 本次新增条数」不得超过账号额度。
 * 额度取自 profiles.max_resources（管理员可调），为空时用默认 200。
 * 配额不足时抛出带 RESOURCE_QUOTA_EXCEEDED_CODE 的错误。
 */
async function ensureResourceQuota(userId: string, incoming: number): Promise<void> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, max_resources')
    .eq('id', userId)
    .maybeSingle();
  // 查不到角色时按普通用户处理，避免绕过限制
  if (profile?.role === 'admin') return;

  const limit = resolveResourceLimit(profile?.max_resources);

  const { count, error } = await supabase
    .from('resources')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', userId);
  if (error) throw error;

  const used = count ?? 0;
  if (used + incoming > limit) throw resourceQuotaError(limit, used, incoming);
}

/** 查询当前用户的资源配额使用情况，供前端提前提示（管理员 isAdmin=true，不限制） */
export async function fetchResourceQuota(): Promise<{ isAdmin: boolean; used: number; limit: number }> {
  const uid = await currentUserId();
  if (!uid) return { isAdmin: false, used: 0, limit: MAX_RESOURCES_PER_USER };

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, max_resources')
    .eq('id', uid)
    .maybeSingle();
  if (profile?.role === 'admin') return { isAdmin: true, used: 0, limit: MAX_RESOURCES_PER_USER };

  const limit = resolveResourceLimit(profile?.max_resources);

  const { count, error } = await supabase
    .from('resources')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', uid);
  if (error) throw error;
  return { isAdmin: false, used: count ?? 0, limit };
}

export async function insertResource(
  resource: Omit<Resource, 'id' | 'created_at' | 'updated_at' | 'owner_id' | 'link_status' | 'link_checked_at'>
): Promise<Resource | null> {
  const { data: { user } } = await supabase.auth.getUser();
  // 非管理员配额校验（管理员不限）
  if (user?.id) await ensureResourceQuota(user.id, 1);
  const episodeCount = Number(resource.episode_count) || 0;
  const { data, error } = await supabase
    .from('resources')
    .insert({
      ...resource,
      episode_count: episodeCount,
      // 集数填 0 即视为已完结：直接进「已完结」面板，对外 API 推送也显示「已完结」
      is_finished: episodeCount === 0 ? true : resource.is_finished === true,
      owner_id: user?.id,
    })
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
  // 非管理员配额校验（管理员不限）
  if (user?.id) await ensureResourceQuota(user.id, items.length);
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

/** 单个资源的云盘链接检测结果 */
export interface LinkCheckResult {
  id: string;
  valid: boolean;
  status: 'valid' | 'partial' | 'invalid';
  checkedAt: string;
  linkResults: Array<{ url: string; valid: boolean }>;
}

/** 链接检测整体结果：某几批失败时仍返回其余批次的结果，由调用方提示 */
export interface CheckLinksOutcome {
  results: LinkCheckResult[];
  /** 失败的批次数（外站过慢/超时等），>0 表示结果不完整 */
  failedChunks: number;
  totalChunks: number;
  /** 首条错误信息 */
  lastError?: string;
}

/**
 * 单次提交给 check-links 的资源条数上限：边缘函数需逐条访问外站
 * （光鸭一条链接就要 3 次串行请求，函数内并发仅 5），一次提交过多会超出
 * 函数/网关耗时上限，前端因此分片提交并汇总结果。
 */
const CHECK_LINKS_CHUNK = 20;

/** 链接检测单次请求超时：外站响应普遍偏慢，比通用代理超时放宽到 60s */
const CHECK_LINKS_TIMEOUT_MS = 60000;

/**
 * 检测指定资源的云盘链接是否失效（分片提交，避免整次请求超时）。
 *
 * 单片失败不会让整次检测失败：已完成批次的结果（服务端也已回写）照常返回，
 * 仅当所有批次都失败时才抛错。
 */
export async function checkLinks(
  resourceIds: string[],
  onProgress?: (done: number, total: number) => void
): Promise<CheckLinksOutcome> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) throw new Error('请先登录');

  const ids = resourceIds.filter(Boolean);
  const results: LinkCheckResult[] = [];
  const totalChunks = Math.ceil(ids.length / CHECK_LINKS_CHUNK);
  let failedChunks = 0;
  let succeededChunks = 0;
  let lastError = '';
  onProgress?.(0, ids.length);

  for (let i = 0; i < ids.length; i += CHECK_LINKS_CHUNK) {
    const chunk = ids.slice(i, i + CHECK_LINKS_CHUNK);
    try {
      const res = await fetchWithRetry(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/check-links`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionData.session.access_token}`,
          },
          body: JSON.stringify({ resource_ids: chunk }),
        },
        // 链接检测为幂等读操作，可重试；但超时不重试，避免整体耗时成倍增长
        { retriable: true, timeoutMs: CHECK_LINKS_TIMEOUT_MS, retryOnTimeout: false }
      );
      const data = await parseJsonSafe(res);
      if (!res.ok || !data) throw new Error(data?.error || `链接检测失败（HTTP ${res.status}）`);
      if (Array.isArray(data.results)) results.push(...data.results);
      succeededChunks += 1;
    } catch (err) {
      failedChunks += 1;
      lastError = (err as Error).message || '链接检测失败';
    }
    onProgress?.(Math.min(i + chunk.length, ids.length), ids.length);
  }

  // 全部批次都失败：抛出错误由调用方提示（如网络中断、链接失效等）
  if (succeededChunks === 0 && failedChunks > 0) {
    throw new Error(lastError || '链接检测失败');
  }

  return { results, failedChunks, totalChunks, lastError: lastError || undefined };
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
  // 读本地 session（不发网络请求），避免手机端多一次可能失败的网络往返
  const uid = await currentUserId();
  if (!uid) return [];

  // 计算所选日期的本地起止时间，转为 UTC ISO
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset, 23, 59, 59, 999);

  const { data, error } = await supabase
    .from('change_history')
    .select('*, resources!change_history_resource_id_fkey(*)')
    .eq('user_id', uid)
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

// ============ 资源导入导出 ============

/** 导入/导出使用的外部交换格式：不含 id / owner，便于跨环境迁移 */
export interface ResourceExportItem {
  name: string;
  episode_count: number;
  link: string;
  links: Array<{ url: string; pan_name?: string }>;
  cover_url: string | null;
  is_finished: boolean;
  sort_order: number;
  link_status: string;
  created_at?: string;
  updated_at?: string;
}

/** 导出包结构（与旧环境导出文件保持一致，可直接互相导入） */
export interface ResourceExportBundle {
  version: string;
  app: string;
  export_time: string;
  scope: string;
  scope_label: string;
  total_count: number;
  with_covers_count: number;
  resources: ResourceExportItem[];
}

/** 按范围（全部 / 更新中 / 已完结）把资源组装成导出包 */
export function buildResourceExport(
  resources: Resource[],
  scope: 'all' | 'updating' | 'finished'
): ResourceExportBundle {
  const list = resources.filter((r) =>
    scope === 'all' ? true : scope === 'finished' ? r.is_finished : !r.is_finished
  );
  return {
    version: '1.0',
    app: 'resource-tracker',
    export_time: new Date().toISOString(),
    scope,
    scope_label:
      scope === 'all'
        ? '全部资源 (更新中+已完结)'
        : scope === 'finished'
          ? '已完结资源'
          : '更新中资源',
    total_count: list.length,
    with_covers_count: list.filter((r) => !!r.cover_url).length,
    resources: list.map((r) => ({
      name: r.name,
      episode_count: r.episode_count ?? 0,
      link: r.link ?? '',
      links: Array.isArray(r.links) ? r.links : [],
      cover_url: r.cover_url ?? null,
      is_finished: !!r.is_finished,
      sort_order: r.sort_order ?? 0,
      link_status: r.link_status ?? 'unknown',
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  };
}

/**
 * 批量导入资源（归当前登录用户）。
 * 原文件里的封面多指向旧环境（如 backend.miaoda.online），在新环境可能已失效，
 * 因此会尝试用 cover-import 抓取后落到本应用 covers 桶；失败则保留原地址，不阻断导入。
 */
export async function importResources(
  items: ResourceExportItem[],
  onProgress?: (done: number, total: number) => void
): Promise<{ inserted: number; failed: number; errors: string[] }> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');

  // 导入前整体校验配额：超出时直接拒绝，避免导入一半才发现（管理员不限）
  await ensureResourceQuota(userData.user.id, items.length);

  const BATCH = 20;
  let inserted = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH).map((r) => ({
      name: r.name || '未命名资源',
      episode_count: Number(r.episode_count) || 0,
      link: r.link || '',
      links: (Array.isArray(r.links) ? r.links : []) as Resource['links'],
      cover_url: r.cover_url ?? null,
      is_finished: !!r.is_finished,
      sort_order: Number(r.sort_order) || 0,
    }));

    let rows: Resource[] = [];
    try {
      rows = await insertResources(batch);
      inserted += rows.length;
    } catch (e) {
      failed += batch.length;
      errors.push((e as Error).message);
      onProgress?.(Math.min(i + BATCH, items.length), items.length);
      continue;
    }

    // 封面重新落桶：仅处理非本应用存储桶的地址
    for (const row of rows) {
      const url = row.cover_url;
      if (!url || url.includes('/storage/v1/object/public/covers/')) continue;
      try {
        const local = await importCoverFromUrl(row.id, url);
        if (local) await updateResourceCover(row.id, local);
      } catch { /* 单张封面失败不影响导入 */ }
    }

    onProgress?.(Math.min(i + BATCH, items.length), items.length);
  }

  return { inserted, failed, errors };
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

/**
 * 管理员生成一个新邀请码。
 * isSpecial=true 时生成「特殊邀请码」：永久有效（membership_days=-1），
 * 用它注册的账号只能使用订阅功能、只能订阅管理员维护的订阅源、最多 10 个订阅。
 */
export async function createInviteCode(membershipDays: number, isSpecial = false): Promise<InviteCode | null> {
  const code = makeCode();
  const { data: session } = await supabase.auth.getSession();
  const createdBy = session?.session?.user?.id ?? null;
  const { data, error } = await supabase
    .from('invite_codes')
    .insert({
      code,
      created_by: createdBy,
      membership_days: isSpecial ? -1 : membershipDays,
      is_special: isSpecial,
    })
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

/**
 * 验证邀请码是否有效（注册前客户端乐观检查）。
 * 走 SECURITY DEFINER 函数：匿名访客已无 invite_codes 表读取权限，
 * 服务端只回传布尔值，不再暴露码值 / 创建者 / 记录条数。
 */
export async function validateInviteCode(code: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('check_invite_code', {
    p_code: code.toUpperCase(),
  });
  if (error) throw error;
  return data === true;
}

/** 邀请码状态：ok 可用 / used 已被使用 / revoked 已被撤销 / invalid 不存在 */
export type InviteCodeStatus = 'ok' | 'used' | 'revoked' | 'invalid';

/**
 * 校验邀请码并返回具体原因（注册页据此给出可定位的提示）。
 * 走 check_invite_code_status（SECURITY DEFINER，只回状态不回码值）；
 * 老库若还是缺这个函数（PGRST202），自动退回布尔版 check_invite_code。
 */
export async function checkInviteCode(code: string): Promise<InviteCodeStatus> {
  const { data, error } = await supabase.rpc('check_invite_code_status', {
    p_code: code.toUpperCase(),
  });
  if (error) {
    if (/PGRST202|does not exist|Could not find the function/i.test(error.message ?? '')) {
      const ok = await validateInviteCode(code);
      return ok ? 'ok' : 'invalid';
    }
    throw error;
  }
  const s = String(data ?? 'invalid');
  return (s === 'ok' || s === 'used' || s === 'revoked' ? s : 'invalid');
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

/**
 * 管理员设置某用户的「订阅数量上限」。
 * limit 传 null 表示按账号类型取默认（订阅专用 10 / 普通 80；订阅专用账号 null 仍是「不限」）。
 * 特权列由数据库触发器保护：只有管理员能改（普通用户改会被直接拒绝）。
 */
export async function updateProfileSubscriptionLimit(id: string, limit: number | null): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ max_subscriptions: limit })
    .eq('id', id);
  if (error) throw error;
}

/**
 * 管理员设置某账号的额度（资源条数 / 订阅条数）。
 * 传 undefined 表示「这一次不改这一项」；传 null 表示恢复默认：
 *   · maxResources      null → 默认 200（管理员账号本身不受限）
 *   · maxSubscriptions  null → 订阅专用账号=不限、普通账号=默认 80
 * 特权列由数据库触发器保护：只有管理员能改。
 */
export async function updateProfileQuota(
  id: string,
  quota: { maxResources?: number | null; maxSubscriptions?: number | null }
): Promise<void> {
  const patch: Record<string, number | null> = {};
  if (quota.maxResources !== undefined) patch.max_resources = quota.maxResources;
  if (quota.maxSubscriptions !== undefined) patch.max_subscriptions = quota.maxSubscriptions;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase.from('profiles').update(patch).eq('id', id);
  if (error) throw error;
}

// ============ 订阅源管理（管理员维护；受限账号只能从这里选订阅链接） ============

/**
 * 读取订阅源列表。
 * includeInactive=false（默认，订阅页选源用）只返回已启用的；
 * includeInactive=true（管理后台）返回全部，便于编辑停用的源。
 */
export async function fetchSubscriptionSources(includeInactive = false): Promise<SubscriptionSource[]> {
  let q = supabase
    .from('subscription_sources')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/**
 * 受限账号：读取管理员「资源管理」中**更新中**资源的网盘链接（一个资源可能有多条：光鸭 + 夸克），
 * 供「订阅转存」的选择订阅源弹窗使用。非管理员且非「订阅专用」账号调用会得到空列表。
 */
export async function fetchAdminResourceSources(): Promise<AdminResourceSource[]> {
  const { data, error } = await supabase.rpc('admin_resource_sources');
  if (error) throw error;
  return Array.isArray(data) ? (data as AdminResourceSource[]) : [];
}

// ============================================================
// 源主（Source Owner）
//
// 身份以 public.source_owners 表为准（status='approved' 即源主），
// 不写在 profiles 上 —— profiles 的特权列有触发器保护，独立表更干净。
// 资源暴露靠 SECURITY DEFINER 函数（resources 表 RLS 不允许跨用户读）。
// 特殊邀请码账号（subscription_only）在数据库层就被挡住，看不到源主资源。
// ============================================================

/** 查询我自己的源主申请状态 */
export async function fetchMySourceOwnerStatus(): Promise<MySourceOwnerStatus> {
  const { data, error } = await supabase.rpc('my_source_owner_status');
  if (error) throw error;
  const row = (data ?? {}) as Partial<MySourceOwnerStatus>;
  return {
    status: (row.status ?? 'none') as MySourceOwnerStatus['status'],
    display_name: row.display_name ?? null,
    apply_note: row.apply_note ?? null,
    review_note: row.review_note ?? null,
    username: row.username ?? null,
    created_at: row.created_at ?? null,
    reviewed_at: row.reviewed_at ?? null,
  };
}

/** 申请成为源主（待审核可重复提交；已是源主时只更新展示名） */
export async function applySourceOwner(params: {
  note?: string;
  displayName?: string;
}): Promise<{ ok: boolean; status: string; message?: string }> {
  const { data, error } = await supabase.rpc('apply_source_owner', {
    p_note: params.note?.trim() || null,
    p_display_name: params.displayName?.trim() || null,
  });
  if (error) throw error;
  return (data ?? { ok: true, status: 'pending' }) as {
    ok: boolean;
    status: string;
    message?: string;
  };
}

/** 已通过的源主列表（受限账号得到空数组） */
export async function fetchSourceOwners(): Promise<SourceOwner[]> {
  const { data, error } = await supabase.rpc('source_owner_list');
  if (error) throw error;
  return Array.isArray(data) ? (data as SourceOwner[]) : [];
}

/** 某源主的「更新中」资源链接（受限账号得到空数组） */
export async function fetchSourceOwnerResources(ownerId: string): Promise<SourceOwnerResource[]> {
  const { data, error } = await supabase.rpc('source_owner_resources', {
    p_owner_id: ownerId,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as SourceOwnerResource[]) : [];
}

/** 管理员：源主申请列表 */
export async function fetchSourceOwnerApplications(
  status?: 'pending' | 'approved' | 'rejected' | null
): Promise<SourceOwnerApplication[]> {
  const { data, error } = await supabase.rpc('list_source_owner_applications', {
    p_status: status ?? null,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as SourceOwnerApplication[]) : [];
}

/** 管理员：通过 / 驳回 / 撤销源主身份 */
export async function reviewSourceOwner(params: {
  userId: string;
  action: 'approve' | 'reject' | 'revoke';
  note?: string;
}): Promise<void> {
  const { error } = await supabase.rpc('review_source_owner', {
    p_user_id: params.userId,
    p_action: params.action,
    p_note: params.note?.trim() || null,
  });
  if (error) throw error;
}

/** 管理员新增订阅源 */
export async function createSubscriptionSource(input: SubscriptionSourceInput): Promise<SubscriptionSource | null> {
  const { data, error } = await supabase.from('subscription_sources').insert(input).select().maybeSingle();
  if (error) {
    if (/duplicate key/i.test(error.message)) throw new Error('该订阅源地址已存在，请勿重复添加');
    throw error;
  }
  return data;
}

/** 管理员修改订阅源 */
export async function updateSubscriptionSource(
  id: string,
  patch: Partial<SubscriptionSourceInput>
): Promise<void> {
  const { error } = await supabase.from('subscription_sources').update(patch).eq('id', id);
  if (error) {
    if (/duplicate key/i.test(error.message)) throw new Error('该订阅源地址已存在，请勿重复添加');
    throw error;
  }
}

/** 管理员删除订阅源 */
export async function deleteSubscriptionSource(id: string): Promise<void> {
  const { error } = await supabase.from('subscription_sources').delete().eq('id', id);
  if (error) throw error;
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
  // 会员到期会被数据库定时任务自动禁用（status → disabled）；
  // 这里只要把会员时间改到「有效」（永久或未来），就同时恢复启用，
  // 省得管理员续了会员还得再手动点一次「启用」。（days = 0 表示清空/立即到期，不动状态）
  const patch: { membership_expires_at: string | null; status?: string } = {
    membership_expires_at: expiresAt,
  };
  if (days !== 0) patch.status = 'active';
  const { error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', id);
  if (error) throw error;
}

/**
 * 管理员自定义设置用户会员到期时间（直接指定具体时刻）。
 * iso 传 null 表示永久 / 无期限；传 ISO 字符串表示该时刻到期。
 * 与按天数计算的 updateProfileMembership 互补，用于精确控制（如「到月底」「到某日 23:59」）。
 */
export async function setProfileMembershipExpiry(
  id: string,
  iso: string | null
): Promise<void> {
  // 同上：把到期时间设成「永久 / 未来」时同时恢复启用（普通账号到期会被自动禁用）
  const patch: { membership_expires_at: string | null; status?: string } = {
    membership_expires_at: iso,
  };
  if (iso === null || new Date(iso).getTime() > Date.now()) patch.status = 'active';
  const { error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', id);
  if (error) throw error;
}

// ============ 批量发帖权限（管理员授予） ============

/**
 * 管理员为用户开通批量发帖权限（months 个自然月后到期）。
 * months <= 0 表示关闭权限（到期时间置空 = 未开通）。
 */
export async function updateProfileBatchPost(id: string, months: number): Promise<void> {
  let expiresAt: string | null = null;
  if (months > 0) {
    const d = new Date();
    d.setMonth(d.getMonth() + months);
    expiresAt = d.toISOString();
  }
  const { error } = await supabase
    .from('profiles')
    .update({ batch_post_expires_at: expiresAt })
    .eq('id', id);
  if (error) throw error;
}

/**
 * 管理员直接指定批量发帖权限到期时刻。
 * iso 传 null 表示关闭权限（未开通）；传 ISO 字符串表示该时刻到期。
 */
export async function setProfileBatchPostExpiry(id: string, iso: string | null): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ batch_post_expires_at: iso })
    .eq('id', id);
  if (error) throw error;
}

// ============ 订阅功能权限（管理员授予/收回） ============

/**
 * 管理员开关某用户的「订阅功能」权限。
 * enabled=true 开通；false 关闭（关闭后该用户将无法使用订阅转存相关功能，定时任务也会跳过其订阅）。
 * 管理员自身始终可用，不受此开关影响。
 */
export async function updateProfileSubscription(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ subscriptions_enabled: enabled })
    .eq('id', id);
  if (error) throw error;
}

export type ProfileFeatureKey = 'can_resources' | 'can_site_sync' | 'can_shortlink' | 'can_subscriptions';

/** 管理员：按功能给账号开通/关闭（资源管理 / 站点同步 / 短链管理 / 订阅转存） */
export async function updateProfileFeature(
  id: string,
  feature: ProfileFeatureKey,
  enabled: boolean
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ [feature]: enabled })
    .eq('id', id);
  if (error) throw error;
}

/**
 * 管理员：批量给多个账号开通/关闭功能（用户管理里勾选后使用）。
 * 勾了「订阅转存」时同步老字段 subscriptions_enabled，保证两处开关显示一致。
 * 返回实际更新的行数。
 */
export async function updateProfilesFeatureBulk(
  ids: string[],
  features: ProfileFeatureKey[],
  enabled: boolean
): Promise<number> {
  const list = ids.filter(Boolean);
  if (list.length === 0 || features.length === 0) return 0;
  const patch: Record<string, boolean> = {};
  for (const f of features) patch[f] = enabled;
  if (features.includes('can_subscriptions')) patch.subscriptions_enabled = enabled;

  let updated = 0;
  // 分批（每批 200 个 id），避免 URL/语句过长
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const { error, count } = await supabase
      .from('profiles')
      .update(patch, { count: 'exact' })
      .in('id', chunk);
    if (error) throw error;
    updated += count ?? chunk.length;
  }
  return updated;
}

/**
 * 个人中心：修改「我自己的」资料（用户名 / 头像地址）。
 * 依赖 RLS「Users can update their own profile」——普通用户只能改自己这一行；
 * 角色、会员、功能权限等特权列由触发器拦截，改不动。
 */
export async function updateMyProfile(
  userId: string,
  patch: { username?: string; avatar_url?: string | null }
): Promise<void> {
  const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
  if (error) {
    // 用户名唯一约束冲突
    if ((error as { code?: string }).code === '23505') {
      throw new Error('该用户名已被占用，换一个试试');
    }
    throw error;
  }
}

/** 用户名格式校验（与注册保持一致：字母 / 数字 / 下划线） */
export function validateUsername(name: string): string | null {
  const v = name.trim();
  if (!v) return '用户名不能为空';
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(v)) return '用户名仅支持字母、数字、下划线，长度 2-20 位';
  return null;
}

/**
 * 管理员：删除账号（连同该账号名下的资源/订阅/绑定等数据）。
 * 实际删除走服务端函数 admin_delete_user（内部校验调用者必须是管理员，且不能删自己）。
 */
export async function deleteUserAccount(id: string): Promise<void> {
  const { error } = await supabase.rpc('admin_delete_user', { p_user_id: id });
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
 * retryOnTimeout=false 时超时不再重试（用于本身耗时较长的接口，避免整体耗时成倍增长）。
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { retriable?: boolean; timeoutMs?: number; retryOnTimeout?: boolean } = {}
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
      const aborted = e instanceof Error && e.name === 'AbortError';
      if (!opts.retriable || attempt >= retries || (aborted && opts.retryOnTimeout === false)) {
        throw new Error(aborted ? '请求超时，请稍后重试' : '网络连接异常，请稍后重试');
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
  // 云端加密留档（该站点仅支持 Cookie，失效时需人工更新）
  await saveSiteCredential({ site: 'xn', cookie });
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

/** 观影小牛站内搜索联想项（GET /res/search_suggest，裸数组响应，无 {code,data} 包裹） */
export interface XnSearchItem {
  title: string;
  /** 资源短码 ID —— 发布分享时作为 binds[][id]，须与 dir 配对使用 */
  id: string;
  year?: number | string;
  /** 中文类型，如「剧集」「动漫」 */
  type?: string;
  /** 资源类型：mv 电影 / tv 剧集 / ac 动漫 */
  dir: string;
  ename?: string;
  score?: string;
  /** 站点封面地址（搜索接口不返回封面，由 dir + id 推导，见 xnCoverUrl） */
  cover?: string;
}

/**
 * 观影片库封面地址规律：https://s.tutu.pm/img/{dir}/{id}/384.avif
 * （站点 /res/search_suggest 本身不返回任何封面字段，实测按此规则可稳定取到图）
 */
export function xnCoverUrl(dir?: string, id?: string): string | undefined {
  if (!dir || !id) return undefined;
  return `https://s.tutu.pm/img/${dir}/${id}/384.avif`;
}

/**
 * 观影片库站内搜索联想（片源查询）。
 * 对应 GET /res/search_suggest?q=，返回裸数组。
 * 返回项的 dir + id 即发布分享时 binds[][dir] / binds[][id] 的取值来源。
 * 注意：该接口需登录态（实测无 Cookie 时返回空 body），须先绑定观影站点 Cookie。
 */
export async function searchXnVideos(keyword: string): Promise<XnSearchItem[]> {
  const q = keyword.trim();
  if (!q) return [];
  const data = await callXnProxy<XnSearchItem[]>('search', { q });
  return (Array.isArray(data) ? data : []).map((it) => ({
    ...it,
    cover: xnCoverUrl(it.dir, it.id),
  }));
}

/**
 * 发布网盘分享到观影小牛（POST /res/pan/add，form-urlencoded）。
 * binds 必填且至少 1 个（站点强制要求），取值来自 searchXnVideos 的 dir + id。
 */
export async function addXnShare(params: {
  title: string;
  panurl: string;
  panpw?: string;
  is?: number;
  binds: { dir: string; id: string }[];
}): Promise<{ shareId: string | null }> {
  const res = await callXnProxy<{ data?: { share_id?: string | null } }>('add', {}, {
    title: params.title,
    panurl: params.panurl,
    panpw: params.panpw ?? '',
    is: params.is ?? 1,
    binds: params.binds,
  });
  const sid = res?.data?.share_id;
  return { shareId: sid ? String(sid) : null };
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

/** 将资源绑定到观影站点分享（支持一个资源绑定多条，按分享短码去重）
 *  仅用到 id / title / url，故用 Pick 收窄，便于发布成功后直接落库 */
export async function bindResourceToXnShare(
  resourceId: string,
  share: Pick<import('@/types/index').XnShare, 'id' | 'title' | 'url'>
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
  // 云端留档：token 失效且 refresh 失败时可自动重新登录
  await saveSiteCredential({ site: 'ya', username: username.trim(), password: password.trim() });
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
  opts: { category?: string; limit?: number; includeNoLink?: boolean } = {}
): Promise<import('@/types/index').YaLink[]> {
  type RawLink = { id?: number; link_id?: number; name?: string | null; url?: string | null; extract_code?: string | null; drive_type?: string | null; drive_label?: string | null; updated_at?: string | null; created_at?: string | null };
  const data = await callYaFn<{
    found?: boolean;
    /** 旧结构：精确匹配单 video */
    video?: { id?: number; title?: string; category?: string; cover_url?: string | null };
    links?: RawLink[];
    /** 新结构：包含匹配多 video，精确匹配置顶 */
    videos?: { video?: { id?: number; title?: string; category?: string; cover_url?: string | null }; links?: RawLink[] }[];
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
    const videoCover = g.video?.cover_url ?? null;
    const rawLinks: RawLink[] = Array.isArray(g.links) ? g.links : [];
    if (rawLinks.length === 0) {
      // 片源存在、但本人尚未在其下发布过链接。
      // includeNoLink（发布/寻源场景）需要把它作为「发布目标」展示出来；
      // 绑定场景则忽略（没有可绑定的 link_id）。
      if (!opts.includeNoLink) return [];
      return [{
        id: 0,
        name: null,
        url: null,
        extract_code: null,
        drive_type: null,
        drive_label: null,
        video_title: videoTitle,
        video_id: videoId,
        video_category: videoCategory,
        video_cover: videoCover,
        updated_at: null,
        created_at: null,
      }];
    }
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
      video_cover: videoCover,
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
    // 网盘名以 URL 识别为准：本地链接的 pan_name 同样由 detectPanName 生成，
    // 同源才能保证同步时匹配得上。站点侧的 drive_label / drive_type 仅作兜底 ——
    // 鸭影对光鸭云盘只返回 drive_type='others'，直接采用会导致
    // 「资源中没有『others』类型的链接，未同步该条片源」。
    pan_label: detectPanName(link.url ?? '') || link.drive_label || link.drive_type || null,
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

/** 积分抽奖：count 次数、cost 单次消耗积分（以鸭影站点当前规则为准） */
export async function yaDraw(
  count = 1,
  cost: number
): Promise<{ limit: number; used: number; remaining: number; prizes: Array<{ id: string; name: string; points: number }> }> {
  return callYaFn('draw', { count, cost });
}

/** 幸运抽签：每日限一次，消耗 15 积分，返回抽签码 */
export async function yaBuyLuckyTicket(): Promise<string> {
  return callYaFn('buyLuckyTicket', {});
}

/** 抽签池状态：当前期号、参与人数、我的号码、状态与最近开奖结果 */
export async function yaGetLuckyDraw(): Promise<{
  period: number;
  pool_count: number;
  max_participants: number;
  my_ticket: string | null;
  status: 'open' | 'full' | 'drawn';
  last_result: Record<string, unknown> | null;
}> {
  return callYaFn('luckyDraw', {});
}

/** 查询片源与本人提交的有效资源链接（link_id 用于订阅 / 修改定位） */
export async function yaSearchMyVideos(params: {
  title: string;
  category?: string;
  limit?: number;
}): Promise<{
  found: boolean;
  video: Record<string, unknown> | null;
  links: Array<{
    link_id: number;
    name: string | null;
    url: string;
    drive_type: string | null;
    drive_label: string | null;
    extract_code: string | null;
    click_count: number;
  }>;
}> {
  return callYaFn('searchMyVideos', params);
}

/** 订阅资源：优先用 linkId 精确定位，也可按片源名模糊匹配（可能返回候选让你二选一） */
export async function yaSubscribeLink(params: {
  linkId?: number;
  title?: string;
  category?: string;
  keyword?: string;
  active?: boolean;
}): Promise<Record<string, unknown>> {
  return callYaFn('subscribeLink', params);
}

/** 取消订阅（linkId 或片源名） */
export async function yaUnsubscribeLink(params: { linkId?: number; title?: string }): Promise<{
  success: boolean;
  link_id?: number;
  deleted?: number;
  message?: string;
}> {
  return callYaFn('unsubscribeLink', params);
}

/** 我的订阅列表 */
export async function yaListSubscriptions(params: {
  activeOnly?: boolean;
  limit?: number;
} = {}): Promise<{ success: boolean; total: number; list: Array<Record<string, unknown>> }> {
  return callYaFn('listSubscriptions', params);
}

/** 拉取订阅更新通知（自动同步完成后产生；formatted 可直接展示） */
export async function yaGetSubscriptionNotifications(params: {
  limit?: number;
  onlyUnread?: boolean;
  markRead?: boolean;
  since?: string;
} = {}): Promise<{
  success: boolean;
  unread_count: number;
  returned: number;
  marked_read: number;
  list: Array<Record<string, unknown>>;
  formatted?: string;
}> {
  return callYaFn('getSubscriptionNotifications', params);
}

/** 标记通知已读（ids 批量 或 all=true） */
export async function yaMarkNotificationsRead(params: {
  ids?: number[];
  all?: boolean;
}): Promise<{ success: boolean; marked: number; message?: string }> {
  return callYaFn('markNotificationsRead', params);
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
  }, { retriable: ['list', 'search', 'resource_list', 'login_status'].includes(action) });
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

/** 帧影片库检索结果项（search.php 解析 / resource_list.php 原样） */
export interface FramehdrSearchItem {
  id: number;
  title: string;
  cover?: string | null;
  year?: number | string | null;
  category_slug?: string | null;
  douban_rating?: number | string | null;
}

/** 帧影片库关键词检索（search.php SSR → 结构化，接口文档 §2.2） */
export async function searchFramehdrResources(keyword: string): Promise<FramehdrSearchItem[]> {
  const q = keyword.trim();
  if (!q) return [];
  const data = await callFramehdrProxy<{ list?: FramehdrSearchItem[] }>('search', { q });
  return data.list ?? [];
}

/** 帧影片库分页列表（resource_list.php 公开 JSON，接口文档 §2.1） */
export async function loadFramehdrResourceList(
  category = 'all',
  year = 'all',
  page = 1
): Promise<{ resources: FramehdrSearchItem[]; totalResources: number }> {
  const data = await callFramehdrProxy<{
    resources?: FramehdrSearchItem[];
    totalResources?: number;
  }>('resource_list', { category, year, page: String(page) });
  return { resources: data.resources ?? [], totalResources: data.totalResources ?? 0 };
}

/** 向帧影指定片源发布网盘分享链接（/user/add_link.php，接口文档 §3.2） */
export async function addFramehdrLink(params: {
  resourceId: number | string;
  url: string;
  name?: string;
  password?: string;
  description?: string;
}): Promise<{ link_id?: number | null; message?: string }> {
  return callFramehdrProxy('add', {}, {
    resource_id: params.resourceId,
    url: params.url,
    ...(params.name ? { name: params.name } : {}),
    ...(params.password ? { password: params.password } : {}),
    ...(params.description ? { description: params.description } : {}),
  });
}

/** 编辑帧影站点已发布链接 */
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

/** 帧影登录状态：锁定情况与剩余尝试次数（接口文档 §1.3） */
export async function getFramehdrLoginStatus(): Promise<{
  is_locked?: boolean;
  attempts_left?: number;
}> {
  const data = await callFramehdrProxy<{ data?: { is_locked?: boolean; attempts_left?: number } }>(
    'login_status'
  );
  return data.data ?? {};
}

/** 帧影账号密码登录绑定（推荐方式）：服务端模拟登录并保存会话，密码不落库 */
export async function loginFramehdr(username: string, password: string): Promise<void> {
  await callFramehdrProxy('login', {}, { username, password });
  // 云端留档（加密）：会话失效后可自动重新登录
  await saveSiteCredential({ site: 'framehdr', username: username.trim(), password });
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
  }, { onConflict: 'resource_id' });
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
  // 云端加密留档（该站点仅支持 Cookie，失效时需人工更新）
  await saveSiteCredential({ site: 'panfx', cookie: cookie.trim() });
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


// ============ 首页图文教程 ============

/** 把 jsonb 字段规整成 string[]，容忍历史脏数据 */
function toImageList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}

function normalizeTutorial(row: Record<string, unknown>): Tutorial {
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    content: String(row.content ?? ''),
    images: toImageList(row.images),
    is_active: Boolean(row.is_active),
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

/** 前台：读取所有启用的教程（按 sort_order、创建时间升序） */
export async function fetchActiveTutorials(): Promise<Tutorial[]> {
  const { data, error } = await supabase
    .from('tutorials')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map(normalizeTutorial);
}

/** 管理员：读取全部教程（含已停用） */
export async function fetchAllTutorials(): Promise<Tutorial[]> {
  const { data, error } = await supabase
    .from('tutorials')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map(normalizeTutorial);
}

export interface TutorialInput {
  title: string;
  content: string;
  images: string[];
  is_active?: boolean;
  sort_order?: number;
}

/** 管理员：新增教程 */
export async function createTutorial(input: TutorialInput): Promise<Tutorial | null> {
  const { data, error } = await supabase
    .from('tutorials')
    .insert({
      title: input.title.trim(),
      content: input.content,
      images: input.images,
      is_active: input.is_active ?? true,
      sort_order: input.sort_order ?? 0,
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeTutorial(data) : null;
}

/** 管理员：更新教程 */
export async function updateTutorial(id: string, patch: Partial<TutorialInput>): Promise<void> {
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) payload.title = patch.title.trim();
  if (patch.content !== undefined) payload.content = patch.content;
  if (patch.images !== undefined) payload.images = patch.images;
  if (patch.is_active !== undefined) payload.is_active = patch.is_active;
  if (patch.sort_order !== undefined) payload.sort_order = patch.sort_order;

  const { error } = await supabase.from('tutorials').update(payload).eq('id', id);
  if (error) throw error;
}

/** 管理员：删除教程 */
export async function deleteTutorial(id: string): Promise<void> {
  const { error } = await supabase.from('tutorials').delete().eq('id', id);
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
  // 云端留档（该站点重登需要图形验证码，巡检时会提示手动处理）
  await saveSiteCredential({ site: 'mukaku', username: params.username.trim(), password: params.password });
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

// ============ 聚影站点同步（www.jying.top） ============

export const JYING_EXPIRED_CODE = 'JYING_COOKIE_EXPIRED';
export const JYING_NOT_BOUND_CODE = 'JYING_NOT_BOUND';

type JyingShareRow = import('@/types/index').JyingShareItem;

/** 统一调用聚影代理 Edge Function */
async function callJyingProxy<T = unknown>(
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
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jying-proxy?${qs.toString()}`,
    init,
    { retriable: !body, timeoutMs: opts.timeoutMs } // GET 读操作可安全重试
  );
  const data = await parseJsonSafe(res);
  if (!res.ok || !data || data.success === false) {
    if (data?.code === JYING_EXPIRED_CODE || data?.code === JYING_NOT_BOUND_CODE) {
      const err = new Error(data.error || data.message || '聚影请求失败');
      (err as Error & { code: string }).code = data.code;
      throw err;
    }
    throw new Error(data?.error || data?.message || `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

/** 查询当前用户聚影绑定信息 */
export async function getJyingBinding(): Promise<import('@/types/index').JyingBinding | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const { data, error } = await supabase
    .from('jying_sessions')
    .select('status, username, last_check_at, remark, updated_at')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * 向站点复检聚影会话：站点侧仍有效时会把本地状态恢复为 active。
 *
 * 用于「本地被标记为失效、但站点侧其实仍可用」的情况（例如上一次是误判的
 * 403/网络抖动），避免用户被卡在「登录已失效」而无法发布；确实失效则保持不变。
 */
export async function revalidateJyingSession(): Promise<import('@/types/index').JyingBinding | null> {
  try {
    await callJyingProxy('status');
  } catch {
    // 站点确实失效：保持现状，由界面提示重新登录
  }
  return getJyingBinding();
}

/** 账号密码登录并绑定聚影（服务端模拟登录，密码不落库） */
export async function loginJying(username: string, password: string): Promise<void> {
  await callJyingProxy(
    'login',
    { username: username.trim(), password },
    { timeoutMs: 45000 }
  );
  // 云端留档（加密）：会话失效后可自动重新登录
  await saveSiteCredential({ site: 'jying', username: username.trim(), password });
}

/** 解绑聚影 */
export async function unbindJying(): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { error } = await supabase
    .from('jying_sessions')
    .delete()
    .eq('user_id', userData.user.id);
  if (error) throw error;
}

/** 查询聚影「我的分享」记录（扁平化：资源条目维度，可直接用于绑定） */
export async function loadJyingShares(keyword = ''): Promise<JyingShareRow[]> {
  const kw = keyword.trim();
  const data = await callJyingProxy<{ data?: { list?: JyingShareRow[] } }>(
    'my_shares',
    undefined,
    {
      query: kw ? { q: kw, page_size: '20' } : { page_size: '10' },
      timeoutMs: 60000, // 需逐个影片取资源条目，放大超时
    }
  );
  return data.data?.list ?? [];
}

/** 聚影全站片库检索 */
export async function searchJyingMovies(keyword: string): Promise<import('@/types/index').JyingMovie[]> {
  const data = await callJyingProxy<{ data?: { results?: import('@/types/index').JyingMovie[] } }>(
    'search_movies',
    undefined,
    { query: { q: keyword.trim(), page_size: '20' } }
  );
  return data.data?.results ?? [];
}

/** 修改聚影分享链接（站点为差量接口，仅提交 share_link） */
export async function updateJyingShareLink(linkId: number, shareLink: string): Promise<void> {
  await callJyingProxy('update', { link_id: linkId, share_link: shareLink }, { timeoutMs: 45000 });
}

/** 在聚影指定影片下新增分享记录（网盘类型由站点按链接自动识别，无需传入） */
export async function addJyingResource(params: {
  movieId: number;
  shareLink: string;
  description?: string;
  extractionCode?: string;
}): Promise<{ id: number; movieId: number; movieTitle: string | null; panLabel: string | null }> {
  const data = await callJyingProxy<{
    data?: {
      resource?: {
        id?: number;
        movie_id?: number;
        movie_title?: string;
        type?: string;
        type_key?: string;
      };
    };
  }>(
    'add',
    {
      movie_id: params.movieId,
      share_link: params.shareLink,
      ...(params.description ? { description: params.description } : {}),
      ...(params.extractionCode ? { extraction_code: params.extractionCode } : {}),
    },
    { timeoutMs: 45000 }
  );
  const r = data.data?.resource ?? {};
  return {
    id: Number(r.id ?? 0),
    movieId: Number(r.movie_id ?? params.movieId),
    movieTitle: r.movie_title ?? null,
    // 站点返回的 type 为网盘中文名（如「光鸭云盘」）
    panLabel: r.type ?? null,
  };
}

/** 查询当前用户所有资源的聚影绑定关系 */
export async function fetchJyingResourceBindings(): Promise<
  import('@/types/index').JyingResourceBinding[]
> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return [];
  const { data, error } = await supabase
    .from('jying_resource_bindings')
    .select('id, resource_id, link_id, movie_id, link_title, vod_name, pan_label, created_at, resources!inner(owner_id)')
    .eq('resources.owner_id', userData.user.id);
  if (error) throw error;
  return (data ?? []).map(({ resources: _r, ...rest }) => rest) as import(
    '@/types/index'
  ).JyingResourceBinding[];
}

/** 将资源绑定到聚影分享条目 */
export async function bindResourceToJying(
  resourceId: string,
  share: {
    id: number;
    movie_id?: number | null;
    title?: string | null;
    vod_name?: string | null;
    share_link?: string | null;
    pan_label?: string | null;
  }
): Promise<void> {
  const { error } = await supabase.from('jying_resource_bindings').upsert(
    {
      resource_id: resourceId,
      link_id: share.id,
      movie_id: share.movie_id ?? null,
      link_title: share.title ?? null,
      vod_name: share.vod_name ?? null,
      // 网盘名以本地 URL 识别为准：与资源链接的 pan_name 同源，同步时才能匹配上
      pan_label: detectPanName(share.share_link ?? '') || share.pan_label || null,
    },
    { onConflict: 'resource_id,link_id' }
  );
  if (error) throw error;
}

/** 解除资源与聚影的绑定（传 linkId 解绑单条，不传解绑全部） */
export async function unbindResourceFromJying(resourceId: string, linkId?: number): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  let q = supabase.from('jying_resource_bindings').delete().eq('resource_id', resourceId);
  if (linkId != null) q = q.eq('link_id', linkId);
  const { error } = await q;
  if (error) throw error;
}

/** 同步资源更新到聚影（替换分享链接） */
export async function syncResourceToJying(params: {
  linkId: number;
  panUrl: string;
}): Promise<void> {
  await updateJyingShareLink(params.linkId, params.panUrl);
}

// ============ 栖影 HDHaven 站点同步（hdhaven.com） ============

/** access_token 失效：用户在站点 OPENAPI 页面撤销授权、重新授权或账号不可用，需重新授权 */
export const HDHAVEN_EXPIRED_CODE = 'HDHAVEN_TOKEN_EXPIRED';
export const HDHAVEN_NOT_BOUND_CODE = 'HDHAVEN_NOT_BOUND';
/**
 * 命中账号额度或每分钟限流。
 * 站点按等级/会员给每日次数（Lv.1 200 次 … Lv.7 2000 次，年卡 5000 次，永久不限，
 * 等级与会员取高者，北京时间零点重置），每分钟 60 次；
 * 签到与 GET /me 不计入每日次数 —— 所以日常巡检不烧额度，批量发布才需要注意。
 */
export const HDHAVEN_RATE_LIMITED_CODE = 'HDHAVEN_RATE_LIMITED';

type HdhavenShare = import('@/types/index').HdhavenShareItem;
type HdhavenTmdb = import('@/types/index').HdhavenTmdbItem;

/**
 * 统一调用栖影代理 Edge Function。
 * 栖影走官方 OpenAPI：用户在浏览器授权一次后，access_token 由服务端持有并加密落库，
 * 前端永远拿不到 token，也不直连站点。
 */
async function callHdhavenProxy<T = unknown>(
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
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/hdhaven-proxy?${qs.toString()}`,
    init,
    // 读操作可安全重试；写操作不重试，避免重复提交
    { retriable: !body, timeoutMs: opts.timeoutMs ?? 45000 }
  );
  const data = await parseJsonSafe(res);
  if (!res.ok || !data || data.success === false) {
    const code = data?.code as string | undefined;
    if (code) {
      const err = new Error(data.error || data.message || '栖影请求失败') as Error & { code?: string };
      err.code = code;
      throw err;
    }
    throw new Error(data?.error || data?.message || `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

/** 查询当前用户栖影绑定信息 */
export async function getHdhavenBinding(): Promise<import('@/types/index').HdhavenBinding | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const { data, error } = await supabase
    .from('hdhaven_sessions')
    .select('status, username, user_number, scope, authorized_at, last_check_at, remark, updated_at')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * 向站点复检栖影会话：站点侧仍有效时会把本地状态恢复为 active。
 * 用于「本地被标记为失效、但站点侧其实仍可用」的情况。
 */
export async function revalidateHdhavenSession(): Promise<import('@/types/index').HdhavenBinding | null> {
  try {
    await callHdhavenProxy('status');
  } catch {
    // 站点确实失效：保持现状，由界面提示重新登录
  }
  return getHdhavenBinding();
}

/**
 * 开始栖影 OAuth 授权：向本站代理索取授权页地址（含 state 与 PKCE challenge）。
 * state 与 code_verifier 都存在服务端，前端只负责把用户跳到站点授权页。
 */
export async function startHdhavenOAuth(): Promise<string> {
  const r = await callHdhavenProxy<{ data?: { authorize_url?: string } }>('oauth_start', {});
  const authorizeUrl = String(r.data?.authorize_url ?? '');
  if (!authorizeUrl) throw new Error('生成栖影授权地址失败，请稍后重试');
  return authorizeUrl;
}

/**
 * 用回调拿到的授权码换 token。
 * 由服务端完成 PKCE 校验并加密落库；授权码一次性且 10 分钟内有效，重复提交会被拒绝。
 */
export async function finishHdhavenOAuth(params: { code: string; state: string }): Promise<void> {
  await callHdhavenProxy(
    'oauth_callback',
    { code: params.code.trim(), state: params.state.trim() },
    { timeoutMs: 60000 }
  );
}

/** 查询栖影账号额度余量（每分钟 60 次；每日按等级/会员，签到与 /me 不计入） */
export async function loadHdhavenQuota(): Promise<unknown> {
  const r = await callHdhavenProxy<{ data?: unknown }>('quota', undefined, { timeoutMs: 30000 });
  return r.data ?? null;
}

/** 栖影每日签到（文档说明签到不计入每日调用次数） */
export async function checkinHdhaven(): Promise<unknown> {
  const r = await callHdhavenProxy<{ data?: unknown; message?: string }>(
    'checkin',
    {},
    { timeoutMs: 30000 }
  );
  return r.data ?? r.message ?? null;
}

/**
 * 解绑栖影：走代理清理，除 token 外也会清掉未完成的授权中间态。
 * 站点侧的撤销授权需用户自行到 OPENAPI 页面操作。
 */
export async function unbindHdhaven(): Promise<void> {
  await callHdhavenProxy('logout', {});
}

/** 我的分享记录（站点无分页/筛选，一次返回全量） */
export async function loadHdhavenShares(): Promise<HdhavenShare[]> {
  const data = await callHdhavenProxy<{ data?: HdhavenShare[] }>('my_shares', undefined, {
    timeoutMs: 60000,
  });
  return Array.isArray(data.data) ? data.data : [];
}

/** 单条分享详情（含当前分享链接 url / 提取码 / 文件列表） */
export async function getHdhavenShareDetail(slug: string): Promise<HdhavenShare | null> {
  const data = await callHdhavenProxy<{ data?: HdhavenShare }>('detail', undefined, {
    query: { slug },
    timeoutMs: 45000,
  });
  return data.data ?? null;
}

/** 片源检索（TMDB，中文可直接搜） */
export async function searchHdhavenTmdb(keyword: string): Promise<HdhavenTmdb[]> {
  const data = await callHdhavenProxy<{ data?: HdhavenTmdb[] }>('search_tmdb', undefined, {
    query: { q: keyword },
    timeoutMs: 45000,
  });
  return Array.isArray(data.data) ? data.data : [];
}

/** 按 TMDB ID 查询站内资源（片源查询） */
export async function fetchHdhavenResources(
  mediaType: string,
  tmdbId: string
): Promise<HdhavenShare[]> {
  const data = await callHdhavenProxy<{ data?: HdhavenShare[] }>('resources', undefined, {
    query: { media_type: mediaType, tmdb_id: tmdbId },
    timeoutMs: 45000,
  });
  return Array.isArray(data.data) ? data.data : [];
}

/**
 * 更新栖影分享链接。
 * 栖影的 update 是「全量字段回写」语义，服务端会先取原值再合并，仅替换链接，
 * 避免未提交字段被清空；普通用户改动后资源会重新进入审核。
 */
export async function updateHdhavenShareLink(params: {
  slug: string;
  url: string;
  panType?: string;
  accessCode?: string;
  /** 站点分享标题（一般传本地资源名 / 已更新标题）；不传或为空则沿用站点现值 */
  title?: string;
  /** 按资源名称解析出的属性（分辨率/来源/字幕/集数范围），只有非空字段才覆盖站点现值 */
  meta?: import('@/lib/hdhavenMeta').HdhavenShareMeta;
}): Promise<void> {
  await callHdhavenProxy(
    'update',
    {
      slug: params.slug,
      url: params.url,
      ...(params.panType ? { pan_type: params.panType } : {}),
      ...(params.accessCode ? { access_code: params.accessCode } : {}),
      ...(params.title?.trim() ? { title: params.title.trim() } : {}),
      ...(params.meta
        ? {
            ...(params.meta.video_resolution.length
              ? { video_resolution: params.meta.video_resolution }
              : {}),
            ...(params.meta.source.length ? { source: params.meta.source } : {}),
            ...(params.meta.subtitle_language.length
              ? { subtitle_language: params.meta.subtitle_language }
              : {}),
            ...(params.meta.subtitle_type.length
              ? { subtitle_type: params.meta.subtitle_type }
              : {}),
            ...(params.meta.episode_range ? { episode_range: params.meta.episode_range } : {}),
          }
        : {}),
    },
    // 服务端要「详情 → 解析链接 → 回写」三步，且带限速，放宽超时
    { timeoutMs: 120000 }
  );
}

/** 读取本用户全部栖影绑定关系 */
export async function fetchHdhavenResourceBindings(): Promise<
  import('@/types/index').HdhavenResourceBinding[]
> {
  const { data, error } = await supabase
    .from('hdhaven_resource_bindings')
    .select('*, resources!inner(owner_id)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as unknown as import('@/types/index').HdhavenResourceBinding[];
}

/** 建立资源与栖影分享条目的绑定 */
export async function bindResourceToHdhaven(
  resourceId: string,
  share: HdhavenShare,
  vodName?: string
): Promise<void> {
  const { error } = await supabase.from('hdhaven_resource_bindings').upsert(
    {
      resource_id: resourceId,
      slug: share.slug,
      tmdb_id: share.tmdb_id ?? null,
      media_type: share.media_type ?? null,
      link_title: share.title ?? null,
      vod_name: vodName ?? share.media_title ?? null,
      pan_type: share.pan_type ?? null,
      // 网盘中文名用于展示；同步匹配以 pan_type 为主（panUtils 里有别名映射）
      pan_label: share.pan_type ? (PAN_TYPE_LABELS[share.pan_type] ?? share.pan_type) : null,
    },
    { onConflict: 'resource_id,slug' }
  );
  if (error) throw error;
}

/** 解除资源与栖影的绑定（传 slug 解绑单条，不传解绑全部） */
export async function unbindResourceFromHdhaven(resourceId: string, slug?: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  let q = supabase.from('hdhaven_resource_bindings').delete().eq('resource_id', resourceId);
  if (slug) q = q.eq('slug', slug);
  const { error } = await q;
  if (error) throw error;
}

/** 同步资源更新到栖影（替换分享链接） */
export async function syncResourceToHdhaven(params: {
  slug: string;
  panUrl: string;
  panType?: string;
  accessCode?: string;
  /** 本地资源名称（含「更新至第N集」修正）：作为站点分享标题同步过去 */
  title?: string;
  /** 按资源名称解析出的属性，非空字段才覆盖站点现值 */
  meta?: import('@/lib/hdhavenMeta').HdhavenShareMeta;
}): Promise<void> {
  await updateHdhavenShareLink({
    slug: params.slug,
    url: params.panUrl,
    panType: params.panType,
    accessCode: params.accessCode,
    title: params.title,
    meta: params.meta,
  });
}

// ---------- 新建分享（投稿） ----------

/**
 * 新建栖影分享（站点影视详情页「我来分享」所用的 POST /api/resources，接口文档未收录）。
 * 服务端会用 inspect-link 自动识别网盘类型并补齐体积/画质/文件名等字段；
 * 返回新建条目的 slug，便于立即建立「资源 × 栖影分享」绑定，后续改链自动同步。
 * 注意：普通用户投稿后条目会先进入审核（review_status=pending）。
 */
export async function createHdhavenShare(params: {
  tmdbId: string;
  mediaType: string;
  url: string;
  title?: string;
  panType?: string;
  accessCode?: string;
  remark?: string;
  /** 按资源名称解析出的投稿属性（分辨率/来源/字幕/集数范围），服务端优先采用 */
  meta?: import('@/lib/hdhavenMeta').HdhavenShareMeta;
}): Promise<{ slug: string; panType: string; title: string }> {
  const data = await callHdhavenProxy<{
    data?: { slug?: string; pan_type?: string; title?: string };
  }>(
    'create_share',
    {
      tmdb_id: params.tmdbId,
      media_type: params.mediaType,
      url: params.url,
      title: params.title,
      pan_type: params.panType,
      access_code: params.accessCode,
      remark: params.remark,
      ...(params.meta
        ? {
            video_resolution: params.meta.video_resolution,
            source: params.meta.source,
            subtitle_language: params.meta.subtitle_language,
            subtitle_type: params.meta.subtitle_type,
            episode_range: params.meta.episode_range,
          }
        : {}),
    },
    // 服务端内部会先调 inspect-link 解析网盘，耗时较长
    { timeoutMs: 120000 }
  );
  return {
    slug: data.data?.slug ?? '',
    panType: data.data?.pan_type ?? '',
    title: data.data?.title ?? '',
  };
}

/** 用 slug 直接建立栖影绑定（投稿/发布成功后无需再回查站点列表） */
export async function bindResourceToHdhavenBySlug(params: {
  resourceId: string;
  slug: string;
  linkTitle?: string | null;
  vodName?: string | null;
  panType?: string | null;
  /** movie / tv：同步时用于判断是否提交「集数范围」 */
  mediaType?: string | null;
}): Promise<void> {
  const { error } = await supabase.from('hdhaven_resource_bindings').upsert(
    {
      resource_id: params.resourceId,
      slug: params.slug,
      tmdb_id: null,
      media_type: params.mediaType ?? null,
      link_title: params.linkTitle ?? null,
      vod_name: params.vodName ?? null,
      pan_type: params.panType ?? null,
      pan_label: params.panType ? (PAN_TYPE_LABELS[params.panType] ?? params.panType) : null,
    },
    { onConflict: 'resource_id,slug' }
  );
  if (error) throw error;
}

// ============ API 管理（管理员创建开放接口密钥） ============

/** 开放接口基地址：调用方用 API Key 读取资源（更新中 / 已完结） */
export const RESOURCE_API_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/resource-api`;

/** 生成开放接口密钥：rk_ + 40 位随机串（大小写字母 + 数字） */
export function makeApiKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(40);
  crypto.getRandomValues(bytes);
  return `rk_${Array.from(bytes, (b) => chars[b % chars.length]).join('')}`;
}

/** 管理员：读取全部 API Key（按创建时间倒序） */
export async function fetchApiKeys(): Promise<ApiKey[]> {
  const { data, error } = await supabase
    .from('api_keys')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return Array.isArray(data) ? (data as ApiKey[]) : [];
}

/**
 * 管理员：创建 API Key（expiresAt 传 null 表示永久有效）
 * ownerId 为密钥归属账号：范围 owner 时接口只返回该账号自己的资源，因此必填。
 * scope='all' 用于「订阅入库通知」：一个密钥即可查询所有账号的入库记录（资源类接口仍只看归属账号）。
 */
export async function createApiKey(params: {
  name: string;
  ownerId: string;
  remark?: string | null;
  expiresAt?: string | null;
  scope?: 'owner' | 'all';
}): Promise<ApiKey | null> {
  if (!params.ownerId) throw new Error('请选择密钥归属账号');
  const { data: session } = await supabase.auth.getSession();
  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      name: params.name.trim() || '未命名应用',
      api_key: makeApiKey(),
      remark: params.remark?.trim() || null,
      expires_at: params.expiresAt ?? null,
      owner_id: params.ownerId,
      scope: params.scope ?? 'owner',
      created_by: session?.session?.user?.id ?? null,
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as ApiKey | null) ?? null;
}

/** 管理员：更新 API Key（名称 / 备注 / 启停 / 有效期） */
export async function updateApiKey(
  id: string,
  patch: Partial<Pick<ApiKey, 'name' | 'remark' | 'is_active' | 'expires_at'>>
): Promise<void> {
  const { error } = await supabase.from('api_keys').update(patch).eq('id', id);
  if (error) throw error;
}

/** 管理员：删除 API Key（删除后立即失效，不可恢复） */
export async function deleteApiKey(id: string): Promise<void> {
  const { error } = await supabase.from('api_keys').delete().eq('id', id);
  if (error) throw error;
}

// ============ 1号站点（开放 API · 用户自填 pat_ 令牌）同步 ============
//
// 与其它站点的区别：不需要账密/Cookie，用户到 1号站点「开放API」标签生成令牌（明文只显示一次），
// 粘贴到本系统绑定即可。站点接口基地址为 <站点>/api/open，鉴权 Authorization: Bearer pat_…

export const ST1_TOKEN_EXPIRED_CODE = 'ST1_TOKEN_EXPIRED';

const ST1_FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/st1-proxy`;

/** 本人在 1号站点的绑定信息（不含令牌明文） */
export async function getSt1Binding(): Promise<import('@/types/index').St1Binding | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const { data, error } = await supabase
    .from('st1_sessions')
    .select('base_url, username, default_category_id, status, last_error, last_check_at')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** 统一调 st1-proxy；失败时把站点错误码挂到 Error 上（供失效判定用） */
async function callSt1Proxy<T = unknown>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) throw new Error('请先登录');
  const res = await fetch(`${ST1_FN_URL}?action=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionData.session.access_token}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; data?: unknown };
  if (!res.ok || data?.error) {
    const e = new Error(data?.error || `1号站点请求失败（HTTP ${res.status}）`) as Error & { code?: string };
    e.code = data?.code;
    throw e;
  }
  return (data?.data ?? data) as T;
}

/** 绑定/更新：先由代理 GET /profile 校验令牌，成功才落库（站点地址已内置，不必传） */
export async function bindSt1Credential(params: {
  /** 站点地址已由服务端内置，通常不需要传 */
  baseUrl?: string;
  token: string;
  defaultCategoryId?: string | null;
}): Promise<{ username: string | null }> {
  const r = await callSt1Proxy<{ username: string | null }>('bind', {
    ...(params.baseUrl ? { baseUrl: params.baseUrl.trim() } : {}),
    token: params.token.trim(),
    defaultCategoryId: params.defaultCategoryId ?? null,
  });
  // 云端加密留档：便于「站点同步」页统一展示/巡检（令牌型不自动重登，失效需用户重新生成）
  await saveSiteCredential({ site: 'st1', username: r?.username ?? '', token: params.token.trim() });
  return { username: r?.username ?? null };
}

export async function unbindSt1(): Promise<void> {
  await callSt1Proxy('unbind');
}

/** 巡检：令牌是否还有效（顺带刷新站点用户名与状态） */
export async function checkSt1(): Promise<{ username: string | null }> {
  return await callSt1Proxy<{ username: string | null }>('status');
}

/**
 * 取站点图形验证码（SVG 文本）。
 * 站点把验证码与当前会话绑定，所以代理会把这一步建立的 Cookie 暂存下来，登录时必须紧接着调用 login。
 */
export async function st1Captcha(baseUrl?: string): Promise<{ svg: string }> {
  return await callSt1Proxy<{ svg: string }>('captcha', baseUrl ? { baseUrl: baseUrl.trim() } : {});
}

/** 用站点账号密码 + 图形验证码登录（站点内部会话；与开放 API 令牌相互独立） */
export async function st1Login(params: {
  /** 站点地址已由服务端内置，通常不需要传 */
  baseUrl?: string;
  username: string;
  password: string;
  captcha: string;
}): Promise<{ username: string | null }> {
  const r = await callSt1Proxy<{ username: string | null }>('login', {
    ...(params.baseUrl ? { baseUrl: params.baseUrl.trim() } : {}),
    username: params.username.trim(),
    password: params.password,
    captcha: params.captcha.trim(),
  });
  // 云端加密留档：验证码站点无法自动重登，留档用于「站点同步」页统一展示
  await saveSiteCredential({ site: 'st1', username: params.username.trim(), password: params.password });
  return r;
}

/** 站点信息（地址由服务端内置，用户不需要填写） */
export async function st1SiteInfo(): Promise<{ baseUrl: string | null; builtin: boolean }> {
  return await callSt1Proxy<{ baseUrl: string | null; builtin: boolean }>('site');
}

/** 站点上的「我发布的片源」列表（用于登录后展示与编辑） */
export interface St1RemoteItem {
  [key: string]: unknown;
}

export async function st1MyResources(params: { keyword?: string; pageSize?: number } = {}): Promise<{
  me: { id?: string; username?: string; nickname?: string };
  items: St1RemoteItem[];
  scanned: number;
  filtered: boolean;
  sample_keys: string[];
}> {
  return await callSt1Proxy('list_mine', params as Record<string, unknown>);
}

/** 站点登录态自检（GET /api/me） */
export async function st1Me(): Promise<{ username: string | null }> {
  return await callSt1Proxy<{ username: string | null }>('me');
}

/** 站点分类列表（发布片源时选默认分类） */
export async function st1Categories(): Promise<unknown> {
  return await callSt1Proxy('categories');
}

/** 站点 PT 规格标签 */
export async function st1PtTags(): Promise<unknown> {
  return await callSt1Proxy('pt_tags');
}

/** 站点片源列表（按关键词搜索，用于确认某个资源是否已发布） */
export async function searchSt1Resources(params: {
  keyword?: string;
  page?: number;
  pageSize?: number;
  category?: string;
} = {}): Promise<unknown> {
  return await callSt1Proxy('search', params as Record<string, unknown>);
}

/** 发布片源到 1号站点；带 resourceId 时会回写「资源 ↔ 片源」绑定，之后变更自动 PATCH */
export async function publishSt1Resource(params: {
  resourceId?: string;
  title: string;
  panUrl: string;
  panCode?: string;
  content?: string;
  categoryId?: string | null;
  tags?: string[];
  ptTagIds?: Array<string | number>;
}): Promise<unknown> {
  return await callSt1Proxy('publish', params as unknown as Record<string, unknown>);
}

/** 局部更新已发布的片源（标题 / 云盘地址等） */
export async function updateSt1Resource(params: {
  resourceId?: string;
  remoteId?: string;
  title?: string;
  panUrl?: string;
  panCode?: string;
  content?: string;
  categoryId?: string | null;
}): Promise<unknown> {
  return await callSt1Proxy('update', params as unknown as Record<string, unknown>);
}

/** 更新默认发布分类（只改本地绑定记录，不下发站点） */
export async function setSt1DefaultCategory(id: string | null): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { error } = await supabase
    .from('st1_sessions')
    .update({ default_category_id: id })
    .eq('user_id', userData.user.id);
  if (error) throw error;
}

/**
 * 把本地资源绑定到「站点上已存在的片源」（不新建片源，只建立同步关系）。
 * 绑定后资源变更会由服务端 resource-sync-worker 自动 PATCH 到该片源。
 */
export async function bindResourceToSt1(params: {
  resourceId: string;
  remoteId: string;
  title?: string | null;
  remoteUrl?: string | null;
}): Promise<import('@/types/index').St1ResourceBinding> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error('请先登录');
  const { data, error } = await supabase
    .from('st1_resource_bindings')
    .upsert({
      user_id: userData.user.id,
      resource_id: params.resourceId,
      remote_id: params.remoteId,
      title: params.title ?? null,
      remote_url: params.remoteUrl ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'resource_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data as import('@/types/index').St1ResourceBinding;
}

/** 解除与 1号站图片源的绑定（不影响站点上已发布的内容） */
export async function unbindResourceFromSt1(resourceId: string): Promise<void> {
  const { error } = await supabase
    .from('st1_resource_bindings')
    .delete()
    .eq('resource_id', resourceId);
  if (error) throw error;
}

/** 本地资源在 1号站点的发布绑定（有绑定才能用 PATCH 同步） */
export async function getSt1ResourceBindings(): Promise<import('@/types/index').St1ResourceBinding[]> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return [];
  const { data, error } = await supabase
    .from('st1_resource_bindings')
    .select('*')
    .eq('user_id', userData.user.id);
  if (error) throw error;
  return Array.isArray(data) ? (data as import('@/types/index').St1ResourceBinding[]) : [];
}

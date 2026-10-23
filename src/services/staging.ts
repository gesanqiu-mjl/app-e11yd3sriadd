import { supabase } from '@/db/supabase';

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/subscription-run`;

async function callStagingFn<T>(
  action: string,
  body: Record<string, unknown> = {},
  timeoutMs = 120000
): Promise<T> {
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
    throw new Error(`暂存服务返回异常（HTTP ${res.status}）`);
  }
  if (!res.ok || parsed?.success === false) {
    throw new Error(parsed?.message || `暂存服务异常（HTTP ${res.status}）`);
  }
  return parsed.data as T;
}

export interface StagingAccount {
  id: string;
  label: string;
  pan_owner_user_id: string;
  root_dir_id: string | null;
  total_capacity_bytes: number;
  status: string;
  last_error: string | null;
  created_at: string;
  used_bytes?: number;
  allocated_bytes?: number;
  user_count?: number;
}

export interface StagingPanOwner {
  user_id: string;
  username: string;
  status: string;
}

export interface StagingAllocation {
  id: string;
  account_id: string;
  user_id: string;
  capacity_bytes: number;
  created_at: string;
  profile?: { id: string; username: string | null; email: string | null } | null;
}

export interface StagingMyAlloc {
  id: string;
  account_id: string;
  capacity_bytes: number;
  used_bytes: number;
  account?: {
    id: string;
    label: string;
    status: string;
    total_capacity_bytes: number;
    root_dir_id: string | null;
    pan_owner_user_id?: string;
  } | null;
}

export interface StagingFile {
  id: string;
  account_id: string;
  file_id: string;
  name: string;
  size_bytes: number;
  is_dir: boolean;
  status: string;
  created_at: string;
}

export const GB = 1024 * 1024 * 1024;

export async function stagingListAccounts(): Promise<StagingAccount[]> {
  return callStagingFn<StagingAccount[]>('stagingListAccounts');
}

/** 管理员：列出已绑定光鸭的账号，供添加主账号时选择 */
export async function stagingListPanOwners(): Promise<StagingPanOwner[]> {
  return callStagingFn<StagingPanOwner[]>('stagingListPanOwners');
}

export async function stagingSaveAccount(p: {
  id?: string;
  label: string;
  pan_owner_user_id: string;
  root_dir_id?: string | null;
  total_capacity_bytes: number;
}): Promise<{ id: string }> {
  return callStagingFn('stagingSaveAccount', p as Record<string, unknown>);
}

export async function stagingDeleteAccount(id: string): Promise<{ id: string }> {
  return callStagingFn('stagingDeleteAccount', { id });
}

export async function stagingListAllocations(accountId: string): Promise<StagingAllocation[]> {
  return callStagingFn<StagingAllocation[]>('stagingListAllocations', { account_id: accountId });
}

export async function stagingSaveAllocation(p: {
  account_id: string;
  user_id: string;
  capacity_bytes: number;
}): Promise<{ ok: boolean }> {
  return callStagingFn('stagingSaveAllocation', p as Record<string, unknown>);
}

export async function stagingDeleteAllocation(id: string): Promise<{ id: string }> {
  return callStagingFn('stagingDeleteAllocation', { id });
}

export async function stagingMyStatus(accountId?: string): Promise<StagingMyAlloc[]> {
  return callStagingFn<StagingMyAlloc[]>('stagingMyStatus', accountId ? { account_id: accountId } : {});
}

export async function stagingTransfer(p: {
  account_id: string;
  share_url: string;
  pwd?: string;
}): Promise<{ transferred: number; total: number; message: string }> {
  return callStagingFn('stagingTransfer', p as Record<string, unknown>, 180000);
}

export async function stagingListFiles(accountId?: string): Promise<StagingFile[]> {
  return callStagingFn<StagingFile[]>('stagingListFiles', accountId ? { account_id: accountId } : {});
}

export async function stagingDeleteFiles(ids: string[]): Promise<{ deleted: number; message: string }> {
  return callStagingFn('stagingDeleteFiles', { ids });
}

export async function stagingRenameFile(id: string, newName: string): Promise<{ id: string; name: string }> {
  return callStagingFn('stagingRenameFile', { id, new_name: newName });
}

// 创建分享链接：接口待用户后续提供，先占位
export async function stagingCreateShare(): Promise<unknown> {
  return callStagingFn('stagingCreateShare', {});
}

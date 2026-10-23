import { callSubscriptionFn } from './subscriptions';

export interface StagingAccount {
  id: string;
  label: string;
  root_dir_id: string | null;
  root_dir_name?: string | null;
  total_capacity_bytes: number;
  status: string;
  last_error?: string | null;
  created_at?: string;
  used_bytes?: number;
  allocated_bytes?: number;
  user_count?: number;
}

export interface StagingAllocation {
  id: string;
  account_id: string;
  user_id: string;
  capacity_bytes: number;
  profile?: { id: string; username: string | null; email: string | null } | null;
}

export interface StagingMyAlloc {
  id: string;
  account_id: string;
  capacity_bytes: number;
  used_bytes: number;
  account: {
    id: string;
    label: string;
    status: string;
    total_capacity_bytes: number;
    root_dir_id: string | null;
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
  created_at?: string;
}

export const GB = 1024 ** 3;

export interface StagingDir {
  id: string;
  name: string;
}

// ───────── 管理员端 ─────────
export async function stagingListAccounts(): Promise<StagingAccount[]> {
  return callSubscriptionFn<StagingAccount[]>('stagingListAccounts', {});
}

/** 扫码授权后自动绑定主账号：后端读取账号名与云盘根目录，返回目录列表供选择 */
export async function stagingBindAccount(input: {
  token_json: string;
  id?: string;
  root_dir_id?: string | null;
  total_capacity_bytes?: number;
}): Promise<{ id: string; label: string; username?: string; dirs: StagingDir[] }> {
  return callSubscriptionFn<{ id: string; label: string; username?: string; dirs: StagingDir[] }>(
    'stagingBindAccount',
    input,
  );
}

/** 浏览主账号云盘目录（parentId 为空 = 根目录） */
export async function stagingListDirs(accountId: string, parentId?: string): Promise<StagingDir[]> {
  return callSubscriptionFn<StagingDir[]>('stagingListDirs', {
    account_id: accountId,
    parent_id: parentId ?? '',
  });
}

/** 设置主账号的暂存目录（空 = 根目录） */
export async function stagingSetDir(input: {
  id: string;
  root_dir_id: string | null;
  root_dir_name?: string | null;
}): Promise<void> {
  return callSubscriptionFn('stagingSetDir', input);
}

export async function stagingSaveAccount(input: {
  id?: string;
  label: string;
  token_json?: string;
  root_dir_id?: string | null;
  total_capacity_bytes: number;
}): Promise<{ id: string }> {
  return callSubscriptionFn<{ id: string }>('stagingSaveAccount', input);
}

export async function stagingDeleteAccount(id: string): Promise<void> {
  return callSubscriptionFn('stagingDeleteAccount', { id });
}

export async function stagingListAllocations(accountId: string): Promise<StagingAllocation[]> {
  return callSubscriptionFn<StagingAllocation[]>('stagingListAllocations', { account_id: accountId });
}

export async function stagingSaveAllocation(input: {
  account_id: string;
  user_id: string;
  capacity_bytes: number;
}): Promise<{ ok: boolean }> {
  return callSubscriptionFn<{ ok: boolean }>('stagingSaveAllocation', input);
}

export async function stagingDeleteAllocation(id: string): Promise<{ id: string }> {
  return callSubscriptionFn<{ id: string }>('stagingDeleteAllocation', { id });
}

// ───────── 用户端 ─────────
export async function stagingMyStatus(): Promise<StagingMyAlloc[]> {
  return callSubscriptionFn<StagingMyAlloc[]>('stagingMyStatus', {});
}

export async function stagingTransfer(input: {
  account_id: string;
  share_url: string;
  pwd?: string;
}): Promise<{ transferred: number; total: number; message: string }> {
  return callSubscriptionFn<{ transferred: number; total: number; message: string }>('stagingTransfer', input);
}

export async function stagingListFiles(): Promise<StagingFile[]> {
  return callSubscriptionFn<StagingFile[]>('stagingListFiles', {});
}

export async function stagingDeleteFiles(ids: string[]): Promise<{ deleted?: number; message: string }> {
  return callSubscriptionFn<{ deleted?: number; message: string }>('stagingDeleteFiles', { ids });
}

export async function stagingRenameFile(id: string, name: string): Promise<{ id: string; name: string }> {
  return callSubscriptionFn<{ id: string; name: string }>('stagingRenameFile', { id, new_name: name });
}

export async function stagingCreateShare(input: {
  account_id: string;
  file_id: string;
}): Promise<any> {
  return callSubscriptionFn('stagingCreateShare', input);
}

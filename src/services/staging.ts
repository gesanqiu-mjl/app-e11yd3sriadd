import { callSubscriptionFn } from './subscriptions';

export interface StagingAccount {
  id: string;
  label: string;
  root_dir_id: string | null;
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

// ───────── 管理员端 ─────────
export async function stagingListAccounts(): Promise<StagingAccount[]> {
  return callSubscriptionFn<StagingAccount[]>('stagingListAccounts', {});
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

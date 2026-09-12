
-- xn_sessions：存储用户与 xn--wcv59z.com 账号的 Cookie 绑定
create table if not exists public.xn_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  cookie text not null,
  status text not null default 'active',
  last_check_at timestamptz,
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

-- xn_shares_cache：分享记录可选本地缓存
create table if not exists public.xn_shares_cache (
  share_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  dir text,
  tname text,
  time text,
  url text,
  atitle text,
  bindcount integer default 0,
  status integer default 0,
  cached_at timestamptz not null default now()
);

-- RLS
alter table public.xn_sessions enable row level security;
alter table public.xn_shares_cache enable row level security;

drop policy if exists "xn_session_select_own" on public.xn_sessions;
drop policy if exists "xn_session_insert_own" on public.xn_sessions;
drop policy if exists "xn_session_update_own" on public.xn_sessions;
drop policy if exists "xn_session_delete_own" on public.xn_sessions;

create policy "xn_session_select_own" on public.xn_sessions for select using (auth.uid() = user_id);
create policy "xn_session_insert_own" on public.xn_sessions for insert with check (auth.uid() = user_id);
create policy "xn_session_update_own" on public.xn_sessions for update using (auth.uid() = user_id);
create policy "xn_session_delete_own" on public.xn_sessions for delete using (auth.uid() = user_id);

drop policy if exists "xn_cache_select_own" on public.xn_shares_cache;
drop policy if exists "xn_cache_insert_own" on public.xn_shares_cache;
drop policy if exists "xn_cache_update_own" on public.xn_shares_cache;
drop policy if exists "xn_cache_delete_own" on public.xn_shares_cache;

create policy "xn_cache_select_own" on public.xn_shares_cache for select using (auth.uid() = user_id);
create policy "xn_cache_insert_own" on public.xn_shares_cache for insert with check (auth.uid() = user_id);
create policy "xn_cache_update_own" on public.xn_shares_cache for update using (auth.uid() = user_id);
create policy "xn_cache_delete_own" on public.xn_shares_cache for delete using (auth.uid() = user_id);

create index if not exists idx_xn_sessions_user on public.xn_sessions (user_id);
create index if not exists idx_xn_cache_user on public.xn_shares_cache (user_id);


create table if not exists public.framehdr_sessions (
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
alter table public.framehdr_sessions enable row level security;
drop policy if exists "framehdr_sessions_own" on public.framehdr_sessions;
create policy "framehdr_sessions_own" on public.framehdr_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.framehdr_sync_logs (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete cascade,
  action text not null,
  remote_id integer,
  title text,
  status text not null,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists idx_framehdr_sync_logs_user
  on public.framehdr_sync_logs (user_id, created_at desc);
alter table public.framehdr_sync_logs enable row level security;
drop policy if exists "framehdr_sync_logs_own" on public.framehdr_sync_logs;
create policy "framehdr_sync_logs_own" on public.framehdr_sync_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- 123社区（123panfx.com）盘链式集成 · Supabase 数据库脚本
-- panfx_sessions：用户绑定的 Cookie（bbs_token + bbs_sid 完整串）
-- panfx_resource_bindings：资源 → 帖子绑定关系
-- ============================================================

-- 1. 会话表
create table if not exists public.panfx_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  cookie text not null,
  status text not null default 'active',     -- active / expired
  username text,
  last_check_at timestamptz,
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

alter table public.panfx_sessions enable row level security;
drop policy if exists "panfx_sessions_own" on public.panfx_sessions;
create policy "panfx_sessions_own" on public.panfx_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 2. 资源-帖子绑定关系表（与 framehdr_resource_bindings 同构）
create table if not exists public.panfx_resource_bindings (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources (id) on delete cascade,
  tid integer not null,
  firstpid integer,
  subject text,
  fid text,
  created_at timestamptz not null default now(),
  unique (resource_id)
);

create index if not exists idx_panfx_rb_resource
  on public.panfx_resource_bindings (resource_id);

alter table public.panfx_resource_bindings enable row level security;

drop policy if exists "panfx_rb_select_own" on public.panfx_resource_bindings;
create policy "panfx_rb_select_own" on public.panfx_resource_bindings
  for select using (
    exists (select 1 from public.resources r
      where r.id = panfx_resource_bindings.resource_id and r.owner_id = auth.uid())
  );

drop policy if exists "panfx_rb_insert_own" on public.panfx_resource_bindings;
create policy "panfx_rb_insert_own" on public.panfx_resource_bindings
  for insert with check (
    exists (select 1 from public.resources r
      where r.id = panfx_resource_bindings.resource_id and r.owner_id = auth.uid())
  );

drop policy if exists "panfx_rb_update_own" on public.panfx_resource_bindings;
create policy "panfx_rb_update_own" on public.panfx_resource_bindings
  for update using (
    exists (select 1 from public.resources r
      where r.id = panfx_resource_bindings.resource_id and r.owner_id = auth.uid())
  );

drop policy if exists "panfx_rb_delete_own" on public.panfx_resource_bindings;
create policy "panfx_rb_delete_own" on public.panfx_resource_bindings
  for delete using (
    exists (select 1 from public.resources r
      where r.id = panfx_resource_bindings.resource_id and r.owner_id = auth.uid())
  );
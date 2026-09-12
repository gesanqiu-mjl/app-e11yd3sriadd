-- 鸭影臻藏账号绑定（存储用户名/密码/登录 token）
create table public.ya_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  password text not null,
  access_token text,
  refresh_token text,
  expires_in integer,
  remark text,
  status text not null default 'active',
  last_check_at timestamptz,
  updated_at timestamptz not null default now()
);

-- 资源与鸭影臻藏发布记录的绑定关系
create table public.ya_resource_bindings (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources(id) on delete cascade,
  link_id bigint not null,
  link_title text,
  vod_name text,
  created_at timestamptz not null default now()
);
create index idx_ya_resource_bindings_resource on public.ya_resource_bindings(resource_id);

alter table public.ya_sessions enable row level security;
alter table public.ya_resource_bindings enable row level security;

-- ya_sessions：仅本人可读写
create policy "ya_sessions_select_own" on public.ya_sessions
  for select to authenticated using (user_id = auth.uid());
create policy "ya_sessions_insert_own" on public.ya_sessions
  for insert to authenticated with check (user_id = auth.uid());
create policy "ya_sessions_update_own" on public.ya_sessions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "ya_sessions_delete_own" on public.ya_sessions
  for delete to authenticated using (user_id = auth.uid());

-- ya_resource_bindings：仅本人可读写（通过 resources.owner_id）
create policy "ya_bindings_select_own" on public.ya_resource_bindings
  for select to authenticated
  using (exists (select 1 from public.resources r where r.id = resource_id and r.owner_id = auth.uid()));
create policy "ya_bindings_insert_own" on public.ya_resource_bindings
  for insert to authenticated
  with check (exists (select 1 from public.resources r where r.id = resource_id and r.owner_id = auth.uid()));
create policy "ya_bindings_update_own" on public.ya_resource_bindings
  for update to authenticated
  using (exists (select 1 from public.resources r where r.id = resource_id and r.owner_id = auth.uid()))
  with check (exists (select 1 from public.resources r where r.id = resource_id and r.owner_id = auth.uid()));
create policy "ya_bindings_delete_own" on public.ya_resource_bindings
  for delete to authenticated
  using (exists (select 1 from public.resources r where r.id = resource_id and r.owner_id = auth.uid()));
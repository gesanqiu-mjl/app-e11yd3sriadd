-- 1. 站点登录凭据表
create table if not exists public.mukaku_tokens (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  username         text        not null,
  access_token     text        not null,
  token_expires_at timestamptz,
  status           text        not null default 'active',
  last_check_at    timestamptz,
  remark           text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.mukaku_tokens enable row level security;

-- 允许用户查自己的凭据状态（仅非敏感字段，或通过 Edge Function）
create index if not exists idx_mukaku_tokens_status on public.mukaku_tokens (status);

-- 2. 资源绑定表
create table if not exists public.mukaku_resource_bindings (
  id           uuid primary key default gen_random_uuid(),
  resource_id  uuid not null references public.resources (id) on delete cascade,
  link_id      bigint not null,
  movies_id    bigint not null,
  seed_name    text,
  vod_name     text,
  pan_type     text,
  share_code   text,
  created_at   timestamptz not null default now(),
  constraint uq_mukaku_resource_link unique (resource_id, link_id)
);

create index if not exists idx_mukaku_bindings_resource on public.mukaku_resource_bindings (resource_id);

alter table public.mukaku_resource_bindings enable row level security;

drop policy if exists "Users can view their own mukaku bindings" on public.mukaku_resource_bindings;
create policy "Users can view their own mukaku bindings"
  on public.mukaku_resource_bindings for select
  using (exists (
    select 1 from public.resources r
    where r.id = mukaku_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));

drop policy if exists "Users can insert their own mukaku bindings" on public.mukaku_resource_bindings;
create policy "Users can insert their own mukaku bindings"
  on public.mukaku_resource_bindings for insert
  with check (exists (
    select 1 from public.resources r
    where r.id = mukaku_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));

drop policy if exists "Users can update their own mukaku bindings" on public.mukaku_resource_bindings;
create policy "Users can update their own mukaku bindings"
  on public.mukaku_resource_bindings for update
  using (exists (
    select 1 from public.resources r
    where r.id = mukaku_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));

drop policy if exists "Users can delete their own mukaku bindings" on public.mukaku_resource_bindings;
create policy "Users can delete their own mukaku bindings"
  on public.mukaku_resource_bindings for delete
  using (exists (
    select 1 from public.resources r
    where r.id = mukaku_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));
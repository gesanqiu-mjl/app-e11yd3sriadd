-- 聚影站点（www.jying.top）接入：登录会话 + 资源绑定
-- 站点为 Django，写操作需 CSRF（csrftoken cookie + X-CSRFToken 头）
-- 且需双通道鉴权：Cookie(sessionid) + 请求头 X-App-User-Token

-- 1. 站点登录凭据（账号密码登录后保存会话与 token）
create table if not exists public.jying_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  username      text not null default '',
  cookie        text not null default '',   -- 站点 Cookie（csrftoken / sessionid）
  token         text not null default '',   -- X-App-User-Token
  status        text not null default 'active',
  last_check_at timestamptz,
  remark        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id)
);
alter table public.jying_sessions enable row level security;
drop policy if exists "jying_sessions_own" on public.jying_sessions;
create policy "jying_sessions_own" on public.jying_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 2. 资源 × 聚影分享条目 绑定关系（一个资源可绑定多条，每条对应一种网盘）
create table if not exists public.jying_resource_bindings (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources (id) on delete cascade,
  link_id     bigint not null,   -- 聚影资源条目 ID（POST /api/app/resource/{id}/update/）
  movie_id    bigint,            -- 聚影影片 ID（/api/app/my-resource-movies/ 的 id）
  link_title  text,
  vod_name    text,              -- 影片名（绑定时的片源标题）
  pan_label   text,              -- 网盘中文名（本地按 URL 识别，同步时用于匹配链接）
  created_at  timestamptz not null default now(),
  constraint uq_jying_resource_link unique (resource_id, link_id)
);

create index if not exists idx_jying_bindings_resource on public.jying_resource_bindings (resource_id);
create index if not exists idx_jying_bindings_link on public.jying_resource_bindings (link_id);

alter table public.jying_resource_bindings enable row level security;

drop policy if exists "jying_bindings_select_own" on public.jying_resource_bindings;
create policy "jying_bindings_select_own"
  on public.jying_resource_bindings for select
  using (exists (
    select 1 from public.resources r
    where r.id = jying_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));

drop policy if exists "jying_bindings_insert_own" on public.jying_resource_bindings;
create policy "jying_bindings_insert_own"
  on public.jying_resource_bindings for insert
  with check (exists (
    select 1 from public.resources r
    where r.id = jying_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));

drop policy if exists "jying_bindings_update_own" on public.jying_resource_bindings;
create policy "jying_bindings_update_own"
  on public.jying_resource_bindings for update
  using (exists (
    select 1 from public.resources r
    where r.id = jying_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));

drop policy if exists "jying_bindings_delete_own" on public.jying_resource_bindings;
create policy "jying_bindings_delete_own"
  on public.jying_resource_bindings for delete
  using (exists (
    select 1 from public.resources r
    where r.id = jying_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));

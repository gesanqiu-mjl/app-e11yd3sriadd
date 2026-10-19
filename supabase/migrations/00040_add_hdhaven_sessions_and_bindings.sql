-- 栖影 HDHaven（hdhaven.com）接入：登录会话 + 资源绑定
-- 站点为 Next.js，鉴权走「同源 httpOnly 会话 Cookie」，不使用 Authorization / Token 头，
-- 因此这里保存登录后的完整 Cookie；风控命中时接口返回 SCRAPE_CHALLENGE_REQUIRED（需人工过图形验证码）。

-- 1. 站点登录凭据（账号密码登录后保存会话 Cookie）
create table if not exists public.hdhaven_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  username      text not null default '',
  user_number   integer,                      -- 站点用户编号（主页 /user/{user_number}）
  cookie        text not null default '',     -- 站点会话 Cookie（httpOnly，服务端代理代发请求用）
  status        text not null default 'active',
  last_check_at timestamptz,
  remark        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id)
);
alter table public.hdhaven_sessions enable row level security;
drop policy if exists "hdhaven_sessions_own" on public.hdhaven_sessions;
create policy "hdhaven_sessions_own" on public.hdhaven_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 2. 资源 × 栖影分享条目 绑定关系（一个资源可绑定多条，每条对应一种网盘）
-- 栖影用 slug 标识分享条目（POST /api/users/me/shares/{slug}/update）
create table if not exists public.hdhaven_resource_bindings (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources (id) on delete cascade,
  slug        text not null,           -- 栖影分享条目 slug
  tmdb_id     text,                    -- TMDB ID
  media_type  text,                    -- movie / tv
  link_title  text,                    -- 分享标题（站点 title）
  vod_name    text,                    -- 影片名（绑定时的片源标题）
  pan_type    text,                    -- 站点网盘类型：guangya / 115 / 123 / ed2k
  pan_label   text,                    -- 网盘中文名（本地按 URL 识别，同步时用于匹配链接）
  created_at  timestamptz not null default now(),
  constraint uq_hdhaven_resource_slug unique (resource_id, slug)
);

create index if not exists idx_hdhaven_bindings_resource on public.hdhaven_resource_bindings (resource_id);
create index if not exists idx_hdhaven_bindings_slug on public.hdhaven_resource_bindings (slug);

alter table public.hdhaven_resource_bindings enable row level security;

drop policy if exists "hdhaven_bindings_select_own" on public.hdhaven_resource_bindings;
create policy "hdhaven_bindings_select_own"
  on public.hdhaven_resource_bindings for select
  using (exists (
    select 1 from public.resources r
    where r.id = hdhaven_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));

drop policy if exists "hdhaven_bindings_insert_own" on public.hdhaven_resource_bindings;
create policy "hdhaven_bindings_insert_own"
  on public.hdhaven_resource_bindings for insert
  with check (exists (
    select 1 from public.resources r
    where r.id = hdhaven_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));

drop policy if exists "hdhaven_bindings_update_own" on public.hdhaven_resource_bindings;
create policy "hdhaven_bindings_update_own"
  on public.hdhaven_resource_bindings for update
  using (exists (
    select 1 from public.resources r
    where r.id = hdhaven_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));

drop policy if exists "hdhaven_bindings_delete_own" on public.hdhaven_resource_bindings;
create policy "hdhaven_bindings_delete_own"
  on public.hdhaven_resource_bindings for delete
  using (exists (
    select 1 from public.resources r
    where r.id = hdhaven_resource_bindings.resource_id
      and r.owner_id = auth.uid()
  ));

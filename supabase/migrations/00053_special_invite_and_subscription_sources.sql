-- 特殊邀请码（永久 + 一码一用 + 仅订阅功能 + 最多 10 个订阅）与「订阅源」管理
--
-- 1) invite_codes.is_special：特殊邀请码（永久有效；注册出来的用户受限）
-- 2) profiles.subscription_only / max_subscriptions：受限账号标记与订阅数量上限（NULL = 不限）
-- 3) subscription_sources：管理员维护的订阅源，受限账号只能从里面选订阅链接
-- 4) consume_invite_code：消费特殊码时把「永久 + 仅订阅 + 上限 10 + 开通订阅功能」写到 profiles
-- 5) guard_profile_privileged_columns：把新增的特权列（及 subscriptions_enabled）纳入保护，
--    避免受限用户用 PostgREST 直接把自己的限制改掉

-- ── 1. 邀请码：特殊码标记 ──
alter table public.invite_codes
  add column if not exists is_special boolean not null default false;

comment on column public.invite_codes.is_special is '特殊邀请码：永久有效，注册出来的账号只能使用订阅功能且最多 10 个订阅';

-- ── 2. profiles：受限账号标记与订阅上限 ──
alter table public.profiles
  add column if not exists subscription_only boolean not null default false;
alter table public.profiles
  add column if not exists max_subscriptions int;

comment on column public.profiles.subscription_only is '仅订阅账号：只能使用订阅功能，且只能订阅管理员维护的订阅源';
comment on column public.profiles.max_subscriptions is '订阅数量上限；NULL = 不限';

-- ── 3. 订阅源（管理员维护） ──
create table if not exists public.subscription_sources (
  id               uuid primary key default gen_random_uuid(),
  name             text not null default '未命名订阅源',
  note             text,
  source_url       text not null,
  source_type      text not null default 'auto' check (source_type in ('auto','rss','page','pan_share')),
  source_passcode  text,
  keyword          text,
  pan              text not null default 'guangya' check (pan in ('guangya','quark')),
  clean_mode       text not null default 'episode',
  interval_minutes int not null default 30,
  is_active        boolean not null default true,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.subscription_sources is '管理员维护的订阅源：受限（special）账号只能从这里选订阅链接';

-- 同一个源地址只保留一条（忽略大小写与首尾空白）
create unique index if not exists subscription_sources_url_key
  on public.subscription_sources (lower(btrim(source_url)));

create index if not exists subscription_sources_active_idx
  on public.subscription_sources (is_active, sort_order, created_at);

alter table public.subscription_sources enable row level security;

-- 管理员：增删改查全权
drop policy if exists subscription_sources_admin_all on public.subscription_sources;
create policy subscription_sources_admin_all on public.subscription_sources
  for all to authenticated
  using (public.get_user_role(auth.uid()) = 'admin')
  with check (public.get_user_role(auth.uid()) = 'admin');

-- 其它登录用户：只读「已启用」的源（用于订阅页选源）
drop policy if exists subscription_sources_read_active on public.subscription_sources;
create policy subscription_sources_read_active on public.subscription_sources
  for select to authenticated
  using (is_active = true);

grant select, insert, update, delete on public.subscription_sources to authenticated, service_role;

drop trigger if exists subscription_sources_updated_at on public.subscription_sources;
create trigger subscription_sources_updated_at
  before update on public.subscription_sources
  for each row execute function public.update_updated_at();

-- ── 4. 消费邀请码：特殊码 → 永久 + 仅订阅 + 上限 10 ──
create or replace function public.consume_invite_code(p_code text, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_days int;
  v_special boolean;
  v_target uuid := coalesce(auth.uid(), p_user_id);
begin
  if v_target is null then
    return false;
  end if;

  select id, membership_days, coalesce(is_special, false)
    into v_id, v_days, v_special
  from invite_codes
  where code = upper(btrim(p_code))
    and used_by is null
    and is_revoked = false
  for update skip locked;

  if v_id is null then
    return false;
  end if;

  update invite_codes
  set used_by = v_target, used_at = now()
  where id = v_id;

  -- 受信任：允许本次事务内修改 profiles 的特权列
  perform set_config('app.allow_privileged_profile_update', 'on', true);

  update profiles
  set membership_expires_at = case
        when v_special then null                                     -- 特殊码：永久
        when v_days is null or v_days < 0 then null                   -- -1 也按永久
        else now() + (v_days || ' days')::interval
      end,
      subscription_only = v_special,
      max_subscriptions = case when v_special then 10 else max_subscriptions end,
      -- 特殊码注册出来的账号要能直接用订阅功能（只开订阅，不开别的）
      subscriptions_enabled = case when v_special then true else subscriptions_enabled end
  where id = v_target;

  return true;
end;
$$;

-- ── 5. 特权列保护：把新增列与 subscriptions_enabled 一起纳入 ──
create or replace function public.guard_profile_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (v_claims)::jsonb ->> 'role'
  );
  v_trusted text := current_setting('app.allow_privileged_profile_update', true);
begin
  -- 特权列都没动，正常放行（不影响普通字段更新）
  if new.role is not distinct from old.role
     and new.status is not distinct from old.status
     and new.membership_expires_at is not distinct from old.membership_expires_at
     and new.batch_post_expires_at is not distinct from old.batch_post_expires_at
     and new.subscriptions_enabled is not distinct from old.subscriptions_enabled
     and new.subscription_only is not distinct from old.subscription_only
     and new.max_subscriptions is not distinct from old.max_subscriptions then
    return new;
  end if;

  -- 无 JWT 上下文：SQL Editor / 迁移脚本 / psql 等直接库内操作，放行
  if v_claims is null then
    return new;
  end if;

  -- service_role（边缘函数）、显式白名单（受信任的 SECURITY DEFINER 函数）、管理员
  if v_jwt_role = 'service_role'
     or v_trusted = 'on'
     or public.get_user_role(auth.uid()) = 'admin' then
    return new;
  end if;

  raise exception '无权修改账号特权字段（角色 / 状态 / 会员到期 / 批量发帖 / 订阅权限），请联系管理员';
end;
$$;

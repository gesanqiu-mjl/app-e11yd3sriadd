-- ============================================================
-- 按账号可配置额度：资源条数上限（max_resources）+ 订阅条数上限（max_subscriptions）
--
-- 背景：
--   · 订阅上限此前只有「特殊邀请码注册的订阅专用账号」能调（管理员后台只对这类账号露出入口），
--     普通用户固定 80；资源条数上限更是写死在前端 200，管理员无从调整。
--   · 现在管理员可对任意账号分别设置「资源上限」和「订阅上限」。
--
-- 语义（与服务端保持一致）：
--   max_resources      NULL / <1 = 默认 200（管理员账号不受限）
--   max_subscriptions  NULL = 按账号类型取默认：订阅专用 10 / 普通 80
--                      （订阅专用账号若被管理员显式设为 NULL，含义仍是「不限」——
--                        这一条由 subscription-run 判定，本迁移不改其语义）
--
-- 安全：
--   1) max_resources 与 max_subscriptions 一样属于「特权列」，纳入 guard 触发器，
--      普通用户不能自己改大额度；
--   2) 资源配额在数据层兜底：用户自己往自己名下插资源时按额度拦截
--      （后端 service_role 的订阅转存 / 批量导入不拦，避免打断自动化流程）。
-- ============================================================

-- ── 1. 新列 ──
alter table public.profiles add column if not exists max_resources int;

comment on column public.profiles.max_resources is '资源条数上限；NULL 或 <1 = 默认 200（管理员不受限）';
comment on column public.profiles.max_subscriptions is '订阅条数上限；NULL = 按账号类型取默认（订阅专用 10 / 普通 80）';

-- ── 2. 特权列保护：把 max_resources 一起纳入 ──
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
     and new.max_subscriptions is not distinct from old.max_subscriptions
     and new.max_resources is not distinct from old.max_resources
     and new.schedule_policy is not distinct from old.schedule_policy
     and new.can_resources is not distinct from old.can_resources
     and new.can_site_sync is not distinct from old.can_site_sync
     and new.can_shortlink is not distinct from old.can_shortlink
     and new.can_subscriptions is not distinct from old.can_subscriptions then
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

  raise exception '无权修改账号特权字段（角色 / 状态 / 会员到期 / 批量发帖 / 订阅权限 / 额度 / 调度策略 / 功能权限），请联系管理员';
end;
$$;

-- ── 3. 资源配额兜底：用户自己插自己名下资源时按额度拦截 ──
create or replace function public.enforce_resource_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_role  text;
  v_limit int;
  v_used  int;
begin
  -- 只拦「用户本人 → 自己名下」的插入：
  --   · 管理员、service_role（订阅转存 / 批量导入等后台流程，auth.uid() 为空）放行；
  --   · 管理端给他人建资源（owner_id ≠ 自己）也放行。
  if v_uid is null or new.owner_id is distinct from v_uid then
    return new;
  end if;

  select p.role::text, p.max_resources
    into v_role, v_limit
    from public.profiles p
   where p.id = v_uid;

  if v_role = 'admin' then
    return new;
  end if;

  if v_limit is null or v_limit < 1 then
    v_limit := 200;
  end if;

  select count(*) into v_used from public.resources where owner_id = v_uid;
  if v_used >= v_limit then
    raise exception '资源条数已达上限（% 条），请联系管理员调整额度', v_limit
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists resources_enforce_quota on public.resources;
create trigger resources_enforce_quota
  before insert on public.resources
  for each row execute function public.enforce_resource_quota();

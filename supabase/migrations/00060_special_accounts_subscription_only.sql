-- 特殊（订阅专用）账号：只能用订阅功能 —— 把这条限制从「仅前端路由」下沉到数据层。
--
-- 背景：subscription_only = true 的账号（特殊邀请码注册）此前只在 RouteGuard 与侧边栏被拦，
-- 数据层的四项功能开关仍是默认 true，导致：
--   ① 后台「功能权限」列把它们显示成「已开通」（状态与实际不符，容易被误解为已放开）；
--   ② 单点开关 / 批量开通 / 直接调接口都能把它们置为 true（前端虽然仍会拦，但库里状态是错的）。
--
-- 本迁移做三件事：
--   1) 一次性对齐：现有订阅专用账号的 资源 / 站点同步 / 短链 三项统一置 false；
--   2) 触发器守护：此后任何写入（后台单点开关、批量开通、API）对订阅专用账号都强制这三项为 false；
--   3) 权限漏洞补全：四项功能权限列（can_resources / can_site_sync / can_shortlink / can_subscriptions）
--      此前不在 guard_profile_privileged_columns 的保护名单里 ——
--      普通用户可在「自己的 profile」上自助开通这些功能（越权），一并纳入保护。

-- ── 1. 一次性对齐：订阅专用账号只保留「订阅」 ──
update public.profiles
   set can_resources = false,
       can_site_sync = false,
       can_shortlink = false
 where subscription_only = true
   and (can_resources or can_site_sync or can_shortlink);

-- ── 2. 触发器：订阅专用账号的三项功能恒为 false ──
-- 注意：不强制打开 can_subscriptions —— 特殊码注册时已开通，管理员仍可自行关闭。
create or replace function public.enforce_special_account_features()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.subscription_only is true then
    new.can_resources := false;
    new.can_site_sync := false;
    new.can_shortlink := false;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_enforce_special_features on public.profiles;
create trigger profiles_enforce_special_features
  before insert or update on public.profiles
  for each row execute function public.enforce_special_account_features();

-- ── 3. 特权列保护补全：把四项功能权限列也纳入（普通用户不得自行开通/关闭） ──
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

  raise exception '无权修改账号特权字段（角色 / 状态 / 会员到期 / 批量发帖 / 订阅权限 / 调度策略 / 功能权限），请联系管理员';
end;
$$;

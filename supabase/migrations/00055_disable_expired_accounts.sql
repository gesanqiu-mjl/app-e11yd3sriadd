-- 普通账号会员到期 → 直接禁用（disabled）
--
-- 语义：本项目的「禁用」= 登录即被拒（前端 AuthContext 登录/恢复会话时校验 profiles.status，
--       被禁用则立即登出并提示「该账号已被禁用，请联系管理员」）。
--
-- 规则：
--   * 只处理 role = 'user'（管理员不受影响）；
--   * membership_expires_at 已过期（<= now()）→ status = 'disabled'；
--   * membership_expires_at = NULL（永久，含特殊邀请码注册的账号）永不禁用；
--   * 到期时间可能精确到分钟，所以用定时任务每 5 分钟复查一次。
--
-- 恢复路径（避免「续了会员还是登不进去」）：
--   * 管理员把会员到期时间改到未来（或设为永久）时，前端同时把 status 置回 active；
--   * 消费邀请码（含注册流程）时也把 status 置回 active。

-- ── 1. 立即执行一次：把当前已过期的普通账号禁用 ──
update public.profiles
   set status = 'disabled'
 where role = 'user'
   and status <> 'disabled'
   and membership_expires_at is not null
   and membership_expires_at <= now();

-- ── 2. 定时任务：每 5 分钟复查 ──
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron 未启用，跳过定时任务创建（请按 README 手动创建）';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'disable-expired-accounts') then
    perform cron.unschedule('disable-expired-accounts');
  end if;

  perform cron.schedule(
    'disable-expired-accounts',
    '*/5 * * * *',
    $job$
      update public.profiles
         set status = 'disabled'
       where role = 'user'
         and status <> 'disabled'
         and membership_expires_at is not null
         and membership_expires_at <= now();
    $job$
  );
  raise notice '已创建定时任务 disable-expired-accounts（每 5 分钟）';
end
$cron$;

-- ── 3. 消费邀请码：视为「有效账号」，同时把 status 置回 active ──
--    （注册时 profiles 由 handle_new_user 建出，默认 membership_expires_at = now()，
--      在被邀请码授权前属于「已过期」；这里一并复活，避免刚注册就被定时任务禁用）
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
      -- 拿到邀请码即视为有效账号：到期被自动禁用的账号在这里复活
      status = 'active',
      subscription_only = v_special,
      max_subscriptions = case when v_special then 10 else max_subscriptions end,
      -- 特殊码注册出来的账号要能直接用订阅功能（只开订阅，不开别的）
      subscriptions_enabled = case when v_special then true else subscriptions_enabled end
  where id = v_target;

  return true;
end;
$$;

-- ============================================================
-- 与 Supabase 托管版对齐：订阅运行机制（自建部署专用）
-- 生成日期：2026-10-16
-- 依据：托管项目 ichmfsvdjfxkzduellsw 的 pg_get_functiondef / pg_trigger / cron.job
-- 覆盖内容：
--   ① 6 个缺失函数：norm_show_name / cleanup_finished_subscriptions /
--      apply_schedule_policy_to_subscriptions / enforce_subscription_schedule_policy /
--      enforce_special_account_inactivity / unfreeze_my_special_account
--   ② 4 个缺失触发器：profiles_apply_schedule_policy / subscriptions_enforce_schedule_policy /
--      subscriptions_enforce_folder_mode_pan / trg_guard_profile_privileged
--   ③ refresh_subscription_profiles 覆盖为托管版
--   ④ subscriptions.cred_fail_count 对齐为 NOT NULL DEFAULT 0
--   ⑤ cron 对齐：subscription-run-1min（?action=runAll + 5s 超时）、
--      resource-sync-worker-1min（?action=drain）、subscription-cleanup-finished(*/5)、
--      special-account-inactivity(0 20 * * *)
-- 说明：地址与密钥为自建部署值（kong:8000 + 本机密钥），**不要**应用到托管项目。
-- 注意：需以函数/表属主（supabase_admin）身份执行；自建环境请用 pg-meta 通道，
--       容器内 psql 的 postgres 用户会因属主不同报 must be owner。
-- ============================================================

-- ⚠️ pg_cron 1.6 的 cron.schedule(名字, …) 不会覆盖同名任务，而是新建一条；
-- 因此重建前必须先按名字清掉，否则每次应用都会多出一条、导致每分钟重复触发。
select cron.unschedule(jobid) from cron.job
 where jobname in ('subscription-run-1min', 'resource-sync-worker-1min',
                   'subscription-cleanup-finished', 'special-account-inactivity');


-- 与 Supabase 托管版对齐：订阅运行相关的缺失对象（函数 / 触发器 / cron）
-- 依据：托管项目 ichmfsvdjfxkzduellsw 的 pg_get_functiondef / pg_trigger / cron.job
-- 幂等：全部 create or replace + drop trigger if exists

-- ── ① 缺失函数 ────────────────────────────────────────────────
create or replace function public.norm_show_name(p_name text)
 returns text
 language sql
 immutable
as $function$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            lower(coalesce(p_name, '')),
            '\.[a-z0-9]{2,5}$', '', 'g'),
          '(更新至|更至|全|共)\s*[0-9]+\s*[集话話]', ' ', 'g'),
        '(第\s*[0-9]{1,4}\s*[集话話]|s[0-9]{1,2}[\s._-]*e[p]?[0-9]{1,3})', ' ', 'g'),
      '[^0-9a-z\u4e00-\u9fa5]', '', 'g'),
    '');
$function$;

create or replace function public.cleanup_finished_subscriptions()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_deleted int := 0;
begin
  with due as (
    select id, user_id, name, resource_id
      from public.subscriptions
     where delete_after is not null and delete_after < now()
  ),
  cascade as (
    select s.id
      from public.subscriptions s
      join due d on d.user_id = s.user_id and s.id <> d.id
     where s.delete_after is null
       and (
         s.name = d.name
         or (public.norm_show_name(s.name) is not null
             and public.norm_show_name(s.name) = public.norm_show_name(d.name))
         or (d.resource_id is not null and s.resource_id = d.resource_id)
       )
  ),
  victims as (
    select id from due
    union
    select id from cascade
  )
  delete from public.subscriptions where id in (select id from victims);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

create or replace function public.apply_schedule_policy_to_subscriptions()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if new.schedule_policy is distinct from old.schedule_policy then
    if new.schedule_policy = 'strict3' then
      update public.subscriptions
         set interval_minutes = 3, adaptive_enabled = false,
             schedule_policy = 'strict3', next_check_at = now()
       where user_id = new.id;
    elsif new.schedule_policy = 'day15_night60' then
      update public.subscriptions
         set interval_minutes = 15, adaptive_enabled = false,
             schedule_policy = 'day15_night60', next_check_at = now()
       where user_id = new.id;
    elsif new.schedule_policy = 'adaptive' then
      update public.subscriptions
         set adaptive_enabled = true, schedule_policy = 'adaptive'
       where user_id = new.id and adaptive_enabled = false;
    else
      update public.subscriptions set schedule_policy = null where user_id = new.id;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.enforce_subscription_schedule_policy()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_policy text;
begin
  select p.schedule_policy into v_policy from public.profiles p where p.id = new.user_id;
  new.schedule_policy := v_policy;
  if v_policy = 'strict3' then
    new.interval_minutes := 3;
    new.adaptive_enabled := false;
  elsif v_policy = 'adaptive' then
    new.adaptive_enabled := true;
  elsif v_policy = 'day15_night60' then
    -- 15 分钟是白天间隔；深夜 1 小时由引擎按北京时间动态判定（见 subscription-run 的 due 判定）
    new.interval_minutes := 15;
    new.adaptive_enabled := false;
  end if;
  return new;
end;
$function$;

create or replace function public.enforce_special_account_inactivity()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_disabled int := 0;
  v_frozen   int := 0;
  v_stopped  int := 0;
begin
  -- 候选：特殊激活码账号（schedule_policy = day15_night60 或 subscription_only），且未禁用
  -- 判定依据：最近一条转存记录（没有记录则退回账号创建时间）
  create temp table _cand on commit drop as
  select p.id,
         coalesce(
           (select max(t.transferred_at) from public.subscription_transferred t where t.user_id = p.id),
           p.created_at
         ) as last_active,
         p.created_at,
         p.frozen_at,
         p.disabled_at
  from public.profiles p
  where (p.schedule_policy = 'day15_night60' or p.subscription_only);

  -- ① 14 天 → 禁用
  with upd as (
    update public.profiles p
       set disabled_at = now(),
           frozen_reason = 'inactive14',
           frozen_at = coalesce(p.frozen_at, now())
      from _cand c
     where p.id = c.id
       and c.disabled_at is null
       and c.created_at < now() - interval '14 days'
       and c.last_active < now() - interval '14 days'
    returning p.id
  ), stopped as (
    update public.subscriptions s
       set enabled = false,
           paused_reason = 'inactive_freeze',
           next_check_at = null
      from upd u
     where s.user_id = u.id and s.enabled
    returning s.id
  )
  select (select count(*) from upd), (select count(*) from stopped) into v_disabled, v_stopped;
  v_frozen := 0;

  -- ② 7 天 → 冻结（已禁用的不再处理）
  with upd as (
    update public.profiles p
       set frozen_at = now(),
           frozen_reason = 'inactive7'
      from _cand c
     where p.id = c.id
       and c.disabled_at is null
       and c.frozen_at is null
       and c.created_at < now() - interval '7 days'
       and c.last_active < now() - interval '7 days'
    returning p.id
  ), stopped2 as (
    update public.subscriptions s
       set enabled = false,
           paused_reason = 'inactive_freeze',
           next_check_at = null
      from upd u
     where s.user_id = u.id and s.enabled
    returning s.id
  )
  select (select count(*) from upd), (select count(*) from stopped2) into v_frozen, v_stopped;

  return jsonb_build_object('disabled', v_disabled, 'frozen', v_frozen, 'stopped_subscriptions', v_stopped);
end $function$;

create or replace function public.unfreeze_my_special_account()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_restored int := 0;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'message', '未登录');
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found then
    return jsonb_build_object('ok', false, 'message', '账号不存在');
  end if;
  if v_profile.disabled_at is not null then
    return jsonb_build_object('ok', false, 'message', '账号已被禁用（14 天无转存），无法自助解冻，请联系管理员');
  end if;
  if v_profile.frozen_at is null then
    return jsonb_build_object('ok', false, 'message', '账号当前未被冻结');
  end if;
  if coalesce(v_profile.unfreeze_used, false) then
    return jsonb_build_object('ok', false, 'message', '解冻机会已使用过（每人仅一次）');
  end if;

  update public.profiles
     set frozen_at = null,
         frozen_reason = null,
         unfreeze_used = true
   where id = v_uid;

  update public.subscriptions
     set enabled = true,
         paused_reason = null,
         next_check_at = now()
   where user_id = v_uid
     and paused_reason = 'inactive_freeze';
  get diagnostics v_restored = row_count;

  return jsonb_build_object(
    'ok', true,
    'restored', v_restored,
    'message', format('解冻成功，已恢复 %s 个订阅的检测（解冻机会已用完）', v_restored)
  );
end $function$;

-- ── ② 覆盖为托管版：自适应画像刷新 ────────────────────────────
create or replace function public.refresh_subscription_profiles(p_days integer default 30)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_days    int := greatest(1, least(coalesce(p_days, 30), 180));
  v_updated int := 0;
begin
  with batches as (
    select distinct
           t.subscription_id as sub_id,
           date_trunc('minute', t.transferred_at) as batch_min,
           extract(hour from (t.transferred_at at time zone 'Asia/Shanghai'))::int as hour_bj
    from public.subscription_transferred t
    where t.transferred_at > now() - make_interval(days => v_days)
  ),
  base as (
    select b.sub_id, count(*)::int as batches, max(b.batch_min) as last_found_recent
    from batches b
    group by b.sub_id
  ),
  per_hour as (
    select b.sub_id, b.hour_bj, count(*)::int as n
    from batches b
    group by 1, 2
  ),
  ranked as (
    select p.sub_id, p.hour_bj, p.n,
           sum(p.n) over (partition by p.sub_id) as total,
           sum(p.n) over (partition by p.sub_id order by p.n desc, p.hour_bj asc
                          rows between unbounded preceding and current row) as cum
    from per_hour p
  ),
  hot as (
    select r.sub_id, (array_agg(r.hour_bj order by r.hour_bj))[1:6] as hours
    from ranked r
    where r.cum - r.n < 0.8 * r.total
    group by r.sub_id
  ),
  batch_gaps as (
    select b.sub_id,
           extract(epoch from (b.batch_min - lag(b.batch_min) over (partition by b.sub_id order by b.batch_min))) / 60.0 as gap_min
    from batches b
  ),
  gaps as (
    select g.sub_id, percentile_cont(0.5) within group (order by g.gap_min) as gap_min
    from batch_gaps g
    where g.gap_min is not null
    group by g.sub_id
  ),
  merged as (
    select base.sub_id,
           base.batches,
           greatest(base.last_found_recent,
                    coalesce((select max(t.transferred_at) from public.subscription_transferred t
                               where t.subscription_id = base.sub_id), base.last_found_recent)) as last_found,
           coalesce((select jsonb_object_agg(p.hour_bj, p.n) from per_hour p where p.sub_id = base.sub_id), '{}'::jsonb) as hour_counts,
           g.gap_min,
           h.hours
    from base
    left join gaps g on g.sub_id = base.sub_id
    left join hot h on h.sub_id = base.sub_id
  )
  update public.subscriptions s
     set update_hours = case
           when m.batches >= 4 and m.hours is not null
             then (select array_agg(x::smallint order by x) from unnest(m.hours) as x)
           else null
         end,
         update_profile = jsonb_build_object(
           'batches',       m.batches,
           'hours',         m.hour_counts,
           'gap_min',       case when m.gap_min is null then null else round(m.gap_min::numeric, 1) end,
           'last_found_at', m.last_found,
           'computed_at',   now()
         ),
         last_found_at = m.last_found
    from merged m
   where s.id = m.sub_id
     and s.enabled;

  get diagnostics v_updated = row_count;

  update public.subscriptions s
     set update_hours = null,
         update_profile = jsonb_build_object(
           'batches', 0,
           'hours', '{}'::jsonb,
           'computed_at', now()
         ),
         last_found_at = (select max(t.transferred_at) from public.subscription_transferred t
                           where t.subscription_id = s.id)
   where s.enabled
     and not exists (select 1 from public.subscription_transferred t
                      where t.subscription_id = s.id
                        and t.transferred_at > now() - make_interval(days => v_days));

  return v_updated;
end;
$function$;

-- ── ③ 缺失触发器（托管版有、自部署版没有）────────────────────
drop trigger if exists profiles_apply_schedule_policy on public.profiles;
create trigger profiles_apply_schedule_policy
  after update on public.profiles
  for each row execute function public.apply_schedule_policy_to_subscriptions();

drop trigger if exists subscriptions_enforce_schedule_policy on public.subscriptions;
create trigger subscriptions_enforce_schedule_policy
  before insert or update on public.subscriptions
  for each row execute function public.enforce_subscription_schedule_policy();

drop trigger if exists subscriptions_enforce_folder_mode_pan on public.subscriptions;
create trigger subscriptions_enforce_folder_mode_pan
  before insert or update on public.subscriptions
  for each row execute function public.enforce_folder_mode_pan();

drop trigger if exists trg_guard_profile_privileged on public.profiles;
create trigger trg_guard_profile_privileged
  before update on public.profiles
  for each row execute function public.guard_profile_privileged_columns();


-- 用托管版覆盖 refresh_subscription_profiles（需以函数属主身份执行，故走 pg-meta/supabase_admin）
create or replace function public.refresh_subscription_profiles(p_days integer default 30)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_days    int := greatest(1, least(coalesce(p_days, 30), 180));
  v_updated int := 0;
begin
  with batches as (
    select distinct
           t.subscription_id as sub_id,
           date_trunc('minute', t.transferred_at) as batch_min,
           extract(hour from (t.transferred_at at time zone 'Asia/Shanghai'))::int as hour_bj
    from public.subscription_transferred t
    where t.transferred_at > now() - make_interval(days => v_days)
  ),
  base as (
    select b.sub_id, count(*)::int as batches, max(b.batch_min) as last_found_recent
    from batches b
    group by b.sub_id
  ),
  per_hour as (
    select b.sub_id, b.hour_bj, count(*)::int as n
    from batches b
    group by 1, 2
  ),
  ranked as (
    select p.sub_id, p.hour_bj, p.n,
           sum(p.n) over (partition by p.sub_id) as total,
           sum(p.n) over (partition by p.sub_id order by p.n desc, p.hour_bj asc
                          rows between unbounded preceding and current row) as cum
    from per_hour p
  ),
  hot as (
    select r.sub_id, (array_agg(r.hour_bj order by r.hour_bj))[1:6] as hours
    from ranked r
    where r.cum - r.n < 0.8 * r.total
    group by r.sub_id
  ),
  batch_gaps as (
    select b.sub_id,
           extract(epoch from (b.batch_min - lag(b.batch_min) over (partition by b.sub_id order by b.batch_min))) / 60.0 as gap_min
    from batches b
  ),
  gaps as (
    select g.sub_id, percentile_cont(0.5) within group (order by g.gap_min) as gap_min
    from batch_gaps g
    where g.gap_min is not null
    group by g.sub_id
  ),
  merged as (
    select base.sub_id,
           base.batches,
           greatest(base.last_found_recent,
                    coalesce((select max(t.transferred_at) from public.subscription_transferred t
                               where t.subscription_id = base.sub_id), base.last_found_recent)) as last_found,
           coalesce((select jsonb_object_agg(p.hour_bj, p.n) from per_hour p where p.sub_id = base.sub_id), '{}'::jsonb) as hour_counts,
           g.gap_min,
           h.hours
    from base
    left join gaps g on g.sub_id = base.sub_id
    left join hot h on h.sub_id = base.sub_id
  )
  update public.subscriptions s
     set update_hours = case
           when m.batches >= 4 and m.hours is not null
             then (select array_agg(x::smallint order by x) from unnest(m.hours) as x)
           else null
         end,
         update_profile = jsonb_build_object(
           'batches',       m.batches,
           'hours',         m.hour_counts,
           'gap_min',       case when m.gap_min is null then null else round(m.gap_min::numeric, 1) end,
           'last_found_at', m.last_found,
           'computed_at',   now()
         ),
         last_found_at = m.last_found
    from merged m
   where s.id = m.sub_id
     and s.enabled;

  get diagnostics v_updated = row_count;

  update public.subscriptions s
     set update_hours = null,
         update_profile = jsonb_build_object(
           'batches', 0,
           'hours', '{}'::jsonb,
           'computed_at', now()
         ),
         last_found_at = (select max(t.transferred_at) from public.subscription_transferred t
                           where t.subscription_id = s.id)
   where s.enabled
     and not exists (select 1 from public.subscription_transferred t
                      where t.subscription_id = s.id
                        and t.transferred_at > now() - make_interval(days => v_days));

  return v_updated;
end;
$function$;

-- 让 subscriptions.cred_fail_count 与托管版一致：NOT NULL + default 0（需表属主身份 → 走 pg-meta）
alter table public.subscriptions alter column cred_fail_count set default 0;
alter table public.subscriptions alter column cred_fail_count set not null;

-- 与托管版一致：恢复 pg_net 5s 客户端超时（远程 55s 实验无收益，且托管版就是 5000）
select cron.schedule('subscription-run-1min', '* * * * *', $cmd$
  select net.http_post(
    url := 'http://kong:8000/functions/v1/subscription-run?action=runAll',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-subscription-secret', 'd56660fbb4ed8ba66bd69fa4570a18e9419e55a9874daded'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
$cmd$);

-- 其余 3 个 cron（订阅清理 + 特殊账号冻结 + 资源同步），与托管版一致
select cron.schedule('subscription-cleanup-finished', '*/5 * * * *',
                     'select public.cleanup_finished_subscriptions()');
select cron.schedule('special-account-inactivity', '0 20 * * *',
                     ' select public.enforce_special_account_inactivity(); ');

-- 资源同步 cron：对齐托管版的 ?action=drain 调用形态
select cron.schedule('resource-sync-worker-1min', '* * * * *', $cmd$
  select net.http_post(
    url := 'http://kong:8000/functions/v1/resource-sync-worker?action=drain',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', 'e3cefc3e50fb446e05daba45277daa705540d21c6c7ada52'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
$cmd$);

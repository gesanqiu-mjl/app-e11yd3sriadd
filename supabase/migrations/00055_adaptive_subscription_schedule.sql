-- 订阅「智能检测」（自适应调度）
--
-- 背景：每部剧一天通常只更新一次，却按固定间隔全天候轮询 —— 实测 195 个订阅
--       每天跑 37,152 次检查，而真正抓到更新的只有 60.7 批（约 612 次检查换来 1 次更新）。
-- 思路：从历史入库时间（subscription_transferred）学出每部剧的「典型更新时段」，据此
--       · 临近预期时段（±1 小时）→ 加密到 5 分钟，出通知更快；
--       · 其余白天时段 → 放宽到 4 倍间隔（下限 1 小时，上限 2 小时）；
--       · 深夜（北京时间 0-7 点，实测 7 天只有 3 个文件）→ 放宽到 8 倍（上限 4 小时）；
--       · 长期零更新（>7 天）→ 每天 1 次；
--       · 兜底：距上次有新增超过 max(36 小时, 1.5×平常间隔) → 加密到 1 小时内，防历史规律失效漏更。
-- 说明：调度判定与「下次检查时间」的计算在 Edge 函数（subscription-run）里，本迁移只负责
--       字段、画像计算与定时刷新，保证「一个真值来源」。

-- ── 1. 字段 ──
alter table public.subscriptions
  add column if not exists adaptive_enabled    boolean not null default true,
  add column if not exists next_check_at       timestamptz,
  add column if not exists update_hours        smallint[],
  add column if not exists update_profile      jsonb not null default '{}'::jsonb,
  add column if not exists checks_since_update int not null default 0,
  add column if not exists last_found_at       timestamptz;

comment on column public.subscriptions.adaptive_enabled is
  '智能检测（自适应调度）：开启后按学习到的更新时段加密/放宽检查；关闭则严格按 interval_minutes';
comment on column public.subscriptions.next_check_at is
  '下次检查时间（智能检测开启时生效）；由 subscription-run 每次执行结束时按画像重算';
comment on column public.subscriptions.update_hours is
  '学习到的典型更新时段（北京时间小时，0-23）；null = 样本不足（冷启动，按 interval_minutes 跑）';
comment on column public.subscriptions.update_profile is
  '{batches,hours,gap_min,last_found_at,computed_at}：更新画像原始数据，用于界面展示与调试';
comment on column public.subscriptions.checks_since_update is
  '连续多少次检查没抓到新增（抓到即清零）：界面展示用，也是退避判定的输入';
comment on column public.subscriptions.last_found_at is
  '最近一次「抓到新增文件」的时间（全历史）；用于兜底与长期零更新降频';

create index if not exists idx_subscriptions_next_check
  on public.subscriptions (enabled, next_check_at);

-- ── 2. 画像学习：从入库记录统计每部剧的更新时段 ──
-- 一次转存多个文件时 transferred_at 完全相同 → 先按分钟聚成「批次」，再统计小时分布，
-- 否则「一批 25 个文件」会让某个小时被误判为高频。
create or replace function public.refresh_subscription_profiles(p_days int default 30)
returns int
language plpgsql
security definer
set search_path = public
as $$
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
    -- 覆盖累计 80% 的主要时段（按批次占比，最多不超过 6 个小时）
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

  -- 窗口内没有入库记录的订阅：清空「时段画像」（回到冷启动），但保留全历史的 last_found_at
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
     and not exists (select 1 from subscription_transferred t
                      where t.subscription_id = s.id
                        and t.transferred_at > now() - make_interval(days => v_days));

  return v_updated;
end;
$$;

comment on function public.refresh_subscription_profiles(int) is
  '刷新每部剧的更新画像（update_hours / update_profile / last_found_at）：每小时由 pg_cron 调用';

revoke all on function public.refresh_subscription_profiles(int) from public;
grant execute on function public.refresh_subscription_profiles(int) to service_role;

-- ── 3. 立即算一次（新老订阅都先拿到画像） ──
select public.refresh_subscription_profiles(30);

-- ── 4. 每小时刷新一次画像（偏差 17 分，避开整点高峰） ──
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron 未启用，跳过定时任务创建';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'refresh-subscription-profiles') then
    perform cron.unschedule('refresh-subscription-profiles');
  end if;

  perform cron.schedule(
    'refresh-subscription-profiles',
    '17 * * * *',
    'select public.refresh_subscription_profiles(30)'
  );
end
$cron$;

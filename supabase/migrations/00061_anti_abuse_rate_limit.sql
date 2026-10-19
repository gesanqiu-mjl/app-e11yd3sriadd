-- 短链 / 开放接口的防滥用（限流计数桶 + 点击明细保留期）
--
-- 背景：短链函数（functions/go）是**公开无鉴权**的，被恶意疯狂访问时有两个致命点：
--   ① 每次点击都写一条 short_link_clicks（写放大 → 直接压数据库）；
--   ② 点击明细无上限增长 → 表越来越大，最终查询/写入都变慢。
-- 这里提供「原子限流计数」与「保留期清理」两块基础设施，函数侧据此决定
-- 「本次点击是否记账」（被限流时仍然正常跳转，只是不记明细 —— 用户无感、攻击无效）。

-- ── 1. 限流计数桶 ──
create table if not exists public.rate_limit_counters (
  bucket       text primary key,
  window_start timestamptz not null default now(),
  hits         integer not null default 0
);
comment on table public.rate_limit_counters is
  '限流计数桶：bucket 如 code:<短码> / global / apikey:<id>；由 rate_limit_hit 原子累加';

alter table public.rate_limit_counters enable row level security;
-- 只给服务端用：不建任何策略（默认拒绝），前端与匿名用户读不到也写不了
grant select, insert, update, delete on public.rate_limit_counters to service_role;

-- ── 2. 原子限流：单条 UPSERT 完成「开窗 / 累加 / 判定」，并发安全（行锁）──
create or replace function public.rate_limit_hit(
  p_bucket        text,
  p_window_seconds integer,
  p_limit         integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window integer := greatest(1, coalesce(p_window_seconds, 60));
  v_hits   integer;
begin
  insert into public.rate_limit_counters (bucket, window_start, hits)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update
     set hits = case
                  when public.rate_limit_counters.window_start < now() - make_interval(secs => v_window)
                    then 1
                  else public.rate_limit_counters.hits + 1
                end,
         window_start = case
                  when public.rate_limit_counters.window_start < now() - make_interval(secs => v_window)
                    then now()
                  else public.rate_limit_counters.window_start
                end
  returning public.rate_limit_counters.hits into v_hits;

  -- true = 未超限（放行）；false = 已超限（调用方应停止记账/限流）
  return v_hits <= greatest(1, coalesce(p_limit, 60));
end;
$$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- ── 3. 点击明细：加索引 + 只保留 90 天 ──
create index if not exists idx_short_link_clicks_clicked_at
  on public.short_link_clicks (clicked_at);

create or replace function public.cleanup_short_link_noise()
returns void
language sql
security definer
set search_path = public
as $$
  -- 计数桶：超过 1 小时没动过的直接删（桶数量因此有界，不会被刷爆）
  delete from public.rate_limit_counters where window_start < now() - interval '1 hour';
  -- 点击明细：只保留 90 天（统计看板本身就是按天/渠道聚合，历史明细留着没用）
  delete from public.short_link_clicks where clicked_at < now() - interval '90 days';
$$;

revoke all on function public.cleanup_short_link_noise() from public;
grant execute on function public.cleanup_short_link_noise() to service_role;

-- ── 4. 每小时清理一次（偏差 23 分，避开整点高峰）──
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron 未启用，跳过定时任务创建';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'cleanup-short-link-noise') then
    perform cron.unschedule('cleanup-short-link-noise');
  end if;

  perform cron.schedule(
    'cleanup-short-link-noise',
    '23 * * * *',
    'select public.cleanup_short_link_noise()'
  );
end
$cron$;

-- 立即跑一次，把存量噪音清掉
select public.cleanup_short_link_noise();

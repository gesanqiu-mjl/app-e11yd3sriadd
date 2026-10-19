-- 订阅调度：单轮互斥 + 轮转公平（解决「订阅多、间隔 1 分钟」时的饿死问题）
--
-- 背景（实测）：gesanqiu 152 个订阅全设 1 分钟，而光鸭请求必须排队经过数据库代理
--   （pg_net 单工作线程，实测上限约 250 请求/分钟）。旧的 runAll 每轮都从
--   `select ... where enabled` 的**无排序**结果里顺次跑，一轮跑不完就在 600s 被平台杀掉，
--   下一分钟又从同一批头部重来 → 头部反复跑、尾部饿死（实测最久 30 小时没执行过）。
--
-- 现在加两件事：
--   1) 单轮互斥：一次只允许一轮在跑，避免每分钟新起一轮、几十个订阅同时抢代理；
--      · claim_subscription_round() 抢锁（CAS）；跑的过程中由 Edge 侧每分钟
--        touch_subscription_round() 续期（心跳）；跑完 finish_subscription_round() 释放；
--      · 若函数被平台中途杀掉，心跳停止 → 超过 p_stale_seconds 后锁自动失效，下一分钟可接管。
--   2) 轮转公平：Edge 侧改为「按 last_run_at 升序（最久没跑的优先）+ 每轮限量限时」取订阅，
--      跑不完留给下一轮，从而每个订阅都能稳定轮到。

create table if not exists public.subscription_run_state (
  id               int primary key default 1 check (id = 1),
  round_started_at timestamptz,
  last_finished_at timestamptz,
  last_ran         int not null default 0,
  last_due         int not null default 0,
  last_note        text,
  updated_at       timestamptz not null default now()
);

comment on table public.subscription_run_state is
  '订阅调度状态（单行）：round_started_at 非空表示有一轮正在跑；updated_at 为心跳时间，用于判断锁是否失效';

insert into public.subscription_run_state (id) values (1) on conflict (id) do nothing;

alter table public.subscription_run_state enable row level security;
-- 只给服务端（service_role）用：不建任何 authenticated 策略（默认拒绝），前端无需读取
grant select, insert, update on public.subscription_run_state to service_role;

-- ── 抢锁：成功返回 true（可以开始这一轮）──
create or replace function public.claim_subscription_round(p_stale_seconds integer default 120)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  insert into public.subscription_run_state (id) values (1) on conflict (id) do nothing;

  update public.subscription_run_state
     set round_started_at = now(),
         updated_at = now()
   where id = 1
     and (
       round_started_at is null
       -- 心跳停了（函数被平台杀掉）→ 超过阈值视为锁失效，允许新一轮接管
       or updated_at < now() - make_interval(secs => greatest(30, coalesce(p_stale_seconds, 120)))
     )
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

-- ── 心跳：跑的过程中定期续期，证明「这一轮还活着」──
create or replace function public.touch_subscription_round()
returns void
language sql
security definer
set search_path = public
as $$
  update public.subscription_run_state
     set updated_at = now()
   where id = 1 and round_started_at is not null;
$$;

-- ── 释放：本轮结束（正常结束 / 达到本轮上限）──
create or replace function public.finish_subscription_round(
  p_ran integer default 0,
  p_due integer default 0,
  p_note text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.subscription_run_state
     set round_started_at = null,
         last_finished_at = now(),
         last_ran = coalesce(p_ran, 0),
         last_due = coalesce(p_due, 0),
         last_note = p_note,
         updated_at = now()
   where id = 1;
$$;

revoke all on function public.claim_subscription_round(integer) from public;
revoke all on function public.touch_subscription_round() from public;
revoke all on function public.finish_subscription_round(integer, integer, text) from public;
grant execute on function public.claim_subscription_round(integer) to service_role;
grant execute on function public.touch_subscription_round() to service_role;
grant execute on function public.finish_subscription_round(integer, integer, text) to service_role;

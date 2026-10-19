-- 移除 OpenList 管理功能：清理定时任务 + 删除全部相关数据表
--
-- 背景：OpenList 管理功能已从产品中下线，相关代码与边缘函数（openlist-proxy /
--       openlist-watch / _shared/openlist.ts）均已删除。数据库侧还需清理：
--       1) pg_cron 定时任务（原本每分钟调用已删除的 openlist-watch，会持续刷失败日志）
--       2) OpenList 的 4 张业务表
--       3) pg_net 中遗留的对 openlist-watch 的排队请求
--
-- 注意：本脚本会删除 OpenList 的历史数据，且不可恢复。确认不再需要后执行。

-- 1. 取消定时任务（按任务名或命令内容匹配，兼容不同命名），并清掉其执行历史
do $$
declare
  jid bigint;
begin
  for jid in
    select jobid
    from cron.job
    where jobname like '%openlist%'
       or command like '%openlist%'
  loop
    delete from cron.job_run_details where jobid = jid;
    perform cron.unschedule(jid);
    raise notice '已取消 OpenList 定时任务 jobid=%', jid;
  end loop;
end $$;

-- 2. 删除 OpenList 业务表（cascade 兼容潜在的外键引用）
drop table if exists public.openlist_watch_rules cascade;
drop table if exists public.openlist_sync_tasks cascade;
drop table if exists public.openlist_credentials cascade;
drop table if exists public.openlist_instances cascade;

-- 3. 清理 pg_net 中遗留的对 openlist-watch 的排队请求（若有）
do $$
begin
  if to_regclass('net.http_request_queue') is not null then
    delete from net.http_request_queue where url like '%openlist%';
  end if;
end $$;

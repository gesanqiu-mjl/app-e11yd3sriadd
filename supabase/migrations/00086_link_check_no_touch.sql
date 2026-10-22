-- 链接检测回写时不要刷新 updated_at
--
-- 背景：check-links 检测到结果后会把 link_status / link_checked_at / links 写回
--       resources。这原本会触发 resources_updated_at 把 updated_at 刷成 now()，
--       而外部「自动推送」是通过 resource-api 的 since= 增量拉取
--       （q.gte("updated_at", since)）来判断资源是否更新的，
--       结果每次「点击链接检测」都会被误判为资源更新、把资源推送到群里。
--
-- 做法：检测结果照常落库（有价值、刷新后仍在），但这次写库不刷新 updated_at。
--       区分「内容真的变了」和「只是做了一次检测」——只有前者才该触发推送。

-- ── 1) updated_at 触发器支持「本次不刷新」────────────────────
-- 用事务级会话变量做开关：由下面的 apply_link_check 在同一事务里设置，
-- 因此本次 UPDATE 语句自身、以及它连带触发的其它写库
-- （例如 resources_auto_short_links 短链回写）都不会刷新 updated_at。
create or replace function public.update_updated_at()
returns trigger
language plpgsql
as $$
begin
  if current_setting('app.skip_touch_updated_at', true) = 'on' then
    new.updated_at = old.updated_at;
    return new;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.update_updated_at() is
  '维护 resources.updated_at；会话变量 app.skip_touch_updated_at=on 时保留原值（链接检测等纯状态回写用）';

-- ── 2) 链接检测结果回写入口 ──────────────────────────────────
-- 必须是单个函数内完成「设变量 + 写库」：PostgREST 每个请求是独立事务，
-- 分开两次调用的话会话变量不会跨请求保留。
create or replace function public.apply_link_check(
  p_id uuid,
  p_links jsonb,
  p_link_status text,
  p_link_checked_at timestamptz
)
returns void
language plpgsql
as $$
begin
  perform set_config('app.skip_touch_updated_at', 'on', true);
  update public.resources
     set links = p_links,
         link_status = p_link_status,
         link_checked_at = p_link_checked_at
   where id = p_id;
end;
$$;

comment on function public.apply_link_check(uuid, jsonb, text, timestamptz) is
  '回写链接检测结果（不刷新 updated_at，避免外部按 updated_at 增量的推送误判）';
-- ============================================================
-- 绑定站点即自动补推
--
-- 背景：resource-sync-worker 现在「无绑定站点时也写 synced_episode_count」（避免闸门反复入队）。
-- 这带来一个新问题：用户**之后**才把资源绑定到某个站点时，闸门认为「站点不落后」，
-- 那个站点就拿不到当前集数（只能手动点「同步到站点」）。
--
-- 这里用触发器补上：任何一张站点绑定表新增/更新绑定时，自动登记一条待推送任务
-- （resource_sync_queue 对 resource_id 唯一，重复绑定只会刷新同一条任务）。
-- worker 每分钟执行，会把资源当前的名称/集数/链接推到该站点。
-- ============================================================

create or replace function public.enqueue_sync_on_binding()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_name text;
begin
  select r.owner_id, r.name into v_owner, v_name
    from public.resources r
   where r.id = new.resource_id;

  -- 资源不存在（或已删）→ 不登记
  if v_owner is null then
    return new;
  end if;

  insert into public.resource_sync_queue (user_id, resource_id, resource_name, reason, created_at, attempts, claimed_at, last_error)
  values (v_owner, new.resource_id, coalesce(v_name, ''), '新绑定站点：自动补推当前内容', now(), 0, null, null)
  on conflict (resource_id) do update
    set reason = excluded.reason,
        resource_name = excluded.resource_name,
        created_at = now(),
        attempts = 0,
        claimed_at = null,
        last_error = null;

  return new;
end;
$$;

-- 为所有站点绑定表挂上触发器（已存在则跳过）
do $$
declare
  t text;
  tables text[] := array[
    'resource_bindings',            -- 盘链
    'xn_resource_bindings',         -- 观影片库
    'ya_resource_bindings',         -- 鸭影臻藏
    'framehdr_resource_bindings',   -- 帧影
    'panfx_resource_bindings',      -- 123社区
    'mukaku_resource_bindings',     -- 不太灵
    'jying_resource_bindings',      -- 聚影
    'hdhaven_resource_bindings',    -- 栖影
    'st1_resource_bindings'         -- 1号站点
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then
      continue;  -- 该绑定表不存在（站点未接入）→ 跳过
    end if;
    if not exists (
      select 1 from pg_trigger where tgname = 'enqueue_sync_' || t and tgrelid = to_regclass('public.' || t)
    ) then
      execute format(
        'create trigger %I after insert or update on public.%I for each row execute function public.enqueue_sync_on_binding()',
        'enqueue_sync_' || t, t
      );
    end if;
  end loop;
end $$;

comment on function public.enqueue_sync_on_binding() is
  '站点绑定表发生新增/变更时，自动登记一条「待推送站点」任务，保证新绑定的站点也能收到当前内容';

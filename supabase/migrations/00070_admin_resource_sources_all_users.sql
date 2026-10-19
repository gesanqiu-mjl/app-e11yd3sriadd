-- 内置订阅源对**所有登录账号**开放
--
-- 背景：admin_resource_sources() 原先只放行「管理员」与「订阅专用（特殊邀请码注册）」账号
--       （00054 里有意为之：不暴露他人资源）。但「订阅页 → 新建/编辑订阅 → 内置订阅源」这个入口
--       前端是**给所有账号**都留着的（普通账号打开弹窗也会拉一次资源库链接），
--       于是普通账号点进去只能看到「管理员目前没有『更新中』的资源」——看起来就是「内置订阅源不展示了」。
--
-- 现在的规则（本次调整）：
--   * 只要**已登录**（auth.uid() 非空）就能读管理员「更新中」资源的分享链接；
--     未登录（anon）拿不到（函数 execute 权限本来也只给了 authenticated / service_role）。
--   * 普通账号读到后可直接订阅这些链接：saveSubscription 的订阅源白名单只对「订阅专用」账号硬校验，
--     所以这里放开读取不会绕过任何写入校验。
--   * 其余逻辑（只取 is_finished = false、一个资源多链接返回多行、按 url 去重）与 00054 完全一致。
--
-- 注意：只在下方守卫处与函数注释上做了改动，查询体保持原样，避免与 00054 产生行为差异。

create or replace function public.admin_resource_sources()
returns table (
  resource_id   uuid,
  name          text,
  episode_count int,
  pan           text,
  url           text,
  link_status   text,
  is_finished   boolean,
  updated_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- 仅要求「已登录」：管理员、订阅专用账号、普通账号都能看到管理员「更新中」的资源链接
  if auth.uid() is null then
    return;
  end if;

  return query
  select distinct on (lower(btrim(l.value ->> 'url')))
    r.id,
    r.name,
    coalesce(r.episode_count, 0),
    case
      when coalesce(l.value ->> 'pan_name', '') like '%夸克%'
        or coalesce(l.value ->> 'url', '') ~* '(pan\.quark\.cn|drive\.uc\.cn)' then 'quark'
      when coalesce(l.value ->> 'pan_name', '') like '%光鸭%'
        or coalesce(l.value ->> 'url', '') ~* 'guangyapan\.com' then 'guangya'
      else 'guangya'
    end,
    btrim(l.value ->> 'url'),
    coalesce(nullif(l.value ->> 'status', ''), 'unknown'),
    coalesce(r.is_finished, false),
    r.updated_at
  from public.resources r
  join public.profiles p on p.id = r.owner_id and p.role = 'admin'
  cross join lateral jsonb_array_elements(coalesce(r.links, '[]'::jsonb)) as l(value)
  where coalesce(r.is_finished, false) = false          -- 只取「更新中」的资源
    and coalesce(btrim(l.value ->> 'url'), '') <> ''
  order by lower(btrim(l.value ->> 'url'));
end;
$$;

comment on function public.admin_resource_sources() is
  '管理员「更新中」资源的网盘分享链接（一个资源可返回多行：光鸭 + 夸克）；**所有已登录账号**可读（未登录返回空）';

revoke all on function public.admin_resource_sources() from public;
grant execute on function public.admin_resource_sources() to authenticated, service_role;

-- 自检：函数定义里应该只剩 auth.uid() is null 这一层守卫
select pg_get_functiondef('public.admin_resource_sources()'::regprocedure) ~ 'auth\.uid\(\) is null' as guard_relaxed;

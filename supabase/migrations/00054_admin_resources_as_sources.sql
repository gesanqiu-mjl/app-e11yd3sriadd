-- 把管理员「资源管理」里的资源直接当订阅源用
--
-- 背景：管理员在「资源管理」里维护了整库剧集（每个资源带若干网盘分享链接，常见「光鸭 + 夸克」两条），
--       受限（特殊邀请码注册的「订阅专用」）账号在「订阅转存」里要能直接挑这些资源来追更，
--       不用管理员再去「订阅源」里手工粘贴一遍链接。
--
-- 规则：
--   * 只有 **更新中**（is_finished = false）的管理员资源会出现在可选列表里；
--   * 同一资源有光鸭 + 夸克两条链接时，返回两行 → 前端让用户自己选（跨盘不能转存，用户按自己绑定的网盘挑）；
--   * 白名单（后端 saveSubscription 用）放宽为「管理员资源里的任意链接」，这样资源完结后
--     已存在的订阅仍能正常编辑保存，不会因为资源下架/完结而卡住用户。
--
-- 1) admin_resource_sources()   —— 受限账号/管理员读取可选资源链接（含链接有效性，供界面标注失效）
-- 2) is_admin_resource_url(txt) —— 给 Edge Function 做白名单判定（service_role 调用）

-- ── 1. 可选资源链接（仅管理员与「订阅专用」账号可读） ──
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
  -- 只放给管理员本人与「订阅专用」账号；其它登录用户拿到空列表（不暴露他人资源）
  if not exists (
    select 1 from public.profiles c
    where c.id = auth.uid()
      and (c.role = 'admin' or c.subscription_only = true)
  ) then
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
  '管理员「更新中」资源的网盘分享链接（一个资源可返回多行：光鸭 + 夸克）；仅管理员与订阅专用账号可读';

revoke all on function public.admin_resource_sources() from public;
grant execute on function public.admin_resource_sources() to authenticated, service_role;

-- ── 2. 白名单判定：这个分享链接是不是管理员资源里的链接 ──
create or replace function public.is_admin_resource_url(p_url text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.resources r
    join public.profiles p on p.id = r.owner_id and p.role = 'admin'
    cross join lateral jsonb_array_elements(coalesce(r.links, '[]'::jsonb)) as l(value)
    where coalesce(btrim(l.value ->> 'url'), '') <> ''
      and regexp_replace(lower(btrim(l.value ->> 'url')), '/+$', '')
        = regexp_replace(lower(btrim(coalesce(p_url, ''))), '/+$', '')
  );
$$;

comment on function public.is_admin_resource_url(text) is
  '分享链接是否属于管理员资源管理里的资源（含已完结资源：保证老订阅仍可编辑保存）';

revoke all on function public.is_admin_resource_url(text) from public;
grant execute on function public.is_admin_resource_url(text) to authenticated, service_role;

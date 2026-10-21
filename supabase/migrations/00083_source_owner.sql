-- ============================================================
-- 源主（Source Owner）功能
--
-- 目标：
--   1. 用户在个人中心申请成为源主，管理员审核（通过 / 驳回 / 撤销）
--   2. 通过的源主，其「更新中」资源出现在内置订阅源中供他人订阅
--   3. 订阅源里按源主分组，点源主 → 进该源主的资源列表 → 选具体资源订阅
--   4. 用特殊邀请码注册的账号（profiles.subscription_only = true）看不到源主资源
--
-- 设计取舍：
--   * 身份不写进 profiles，而是以本表为唯一事实来源（status='approved' 即源主）。
--     profiles 有 guard_profile_privileged_columns 触发器保护特权列，新增列会牵连
--     一批既有迁移；独立表更干净，也让「历史申请」可追溯。
--   * resources 表 RLS 只允许本人读（00003 + 00012 移除了管理员旁路），
--     所以跨用户暴露资源必须走 SECURITY DEFINER 函数——与既有
--     admin_resource_sources() 同一套路。
-- ============================================================

-- ---------- 申请表 ----------
-- 一人一行：重新申请即更新同一条记录，避免堆重复申请
create table if not exists public.source_owners (
  user_id       uuid primary key references public.profiles(id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected')),
  display_name  text,                    -- 源主展示名，空则回退 profiles.username
  apply_note    text,                    -- 申请理由（给管理员看）
  review_note   text,                    -- 审核意见 / 驳回原因
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.source_owners is
  '源主申请表：一人一行，status=approved 即为源主；source_owner 资源的来源以此表为准';

-- 审核队列按「待处理优先 + 申请时间」排
create index if not exists idx_source_owners_status
  on public.source_owners (status, created_at desc);

-- ---------- 工具：当前调用者是否为管理员 ----------
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.role = 'admin'
  );
$$;

revoke all on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to authenticated, service_role;

-- ---------- 工具：当前调用者是否为受限账号（特殊邀请码）----------
-- 受限账号不展示源主资源
create or replace function public.is_subscription_only()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and coalesce(p.subscription_only, false) = true
  );
$$;

revoke all on function public.is_subscription_only() from public;
grant execute on function public.is_subscription_only() to authenticated, service_role;

-- ---------- 用户：申请成为源主 ----------
-- 待审核可重复提交（更新理由）；被驳回也允许再次申请；
-- 已通过的再次申请视为「不改状态」，保持源主身份。
create or replace function public.apply_source_owner(
  p_note text default null,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    raise exception '请先登录';
  end if;

  select status into v_status from public.source_owners where user_id = v_uid;

  if v_status = 'approved' then
    -- 已是源主：只允许改展示名，不动审核状态
    update public.source_owners
       set display_name = nullif(btrim(coalesce(p_display_name, '')), ''),
           updated_at = now()
     where user_id = v_uid;
    return jsonb_build_object('ok', true, 'status', 'approved', 'message', '你已经是源主');
  end if;

  insert into public.source_owners (user_id, status, apply_note, display_name, created_at, updated_at)
  values (v_uid, 'pending',
          nullif(btrim(coalesce(p_note, '')), ''),
          nullif(btrim(coalesce(p_display_name, '')), ''),
          now(), now())
  on conflict (user_id) do update
    set status = 'pending',
        apply_note = excluded.apply_note,
        display_name = coalesce(excluded.display_name, public.source_owners.display_name),
        review_note = null,
        reviewed_by = null,
        reviewed_at = null,
        updated_at = now();

  return jsonb_build_object('ok', true, 'status', 'pending', 'message', '申请已提交，等待管理员审核');
end;
$$;

revoke all on function public.apply_source_owner(text, text) from public;
grant execute on function public.apply_source_owner(text, text) to authenticated, service_role;

-- ---------- 用户：查看自己的源主申请状态 ----------
create or replace function public.my_source_owner_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.source_owners%rowtype;
  v_username text;
begin
  if v_uid is null then
    raise exception '请先登录';
  end if;

  select * into v_row from public.source_owners where user_id = v_uid;
  select username into v_username from public.profiles where id = v_uid;

  -- 注意：不能用 `not found` —— 上面那条查 username 的 SELECT 会覆盖 FOUND 的值。
  -- source_owners.user_id 是主键，查不到行时整条记录都是 null。
  if v_row.user_id is null then
    return jsonb_build_object(
      'status', 'none',
      'display_name', null,
      'apply_note', null,
      'review_note', null,
      'username', v_username,
      'created_at', null,
      'reviewed_at', null
    );
  end if;

  return jsonb_build_object(
    'status', v_row.status,
    'display_name', v_row.display_name,
    'apply_note', v_row.apply_note,
    'review_note', v_row.review_note,
    'username', v_username,
    'created_at', v_row.created_at,
    'reviewed_at', v_row.reviewed_at
  );
end;
$$;

revoke all on function public.my_source_owner_status() from public;
grant execute on function public.my_source_owner_status() to authenticated, service_role;

-- ---------- 管理员：申请列表（含未申请账号的统计）----------
create or replace function public.list_source_owner_applications(
  p_status text default null
)
returns table (
  user_id uuid,
  username text,
  display_name text,
  status text,
  apply_note text,
  review_note text,
  created_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by_name text,
  resource_count bigint,
  finished_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception '仅管理员可查看源主申请';
  end if;

  return query
  select s.user_id,
         p.username,
         s.display_name,
         s.status,
         s.apply_note,
         s.review_note,
         s.created_at,
         s.reviewed_at,
         rp.username,
         count(r.id) filter (where coalesce(r.is_finished, false) = false),
         count(r.id) filter (where coalesce(r.is_finished, false) = true)
    from public.source_owners s
    join public.profiles p on p.id = s.user_id
    left join public.profiles rp on rp.id = s.reviewed_by
    left join public.resources r on r.owner_id = s.user_id
   where (p_status is null or s.status = p_status)
   group by s.user_id, p.username, s.display_name, s.status, s.apply_note,
            s.review_note, s.created_at, s.reviewed_at, rp.username
   order by (s.status = 'pending') desc, s.created_at desc;
end;
$$;

revoke all on function public.list_source_owner_applications(text) from public;
grant execute on function public.list_source_owner_applications(text) to authenticated, service_role;

-- ---------- 管理员：通过 / 驳回 / 撤销源主身份 ----------
-- p_action: 'approve' | 'reject' | 'revoke'
create or replace function public.review_source_owner(
  p_user_id uuid,
  p_action text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := auth.uid();
  v_status text;
begin
  if not public.is_admin(v_admin) then
    raise exception '仅管理员可审核源主申请';
  end if;
  if p_action not in ('approve', 'reject', 'revoke') then
    raise exception '未知的操作: %', p_action;
  end if;

  select status into v_status from public.source_owners where user_id = p_user_id;
  if v_status is null then
    raise exception '该账号没有提交过源主申请';
  end if;

  if p_action = 'approve' then
    update public.source_owners
       set status = 'approved',
           review_note = nullif(btrim(coalesce(p_note, '')), ''),
           reviewed_by = v_admin,
           reviewed_at = now(),
           updated_at = now()
     where user_id = p_user_id;
    return jsonb_build_object('ok', true, 'status', 'approved');

  elsif p_action = 'reject' then
    update public.source_owners
       set status = 'rejected',
           review_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), '未填写原因'),
           reviewed_by = v_admin,
           reviewed_at = now(),
           updated_at = now()
     where user_id = p_user_id;
    return jsonb_build_object('ok', true, 'status', 'rejected');

  else  -- revoke：撤销源主身份，资源随即从订阅源隐藏
    update public.source_owners
       set status = 'rejected',
           review_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), '源主身份已被撤销'),
           reviewed_by = v_admin,
           reviewed_at = now(),
           updated_at = now()
     where user_id = p_user_id;
    return jsonb_build_object('ok', true, 'status', 'rejected', 'message', '已撤销该源主身份');
  end if;
end;
$$;

revoke all on function public.review_source_owner(uuid, text, text) from public;
grant execute on function public.review_source_owner(uuid, text, text) to authenticated, service_role;

-- ---------- 订阅源用：已通过的源主列表 ----------
-- 受限账号（特殊邀请码）返回空
create or replace function public.source_owner_list()
returns table (
  owner_id uuid,
  display_name text,
  username text,
  avatar_url text,
  resource_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  -- 特殊邀请码注册的账号不展示源主
  if public.is_subscription_only() then
    return;
  end if;

  return query
  select s.user_id,
         coalesce(nullif(btrim(coalesce(s.display_name, '')), ''), p.username, '源主'),
         p.username,
         p.avatar_url,
         count(r.id)
    from public.source_owners s
    join public.profiles p on p.id = s.user_id
    left join public.resources r
      on r.owner_id = s.user_id and coalesce(r.is_finished, false) = false
   where s.status = 'approved'
     and coalesce(p.status, 'active') = 'active'
   group by s.user_id, s.display_name, p.username, p.avatar_url
   order by count(r.id) desc, s.user_id;
end;
$$;

revoke all on function public.source_owner_list() from public;
grant execute on function public.source_owner_list() to authenticated, service_role;

-- ---------- 订阅源用：某源主的「更新中」资源链接 ----------
-- 完全对齐 admin_resource_sources() 的返回列与网盘识别，
-- 这样前端可以复用同一套类型与渲染逻辑。
create or replace function public.source_owner_resources(p_owner_id uuid)
returns table (
  owner_id uuid,
  resource_id uuid,
  name text,
  episode_count integer,
  pan text,
  url text,
  link_status text,
  is_finished boolean,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
-- returns table 的输出列（如 resource_id）会被 PL/pgSQL 当成变量，
-- 与 CTE 里的裸列引用冲突（报 42702 ambiguous）。这里强制按列名解析。
#variable_conflict use_column
begin
  if auth.uid() is null then
    return;
  end if;
  if public.is_subscription_only() then
    return;
  end if;

  -- 必须是已通过的源主，否则任何人都能查任意人的资源
  if not exists (
    select 1 from public.source_owners s
    where s.user_id = p_owner_id and s.status = 'approved'
  ) then
    return;
  end if;

  return query
  with links as (
    select r.id            as resource_id,
           r.name,
           r.episode_count,
           r.is_finished,
           r.updated_at,
           l.value,
           row_number() over (
             partition by r.id
             order by lower(btrim(coalesce(l.value->>'url', '')))
           ) as url_dup_rank
      from public.resources r
      cross join lateral jsonb_array_elements(coalesce(r.links, '[]'::jsonb)) as l(value)
     where r.owner_id = p_owner_id
       and coalesce(r.is_finished, false) = false
       and coalesce(btrim(l.value->>'url'), '') <> ''
  ), normalized as (
    select distinct on (resource_id, lower(btrim(value->>'url')))
           resource_id, name, episode_count, is_finished, updated_at,
           lower(btrim(value->>'url')) as url_norm,
           btrim(value->>'url')        as url_clean,
           value->>'pan_name'          as pan_name,
           value->>'status'            as link_status
      from links
     order by resource_id, lower(btrim(value->>'url')), url_dup_rank
  ), typed as (
    select n.*,
           case
             when n.pan_name ilike '%123%' then 'p123'
             when n.url_norm like '%123pan.cn%' or n.url_norm like '%123684.com%'
               or n.url_norm like '%123865.com%' or n.url_norm like '%123912.com%' then 'p123'
             when n.pan_name ilike '%uc%' then 'uc'
             when n.url_norm like '%drive.uc.cn%' then 'uc'
             when n.pan_name ilike '%夸克%' then 'quark'
             when n.url_norm like '%pan.quark.cn%' then 'quark'
             when n.pan_name ilike '%光鸭%' then 'guangya'
             when n.url_norm like '%guangyapan.com%' then 'guangya'
             when n.pan_name ilike '%百度%' then 'baidu'
             when n.url_norm like '%pan.baidu.com%' then 'baidu'
             when n.pan_name ilike '%迅雷%' then 'xunlei'
             when n.url_norm like '%pan.xunlei.com%' then 'xunlei'
             else null
           end as pan_type
      from normalized n
  )
  select p_owner_id, t.resource_id, t.name, t.episode_count,
         t.pan_type, t.url_clean, t.link_status, t.is_finished, t.updated_at
    from typed t
   where t.pan_type is not null
   order by t.name, t.pan_type;
end;
$$;

revoke all on function public.source_owner_resources(uuid) from public;
grant execute on function public.source_owner_resources(uuid) to authenticated, service_role;

-- ---------- 订阅白名单：某链接是否属于可见的源主资源 ----------
-- 与既有 is_admin_resource_url() 同构，供 Edge Function 校验用。
-- 受限账号即便拿到链接也过不了这一关。
create or replace function public.is_source_owner_url(p_url text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_url text := lower(btrim(coalesce(p_url, '')));
begin
  if v_url = '' then
    return false;
  end if;

  -- 受限账号不允许订阅源主资源
  if public.is_subscription_only() then
    return false;
  end if;

  return exists (
    select 1
      from public.source_owners s
      join public.resources r
        on r.owner_id = s.user_id
     cross join lateral jsonb_array_elements(coalesce(r.links, '[]'::jsonb)) as l(value)
     where s.status = 'approved'
       and coalesce(r.is_finished, false) = false
       and lower(btrim(coalesce(l.value->>'url', ''))) = v_url
  );
end;
$$;

revoke all on function public.is_source_owner_url(text) from public;
grant execute on function public.is_source_owner_url(text) to authenticated, service_role;
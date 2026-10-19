-- ============================================================
-- UC 网盘接入「订阅转存」（第 5 个转存目标网盘）
--
-- 背景：目标网盘原为 guangya / quark / baidu / xunlei（00076 的 CHECK 是唯一真源）。
-- UC 与夸克同属 clouddrive 架构（pc-api.uc.cn/1/clouddrive），凭证同样是 Cookie，
-- 因此复用 00046 的 save_pan_account（credential_type = 'cookie'）。
--
-- 变更：
--   1. pan_accounts.pan / subscriptions.pan / subscription_sources.pan 三处 CHECK 放开到 uc
--   2. admin_resource_sources() 里 drive.uc.cn 原来被归到 quark，现在拆出独立 uc 分支
--
-- 文件夹模式：UC 暂不开启（enforce_folder_mode_pan 保持 guangya / quark / baidu）。
-- ============================================================

-- ── 1. pan_accounts.pan 放开 uc ──
ALTER TABLE public.pan_accounts DROP CONSTRAINT IF EXISTS pan_accounts_pan_check;
ALTER TABLE public.pan_accounts
  ADD CONSTRAINT pan_accounts_pan_check CHECK (pan IN ('guangya', 'quark', 'baidu', 'xunlei', 'uc'));

-- ── 2. subscriptions.pan 放开 uc ──
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_pan_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_pan_check CHECK (pan IN ('guangya', 'quark', 'baidu', 'xunlei', 'uc'));

-- ── 3. subscription_sources.pan 放开 uc（管理员维护的订阅源） ──
ALTER TABLE public.subscription_sources DROP CONSTRAINT IF EXISTS subscription_sources_pan_check;
ALTER TABLE public.subscription_sources
  ADD CONSTRAINT subscription_sources_pan_check CHECK (pan IN ('guangya', 'quark', 'baidu', 'xunlei', 'uc'));

-- ── 4. 内置订阅源：drive.uc.cn 归 uc，不再误标成夸克 ──
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
      -- UC 必须排在夸克前面：两者链接域名不同，但 pan_name 里可能只写「UC」
      when coalesce(l.value ->> 'pan_name', '') ~* '(^|[^a-z])uc([^a-z]|$)'
        or coalesce(l.value ->> 'url', '') ~* 'drive\.uc\.cn' then 'uc'
      when coalesce(l.value ->> 'pan_name', '') like '%夸克%'
        or coalesce(l.value ->> 'url', '') ~* 'pan\.quark\.cn' then 'quark'
      when coalesce(l.value ->> 'pan_name', '') like '%光鸭%'
        or coalesce(l.value ->> 'pan_name', '') like '%光雅%'
        or coalesce(l.value ->> 'url', '') ~* 'guangyapan\.com' then 'guangya'
      when coalesce(l.value ->> 'pan_name', '') like '%百度%'
        or coalesce(l.value ->> 'url', '') ~* '(pan\.baidu\.com|yun\.baidu\.com)' then 'baidu'
      when coalesce(l.value ->> 'pan_name', '') like '%迅雷%'
        or coalesce(l.value ->> 'url', '') ~* 'pan\.xunlei\.com' then 'xunlei'
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
  '管理员「更新中」资源的网盘分享链接（一个资源可返回多行：光鸭 + 夸克 + 百度 + 迅雷 + UC）；**所有已登录账号**可读（未登录返回空）';

revoke all on function public.admin_resource_sources() from public;
grant execute on function public.admin_resource_sources() to authenticated, service_role;

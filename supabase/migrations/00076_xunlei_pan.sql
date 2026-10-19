-- ============================================================
-- 迅雷云盘接入「订阅转存」（第 4 个转存目标网盘）
--
-- 背景：订阅转存的目标网盘原来只有 guangya / quark / baidu（00072 的 CHECK 是唯一真源）。
-- 现在把 xunlei 加进来：
--   · pan_accounts.pan / subscriptions.pan / subscription_sources.pan 三处 CHECK 放开到 xunlei
--   · admin_resource_sources() 补一条 xunlei 分支（否则管理员资源里的迅雷分享链接
--     在「内置订阅源」里会被默认标成光鸭 → 目标网盘对不上、无法转存）
--
-- 凭证形态：迅雷走 OAuth 2.0 Device Authorization Grant（与光鸭同一套「扫码 → 令牌」），
-- 因此复用 00046 的 save_pan_oauth / load_pan_oauth（credential_type = 'oauth'），
-- token_json = {access_token, refresh_token, expires_at, open_id, device_id}。
--   · device_id（32 位 hex）是 drive 接口的必需请求头，绑定时生成后随令牌一起存；
--   · 令牌过期用 refresh_token 自动续期，失败才提示重新扫码。
--
-- 文件夹模式：迅雷不支持（enforce_folder_mode_pan 保持「只放行 guangya / quark」）。
-- ============================================================

-- ── 1. pan_accounts.pan 放开 xunlei ──
ALTER TABLE public.pan_accounts DROP CONSTRAINT IF EXISTS pan_accounts_pan_check;
ALTER TABLE public.pan_accounts
  ADD CONSTRAINT pan_accounts_pan_check CHECK (pan IN ('guangya', 'quark', 'baidu', 'xunlei'));

-- ── 2. subscriptions.pan 放开 xunlei ──
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_pan_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_pan_check CHECK (pan IN ('guangya', 'quark', 'baidu', 'xunlei'));

-- ── 3. subscription_sources.pan 放开 xunlei（管理员维护的订阅源） ──
ALTER TABLE public.subscription_sources DROP CONSTRAINT IF EXISTS subscription_sources_pan_check;
ALTER TABLE public.subscription_sources
  ADD CONSTRAINT subscription_sources_pan_check CHECK (pan IN ('guangya', 'quark', 'baidu', 'xunlei'));

-- ── 4. 内置订阅源：管理员资源里的迅雷分享链接要能标成 xunlei ──
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
  '管理员「更新中」资源的网盘分享链接（一个资源可返回多行：光鸭 + 夸克 + 百度 + 迅雷）；**所有已登录账号**可读（未登录返回空）';

revoke all on function public.admin_resource_sources() from public;
grant execute on function public.admin_resource_sources() to authenticated, service_role;

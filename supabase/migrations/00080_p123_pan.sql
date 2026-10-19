-- ============================================================
-- 123 云盘（123pan）接入「订阅转存」（第 6 个转存目标网盘）
--
-- 凭证形态：与夸克/百度不同 —— 123 的凭证是浏览器 localStorage 里的 authorToken
-- （请求头 Authorization: Bearer <token>），不是 Cookie。为复用既有加解密链路，
-- 仍存在 pan_accounts.cookie_enc 列里，读取时当作 token 使用。
--
-- 接口特征（见《123网盘接口文档》）：
--   · 每个请求都要带动态签名 ?<timeSign>=<timestamp>-<random>-<dataSign>
--   · 分享页跑在专属子域 https://<分享号>.share.123pan.cn，个人网盘接口在 yun.123pan.com/b/api
--
-- 文件夹模式：2026-10-18 起已放开（见迁移 00081_folder_mode_support_p123.sql）。

-- ── 1. pan_accounts.pan 放开 p123 ──
ALTER TABLE public.pan_accounts DROP CONSTRAINT IF EXISTS pan_accounts_pan_check;
ALTER TABLE public.pan_accounts
  ADD CONSTRAINT pan_accounts_pan_check
  CHECK (pan IN ('guangya', 'quark', 'baidu', 'xunlei', 'uc', 'p123'));

-- ── 2. subscriptions.pan 放开 p123 ──
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_pan_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_pan_check
  CHECK (pan IN ('guangya', 'quark', 'baidu', 'xunlei', 'uc', 'p123'));

-- ── 3. subscription_sources.pan 放开 p123 ──
ALTER TABLE public.subscription_sources DROP CONSTRAINT IF EXISTS subscription_sources_pan_check;
ALTER TABLE public.subscription_sources
  ADD CONSTRAINT subscription_sources_pan_check
  CHECK (pan IN ('guangya', 'quark', 'baidu', 'xunlei', 'uc', 'p123'));

-- ── 4. 内置订阅源：123 分享链接要能标成 p123 ──
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
  if auth.uid() is null then
    return;
  end if;

  return query
  select distinct on (lower(btrim(l.value ->> 'url')))
    r.id,
    r.name,
    coalesce(r.episode_count, 0),
    case
      when coalesce(l.value ->> 'pan_name', '') ~* '(^|[^0-9])123(pan|云盘|云)'
        or coalesce(l.value ->> 'url', '') ~* '(123pan\.com|123865\.com|123684\.com|123912\.com)' then 'p123'
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
  where coalesce(r.is_finished, false) = false
    and coalesce(btrim(l.value ->> 'url'), '') <> ''
  order by lower(btrim(l.value ->> 'url'));
end;
$$;

comment on function public.admin_resource_sources() is
  '管理员「更新中」资源的网盘分享链接（一个资源可返回多行：光鸭 + 夸克 + 百度 + 迅雷 + UC + 123）；**所有已登录账号**可读（未登录返回空）';

revoke all on function public.admin_resource_sources() from public;
grant execute on function public.admin_resource_sources() to authenticated, service_role;
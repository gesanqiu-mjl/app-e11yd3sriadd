-- ============================================================
-- 自建中转短链 + 点击统计
--
-- 场景：把网盘链接换成本系统生成的短链再分享出去，别人点开短链时：
--   1) 记录一次点击（渠道 / UA / Referer / IP 加盐哈希，不存明文 IP）
--   2) 302 跳转到真实网盘链接
-- 这样「我的分享被多少人访问/点击」完全由自己统计，且能区分渠道、看趋势。
--
-- 表：
--   short_links        短链定义（每条短链指向一个目标地址）
--   short_link_clicks  点击明细（每次跳转一行；机器人也记，但标 is_bot 且不计入总数）
-- 函数：
--   short_link_hit     跳转时原子记录点击并返回目标地址（只给服务端调用）
--   short_link_stats   列表页用的按短链聚合（含今日/区间点击数、区间独立访客）
--   short_link_daily   趋势图用的按天聚合
--   short_link_channels 渠道分布
-- ============================================================

-- ── 短链定义 ──────────────────────────────────────────────
create table if not exists public.short_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 短码：URL 里那一段（只用小写字母+数字，去掉易混字符）
  code text not null unique,
  title text not null default '',
  target_url text not null,
  extract_code text,
  pan_name text,
  resource_id uuid,
  -- 生成时的默认渠道标记（分享时也可用 ?c=群A 临时覆盖）
  channel text,
  enabled boolean not null default true,
  expires_at timestamptz,
  -- 冗余计数：跳转时原子自增，列表页无需扫明细表
  click_count integer not null default 0,
  unique_count integer not null default 0,
  last_click_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists short_links_user_idx on public.short_links (user_id, created_at desc);
create index if not exists short_links_resource_idx on public.short_links (resource_id);

-- ── 点击明细 ──────────────────────────────────────────────
create table if not exists public.short_link_clicks (
  id bigserial primary key,
  link_id uuid not null references public.short_links(id) on delete cascade,
  user_id uuid not null,
  code text not null,
  clicked_at timestamptz not null default now(),
  -- 加盐哈希后的访客标识（不保存明文 IP，符合最小化原则）
  ip_hash text,
  ua text,
  referer text,
  channel text,
  is_bot boolean not null default false,
  -- 同一访客当天首次（用于「独立访客」）
  is_unique boolean not null default true,
  -- 归属日期（按北京时间切分，便于「今日」统计）
  day date not null default (now() at time zone 'Asia/Shanghai')::date
);

create index if not exists short_link_clicks_link_idx on public.short_link_clicks (link_id, clicked_at desc);
create index if not exists short_link_clicks_user_idx on public.short_link_clicks (user_id, clicked_at desc);
create index if not exists short_link_clicks_day_idx on public.short_link_clicks (link_id, day);
create index if not exists short_link_clicks_ip_idx on public.short_link_clicks (link_id, ip_hash, day);

-- ── RLS：短链只有本人可读写；明细只有本人可读（写入由服务端 service_role 完成）──
alter table public.short_links enable row level security;
alter table public.short_link_clicks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'short_links' and policyname = 'short_links_own'
  ) then
    create policy "short_links_own" on public.short_links
      for all to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'short_links' and policyname = 'short_links_admin_read'
  ) then
    create policy "short_links_admin_read" on public.short_links
      for select to authenticated
      using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'short_link_clicks' and policyname = 'short_link_clicks_own_read'
  ) then
    create policy "short_link_clicks_own_read" on public.short_link_clicks
      for select to authenticated
      using (user_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'short_link_clicks' and policyname = 'short_link_clicks_admin_read'
  ) then
    create policy "short_link_clicks_admin_read" on public.short_link_clicks
      for select to authenticated
      using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
  end if;
end $$;

-- ── 跳转打点（唯一写入口，仅供服务端 service_role 调用）──
-- 一次调用完成：查短链 → 判定有效/过期 → 算是否独立访客 → 写明细 → 原子自增计数。
-- 返回值里带目标地址，Edge Function 拿到后直接 302。
create or replace function public.short_link_hit(
  p_code text,
  p_ip_hash text,
  p_ua text,
  p_referer text,
  p_channel text,
  p_is_bot boolean
)
returns table (
  found boolean,
  enabled boolean,
  expired boolean,
  target_url text,
  extract_code text,
  title text,
  is_unique boolean,
  link_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.short_links%rowtype;
  v_day date := (now() at time zone 'Asia/Shanghai')::date;
  v_ip text := coalesce(nullif(trim(p_ip_hash), ''), '');
  v_bot boolean := coalesce(p_is_bot, false);
  v_unique boolean := true;
  v_expired boolean := false;
begin
  select * into v from public.short_links where code = p_code;
  if not found then
    return query select false, false, false, null::text, null::text, null::text, false, null::uuid;
    return;
  end if;

  v_expired := (v.expires_at is not null and v.expires_at < now());
  if (not v.enabled) or v_expired then
    return query select true, false, v_expired, v.target_url, v.extract_code, v.title, false, v.id;
    return;
  end if;

  -- 同一访客（同 ip_hash）当天已访问过 → 本次不算独立访客；无 IP 时按独立计
  if v_ip <> '' then
    v_unique := not exists (
      select 1 from public.short_link_clicks c
      where c.link_id = v.id and c.ip_hash = v_ip and c.day = v_day and c.is_bot = false
    );
  end if;

  insert into public.short_link_clicks
    (link_id, user_id, code, ip_hash, ua, referer, channel, is_bot, is_unique, day)
  values
    (v.id, v.user_id, v.code, nullif(v_ip, ''),
     left(coalesce(p_ua, ''), 300), left(coalesce(p_referer, ''), 500),
     nullif(left(coalesce(p_channel, ''), 60), ''), v_bot, v_unique, v_day);

  -- 机器人点击不入总量，避免统计被爬虫污染
  if not v_bot then
    update public.short_links
       set click_count = click_count + 1,
           unique_count = unique_count + case when v_unique then 1 else 0 end,
           last_click_at = now()
     where id = v.id;
  end if;

  return query select true, true, false, v.target_url, v.extract_code, v.title, v_unique, v.id;
end;
$$;

revoke all on function public.short_link_hit(text, text, text, text, text, boolean) from public;
revoke all on function public.short_link_hit(text, text, text, text, text, boolean) from anon;
revoke all on function public.short_link_hit(text, text, text, text, text, boolean) from authenticated;

-- ── 列表页聚合（按当前登录用户，RLS 保证只看自己的数据）──
create or replace function public.short_link_stats(p_days integer default 7)
returns table (
  link_id uuid,
  clicks_total bigint,
  clicks_range bigint,
  uniques_range bigint,
  clicks_today bigint,
  last_click_at timestamptz
)
language sql
security invoker
stable
as $$
  select l.id,
         l.click_count::bigint,
         coalesce(sum(case when c.clicked_at >= now() - make_interval(days => greatest(p_days, 1)) and not c.is_bot then 1 else 0 end), 0)::bigint,
         coalesce(count(distinct case when c.clicked_at >= now() - make_interval(days => greatest(p_days, 1)) and not c.is_bot then c.ip_hash end), 0)::bigint,
         coalesce(sum(case when c.day = (now() at time zone 'Asia/Shanghai')::date and not c.is_bot then 1 else 0 end), 0)::bigint,
         l.last_click_at
    from public.short_links l
    left join public.short_link_clicks c
      on c.link_id = l.id and c.user_id = auth.uid()
   where l.user_id = auth.uid()
   group by l.id, l.click_count, l.last_click_at;
$$;

-- ── 趋势（按天）──
create or replace function public.short_link_daily(p_link_id uuid, p_days integer default 30)
returns table (day date, clicks bigint, uniques bigint, bots bigint)
language sql
security invoker
stable
as $$
  with span as (
    select generate_series(
      ((now() at time zone 'Asia/Shanghai')::date - greatest(p_days, 1) + 1),
      (now() at time zone 'Asia/Shanghai')::date,
      interval '1 day'
    )::date as d
  )
  select s.d as day,
         coalesce(count(c.id) filter (where not c.is_bot), 0)::bigint,
         coalesce(count(distinct c.ip_hash) filter (where not c.is_bot), 0)::bigint,
         coalesce(count(c.id) filter (where c.is_bot), 0)::bigint
    from span s
    left join public.short_link_clicks c
      on c.day = s.d and c.link_id = p_link_id and c.user_id = auth.uid()
   group by s.d
   order by s.d;
$$;

-- ── 渠道分布 ──
create or replace function public.short_link_channels(p_link_id uuid, p_days integer default 30)
returns table (channel text, clicks bigint, uniques bigint)
language sql
security invoker
stable
as $$
  select coalesce(nullif(c.channel, ''), '（未标记）') as channel,
         count(*)::bigint as clicks,
         count(distinct c.ip_hash)::bigint as uniques
    from public.short_link_clicks c
   where c.link_id = p_link_id
     and c.user_id = auth.uid()
     and not c.is_bot
     and c.clicked_at >= now() - make_interval(days => greatest(p_days, 1))
   group by 1
   order by 2 desc
   limit 30;
$$;

comment on table public.short_links is '自建中转短链：短码 → 目标网盘链接，含点击数冗余计数';
comment on table public.short_link_clicks is '短链点击明细（IP 以加盐哈希保存，不存明文）';

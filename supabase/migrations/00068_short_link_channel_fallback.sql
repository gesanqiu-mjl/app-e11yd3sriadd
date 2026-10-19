-- ============================================================
-- 短链渠道：把「渠道」从 URL 搬进短链行（短链更短）
--
-- 背景：短链的渠道此前只能靠分享时在 URL 上带 ?c=<渠道名>，中文渠道名会被 URL 编码成
--       60 多个字符 —— 例如
--         https://guangya.xyz.hr/go/rb8f33?c=%E7%BE%A4%E6%8E%A8%E9%80%81-%E5%85%89%E9%B8%AD%E4%BA%91%E7%9B%98
--       看起来比短链本身还长，分享到群里极不美观。
--
-- 做法：short_links.channel 本身就是「生成时的默认渠道标记」，让跳转打点在**没带 ?c=** 时
--       回落到该字段即可 —— 于是短链可以只写成 https://域名/go/rb8f33，点击照样按渠道统计；
--       需要临时改渠道时，?c= 仍然优先（覆盖行上的默认值），行为向后兼容。
--
-- 只改 public.short_link_hit 里写入 short_link_clicks.channel 的取值：
--   coalesce(nullif(参数里的渠道, ''), 短链行上的渠道)
-- ============================================================

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
  -- 渠道：URL 上的 ?c= 优先；没带时用短链行上保存的默认渠道（短链因此可以不带 ?c=）
  v_channel text;
begin
  select * into v from public.short_links where code = p_code;
  if not found then
    return query select false, false, false, null::text, null::text, null::text, false, null::uuid;
    return;
  end if;

  v_channel := nullif(left(coalesce(nullif(trim(coalesce(p_channel, '')), ''), coalesce(v.channel, '')), 60), '');

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
     v_channel, v_bot, v_unique, v_day);

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

comment on column public.short_links.channel is
  '生成短链时的默认渠道标记：分享链接**不需要**再带 ?c= 也能统计到该渠道；带 ?c= 时以 URL 上的为准（临时覆盖）';

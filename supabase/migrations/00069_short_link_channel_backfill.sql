-- ============================================================
-- 短链渠道回填：把「历史点击里记录的渠道」写回短链行
--
-- 背景：短链的渠道此前只能写在 URL 上（?c=<渠道名>），点击明细里因此存了渠道，
--       但 short_links.channel 一直是空的 —— 于是 URL 里那个又长又丑的 ?c= 必须一直带着，
--       否则统计就丢渠道。配合 00068（跳转打点回落到行上的渠道），这里做一次性回填：
--       短链行上取该短链**点击最多的那个渠道**作为默认渠道。
--
-- 回填后：https://域名/go/<短码> 不带 ?c= 也能按原渠道统计，
--         旧的长链接（带 ?c=）依旧可用，且以 URL 上的渠道为准。
-- ============================================================

with top_channel as (
  select link_id,
         channel,
         row_number() over (
           partition by link_id
           order by count(*) desc, max(clicked_at) desc
         ) as rn
    from public.short_link_clicks
   where channel is not null
     and channel <> ''
   group by link_id, channel
)
update public.short_links l
   set channel = t.channel
  from top_channel t
 where t.link_id = l.id
   and t.rn = 1
   and coalesce(l.channel, '') = '';

-- 结果自检：还有多少条「有点击渠道、但行上没有渠道」的短链
select count(*) as remain_missing_channel
  from public.short_links l
 where coalesce(l.channel, '') = ''
   and exists (
     select 1 from public.short_link_clicks c
      where c.link_id = l.id and coalesce(c.channel, '') <> ''
   );

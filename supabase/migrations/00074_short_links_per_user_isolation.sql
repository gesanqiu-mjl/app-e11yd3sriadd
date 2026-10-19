-- ============================================================
-- 短链数据按账号隔离：去掉「管理员可读全部短链 / 全部点击明细」的策略
--
-- 背景：短链统计页要求「每个账号只看自己的」。
-- 前端已显式按 user_id 过滤（shortlinks.ts → listShortLinks），
-- 但库里的 short_links_admin_read / short_link_clicks_admin_read 会让
-- 管理员令牌通过 REST 读到所有账号的短链与点击明细 —— 与隔离语义冲突。
--
-- 处理：删掉这两条 admin_read 策略。
--   · 普通用户：仍由 short_links_own / short_link_clicks_own_read（user_id = auth.uid()）兜底；
--   · 管理员本人：同样只看到自己的（页面本来就只统计自己的）；
--   · 后台运维（service_role，PostgREST / Edge Function）不受 RLS 限制，需要全量时走服务端。
-- ============================================================

drop policy if exists short_links_admin_read on public.short_links;
drop policy if exists short_link_clicks_admin_read on public.short_link_clicks;

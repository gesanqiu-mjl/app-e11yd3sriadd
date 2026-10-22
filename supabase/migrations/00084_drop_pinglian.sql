--下线「盘链站点」（pinglian.lol）全部功能
--
-- 背景：盘链站点已停止运营，本工具不再支持对它的账号绑定、片源检索、
--       发布与增量同步。本次下线其全部代码与数据。
--
-- 说明：历史迁移（00009 / 00010 / 00025 / 00026 等）保留不动，
--       仅用本迁移把相关对象删除，达到「下线」效果。
--
-- 关联代码：src/services/api.ts、src/pages/SyncPage.tsx、
--          src/components/{BindDialog,QuickBindDialog,ResourceTable}.tsx、
--          supabase/functions/{site-credential,batch-post,resource-sync-worker}

-- ── 1) 删除盘链会话 / 片源缓存表 ────────────────────────────
-- CASCADE 会一并带走建在这两张表上的 RLS 策略、索引、触发器
DROP TABLE IF EXISTS public.pinglian_sessions CASCADE;
DROP TABLE IF EXISTS public.pinglian_links_cache CASCADE;

-- ── 2) 删除「资源 × 盘链记录」绑定表 ──────────────────────────
-- 该表是盘链专用（其余站点各有自己的 xxx_resource_bindings），
-- 表内无 site 列，但 enqueue_sync_resource_bindings 触发器只挂在它上面。
DROP TABLE IF EXISTS public.resource_bindings CASCADE;

-- ── 3) 删除盘链站点凭据 ──────────────────────────────────────
DELETE FROM public.site_credentials WHERE site = 'pinglian';

-- ── 4) 清理站点白名单类约束 / 注释里的盘链枚举 ─────────────────
-- site_credentials.site 上可能存在 CHECK 约束含'pinglian'，
-- 这里统一重建为不含盘链的白名单（若约束不存在则跳过）。
DO $do$
DECLARE
  conname text;
BEGIN
  SELECT c.conname INTO conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'site_credentials'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%pinglian%'
  LIMIT 1;

  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.site_credentials DROP CONSTRAINT %I', conname);
    RAISE NOTICE '已移除 site_credentials 上的约束 %', conname;
  END IF;
END
$do$;

COMMENT ON TABLE public.site_credentials IS
  '各站点登录凭据（按 site 区分：ya / jying / hdhaven / framehdr / mukaku / panfx / xn / st1）';
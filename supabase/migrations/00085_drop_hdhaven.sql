-- 下线「栖影站点」（hdhaven.com / HDHaven）全部功能
--
-- 背景：栖影站点已不再作为本工具的同步/发布目标下线。
--       前端（SyncPage / BindDialog / QuickBindDialog / ResourceTable）、
--       API 层（src/services/api.ts）、共享类型层，以及
--       site-credential / batch-post / resource-sync-worker 边缘函数
--       与 hdhaven-proxy 边缘函数均已移除栖影分支。
--
-- 说明：历史迁移保留不动，仅用本迁移删除相关对象达成下线效果。
--
-- 关联代码：src/services/api.ts、src/types/index.ts、src/lib/hdhavenMeta.ts、
--          src/pages/SyncPage.tsx、
--          src/components/{BindDialog,QuickBindDialog,ResourceTable}.tsx、
--          supabase/functions/{site-credential,batch-post,resource-sync-worker}

-- ── 1) 删除栖影 OAuth state 临时表（防 CSRF 授权中间态，无长期价值）──
DROP TABLE IF EXISTS public.hdhaven_oauth_states CASCADE;

-- ── 2) 删除栖影会话表（存 OpenAPI OAuth 的 access/refresh token 密文）──
DROP TABLE IF EXISTS public.hdhaven_sessions CASCADE;

-- ── 3) 删除「资源 × 栖影分享」绑定表 ──────────────────────────
DROP TABLE IF EXISTS public.hdhaven_resource_bindings CASCADE;

-- ── 4) 删除栖影站点凭据 ────────────────────────────────────
DELETE FROM public.site_credentials WHERE site = 'hdhaven';

-- ── 5) 清理 site_credentials 上可能含 'hdhaven' 的 CHECK 约束 ─────
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
    AND pg_get_constraintdef(c.oid) ILIKE '%hdhaven%'
  LIMIT 1;

  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.site_credentials DROP CONSTRAINT %I', conname);
    RAISE NOTICE '已移除 site_credentials 上的约束 %', conname;
  END IF;
END
$do$;

COMMENT ON TABLE public.site_credentials IS
  '各站点登录凭据（按 site 区分：ya / jying / framehdr / mukaku / panfx / xn / st1）';
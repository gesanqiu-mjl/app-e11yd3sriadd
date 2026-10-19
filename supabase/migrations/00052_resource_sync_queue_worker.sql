-- ============================================================
-- 站点补推任务队列：支持服务端 worker 无人值守执行
--
-- 背景：订阅在服务端改了资源（集数/链接）后只登记一条 resource_sync_queue，
--   真正的「推送到站点」原先只能由浏览器打开资源管理页时执行，
--   用户关掉页面就永远不会推送。
--
-- 本迁移为队列补上 worker 需要的字段：
--   attempts        已尝试次数（达到上限后不再由 worker 自动重试，避免无限重试）
--   last_error      最近一次失败原因（便于排查）
--   last_attempt_at 最近一次尝试时间
--   claimed_at      worker 抢占标记（防止并发/与前端补推互相重复推送）
-- 以及一个原子抢占函数 claim_resource_sync_tasks（FOR UPDATE SKIP LOCKED）。
-- ============================================================

ALTER TABLE "public"."resource_sync_queue"
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_error" text,
  ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;

COMMENT ON COLUMN "public"."resource_sync_queue"."attempts" IS 'worker 已尝试推送次数；达到上限后不再自动重试（前端打开资源管理页仍会补推）';
COMMENT ON COLUMN "public"."resource_sync_queue"."last_error" IS 'worker 最近一次推送失败原因';
COMMENT ON COLUMN "public"."resource_sync_queue"."claimed_at" IS 'worker 抢占时间；超过 5 分钟视为失效可被重新抢占';

CREATE INDEX IF NOT EXISTS "resource_sync_queue_pending_idx"
  ON "public"."resource_sync_queue" ("created_at")
  WHERE "claimed_at" IS NULL;

-- 原子抢占一批待推送任务：只有被本次 UPDATE 命中的行才返回，
-- 因此多个 worker/实例并发时不会重复处理同一条。
CREATE OR REPLACE FUNCTION public.claim_resource_sync_tasks(
  p_limit integer DEFAULT 10,
  p_user_id uuid DEFAULT NULL::uuid,
  p_stale_minutes integer DEFAULT 5,
  p_max_attempts integer DEFAULT 5
)
RETURNS SETOF public.resource_sync_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.resource_sync_queue q
  SET claimed_at = now()
  WHERE q.id IN (
    SELECT id
    FROM public.resource_sync_queue
    WHERE attempts < p_max_attempts
      AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => p_stale_minutes))
      AND (p_user_id IS NULL OR user_id = p_user_id)
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING q.*;
$function$;

COMMENT ON FUNCTION public.claim_resource_sync_tasks(integer, uuid, integer, integer) IS
  '服务端补推 worker 抢占待推送任务（FOR UPDATE SKIP LOCKED，避免重复推送）';

-- 仅服务端（service_role）可调用，前端/匿名不可
REVOKE ALL ON FUNCTION public.claim_resource_sync_tasks(integer, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_resource_sync_tasks(integer, uuid, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_resource_sync_tasks(integer, uuid, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_resource_sync_tasks(integer, uuid, integer, integer) TO service_role;

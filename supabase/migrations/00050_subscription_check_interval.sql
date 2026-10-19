-- 订阅「检查时间」：定时任务改为每分钟探测链接，最小检查间隔放开到 1 分钟
--   1) interval_minutes 默认 30 → 1（新建订阅默认每分钟探测一次）
--   2) 新增 run_lock_at：执行占用标记，避免上一轮还在跑时被重复执行（导致重复转存）
--   3) pg_cron 由每 3 分钟改为每分钟触发（函数内仍按每个订阅的检查时间判断是否到点）

ALTER TABLE "public"."subscriptions"
  ADD COLUMN IF NOT EXISTS "run_lock_at" timestamp with time zone;

COMMENT ON COLUMN "public"."subscriptions"."run_lock_at" IS
  '订阅执行占用时间：上一轮未结束时不再重复执行，超时（10 分钟）后视为锁失效';

ALTER TABLE "public"."subscriptions"
  ALTER COLUMN "interval_minutes" SET DEFAULT 1;

-- pg_cron：改为每分钟触发。复制原有 command（内含共享密钥），避免在迁移里硬编码 secret。
DO $cron$
DECLARE
  v_cmd text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron 未启用，跳过定时任务调整';
    RETURN;
  END IF;

  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'subscription-run-3min';
  IF v_cmd IS NULL THEN
    RAISE NOTICE '未找到 subscription-run-3min 任务，跳过（请按 README 手动创建）';
    RETURN;
  END IF;

  PERFORM cron.unschedule('subscription-run-3min');
  PERFORM cron.schedule('subscription-run-1min', '* * * * *', v_cmd);
END
$cron$;

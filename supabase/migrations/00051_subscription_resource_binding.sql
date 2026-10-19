-- 订阅「绑定资源管理中的资源」升级：
--   1) 订阅可以直接指定要更新的那条资源（不再只靠剧名自动匹配）
--   2) 服务端改了资源后登记一条待推送任务：站点推送逻辑只存在于前端（各站点重登/重试/链接匹配
--      都在 ResourceTable.syncToSite 里），所以由前端打开页面时自动补推，避免在服务端重复实现 8 套。

ALTER TABLE "public"."subscriptions"
  ADD COLUMN IF NOT EXISTS "resource_id" uuid REFERENCES "public"."resources"("id") ON DELETE SET NULL;

COMMENT ON COLUMN "public"."subscriptions"."resource_id" IS
  '手动绑定的资源（资源管理）：转存后把新文件并入这条资源并更新集数；为空则按剧名自动匹配';

CREATE TABLE IF NOT EXISTS "public"."resource_sync_queue" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "user_id" uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    "resource_id" uuid NOT NULL REFERENCES public.resources(id) ON DELETE CASCADE,
    "resource_name" text DEFAULT ''::text NOT NULL,
    "reason" text DEFAULT ''::text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE "public"."resource_sync_queue" IS
  '服务端（订阅转存）改了资源后登记的待推送任务；前端打开资源管理页时自动把变更推到各站点，推完删除';

CREATE UNIQUE INDEX IF NOT EXISTS "idx_resource_sync_queue_resource"
  ON "public"."resource_sync_queue" USING btree ("resource_id");
CREATE INDEX IF NOT EXISTS "idx_resource_sync_queue_user"
  ON "public"."resource_sync_queue" USING btree ("user_id", "created_at" DESC);

ALTER TABLE "public"."resource_sync_queue" ENABLE ROW LEVEL SECURITY;

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'own_resource_sync_queue' AND n.nspname = 'public' AND c.relname = 'resource_sync_queue'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "own_resource_sync_queue" ON "public"."resource_sync_queue" FOR ALL TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;

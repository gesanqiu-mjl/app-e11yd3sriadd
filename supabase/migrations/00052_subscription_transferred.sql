-- 订阅分享目录监控：持久化「已转存基线」
-- 订阅（分享目录监控）的去重原本只靠「对比目标目录里已有的文件名」，
-- 但当文件被清洗成「高码」变体、或目标目录列不全/列目录失败时，已转文件会被误判为新增而重复转存。
-- 这里单独记一张基线表，以「分享条目 + 原始文件名」为稳定键，记录已经成功转存过的文件，
-- 跨运行持久保留，作为目标目录差集之外的第二道去重，确保同一个文件绝不会被二次转存。
CREATE TABLE IF NOT EXISTS subscription_transferred (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_key        text NOT NULL,
  file_name       text NOT NULL DEFAULT '',
  transferred_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_transferred_dedupe UNIQUE (subscription_id, file_key)
);

CREATE INDEX IF NOT EXISTS idx_subscription_transferred_sub
  ON subscription_transferred (subscription_id);

ALTER TABLE subscription_transferred ENABLE ROW LEVEL SECURITY;
GRANT ALL ON subscription_transferred TO authenticated;
GRANT ALL ON subscription_transferred TO service_role;

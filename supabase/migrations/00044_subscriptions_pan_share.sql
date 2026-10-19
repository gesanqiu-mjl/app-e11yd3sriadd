-- 分享目录订阅：把网盘分享链接本身当订阅源（监控分享里新增的文件）
-- 需要放开 source_type 的取值，并记录分享提取码（夸克分享常用）

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS source_passcode text;

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_type_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_type_check
  CHECK (source_type = ANY (ARRAY['auto'::text, 'rss'::text, 'page'::text, 'pan_share'::text]));

COMMENT ON COLUMN subscriptions.source_passcode IS '分享目录订阅的提取码（夸克分享常用；光鸭分享不需要）';
COMMENT ON COLUMN subscriptions.source_type IS 'auto / rss / page / pan_share（分享目录监控）';

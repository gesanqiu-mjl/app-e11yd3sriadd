-- 订阅：文件名清洗模式 + 转存目录（存目录 ID，用户重命名文件夹不影响转存）

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS clean_mode text NOT NULL DEFAULT 'none';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS target_dir_name text;

COMMENT ON COLUMN subscriptions.clean_mode IS '转存后文件名清洗：none=不处理，episode=精简为 S01E01 形式（无集数标记时去噪）';
COMMENT ON COLUMN subscriptions.target_dir IS '转存目录 ID（光鸭 fileId / 夸克 fid；存 ID 而非名称，用户改文件夹名不影响转存）';
COMMENT ON COLUMN subscriptions.target_dir_name IS '转存目录显示名（仅用于界面展示，不参与转存）';

-- ============================================================
-- API Key 绑定归属账号
-- 开放接口不再返回全站资源：每个密钥必须归属于某个账号，
-- 调用时只返回该账号自己名下的资源（更新中 / 已更新 / 已完结）。
-- ============================================================

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- 历史数据回填：优先归创建者，其次归首个管理员
UPDATE api_keys SET owner_id = created_by WHERE owner_id IS NULL AND created_by IS NOT NULL;
UPDATE api_keys SET owner_id = (
  SELECT id FROM profiles WHERE role = 'admin' ORDER BY created_at LIMIT 1
) WHERE owner_id IS NULL;

ALTER TABLE api_keys ALTER COLUMN owner_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_owner_id ON api_keys (owner_id);

COMMENT ON COLUMN api_keys.owner_id IS '密钥归属账号：接口只返回该账号名下的资源';
COMMENT ON COLUMN api_keys.api_key IS '密钥明文（rk_ 开头），仅管理员可见';

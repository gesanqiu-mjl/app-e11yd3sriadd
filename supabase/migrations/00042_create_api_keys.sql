-- ============================================================
-- API 管理（开放接口）
-- 管理员在「管理后台 → API 管理」创建 API Key，供自研工具 / 第三方程序
-- 通过开放接口读取资源数据（更新中 / 已更新 / 已完结）。
-- 开放接口：supabase/functions/resource-api（X-API-Key 鉴权，无需登录）
-- ============================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL DEFAULT '未命名应用',  -- 应用 / 用途名称，便于区分调用方
  api_key      text UNIQUE NOT NULL,                -- 密钥明文（rk_ 开头），仅管理员可见
  remark       text,                                -- 备注
  is_active    boolean NOT NULL DEFAULT true,       -- 停用后立即失效
  expires_at   timestamptz,                         -- 到期时间，NULL = 永久有效
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,                         -- 最近调用时间
  call_count   bigint NOT NULL DEFAULT 0,           -- 累计调用次数
  last_ip      text                                 -- 最近调用来源 IP
);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- 仅管理员可读写（密钥明文只对管理员可见，普通用户 / 匿名无权限）
CREATE POLICY "admin_full_access_api_keys" ON api_keys
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE INDEX IF NOT EXISTS idx_api_keys_created_at ON api_keys (created_at DESC);

-- 调用计数：开放接口每次鉴权通过后自增（原子自增，避免并发互相覆盖）
CREATE OR REPLACE FUNCTION touch_api_key(p_id uuid, p_ip text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE api_keys
  SET last_used_at = now(),
      call_count   = call_count + 1,
      last_ip      = COALESCE(p_ip, last_ip)
  WHERE id = p_id;
$$;

-- 批量取一批资源各自的「最近一次变更记录」，供开放接口附带最近更新信息。
-- DISTINCT ON 去重：每个资源只返回 changed_at 最大的一行。
CREATE OR REPLACE FUNCTION resource_last_changes(p_ids uuid[])
RETURNS TABLE (resource_id uuid, field_label text, changed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (h.resource_id)
         h.resource_id,
         h.field_label,
         h.changed_at
  FROM change_history h
  WHERE h.resource_id = ANY (p_ids)
  ORDER BY h.resource_id, h.changed_at DESC;
$$;

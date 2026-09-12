
-- 邀请码表
CREATE TABLE IF NOT EXISTS invite_codes (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  code        text UNIQUE NOT NULL,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  used_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  used_at     timestamptz,
  created_at  timestamptz DEFAULT now() NOT NULL,
  is_revoked  boolean DEFAULT false NOT NULL
);

ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;

-- 管理员：完整操作权限
CREATE POLICY "admin_full_access" ON invite_codes
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 未登录/普通用户：只能读取未使用、未撤销的邀请码（注册时验证用）
CREATE POLICY "anyone_read_valid_code" ON invite_codes
  FOR SELECT
  USING (used_by IS NULL AND is_revoked = false);

-- 原子消费邀请码：SELECT FOR UPDATE + UPDATE，避免并发重复使用
-- SECURITY DEFINER 跳过 RLS，确保注册完成后可安全标记
CREATE OR REPLACE FUNCTION consume_invite_code(p_code text, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
  FROM invite_codes
  WHERE code = p_code
    AND used_by IS NULL
    AND is_revoked = false
  FOR UPDATE SKIP LOCKED;

  IF v_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE invite_codes
  SET used_by = p_user_id, used_at = now()
  WHERE id = v_id;

  RETURN true;
END;
$$;

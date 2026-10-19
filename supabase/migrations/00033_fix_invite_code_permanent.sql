-- 修复 consume_invite_code：正确处理「永久」（membership_days = -1）
--
-- 原实现无条件 `now() + (v_days || ' days')::interval`，
-- 当邀请码时长取前端「永久（无期限）」选项（-1）时，会算出 now() - 1 day，
-- 导致用该邀请码注册的用户一进来就是「已过期」状态。
-- 与前端 updateProfileMembership（-1 → NULL）的语义保持一致。
CREATE OR REPLACE FUNCTION consume_invite_code(p_code text, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_days int;
BEGIN
  SELECT id, membership_days INTO v_id, v_days
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

  -- v_days < 0（-1）表示永久：membership_expires_at 置 NULL
  UPDATE profiles
  SET membership_expires_at = CASE
        WHEN v_days IS NULL OR v_days < 0 THEN NULL
        ELSE now() + (v_days || ' days')::interval
      END
  WHERE id = p_user_id;

  RETURN true;
END;
$$;

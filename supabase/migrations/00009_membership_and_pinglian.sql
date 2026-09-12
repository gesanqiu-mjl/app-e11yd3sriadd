-- 1. profiles 增加会员到期时间（NULL = 无限制/管理员）
ALTER TABLE profiles ADD COLUMN membership_expires_at timestamptz;

-- 2. invite_codes 增加该码对应的会员时长（天）
ALTER TABLE invite_codes ADD COLUMN membership_days int NOT NULL DEFAULT 30;

-- 3. 重写 consume_invite_code：消费时按 membership_days 设置会员到期时间
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

  UPDATE profiles
  SET membership_expires_at = now() + (v_days || ' days')::interval
  WHERE id = p_user_id;

  RETURN true;
END;
$$;

-- 4. pinglian 会话表：存储用户与 pinglian.lol 账号绑定（登录 Cookie）
CREATE TABLE public.pinglian_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cookie text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_check_at timestamptz,
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

-- 5. 发布记录缓存表
CREATE TABLE public.pinglian_links_cache (
  link_id bigint PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vod_id bigint,
  vod_name text,
  link_title text,
  link_url text,
  link_password text,
  pan_type text,
  created_at timestamptz,
  updated_at timestamptz,
  cached_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pinglian_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pinglian_links_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "session_select_own" ON public.pinglian_sessions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "session_insert_own" ON public.pinglian_sessions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "session_update_own" ON public.pinglian_sessions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "session_delete_own" ON public.pinglian_sessions FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "cache_select_own" ON public.pinglian_links_cache FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "cache_insert_own" ON public.pinglian_links_cache FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "cache_update_own" ON public.pinglian_links_cache FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "cache_delete_own" ON public.pinglian_links_cache FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_pinglian_sessions_user ON public.pinglian_sessions (user_id);
CREATE INDEX idx_pinglian_cache_user ON public.pinglian_links_cache (user_id);
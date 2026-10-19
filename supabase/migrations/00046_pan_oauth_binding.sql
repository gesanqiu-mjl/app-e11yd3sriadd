-- ============================================================
-- 网盘 OAuth 绑定（光鸭扫码 Device Flow）+ 绑定会话
--
-- 光鸭走开放平台 OAuth（device flow 扫码），拿到 access_token / refresh_token；
-- refresh_token 会轮换，必须随 access_token 一起回写，因此以 JSON 形式整体加密存储。
-- 夸克仍用 Cookie（cookie_enc），两套并存。
-- ============================================================

ALTER TABLE pan_accounts ADD COLUMN IF NOT EXISTS token_enc text;      -- 加密后的 OAuth 令牌 JSON
ALTER TABLE pan_accounts ADD COLUMN IF NOT EXISTS root_dir_id text;    -- 网盘目录 ID（光鸭用 fileId）
ALTER TABLE pan_accounts ADD COLUMN IF NOT EXISTS credential_type text NOT NULL DEFAULT 'cookie';

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pan_accounts_credential_type_check' AND conrelid = 'public.pan_accounts'::regclass
  ) THEN
    ALTER TABLE pan_accounts
      ADD CONSTRAINT pan_accounts_credential_type_check
      CHECK (credential_type IN ('cookie', 'oauth'));
  END IF;
END
$pg_schema_restore$;

-- 扫码绑定会话（临时态：device_code 轮询用）
CREATE TABLE IF NOT EXISTS pan_bind_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pan          text NOT NULL DEFAULT 'guangya',
  status       text NOT NULL DEFAULT 'pending',   -- pending | success | expired | failed
  device_code  text NOT NULL,
  interval     integer NOT NULL DEFAULT 2,
  expires_at   timestamptz NOT NULL,
  last_poll_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pan_bind_sessions_status_check CHECK (status IN ('pending', 'success', 'expired', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_pan_bind_sessions_user ON pan_bind_sessions (user_id, created_at DESC);

ALTER TABLE pan_bind_sessions ENABLE ROW LEVEL SECURITY;

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'own_pan_bind_sessions' AND n.nspname = 'public' AND c.relname = 'pan_bind_sessions'
  ) THEN
    CREATE POLICY "own_pan_bind_sessions" ON pan_bind_sessions
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END
$pg_schema_restore$;

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pan_bind_sessions_updated_at') THEN
    CREATE TRIGGER pan_bind_sessions_updated_at
      BEFORE UPDATE ON pan_bind_sessions
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END
$pg_schema_restore$;

-- 保存 OAuth 凭据（令牌 JSON 整体加密；仅 service_role 可调用）
CREATE OR REPLACE FUNCTION save_pan_oauth(
  p_user_id     uuid,
  p_pan         text,
  p_username    text,
  p_token_json  text,
  p_root_dir_id text,
  p_key         text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO pan_accounts (user_id, pan, username, token_enc, root_dir_id, credential_type, status)
  VALUES (
    p_user_id, p_pan, NULLIF(p_username, ''),
    encode(extensions.pgp_sym_encrypt(p_token_json, p_key), 'base64'),
    NULLIF(p_root_dir_id, ''),
    'oauth', 'active'
  )
  ON CONFLICT (user_id, pan) DO UPDATE SET
    username        = COALESCE(NULLIF(EXCLUDED.username, ''), pan_accounts.username),
    token_enc       = EXCLUDED.token_enc,
    root_dir_id     = COALESCE(EXCLUDED.root_dir_id, pan_accounts.root_dir_id),
    credential_type = 'oauth',
    status          = 'active',
    last_error      = NULL,
    updated_at      = now();
END;
$$;

-- 读取并解密 OAuth 凭据
CREATE OR REPLACE FUNCTION load_pan_oauth(p_user_id uuid, p_pan text, p_key text)
RETURNS TABLE (username text, token_json text, root_dir_id text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT a.username,
         CASE WHEN a.token_enc IS NULL THEN NULL
              ELSE extensions.pgp_sym_decrypt(decode(a.token_enc, 'base64'), p_key) END,
         a.root_dir_id, a.status
  FROM pan_accounts a
  WHERE a.user_id = p_user_id AND a.pan = p_pan;
END;
$$;

-- 刷新后回写令牌（refresh_token 轮换）
CREATE OR REPLACE FUNCTION update_pan_oauth_token(p_user_id uuid, p_pan text, p_token_json text, p_key text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE pan_accounts
  SET token_enc = encode(extensions.pgp_sym_encrypt(p_token_json, p_key), 'base64'),
      status = 'active',
      last_error = NULL,
      updated_at = now()
  WHERE user_id = p_user_id AND pan = p_pan;
$$;

REVOKE ALL ON FUNCTION save_pan_oauth(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION load_pan_oauth(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION update_pan_oauth_token(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_pan_oauth(uuid, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION load_pan_oauth(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION update_pan_oauth_token(uuid, text, text, text) TO service_role;

-- 前端可读的元信息补充（不含密文）
GRANT SELECT (credential_type, root_dir_id) ON pan_accounts TO authenticated;
REVOKE ALL ON pan_bind_sessions FROM anon;
GRANT ALL ON pan_bind_sessions TO authenticated;
GRANT ALL ON pan_bind_sessions TO service_role;

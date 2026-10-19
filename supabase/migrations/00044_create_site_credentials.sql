-- ============================================================
-- 站点登录凭据云端加密存储（site_credentials）
--
-- 目的：各站点会话（*_sessions）失效后，可用这里存的「账号密码 / Cookie」
--       自动重新登录，减少同步失败。凭据用 pgcrypto 对称加密后落库，
--       密钥 SITE_CRED_KEY 只存在 Edge Function 环境变量里，数据库只存密文。
--
-- 安全约定：
--   * 前端只能 select 元信息列（site/username/auto_login/失败记录），
--     密文列 secret_enc 未授权，任何前端请求都读不到；
--   * 写入 / 解密一律走 service role（Edge Function site-credential）；
--   * 加解密函数对 anon / authenticated 全部回收执行权限。
-- ============================================================

CREATE TABLE IF NOT EXISTS site_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 站点标识：ya / jying / hdhaven / framehdr / mukaku / pinglian / panfx / xn
  site            text NOT NULL,
  -- 站点账号名（展示用）
  username        text,
  -- 加密后的密码或 Cookie（pgp_sym_encrypt → base64）
  secret_enc      text,
  -- 凭据类型：password（账密型，可自动重登）/ cookie（仅 Cookie 型，只能人工更新）
  secret_kind     text NOT NULL DEFAULT 'password'
                  CONSTRAINT site_credentials_kind_check CHECK (secret_kind IN ('password', 'cookie')),
  -- 是否允许系统用该凭据自动重登
  auto_login      boolean NOT NULL DEFAULT true,
  last_success_at timestamptz,
  last_error      text,
  fail_count      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_credentials_user_site_key UNIQUE (user_id, site)
);

CREATE INDEX IF NOT EXISTS idx_site_credentials_user ON site_credentials (user_id);

ALTER TABLE site_credentials ENABLE ROW LEVEL SECURITY;

-- 仅本人可读写；写入实际只走 service role，前端拿到的是「只读元信息」
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'own_site_credentials' AND n.nspname = 'public' AND c.relname = 'site_credentials'
  ) THEN
    CREATE POLICY "own_site_credentials" ON site_credentials
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END
$pg_schema_restore$;

-- 列级权限：前端只可读元信息，读不到 secret_enc（密文也不外泄）
REVOKE ALL ON site_credentials FROM anon;
REVOKE ALL ON site_credentials FROM authenticated;
GRANT SELECT (
  id, user_id, site, username, secret_kind, auto_login,
  last_success_at, last_error, fail_count, created_at, updated_at
) ON site_credentials TO authenticated;
GRANT ALL ON site_credentials TO service_role;

-- updated_at 自动维护
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'site_credentials_updated_at') THEN
    CREATE TRIGGER site_credentials_updated_at
      BEFORE UPDATE ON site_credentials
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END
$pg_schema_restore$;

-- ------------------------------------------------------------
-- 加解密助手：密钥由 Edge Function 运行时传入（不落库）
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION site_secret_encrypt(p_plain text, p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT encode(extensions.pgp_sym_encrypt(p_plain, p_key), 'base64');
$$;

CREATE OR REPLACE FUNCTION site_secret_decrypt(p_enc text, p_key text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT extensions.pgp_sym_decrypt(decode(p_enc, 'base64'), p_key);
$$;

-- 保存 / 覆盖某个站点的凭据（p_secret 为空表示只更新账号名等元信息）
CREATE OR REPLACE FUNCTION save_site_credential(
  p_user_id    uuid,
  p_site       text,
  p_username   text,
  p_secret     text,
  p_kind       text,
  p_auto_login boolean,
  p_key        text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO site_credentials (user_id, site, username, secret_enc, secret_kind, auto_login)
  VALUES (
    p_user_id,
    p_site,
    NULLIF(p_username, ''),
    CASE WHEN p_secret IS NULL OR p_secret = '' THEN NULL
         ELSE encode(extensions.pgp_sym_encrypt(p_secret, p_key), 'base64') END,
    COALESCE(NULLIF(p_kind, ''), 'password'),
    COALESCE(p_auto_login, true)
  )
  ON CONFLICT (user_id, site) DO UPDATE SET
    username   = COALESCE(NULLIF(EXCLUDED.username, ''), site_credentials.username),
    secret_enc = COALESCE(EXCLUDED.secret_enc, site_credentials.secret_enc),
    secret_kind = EXCLUDED.secret_kind,
    auto_login = EXCLUDED.auto_login,
    updated_at = now();
END;
$$;

-- 读取并解密（仅 service role 调用）
CREATE OR REPLACE FUNCTION load_site_credential(p_user_id uuid, p_site text, p_key text)
RETURNS TABLE (username text, secret text, secret_kind text, auto_login boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT c.username,
         CASE WHEN c.secret_enc IS NULL THEN NULL
              ELSE extensions.pgp_sym_decrypt(decode(c.secret_enc, 'base64'), p_key) END,
         c.secret_kind,
         c.auto_login
  FROM site_credentials c
  WHERE c.user_id = p_user_id AND c.site = p_site;
END;
$$;

-- 记录巡检 / 重登结果
CREATE OR REPLACE FUNCTION mark_site_credential(
  p_user_id uuid,
  p_site    text,
  p_ok      boolean,
  p_error   text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE site_credentials
  SET last_success_at = CASE WHEN p_ok THEN now() ELSE last_success_at END,
      last_error      = CASE WHEN p_ok THEN NULL ELSE NULLIF(p_error, '') END,
      fail_count      = CASE WHEN p_ok THEN 0 ELSE fail_count + 1 END,
      updated_at      = now()
  WHERE user_id = p_user_id AND site = p_site;
$$;

-- 加解密与凭据读写函数只允许 service_role 调用（前端 / 匿名一律拒绝）
REVOKE ALL ON FUNCTION site_secret_encrypt(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION site_secret_decrypt(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION save_site_credential(uuid, text, text, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION load_site_credential(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mark_site_credential(uuid, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION site_secret_encrypt(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION site_secret_decrypt(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION save_site_credential(uuid, text, text, text, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION load_site_credential(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION mark_site_credential(uuid, text, boolean, text) TO service_role;

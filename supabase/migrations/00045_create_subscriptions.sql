-- ============================================================
-- 订阅转存（Subscription → Drive）
--
-- 流程：定时抓取订阅源（RSS / 网页更新页）→ 提取网盘分享链接
--       → 用云端加密保存的网盘账号转存到自己的光鸭/夸克网盘
--       → 自动写入 resources（进「已更新」）→ 可选自动发布到各站点
--
-- 表：
--   pan_accounts        网盘账号（转存用，Cookie 加密存储）
--   subscriptions       订阅源配置
--   subscription_items  抓取到的条目（去重 + 状态机 + 转存结果）
-- ============================================================

-- ---------------- 网盘账号（光鸭 / 夸克） ----------------
CREATE TABLE IF NOT EXISTS pan_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pan           text NOT NULL,                        -- guangya | quark
  username      text,
  cookie_enc    text,                                 -- 加密后的登录 Cookie（仅 service_role 可读）
  root_dir      text,                                 -- 转存目标目录（网盘内路径，空=默认）
  status        text NOT NULL DEFAULT 'active',       -- active | expired
  last_check_at timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pan_accounts_user_pan_key UNIQUE (user_id, pan),
  CONSTRAINT pan_accounts_pan_check CHECK (pan IN ('guangya', 'quark')),
  CONSTRAINT pan_accounts_status_check CHECK (status IN ('active', 'expired'))
);

-- ---------------- 订阅源 ----------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             text NOT NULL DEFAULT '未命名订阅',
  source_url       text NOT NULL,
  source_type      text NOT NULL DEFAULT 'auto',      -- auto | rss | page
  keyword          text,                              -- 关键字过滤（多个用 | 分隔，留空=全部）
  pan              text NOT NULL DEFAULT 'guangya',   -- 目标网盘 guangya | quark
  target_dir       text,                              -- 目标目录（空=网盘账号默认目录）
  auto_publish     boolean NOT NULL DEFAULT false,    -- 入库后自动发布到各站点
  enabled          boolean NOT NULL DEFAULT true,
  interval_minutes integer NOT NULL DEFAULT 30,       -- 定时轮询间隔（分钟）
  last_run_at      timestamptz,
  last_status      text,                              -- ok | partial | failed
  last_message     text,
  stats            jsonb NOT NULL DEFAULT '{}'::jsonb, -- {found,new,transferred,imported,failed}
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_type_check CHECK (source_type IN ('auto', 'rss', 'page')),
  CONSTRAINT subscriptions_pan_check CHECK (pan IN ('guangya', 'quark')),
  CONSTRAINT subscriptions_user_url_key UNIQUE (user_id, source_url)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_enabled ON subscriptions (enabled, last_run_at);

-- ---------------- 抓取条目 ----------------
CREATE TABLE IF NOT EXISTS subscription_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title           text NOT NULL DEFAULT '',
  source_url      text,                               -- 详情页 / 文章地址
  share_url       text,                               -- 提取到的网盘分享链接
  share_passcode  text,                               -- 提取码
  pan             text,                               -- 识别出的网盘
  fingerprint     text NOT NULL,                      -- 去重指纹（归一化分享链接）
  status          text NOT NULL DEFAULT 'pending',    -- pending|transferred|imported|failed|skipped
  transfer_url    text,                               -- 转存后自己的分享链接
  resource_id     uuid REFERENCES resources(id) ON DELETE SET NULL,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_items_status_check
    CHECK (status IN ('pending', 'transferred', 'imported', 'failed', 'skipped')),
  CONSTRAINT subscription_items_dedupe UNIQUE (subscription_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_subscription_items_user ON subscription_items (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_items_sub ON subscription_items (subscription_id, status);

-- ---------------- RLS ----------------
ALTER TABLE pan_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_items ENABLE ROW LEVEL SECURITY;

DO $pg_schema_restore$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pan_accounts', 'subscriptions', 'subscription_items'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE pol.polname = 'own_' || t AND n.nspname = 'public' AND c.relname = t
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())',
        'own_' || t, t
      );
    END IF;
  END LOOP;
END
$pg_schema_restore$;

-- 网盘 Cookie 密文列不对前端开放（写入走 service role 的 subscription-run）
REVOKE ALL ON pan_accounts FROM anon;
REVOKE ALL ON pan_accounts FROM authenticated;
GRANT SELECT (id, user_id, pan, username, root_dir, status, last_check_at, last_error, created_at, updated_at)
  ON pan_accounts TO authenticated;
GRANT ALL ON pan_accounts TO service_role;

-- 订阅配置与条目本身不含敏感信息，前端可直接读写（RLS 保证只操作自己的行）
GRANT ALL ON subscriptions TO authenticated;
GRANT ALL ON subscriptions TO service_role;
GRANT ALL ON subscription_items TO authenticated;
GRANT ALL ON subscription_items TO service_role;

-- ---------------- updated_at 自动维护 ----------------
DO $pg_schema_restore$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pan_accounts', 'subscriptions', 'subscription_items'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_updated_at') THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
        t || '_updated_at', t
      );
    END IF;
  END LOOP;
END
$pg_schema_restore$;

-- ---------------- 网盘账号保存（服务端调用，加密） ----------------
CREATE OR REPLACE FUNCTION save_pan_account(
  p_user_id  uuid,
  p_pan      text,
  p_username text,
  p_cookie   text,
  p_root_dir text,
  p_key      text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO pan_accounts (user_id, pan, username, cookie_enc, root_dir, status)
  VALUES (
    p_user_id, p_pan, NULLIF(p_username, ''),
    CASE WHEN p_cookie IS NULL OR p_cookie = '' THEN NULL
         ELSE encode(extensions.pgp_sym_encrypt(p_cookie, p_key), 'base64') END,
    NULLIF(p_root_dir, ''),
    'active'
  )
  ON CONFLICT (user_id, pan) DO UPDATE SET
    username   = COALESCE(NULLIF(EXCLUDED.username, ''), pan_accounts.username),
    cookie_enc = COALESCE(EXCLUDED.cookie_enc, pan_accounts.cookie_enc),
    root_dir   = COALESCE(EXCLUDED.root_dir, pan_accounts.root_dir),
    status     = 'active',
    last_error = NULL,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION load_pan_account(p_user_id uuid, p_pan text, p_key text)
RETURNS TABLE (username text, cookie text, root_dir text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT a.username,
         CASE WHEN a.cookie_enc IS NULL THEN NULL
              ELSE extensions.pgp_sym_decrypt(decode(a.cookie_enc, 'base64'), p_key) END,
         a.root_dir, a.status
  FROM pan_accounts a
  WHERE a.user_id = p_user_id AND a.pan = p_pan;
END;
$$;

CREATE OR REPLACE FUNCTION mark_pan_account(p_user_id uuid, p_pan text, p_ok boolean, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE pan_accounts
  SET status        = CASE WHEN p_ok THEN 'active' ELSE 'expired' END,
      last_check_at = now(),
      last_error    = CASE WHEN p_ok THEN NULL ELSE NULLIF(p_error, '') END,
      updated_at    = now()
  WHERE user_id = p_user_id AND pan = p_pan;
$$;

REVOKE ALL ON FUNCTION save_pan_account(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION load_pan_account(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mark_pan_account(uuid, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_pan_account(uuid, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION load_pan_account(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION mark_pan_account(uuid, text, boolean, text) TO service_role;

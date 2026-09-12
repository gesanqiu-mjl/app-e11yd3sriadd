-- 登录页配置表（单行单例）
CREATE TABLE login_config (
  id integer PRIMARY KEY DEFAULT 1,
  left_bg_color text NOT NULL DEFAULT '#1a6b4a',
  left_use_bg_image boolean NOT NULL DEFAULT false,
  left_bg_image_url text,
  left_logo_url text,
  left_title text NOT NULL DEFAULT '资源更新追踪',
  left_heading text NOT NULL DEFAULT '高效追踪每一部剧集的更新',
  left_description text NOT NULL DEFAULT '智能解析、批量导入、自动变更检测。修改即同步到已更新栏，一键复制即可分享。',
  left_copyright text NOT NULL DEFAULT '© 2026 资源更新追踪系统',
  right_title text NOT NULL DEFAULT '欢迎回来',
  right_subtitle text NOT NULL DEFAULT '登录以管理你的剧集资源',
  right_btn_text text NOT NULL DEFAULT '登录',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT login_config_singleton CHECK (id = 1)
);

-- 插入默认行
INSERT INTO login_config (id) VALUES (1);

-- 启用 RLS
ALTER TABLE login_config ENABLE ROW LEVEL SECURITY;

-- 任何人可读（登录页未登录也需要读取）
CREATE POLICY "public_read_login_config"
  ON login_config FOR SELECT
  TO anon, authenticated
  USING (true);

-- 仅管理员可修改
CREATE POLICY "admin_update_login_config"
  ON login_config FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Login assets 存储桶
INSERT INTO storage.buckets (id, name, public)
VALUES ('login-assets', 'login-assets', true);

-- 公开读取
CREATE POLICY "public_read_login_assets"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'login-assets');

-- 管理员上传
CREATE POLICY "admin_upload_login_assets"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'login-assets' AND
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 管理员更新
CREATE POLICY "admin_update_login_assets"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'login-assets' AND
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 管理员删除
CREATE POLICY "admin_delete_login_assets"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'login-assets' AND
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
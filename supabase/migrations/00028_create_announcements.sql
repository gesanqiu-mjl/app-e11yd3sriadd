-- 公告表：管理员自定义公告，顶部滚动展示
CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 启用 RLS
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

-- 任何人可读（顶部公告未登录也可见）
CREATE POLICY "public_read_announcements"
  ON announcements FOR SELECT
  TO anon, authenticated
  USING (true);

-- 仅管理员可增删改
CREATE POLICY "admin_insert_announcements"
  ON announcements FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "admin_update_announcements"
  ON announcements FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "admin_delete_announcements"
  ON announcements FOR DELETE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE INDEX idx_announcements_active_sort ON announcements (is_active, sort_order, created_at DESC);
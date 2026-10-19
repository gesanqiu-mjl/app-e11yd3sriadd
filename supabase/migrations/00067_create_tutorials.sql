-- 首页图文教程：管理员维护「标题 + 正文 + 多张图片」，前台首页可查看。
--
-- 权限模型沿用 announcements（公开可读、仅管理员可写）：
--   前台（含未登录）需要读取教程内容，所以 SELECT 对 anon / authenticated 全开；
--   增删改一律限管理员。
--
-- 图片单独放 tutorials 公开桶，避免与 login-assets / covers 混用。

CREATE TABLE IF NOT EXISTS public.tutorials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tutorials IS '首页图文教程（管理员维护，前台展示）';
COMMENT ON COLUMN public.tutorials.images IS '教程图片公开地址数组（jsonb array of text）';
COMMENT ON COLUMN public.tutorials.content IS '教程正文，按换行分段展示';

CREATE INDEX IF NOT EXISTS idx_tutorials_active_sort
  ON public.tutorials (is_active, sort_order, created_at DESC);

ALTER TABLE public.tutorials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_tutorials" ON public.tutorials;
CREATE POLICY "public_read_tutorials"
  ON public.tutorials FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "admin_insert_tutorials" ON public.tutorials;
CREATE POLICY "admin_insert_tutorials"
  ON public.tutorials FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

DROP POLICY IF EXISTS "admin_update_tutorials" ON public.tutorials;
CREATE POLICY "admin_update_tutorials"
  ON public.tutorials FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

DROP POLICY IF EXISTS "admin_delete_tutorials" ON public.tutorials;
CREATE POLICY "admin_delete_tutorials"
  ON public.tutorials FOR DELETE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

-- 教程图片桶（公开读）
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tutorials', 'tutorials', true,
  5242880,
  ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
ON CONFLICT (id) DO UPDATE
  SET public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

DROP POLICY IF EXISTS "public_read_tutorial_images" ON storage.objects;
CREATE POLICY "public_read_tutorial_images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'tutorials');

DROP POLICY IF EXISTS "admin_upload_tutorial_images" ON storage.objects;
CREATE POLICY "admin_upload_tutorial_images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'tutorials' AND
    EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

DROP POLICY IF EXISTS "admin_update_tutorial_images" ON storage.objects;
CREATE POLICY "admin_update_tutorial_images"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'tutorials' AND
    EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

DROP POLICY IF EXISTS "admin_delete_tutorial_images" ON storage.objects;
CREATE POLICY "admin_delete_tutorial_images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'tutorials' AND
    EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

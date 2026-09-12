-- 封面图 URL 字段
ALTER TABLE public.resources ADD COLUMN cover_url text;

-- 公开 covers bucket（图片无需鉴权）
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'covers', 'covers', true,
  5242880,
  ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
ON CONFLICT (id) DO NOTHING;

-- 存储策略：已登录用户可上传，所有人可读
CREATE POLICY "Authenticated users can upload covers"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'covers');

CREATE POLICY "Anyone can read covers"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'covers');

CREATE POLICY "Owner can update covers"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'covers' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Owner can delete covers"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'covers' AND auth.uid()::text = (storage.foldername(name))[1]);
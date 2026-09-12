-- 1. 删除危险的 anon 全量读写策略（未登录者可读写所有账号数据）
DROP POLICY IF EXISTS "anon_all_resources" ON resources;
DROP POLICY IF EXISTS "anon_all_history" ON change_history;

-- 2. owner_id 默认取当前登录用户（insert 可不带 owner_id）
ALTER TABLE resources ALTER COLUMN owner_id SET DEFAULT auth.uid();

-- 3. change_history：删除也仅限本人（原 INSERT/SELECT 已隔离，补 DELETE）
DROP POLICY IF EXISTS "Owner can delete own history" ON change_history;
CREATE POLICY "Owner can delete own history" ON change_history
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- 4. Storage covers：上传必须传到本人文件夹（uid 为第一级目录）
DROP POLICY IF EXISTS "Authenticated users can upload covers" ON storage.objects;
CREATE POLICY "Authenticated users can upload covers" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'covers'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 5. 历史 owner_id 为空的资源数据不可见（防脏数据越权）
-- RLS 本身已保证（owner_id = uid() 对 NULL 不成立），无需额外策略
-- 暂存主账号：记录暂存目录的名称（仅用于后台展示「绑定云盘的信息目录」）
ALTER TABLE public.staging_accounts ADD COLUMN IF NOT EXISTS "root_dir_name" text;
COMMENT ON COLUMN public.staging_accounts."root_dir_name" IS '暂存目录名称（展示用，root_dir_id 对应的文件夹名）';

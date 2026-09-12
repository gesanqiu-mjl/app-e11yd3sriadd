-- 添加 links JSONB 列，存储多云盘链接数组 [{url, pan_name}]
ALTER TABLE resources ADD COLUMN IF NOT EXISTS links JSONB DEFAULT '[]'::jsonb;

-- 将现有 link 字段数据迁移到 links 数组（pan_name 留空，前端自动识别时补充）
UPDATE resources
SET links = jsonb_build_array(
  jsonb_build_object('url', link, 'pan_name', '')
)
WHERE link IS NOT NULL AND link != '' AND (links IS NULL OR links = '[]'::jsonb);
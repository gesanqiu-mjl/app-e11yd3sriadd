-- 删除冗余字段，只保留 name / episode_count / link
ALTER TABLE resources DROP COLUMN IF EXISTS type_tag;
ALTER TABLE resources DROP COLUMN IF EXISTS quality;
ALTER TABLE resources DROP COLUMN IF EXISTS audio_tag;
ALTER TABLE resources DROP COLUMN IF EXISTS version_tag;
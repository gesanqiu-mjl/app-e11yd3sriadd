
-- 资源表
CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type_tag text NOT NULL DEFAULT '',
  episode_count integer NOT NULL DEFAULT 0,
  quality text NOT NULL DEFAULT '',
  audio_tag text NOT NULL DEFAULT '',
  version_tag text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 修改历史表
CREATE TABLE change_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid REFERENCES resources(id) ON DELETE CASCADE,
  resource_name text NOT NULL,
  field_name text NOT NULL,
  field_label text NOT NULL,
  old_value text NOT NULL DEFAULT '',
  new_value text NOT NULL DEFAULT '',
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- updated_at 自动更新触发器
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER resources_updated_at
  BEFORE UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_history ENABLE ROW LEVEL SECURITY;

-- 开放全部访问（无需登录）
CREATE POLICY "anon_all_resources" ON resources FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_history" ON change_history FOR ALL TO anon USING (true) WITH CHECK (true);

-- 初始化示例数据
INSERT INTO resources (name, type_tag, episode_count, quality, audio_tag, version_tag, link, sort_order) VALUES
  ('择日飞升', '【2026 国漫】', 8, '4K HDR 高码率', '【杜比环绕声+立体环绕声】', '【纯净版、不缺集】', 'https://www.guangyapan.com/s/1935553455604404319_aeZIFqDoqz15G-J_', 1),
  ('完美世界', '【国漫】', 284, '4K 臻彩10B+1080p无损', '', '【纯净版、不缺集】', 'https://www.guangyapan.com/s/1935557581490925652_aeZIFqDoqz15G-J_', 2),
  ('沧元图 年番', '【2026 国漫】', 92, '【4K SDR （25+60）帧 高码率】', '', '', 'https://www.guangyapan.com/s/1940257675910320160_aeZIFqDoqz15G-J_', 3),
  ('绝世唐门', '【2026 国漫】', 168, '【4K SDR 增强 10bit】', '[HIFI 声&杜比音效&立体环绕声]', '【纯净】', 'https://www.guangyapan.com/s/1935565658898313275_aeZIFqDoqz15G-J_', 4),
  ('时光代理人 第三季', '【新番开播】', 4, '4K SDR 增强 高码率', '', '【纯净版】', 'https://www.guangyapan.com/s/1935571182641475590_aeZIFqDoqz15G-J_', 5),
  ('大主宰 年番', '【2026 国漫】', 88, '【4K HDR 高码率+4K DV 高码率】', '[杜比环绕声+立体环绕声]', '【纯净版】', 'https://www.guangyapan.com/s/1935570974100676697_aeZIFqDoqz15G-J_', 6);

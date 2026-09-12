-- 资源与盘链站点剧集绑定表（一个资源只能绑定一个站点剧集）
CREATE TABLE resource_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  link_id bigint NOT NULL,
  link_title text,
  vod_name text,
  pan_type text DEFAULT 'others',
  link_password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_id)
);

ALTER TABLE resource_bindings ENABLE ROW LEVEL SECURITY;

-- 仅资源所有者可操作绑定关系
CREATE POLICY "binding_owner_all" ON resource_bindings
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM resources WHERE id = resource_id AND owner_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM resources WHERE id = resource_id AND owner_id = auth.uid())
  );

CREATE INDEX idx_resource_bindings_resource ON resource_bindings (resource_id);
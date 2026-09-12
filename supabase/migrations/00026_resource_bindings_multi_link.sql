-- 盘链绑定支持一资源多链接：去掉 resource_id 单键唯一，改为 (resource_id, link_id) 复合唯一
ALTER TABLE public.resource_bindings
  DROP CONSTRAINT IF EXISTS resource_bindings_resource_id_key;
ALTER TABLE public.resource_bindings
  ADD CONSTRAINT resource_bindings_resource_link_uniq UNIQUE (resource_id, link_id);
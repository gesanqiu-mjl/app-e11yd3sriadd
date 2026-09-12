-- 观影站点绑定表：支持一个资源绑定多条分享记录（每条对应一种网盘）
alter table public.xn_resource_bindings
  drop constraint if exists xn_resource_bindings_resource_id_key;
alter table public.xn_resource_bindings
  add constraint xn_resource_bindings_resource_share_key unique (resource_id, share_id);
alter table public.xn_resource_bindings
  add column if not exists pan_label text;

-- 鸭影臻藏绑定表：先清理历史重复（保留最新一条），再建复合唯一
alter table public.ya_resource_bindings
  add column if not exists pan_label text;
delete from public.ya_resource_bindings a
  using public.ya_resource_bindings b
  where a.id > b.id and a.resource_id = b.resource_id and a.link_id = b.link_id;
alter table public.ya_resource_bindings
  drop constraint if exists ya_resource_bindings_resource_link_key;
alter table public.ya_resource_bindings
  add constraint ya_resource_bindings_resource_link_key unique (resource_id, link_id);
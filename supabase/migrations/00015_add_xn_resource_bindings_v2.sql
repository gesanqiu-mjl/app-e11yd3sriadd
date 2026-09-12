
create table if not exists public.xn_resource_bindings (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources(id) on delete cascade,
  share_id text not null,
  share_title text,
  share_url text,
  created_at timestamptz not null default now(),
  unique (resource_id)
);
create index if not exists idx_xn_rb_resource on public.xn_resource_bindings (resource_id);

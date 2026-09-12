
-- 帧影站点资源绑定关系（与 ya_resource_bindings / xn_resource_bindings 同构）
create table if not exists public.framehdr_resource_bindings (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources (id) on delete cascade,
  link_id integer not null,
  link_title text,
  drive_name text,
  created_at timestamptz not null default now(),
  unique (resource_id)
);

create index if not exists idx_framehdr_rb_resource
  on public.framehdr_resource_bindings (resource_id);

alter table public.framehdr_resource_bindings enable row level security;

drop policy if exists "framehdr_rb_select_own" on public.framehdr_resource_bindings;
create policy "framehdr_rb_select_own" on public.framehdr_resource_bindings
  for select using (
    exists (
      select 1 from public.resources r
      where r.id = framehdr_resource_bindings.resource_id and r.owner_id = auth.uid()
    )
  );

drop policy if exists "framehdr_rb_insert_own" on public.framehdr_resource_bindings;
create policy "framehdr_rb_insert_own" on public.framehdr_resource_bindings
  for insert with check (
    exists (
      select 1 from public.resources r
      where r.id = framehdr_resource_bindings.resource_id and r.owner_id = auth.uid()
    )
  );

drop policy if exists "framehdr_rb_update_own" on public.framehdr_resource_bindings;
create policy "framehdr_rb_update_own" on public.framehdr_resource_bindings
  for update using (
    exists (
      select 1 from public.resources r
      where r.id = framehdr_resource_bindings.resource_id and r.owner_id = auth.uid()
    )
  );

drop policy if exists "framehdr_rb_delete_own" on public.framehdr_resource_bindings;
create policy "framehdr_rb_delete_own" on public.framehdr_resource_bindings
  for delete using (
    exists (
      select 1 from public.resources r
      where r.id = framehdr_resource_bindings.resource_id and r.owner_id = auth.uid()
    )
  );

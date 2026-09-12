
create table if not exists public.resource_submissions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text check (category in ('movie', 'series', 'anime')),
  episode_count integer,
  link_url text,
  extract_code text,
  remark text,
  submitter_name text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create index if not exists idx_resource_submissions_status
  on public.resource_submissions (status, created_at desc);

alter table public.resource_submissions enable row level security;

drop policy if exists "resource_submissions_insert" on public.resource_submissions;
create policy "resource_submissions_insert" on public.resource_submissions
  for insert with check (true);

drop policy if exists "resource_submissions_select_admin" on public.resource_submissions;
create policy "resource_submissions_select_admin" on public.resource_submissions
  for select using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );

drop policy if exists "resource_submissions_update_admin" on public.resource_submissions;
create policy "resource_submissions_update_admin" on public.resource_submissions
  for update using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );

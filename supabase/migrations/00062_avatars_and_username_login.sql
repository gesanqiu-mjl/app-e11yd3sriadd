-- 个人中心：头像 + 可修改用户名
--
-- 1) profiles.avatar_url：头像地址（存于 avatars bucket）
-- 2) avatars bucket：公开读；登录用户只能写自己的目录 avatars/<uid>/...
-- 3) resolve_login_email RPC：用「用户名」解析出登录邮箱。
--    背景：本项目注册时把「用户名@miaoda.com」当作登录邮箱，用户名一旦可改，
--    邮箱与用户名就不再对应 —— 必须有这条映射，改过用户名的账号才能继续登录。

alter table public.profiles
  add column if not exists avatar_url text;
comment on column public.profiles.avatar_url is '用户头像地址（存于 avatars bucket 的公开 URL）';

-- ── 头像存储桶 ──
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists avatars_owner_insert on storage.objects;
create policy avatars_owner_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── 用户名 → 登录邮箱 ──
-- 注意：返回的是该账号「当前真实」的登录邮箱，因此与邮箱命名规则无关，改过用户名也能登录。
create or replace function public.resolve_login_email(p_username text)
returns text
language sql
security definer
set search_path = public
as $$
  select u.email::text
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.username is not null
     and lower(p.username) = lower(btrim(p_username))
   limit 1;
$$;

revoke all on function public.resolve_login_email(text) from public;
grant execute on function public.resolve_login_email(text) to anon, authenticated;

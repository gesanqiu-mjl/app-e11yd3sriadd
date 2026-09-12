-- 修改管理员用户名为 gesanqiu，邮箱与密码同步更新
UPDATE auth.users
SET
  email = 'gesanqiu@miaoda.com',
  encrypted_password = crypt('sxt010326', gen_salt('bf')),
  raw_user_meta_data = raw_user_meta_data || '{"username":"gesanqiu"}'::jsonb,
  updated_at = now()
WHERE email = 'admin@miaoda.com';

UPDATE public.profiles
SET username = 'gesanqiu'
WHERE email = 'admin@miaoda.com';

UPDATE public.profiles
SET email = 'gesanqiu@miaoda.com'
WHERE username = 'gesanqiu';
-- v3：盘链改为账号密码登录绑定，新增 username 字段（盘链账号名，登录成功后回填）
ALTER TABLE public.pinglian_sessions
  ADD COLUMN IF NOT EXISTS username text NOT NULL DEFAULT '';
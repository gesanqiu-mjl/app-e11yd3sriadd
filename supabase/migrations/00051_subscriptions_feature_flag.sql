-- 订阅功能权限开关
-- 默认关闭：新注册用户不自动获得订阅功能，须由管理员在「用户管理」中为其开通。
-- 存量用户（含已在使用的）一律默认开通，避免上线后老用户突然用不了。
alter table public.profiles
  add column if not exists subscriptions_enabled boolean not null default false;

update public.profiles set subscriptions_enabled = true;

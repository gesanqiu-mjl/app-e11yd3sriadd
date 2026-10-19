-- 让「会员时长只能来自邀请码消费」
--
-- 背景：isMembershipActive 把 membership_expires_at 为 NULL 视为「无限制」，
-- 而 handle_new_user() 建 profile 时不写该列（沿用列默认值 NULL）。
-- 于是任何「注册成功但邀请码未消费」的路径（自动登录失败、并发抢码失败等）
-- 都会让账号白得永久会员。
--
-- 对策：默认值改为 now()（立即过期）。新注册用户的会员天然是过期的，
-- 只有 consume_invite_code 成功写入时长后才会生效；
-- 而「永久」仍由 consume_invite_code 显式写入 NULL 表达，语义不变。
alter table public.profiles
  alter column membership_expires_at set default now();

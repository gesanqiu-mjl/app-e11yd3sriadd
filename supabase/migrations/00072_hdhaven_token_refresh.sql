-- ============================================================
-- 栖影 HDHaven：补充 refresh_token 持久化
--
-- 依据站点 OPENAPI 文档「换取 Token」一节，token 响应包含：
--   access_token、expires_in、refresh_token、token_type、scope、user_number
-- 原实现只保存 access_token，令牌一过期就只能让用户重新授权，
-- 与「授权 Token 长期有效」的产品预期不符。
--
-- 本迁移增加两列：
--   * refresh_token_enc —— refresh_token 用 pgcrypto 加密后的 base64，
--                          密钥 SITE_CRED_KEY 仅存在于 Edge Function 环境变量；
--   * token_expires_at  —— access_token 的到期时间（按 expires_in 推算），
--                          边缘函数据此在过期前自动用 refresh_token 续期。
--
-- 沿用 site_credentials 同一套加密 RPC（site_secret_encrypt/decrypt），
-- 并把两列一并挡在列级权限之外：authenticated 只能读到期时间，
-- 读不到任何密文。
-- ============================================================

alter table public.hdhaven_sessions
  add column if not exists refresh_token_enc text,
  add column if not exists token_expires_at  timestamptz;

comment on column public.hdhaven_sessions.refresh_token_enc is
  'refresh_token 经 site_secret_encrypt 加密后的 base64；解密密钥 SITE_CRED_KEY 只在 Edge Function 环境变量';
comment on column public.hdhaven_sessions.token_expires_at is
  'access_token 到期时间（授权时按 expires_in 推算）；边缘函数在到期前自动续期';

-- 历史授权数据没有到期时间，按「未知即不刷新」处理，
-- 首次成功调用后由边缘函数补齐（site_secret_encrypt 的密文格式自带完整性校验，
-- 这里不需要额外回填）。
update public.hdhaven_sessions
set token_expires_at = null
where token_expires_at is not null and access_token_enc is null;

-- 列级权限收紧：authenticated 只能看是否已授权 / 何时到期，读不到密文
grant select (token_expires_at) on public.hdhaven_sessions to authenticated;

-- 清理过期授权中间态（授权码 10 分钟有效，这里顺带回收 1 小时前的残留）
delete from public.hdhaven_oauth_states
where created_at < now() - interval '1 hour';
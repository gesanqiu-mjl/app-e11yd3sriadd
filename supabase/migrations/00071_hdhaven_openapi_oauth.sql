-- ============================================================
-- 栖影 HDHaven 接入方式变更：网页 Cookie 会话 → 官方 OpenAPI OAuth
--
-- 背景：
--   原实现依赖站点网页版的同源 httpOnly 会话 Cookie（hdhaven_sessions.cookie）。
--   站点 2026-10 起在登录接口加了 Cloudflare Turnstile 人机验证，账号密码无法自动登录，
--   只能让用户人工粘贴 Cookie，且 Cookie 会话随时过期、还需图形验证码兜底。
--   站点现已开放官方 OpenAPI（授权码 + PKCE），access_token 长期有效，
--   因此改为 OAuth 授权码换取 token、以 Bearer + X-HDHaven-App-Key 调用。
--
-- 本迁移只改「凭据存储形态」，不删 cookie 列：
--   * 避免旧版本边缘函数（尚未部署）在部署窗口内读不到 cookie 而报错；
--   * cookie 是明文敏感值，这里直接清空，新逻辑一律不再写入。
--
-- 密钥处理：access_token 用 pgcrypto 对称加密落库，密钥 SITE_CRED_KEY 仅存在于
--   Edge Function 环境变量（与 site_credentials 同一套 site_secret_encrypt/decrypt RPC），
--   数据库只存密文。
-- ============================================================

-- ── ① hdhaven_sessions：新增 OpenAPI 字段 ────────────────────────
alter table public.hdhaven_sessions
  add column if not exists access_token_enc text,          -- pgcrypto 加密后的 access_token
  add column if not exists token_type      text default 'Bearer',
  add column if not exists scope           text,           -- 授权时批准的 scope（空格分隔）
  add column if not exists authorized_at   timestamptz;    -- 最近一次授权成功时间

comment on column public.hdhaven_sessions.access_token_enc is
  'OpenAPI access_token，pgp_sym_encrypt 后的 base64；解密密钥 SITE_CRED_KEY 只在 Edge Function 环境变量';
comment on column public.hdhaven_sessions.scope is
  'OAuth 授权返回的 scope（空格分隔）；空表示站点已批准的全部权限';
comment on column public.hdhaven_sessions.cookie is
  '已废弃：站点登录改走官方 OAuth（Turnstile 使账号密码登录不可行）。此列不再写入，旧明文值已清空。';

-- 清空历史明文 Cookie，避免明文会话长期滞留库中
update public.hdhaven_sessions set cookie = '' where cookie <> '';

-- ── ② hdhaven_oauth_states：OAuth 防 CSRF / PKCE 中间态 ───────────
-- 存 state → (user_id, code_verifier) 的映射：
--   * state 用于回调时校验，防 CSRF；
--   * code_verifier 留在服务端，回调换 token 时做 PKCE S256 校验，
--     前端全程拿不到 verifier，即使被 XSS 读到授权码也无法换取 token；
--   * 授权码 10 分钟有效且只能用一次，因此 used_at 标记一次性消费。
create table if not exists public.hdhaven_oauth_states (
  state         text primary key,                      -- 随机高熵串（>=32 字符）
  user_id       uuid not null references auth.users (id) on delete cascade,
  code_verifier text not null,                         -- PKCE verifier，仅服务端持有
  redirect_uri  text not null,                         -- 当次发起授权用的 redirect_uri，换 token 时须一致
  created_at    timestamptz not null default now(),
  used_at       timestamptz                           -- 非空表示已消费，不可重放
);

create index if not exists idx_hdhaven_oauth_states_user on public.hdhaven_oauth_states (user_id);

-- 无策略 + 撤销客户端权限：只有 service_role（经边缘函数）能读写
alter table public.hdhaven_oauth_states enable row level security;
revoke all on public.hdhaven_oauth_states from anon, authenticated;
grant all on public.hdhaven_oauth_states to service_role;

-- 清理过期未使用的授权中间态（pg_cron 每天跑一次即可，这里只建索引不建任务）
create index if not exists idx_hdhaven_oauth_states_created on public.hdhaven_oauth_states (created_at);

-- ── ③ 列级权限收紧：前端读不到 access_token 密文 ──────────────────
-- 与 site_credentials 同一套做法。RLS 只解决「读不到别人的行」，
-- 这里进一步用列级权限解决「读不到自己那行的密文」：
--   * cookie / access_token_enc → 只给 service_role（边缘函数解密用）
--   * 前端仍需能查绑定状态、也能自己解绑（delete）
REVOKE ALL ON public.hdhaven_sessions FROM anon, authenticated;
GRANT SELECT (
  id, user_id, username, user_number, status, scope,
  authorized_at, last_check_at, remark, created_at, updated_at
) ON public.hdhaven_sessions TO authenticated;
GRANT DELETE ON public.hdhaven_sessions TO authenticated;
GRANT ALL ON public.hdhaven_sessions TO service_role;
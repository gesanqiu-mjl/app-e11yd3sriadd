-- 对齐集成包 database.sql：mukaku_tokens 的 updated_at 自动维护 + 表/列注释
-- （00031 已建表与索引，此处补齐 database.sql 中缺失的 trigger 与注释部分）

comment on table public.mukaku_tokens is 'web3.mukaku.com 站点登录凭据（账号密码登录，密码不落库）';
comment on column public.mukaku_tokens.access_token is '站点 JWT，有效期 7 天，无 refresh 机制，过期需重新登录';

-- updated_at 自动维护
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_mukaku_tokens_touch on public.mukaku_tokens;
create trigger trg_mukaku_tokens_touch
  before update on public.mukaku_tokens
  for each row execute function public.touch_updated_at();

create index if not exists idx_mukaku_tokens_status on public.mukaku_tokens (status);

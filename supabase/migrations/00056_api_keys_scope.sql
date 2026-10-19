-- API Key 数据范围：owner=仅归属账号（默认）；all=全部账号
--
-- 背景：「订阅入库通知」接口（/resource-api/subscriptions）需要一把管理员创建的密钥就能查询
--       **所有账号**的订阅入库记录（管理员做统一通知）；而其它接口仍只返回归属账号的数据。
--
-- 规则：
--   * 取值范围 owner | all，默认 owner；
--   * scope='all' 时，/subscriptions 默认查询所有账号，可用 account=<用户名或用户 ID> 收窄；
--   * scope='owner'（默认）时行为不变，只返回密钥归属账号自己的入库记录；
--   * 资源类接口（/resources、/updated、/finished、/stats）无论哪种范围都仍只看归属账号；
--   * 该列只有管理员能写（api_keys 表的 RLS 策略本身就是「仅管理员全权」）。

alter table public.api_keys
  add column if not exists scope text not null default 'owner';

do $mig$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'api_keys' and c.conname = 'api_keys_scope_check'
  ) then
    alter table public.api_keys
      add constraint api_keys_scope_check check (scope in ('owner', 'all'));
  end if;
end
$mig$;

comment on column public.api_keys.scope is
  '数据范围：owner=仅密钥归属账号；all=全部账号（订阅入库通知接口 /subscriptions 可跨账号查询，仅管理员可创建）';

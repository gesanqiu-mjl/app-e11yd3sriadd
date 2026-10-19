-- ============================================================
-- 邀请码校验：补回 check_invite_code（此前只在托管库里手建过，未进 migrations），
-- 并新增返回「原因」的 check_invite_code_status，供注册页给出可定位的提示。
--
-- 背景：注册页原来只拿到 true/false，于是「码不存在 / 已被使用 / 已被撤销」都提示成
-- 「邀请码无效或已被使用」，管理员无法判断到底是哪种情况（实测最常见的是码被撤销了）。
--
-- 说明：
--   · 两个函数都是 SECURITY DEFINER + 只回状态，不暴露码值 / 创建者 / 记录条数；
--   · 码比对统一 upper(btrim())，不区分大小写与首尾空格。
-- ============================================================

-- ── 1. 兼容旧前端：布尔版（幂等重建，保证全新部署也有这个函数） ──
create or replace function public.check_invite_code(p_code text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.invite_codes
    where code = upper(btrim(p_code))
      and used_by is null
      and is_revoked = false
  );
$$;

-- ── 2. 新版：返回原因 ok / used / revoked / invalid ──
create or replace function public.check_invite_code_status(p_code text)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((
    select case
             when c.is_revoked then 'revoked'
             when c.used_by is not null then 'used'
             else 'ok'
           end
    from public.invite_codes c
    where c.code = upper(btrim(p_code))
    limit 1
  ), 'invalid');
$$;

revoke all on function public.check_invite_code(text) from public;
revoke all on function public.check_invite_code_status(text) from public;
grant execute on function public.check_invite_code(text) to anon, authenticated, service_role;
grant execute on function public.check_invite_code_status(text) to anon, authenticated, service_role;

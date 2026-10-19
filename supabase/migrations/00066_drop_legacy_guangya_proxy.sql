-- ============================================================
-- 清掉托管版已删除的 legacy 光鸭代理函数（自建部署清理）
-- 生成日期：2026-10-16
-- 托管侧对应迁移：drop_legacy_guangya_proxies
-- 依赖检查：dependents=0、cron 引用=0、边缘函数代码无引用
-- ============================================================

-- 清掉托管版已删除的 legacy 光鸭代理函数（托管侧有 drop_legacy_guangya_proxies 迁移）
-- 依赖检查：dependents=0、cron 引用=0、边缘函数代码无引用（仅 00047~00049 老迁移与 README 提及）
drop function if exists public.guangya_proxy(text, jsonb, text, integer, text, text);
drop function if exists public.guangya_proxy_account(text, text, integer, jsonb, text, text);

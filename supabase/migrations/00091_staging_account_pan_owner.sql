-- 暂存主账号改为复用「已绑定的光鸭账号」：去掉手动加密 token 列，
-- 改为关联 pan_owner_user_id（绑定了光鸭的账号 owner），token 经 load_pan_oauth 复用。
-- 原因：光鸭 OAuth token 加密存于 pan_accounts，管理员无法从前端获取明文，
--       且本项目已有完整的光鸭 OAuth 绑定流程（pan_bind_sessions / load_pan_oauth）。

DROP FUNCTION IF EXISTS public.save_staging_account(uuid, text, text, text, bigint, text);
DROP FUNCTION IF EXISTS public.load_staging_account(uuid, text);

ALTER TABLE public.staging_accounts DROP COLUMN IF EXISTS gy_token_enc;
ALTER TABLE public.staging_accounts ADD COLUMN IF NOT EXISTS pan_owner_user_id uuid REFERENCES auth."users"("id") ON DELETE CASCADE;

COMMENT ON COLUMN public.staging_accounts.pan_owner_user_id IS '绑定了光鸭网盘的账号 owner（其 pan_accounts 中的 guangya OAuth 凭证即为暂存主账号凭证）';

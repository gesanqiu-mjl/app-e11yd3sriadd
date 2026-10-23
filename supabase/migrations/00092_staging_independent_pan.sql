-- 暂存主账号改为「独立绑定光鸭」（不混用 pan_accounts 的网盘绑定）：
-- 恢复 gy_token_enc 加密列 + 凭证存取函数。管理员通过光鸭扫码授权把 token 直接存到本表，
-- 与「网盘绑定」里的光鸭账号完全分离，互不干扰。

ALTER TABLE public.staging_accounts ADD COLUMN IF NOT EXISTS "gy_token_enc" text;
COMMENT ON COLUMN public.staging_accounts."gy_token_enc" IS 'pgp_sym_encrypt 加密的 token JSON（独立凭证，不混用网盘绑定）';

-- 重建存取函数（与 00090 一致；00091 曾 DROP，这里恢复）
CREATE OR REPLACE FUNCTION public.save_staging_account(
    p_id uuid, p_label text, p_token_json text, p_root_dir_id text,
    p_total_capacity_bytes bigint, p_key text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id uuid := COALESCE(p_id, gen_random_uuid());
BEGIN
    INSERT INTO public.staging_accounts ("id", "label", "gy_token_enc", "root_dir_id", "total_capacity_bytes", "updated_at")
    VALUES (v_id, p_label, encode(extensions.pgp_sym_encrypt(p_token_json, p_key), 'base64'), p_root_dir_id, p_total_capacity_bytes, now())
    ON CONFLICT ("id") DO UPDATE SET
        "label" = EXCLUDED."label",
        "gy_token_enc" = EXCLUDED."gy_token_enc",
        "root_dir_id" = EXCLUDED."root_dir_id",
        "total_capacity_bytes" = EXCLUDED."total_capacity_bytes",
        "updated_at" = now();
    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_staging_account(uuid, text, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_staging_account(uuid, text, text, text, bigint, text) TO service_role;

CREATE OR REPLACE FUNCTION public.load_staging_account(
    p_id uuid, p_key text
) RETURNS TABLE ("label" text, "token_json" text, "root_dir_id" text, "status" text, "total_capacity_bytes" bigint)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN QUERY
    SELECT s."label",
           extensions.pgp_sym_decrypt(decode(s."gy_token_enc", 'base64'), p_key)::text,
           s."root_dir_id", s."status", s."total_capacity_bytes"
    FROM public.staging_accounts s
    WHERE s."id" = p_id;
END;
$$;
REVOKE ALL ON FUNCTION public.load_staging_account(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_staging_account(uuid, text) TO service_role;

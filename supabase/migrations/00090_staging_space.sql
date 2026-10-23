-- 暂存空间（光鸭云盘）：管理员添加暂存主账号、分配用户空间、用户转存与文件管理
-- 隔离策略：所有用户文件转存到主账号的 root_dir_id 专用目录，靠 staging_files 表按 user_id 隔离，
--           因此无需新建文件夹即可实现"用户只能看到自己的暂存文件"。

-- 1) 暂存主账号（光鸭网盘凭证，token 加密存储）
CREATE TABLE IF NOT EXISTS public.staging_accounts (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "label" text NOT NULL,                       -- 备注名（如「光鸭-主1」）
    "gy_token_enc" text NOT NULL,                -- pgp_sym_encrypt 加密的 token JSON
    "root_dir_id" text,                          -- 暂存专用目录 ID（光鸭 fileId）；NULL=网盘根目录
    "total_capacity_bytes" bigint NOT NULL DEFAULT 0, -- 管理员配置的主账号总容量
    "status" text NOT NULL DEFAULT 'active',     -- active / invalid
    "last_error" text,
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- 2) 用户空间分配（管理员给每个用户在某个主账号上分配的额度）
CREATE TABLE IF NOT EXISTS public.staging_allocations (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "account_id" uuid NOT NULL REFERENCES public.staging_accounts("id") ON DELETE CASCADE,
    "user_id" uuid NOT NULL REFERENCES auth."users"("id") ON DELETE CASCADE,
    "capacity_bytes" bigint NOT NULL DEFAULT 0,  -- 该用户可用容量
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staging_allocations_uniq UNIQUE ("account_id", "user_id")
);

-- 3) 用户暂存文件记录（应用层隔离：每条文件归属某用户）
CREATE TABLE IF NOT EXISTS public.staging_files (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "account_id" uuid NOT NULL REFERENCES public.staging_accounts("id") ON DELETE CASCADE,
    "user_id" uuid NOT NULL REFERENCES auth."users"("id") ON DELETE CASCADE,
    "file_id" text NOT NULL,                     -- 光鸭文件 ID
    "parent_id" text,                            -- 所在目录 ID
    "name" text NOT NULL,
    "size_bytes" bigint NOT NULL DEFAULT 0,
    "is_dir" boolean NOT NULL DEFAULT false,
    "status" text NOT NULL DEFAULT 'done',       -- done / failed
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staging_files_uniq UNIQUE ("account_id", "user_id", "file_id")
);

CREATE INDEX IF NOT EXISTS idx_staging_files_user ON public.staging_files ("user_id", "account_id");
CREATE INDEX IF NOT EXISTS idx_staging_alloc_user ON public.staging_allocations ("user_id", "account_id");

-- RLS
ALTER TABLE public.staging_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staging_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staging_files ENABLE ROW LEVEL SECURITY;

-- 暂存主账号含敏感 token：仅 service_role（后端边缘函数）可访问
DROP POLICY IF EXISTS "service only staging_accounts" ON public.staging_accounts;
CREATE POLICY "service only staging_accounts" ON public.staging_accounts
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 分配：管理员可全操作；用户仅可读自己
DROP POLICY IF EXISTS "admin full staging_allocations" ON public.staging_allocations;
CREATE POLICY "admin full staging_allocations" ON public.staging_allocations
    FOR ALL TO authenticated
    USING (public.get_user_role(auth.uid()) = 'admin')
    WITH CHECK (public.get_user_role(auth.uid()) = 'admin');
DROP POLICY IF EXISTS "user read own staging_allocations" ON public.staging_allocations;
CREATE POLICY "user read own staging_allocations" ON public.staging_allocations
    FOR SELECT TO authenticated
    USING ("user_id" = auth.uid());

-- 文件：管理员可全操作；用户仅可操作自己的
DROP POLICY IF EXISTS "admin full staging_files" ON public.staging_files;
CREATE POLICY "admin full staging_files" ON public.staging_files
    FOR ALL TO authenticated
    USING (public.get_user_role(auth.uid()) = 'admin')
    WITH CHECK (public.get_user_role(auth.uid()) = 'admin');
DROP POLICY IF EXISTS "user rw own staging_files" ON public.staging_files;
CREATE POLICY "user rw own staging_files" ON public.staging_files
    FOR ALL TO authenticated
    USING ("user_id" = auth.uid())
    WITH CHECK ("user_id" = auth.uid());

-- 加密存储 / 读取主账号凭证（仅 service_role 可调用）
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

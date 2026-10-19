-- ============================================================
-- SECTION: SCHEMA
-- ============================================================

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS "public";


--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


--
-- Name: pg_graphql; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";


--
-- Name: EXTENSION "pg_graphql"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "pg_graphql" IS 'pg_graphql: GraphQL support';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";


--
-- Name: EXTENSION "pgcrypto"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "pgcrypto" IS 'cryptographic functions';


--
-- Name: supabase_vault; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";


--
-- Name: EXTENSION "supabase_vault"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "supabase_vault" IS 'Supabase Vault Extension';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'user_role'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE TYPE "public"."user_role" AS ENUM (
    'user',
    'admin'
);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: complete_invite_code_order("text", numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."complete_invite_code_order"("p_out_trade_no" "text", "p_total_amount" numeric) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_order public.invite_code_orders;
  v_code  text;
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
  SELECT * INTO v_order
  FROM public.invite_code_orders
  WHERE out_trade_no = p_out_trade_no
  FOR UPDATE;

  IF v_order IS NULL THEN
    RAISE EXCEPTION 'order not found: %', p_out_trade_no;
  END IF;

  -- 幂等：已支付则直接返回已生成的邀请码
  IF v_order.status = 'paid' THEN
    RETURN v_order.created_invite_code;
  END IF;

  -- 金额校验（防篡改）
  IF v_order.total_amount <> p_total_amount THEN
    RAISE EXCEPTION 'amount mismatch';
  END IF;

  -- 生成唯一 8 位邀请码（重试避免极小概率冲突）
  LOOP
    v_code := '';
    FOR i IN 1..8 LOOP
      v_code := v_code || substr(v_chars, floor(random() * length(v_chars))::int + 1, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM invite_codes WHERE code = v_code);
  END LOOP;

  INSERT INTO invite_codes (code, membership_days, is_revoked)
  VALUES (v_code, v_order.duration_days, false);

  UPDATE public.invite_code_orders
  SET status = 'paid', created_invite_code = v_code, paid_at = now()
  WHERE id = v_order.id;

  RETURN v_code;
END;
$$;


--
-- Name: consume_invite_code("text", "uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."consume_invite_code"("p_code" "text", "p_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_id uuid;
  v_days int;
BEGIN
  SELECT id, membership_days INTO v_id, v_days
  FROM invite_codes
  WHERE code = p_code
    AND used_by IS NULL
    AND is_revoked = false
  FOR UPDATE SKIP LOCKED;

  IF v_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE invite_codes
  SET used_by = p_user_id, used_at = now()
  WHERE id = v_id;

  UPDATE profiles
  SET membership_expires_at = now() + (v_days || ' days')::interval
  WHERE id = p_user_id;

  RETURN true;
END;
$$;


--
-- Name: create_invite_code_order("text", "uuid", integer, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."create_invite_code_order"("p_out_trade_no" "text", "p_plan_id" "uuid", "p_duration_days" integer, "p_total_amount" numeric) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.invite_code_orders (out_trade_no, plan_id, duration_days, total_amount, status)
  VALUES (p_out_trade_no, p_plan_id, p_duration_days, p_total_amount, 'pending')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


--
-- Name: get_user_role("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_user_role"("uid" "uuid") RETURNS "public"."user_role"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT role FROM public.profiles WHERE id = uid;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  is_first boolean;
BEGIN
  SELECT (count(*) = 0) INTO is_first FROM public.profiles;
  INSERT INTO public.profiles (id, email, phone, username, role)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.phone,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)),
    CASE WHEN is_first THEN 'admin'::public.user_role ELSE 'user'::public.user_role END
  );
  RETURN NEW;
END;
$$;


--
-- Name: update_resource_sort_orders("jsonb"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."update_resource_sort_orders"("p_items" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  item jsonb;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    UPDATE resources
    SET sort_order = (item->>'sort_order')::int,
        updated_at = now()
    WHERE id = (item->>'id')::uuid
      AND owner_id = auth.uid();
  END LOOP;
END;
$$;


--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."announcements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "content" "text" DEFAULT ''::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: change_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."change_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resource_id" "uuid",
    "resource_name" "text" NOT NULL,
    "field_name" "text" NOT NULL,
    "field_label" "text" NOT NULL,
    "old_value" "text" DEFAULT ''::"text" NOT NULL,
    "new_value" "text" DEFAULT ''::"text" NOT NULL,
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL
);


--
-- Name: framehdr_resource_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."framehdr_resource_bindings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resource_id" "uuid" NOT NULL,
    "link_id" integer NOT NULL,
    "link_title" "text",
    "drive_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: framehdr_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."framehdr_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "cookie" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_check_at" timestamp with time zone,
    "remark" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "username" "text"
);


--
-- Name: framehdr_sync_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."framehdr_sync_logs" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "action" "text" NOT NULL,
    "remote_id" integer,
    "title" "text",
    "status" "text" NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: framehdr_sync_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE "public"."framehdr_sync_logs" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."framehdr_sync_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: invite_code_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."invite_code_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "out_trade_no" "text" NOT NULL,
    "plan_id" "uuid",
    "duration_days" integer NOT NULL,
    "total_amount" numeric(10,2) NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_invite_code" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "paid_at" timestamp with time zone,
    CONSTRAINT "invite_code_orders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'failed'::"text"])))
);


--
-- Name: invite_code_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."invite_code_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "duration_days" integer NOT NULL,
    "price" numeric(10,2) NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "invite_code_plans_duration_days_check" CHECK (("duration_days" > 0)),
    CONSTRAINT "invite_code_plans_price_check" CHECK (("price" >= (0)::numeric))
);


--
-- Name: invite_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."invite_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "created_by" "uuid",
    "used_by" "uuid",
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_revoked" boolean DEFAULT false NOT NULL,
    "membership_days" integer DEFAULT 30 NOT NULL
);


--
-- Name: login_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."login_config" (
    "id" integer DEFAULT 1 NOT NULL,
    "left_bg_color" "text" DEFAULT '#1a6b4a'::"text" NOT NULL,
    "left_use_bg_image" boolean DEFAULT false NOT NULL,
    "left_bg_image_url" "text",
    "left_logo_url" "text",
    "left_title" "text" DEFAULT '资源更新追踪'::"text" NOT NULL,
    "left_heading" "text" DEFAULT '高效追踪每一部剧集的更新'::"text" NOT NULL,
    "left_description" "text" DEFAULT '智能解析、批量导入、自动变更检测。修改即同步到已更新栏，一键复制即可分享。'::"text" NOT NULL,
    "left_copyright" "text" DEFAULT '© 2026 资源更新追踪系统'::"text" NOT NULL,
    "right_title" "text" DEFAULT '欢迎回来'::"text" NOT NULL,
    "right_subtitle" "text" DEFAULT '登录以管理你的剧集资源'::"text" NOT NULL,
    "right_btn_text" "text" DEFAULT '登录'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tutorial_url" "text",
    "invite_code_info" "text",
    CONSTRAINT "login_config_singleton" CHECK (("id" = 1))
);


--
-- Name: mukaku_resource_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."mukaku_resource_bindings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resource_id" "uuid" NOT NULL,
    "link_id" bigint NOT NULL,
    "movies_id" bigint NOT NULL,
    "seed_name" "text",
    "vod_name" "text",
    "pan_type" "text",
    "share_code" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: mukaku_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."mukaku_tokens" (
    "user_id" "uuid" NOT NULL,
    "username" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "token_expires_at" timestamp with time zone,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_check_at" timestamp with time zone,
    "remark" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: panfx_resource_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."panfx_resource_bindings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resource_id" "uuid" NOT NULL,
    "tid" integer NOT NULL,
    "firstpid" integer,
    "subject" "text",
    "fid" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: panfx_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."panfx_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "cookie" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "username" "text",
    "last_check_at" timestamp with time zone,
    "remark" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: pinglian_links_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."pinglian_links_cache" (
    "link_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "vod_id" bigint,
    "vod_name" "text",
    "link_title" "text",
    "link_url" "text",
    "link_password" "text",
    "pan_type" "text",
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone,
    "cached_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: pinglian_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."pinglian_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "cookie" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_check_at" timestamp with time zone,
    "remark" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "username" "text" DEFAULT ''::"text" NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "phone" "text",
    "username" "text",
    "role" "public"."user_role" DEFAULT 'user'::"public"."user_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "membership_expires_at" timestamp with time zone,
    CONSTRAINT "profiles_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'disabled'::"text"])))
);


--
-- Name: public_profiles; Type: VIEW; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW "public"."public_profiles" AS
 SELECT "id",
    "username",
    "role",
    "created_at"
   FROM "public"."profiles";


--
-- Name: resource_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."resource_bindings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resource_id" "uuid" NOT NULL,
    "link_id" bigint NOT NULL,
    "link_title" "text",
    "vod_name" "text",
    "pan_type" "text" DEFAULT 'others'::"text",
    "link_password" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: resource_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."resource_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "category" "text",
    "episode_count" integer,
    "link_url" "text",
    "extract_code" "text",
    "remark" "text",
    "submitter_name" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "resource_submissions_category_check" CHECK (("category" = ANY (ARRAY['movie'::"text", 'series'::"text", 'anime'::"text"]))),
    CONSTRAINT "resource_submissions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


--
-- Name: resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."resources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "episode_count" integer DEFAULT 0 NOT NULL,
    "link" "text" DEFAULT ''::"text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "owner_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "cover_url" "text",
    "links" "jsonb" DEFAULT '[]'::"jsonb",
    "link_status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "link_checked_at" timestamp with time zone,
    "is_finished" boolean DEFAULT false NOT NULL
);


--
-- Name: xn_resource_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."xn_resource_bindings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resource_id" "uuid" NOT NULL,
    "share_id" "text" NOT NULL,
    "share_title" "text",
    "share_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pan_label" "text"
);


--
-- Name: xn_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."xn_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "cookie" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_check_at" timestamp with time zone,
    "remark" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: xn_shares_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."xn_shares_cache" (
    "share_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text",
    "dir" "text",
    "tname" "text",
    "time" "text",
    "url" "text",
    "atitle" "text",
    "bindcount" integer DEFAULT 0,
    "status" integer DEFAULT 0,
    "cached_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: ya_resource_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."ya_resource_bindings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "resource_id" "uuid" NOT NULL,
    "link_id" bigint NOT NULL,
    "link_title" "text",
    "vod_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pan_label" "text"
);


--
-- Name: ya_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."ya_sessions" (
    "user_id" "uuid" NOT NULL,
    "username" "text" NOT NULL,
    "password" "text" NOT NULL,
    "access_token" "text",
    "refresh_token" "text",
    "expires_in" integer,
    "remark" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_check_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'announcements_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'announcements'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."announcements"
    ADD CONSTRAINT "announcements_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: change_history change_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'change_history_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'change_history'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."change_history"
    ADD CONSTRAINT "change_history_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_resource_bindings framehdr_resource_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'framehdr_resource_bindings_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."framehdr_resource_bindings"
    ADD CONSTRAINT "framehdr_resource_bindings_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_resource_bindings framehdr_resource_bindings_resource_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'framehdr_resource_bindings_resource_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."framehdr_resource_bindings"
    ADD CONSTRAINT "framehdr_resource_bindings_resource_id_key" UNIQUE ("resource_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_sessions framehdr_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'framehdr_sessions_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."framehdr_sessions"
    ADD CONSTRAINT "framehdr_sessions_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_sessions framehdr_sessions_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'framehdr_sessions_user_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."framehdr_sessions"
    ADD CONSTRAINT "framehdr_sessions_user_id_key" UNIQUE ("user_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_sync_logs framehdr_sync_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'framehdr_sync_logs_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_sync_logs'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."framehdr_sync_logs"
    ADD CONSTRAINT "framehdr_sync_logs_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_code_orders invite_code_orders_out_trade_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'invite_code_orders_out_trade_no_key'
      AND n.nspname = 'public'
      AND c.relname = 'invite_code_orders'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."invite_code_orders"
    ADD CONSTRAINT "invite_code_orders_out_trade_no_key" UNIQUE ("out_trade_no");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_code_orders invite_code_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'invite_code_orders_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'invite_code_orders'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."invite_code_orders"
    ADD CONSTRAINT "invite_code_orders_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_code_plans invite_code_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'invite_code_plans_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'invite_code_plans'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."invite_code_plans"
    ADD CONSTRAINT "invite_code_plans_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_codes invite_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'invite_codes_code_key'
      AND n.nspname = 'public'
      AND c.relname = 'invite_codes'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."invite_codes"
    ADD CONSTRAINT "invite_codes_code_key" UNIQUE ("code");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_codes invite_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'invite_codes_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'invite_codes'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."invite_codes"
    ADD CONSTRAINT "invite_codes_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: login_config login_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'login_config_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'login_config'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."login_config"
    ADD CONSTRAINT "login_config_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: mukaku_resource_bindings mukaku_resource_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'mukaku_resource_bindings_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'mukaku_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."mukaku_resource_bindings"
    ADD CONSTRAINT "mukaku_resource_bindings_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: mukaku_tokens mukaku_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'mukaku_tokens_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'mukaku_tokens'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."mukaku_tokens"
    ADD CONSTRAINT "mukaku_tokens_pkey" PRIMARY KEY ("user_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: panfx_resource_bindings panfx_resource_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'panfx_resource_bindings_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'panfx_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."panfx_resource_bindings"
    ADD CONSTRAINT "panfx_resource_bindings_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: panfx_resource_bindings panfx_resource_bindings_resource_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'panfx_resource_bindings_resource_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'panfx_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."panfx_resource_bindings"
    ADD CONSTRAINT "panfx_resource_bindings_resource_id_key" UNIQUE ("resource_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: panfx_sessions panfx_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'panfx_sessions_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'panfx_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."panfx_sessions"
    ADD CONSTRAINT "panfx_sessions_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: panfx_sessions panfx_sessions_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'panfx_sessions_user_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'panfx_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."panfx_sessions"
    ADD CONSTRAINT "panfx_sessions_user_id_key" UNIQUE ("user_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_links_cache pinglian_links_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'pinglian_links_cache_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_links_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."pinglian_links_cache"
    ADD CONSTRAINT "pinglian_links_cache_pkey" PRIMARY KEY ("link_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_sessions pinglian_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'pinglian_sessions_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."pinglian_sessions"
    ADD CONSTRAINT "pinglian_sessions_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_sessions pinglian_sessions_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'pinglian_sessions_user_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."pinglian_sessions"
    ADD CONSTRAINT "pinglian_sessions_user_id_key" UNIQUE ("user_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'profiles_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resource_bindings resource_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'resource_bindings_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."resource_bindings"
    ADD CONSTRAINT "resource_bindings_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resource_bindings resource_bindings_resource_link_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'resource_bindings_resource_link_uniq'
      AND n.nspname = 'public'
      AND c.relname = 'resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."resource_bindings"
    ADD CONSTRAINT "resource_bindings_resource_link_uniq" UNIQUE ("resource_id", "link_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resource_submissions resource_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'resource_submissions_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'resource_submissions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."resource_submissions"
    ADD CONSTRAINT "resource_submissions_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resources resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'resources_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'resources'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."resources"
    ADD CONSTRAINT "resources_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: mukaku_resource_bindings uq_mukaku_resource_link; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'uq_mukaku_resource_link'
      AND n.nspname = 'public'
      AND c.relname = 'mukaku_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."mukaku_resource_bindings"
    ADD CONSTRAINT "uq_mukaku_resource_link" UNIQUE ("resource_id", "link_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_resource_bindings xn_resource_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'xn_resource_bindings_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'xn_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."xn_resource_bindings"
    ADD CONSTRAINT "xn_resource_bindings_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_resource_bindings xn_resource_bindings_resource_share_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'xn_resource_bindings_resource_share_key'
      AND n.nspname = 'public'
      AND c.relname = 'xn_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."xn_resource_bindings"
    ADD CONSTRAINT "xn_resource_bindings_resource_share_key" UNIQUE ("resource_id", "share_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_sessions xn_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'xn_sessions_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'xn_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."xn_sessions"
    ADD CONSTRAINT "xn_sessions_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_sessions xn_sessions_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'xn_sessions_user_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'xn_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."xn_sessions"
    ADD CONSTRAINT "xn_sessions_user_id_key" UNIQUE ("user_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_shares_cache xn_shares_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'xn_shares_cache_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'xn_shares_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."xn_shares_cache"
    ADD CONSTRAINT "xn_shares_cache_pkey" PRIMARY KEY ("share_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_resource_bindings ya_resource_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'ya_resource_bindings_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'ya_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."ya_resource_bindings"
    ADD CONSTRAINT "ya_resource_bindings_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_resource_bindings ya_resource_bindings_resource_link_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'ya_resource_bindings_resource_link_key'
      AND n.nspname = 'public'
      AND c.relname = 'ya_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."ya_resource_bindings"
    ADD CONSTRAINT "ya_resource_bindings_resource_link_key" UNIQUE ("resource_id", "link_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_sessions ya_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'ya_sessions_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'ya_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."ya_sessions"
    ADD CONSTRAINT "ya_sessions_pkey" PRIMARY KEY ("user_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: idx_announcements_active_sort; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_announcements_active_sort" ON "public"."announcements" USING "btree" ("is_active", "sort_order", "created_at" DESC);


--
-- Name: idx_framehdr_rb_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_framehdr_rb_resource" ON "public"."framehdr_resource_bindings" USING "btree" ("resource_id");


--
-- Name: idx_framehdr_sync_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_framehdr_sync_logs_user" ON "public"."framehdr_sync_logs" USING "btree" ("user_id", "created_at" DESC);


--
-- Name: idx_mukaku_bindings_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_mukaku_bindings_resource" ON "public"."mukaku_resource_bindings" USING "btree" ("resource_id");


--
-- Name: idx_mukaku_tokens_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_mukaku_tokens_status" ON "public"."mukaku_tokens" USING "btree" ("status");


--
-- Name: idx_panfx_rb_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_panfx_rb_resource" ON "public"."panfx_resource_bindings" USING "btree" ("resource_id");


--
-- Name: idx_pinglian_cache_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_pinglian_cache_user" ON "public"."pinglian_links_cache" USING "btree" ("user_id");


--
-- Name: idx_pinglian_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_pinglian_sessions_user" ON "public"."pinglian_sessions" USING "btree" ("user_id");


--
-- Name: idx_resource_bindings_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_resource_bindings_resource" ON "public"."resource_bindings" USING "btree" ("resource_id");


--
-- Name: idx_resource_submissions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_resource_submissions_status" ON "public"."resource_submissions" USING "btree" ("status", "created_at" DESC);


--
-- Name: idx_xn_cache_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_xn_cache_user" ON "public"."xn_shares_cache" USING "btree" ("user_id");


--
-- Name: idx_xn_rb_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_xn_rb_resource" ON "public"."xn_resource_bindings" USING "btree" ("resource_id");


--
-- Name: idx_xn_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_xn_sessions_user" ON "public"."xn_sessions" USING "btree" ("user_id");


--
-- Name: idx_ya_resource_bindings_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_ya_resource_bindings_resource" ON "public"."ya_resource_bindings" USING "btree" ("resource_id");


--
-- Name: resources resources_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "resources_updated_at" BEFORE UPDATE ON "public"."resources" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();


--
-- Name: change_history change_history_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'change_history_resource_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'change_history'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."change_history"
    ADD CONSTRAINT "change_history_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: change_history change_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'change_history_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'change_history'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."change_history"
    ADD CONSTRAINT "change_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_resource_bindings framehdr_resource_bindings_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'framehdr_resource_bindings_resource_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."framehdr_resource_bindings"
    ADD CONSTRAINT "framehdr_resource_bindings_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_sessions framehdr_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'framehdr_sessions_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."framehdr_sessions"
    ADD CONSTRAINT "framehdr_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_sync_logs framehdr_sync_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'framehdr_sync_logs_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_sync_logs'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."framehdr_sync_logs"
    ADD CONSTRAINT "framehdr_sync_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_code_orders invite_code_orders_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'invite_code_orders_plan_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'invite_code_orders'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."invite_code_orders"
    ADD CONSTRAINT "invite_code_orders_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."invite_code_plans"("id") ON DELETE SET NULL;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_codes invite_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'invite_codes_created_by_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'invite_codes'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."invite_codes"
    ADD CONSTRAINT "invite_codes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_codes invite_codes_used_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'invite_codes_used_by_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'invite_codes'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."invite_codes"
    ADD CONSTRAINT "invite_codes_used_by_fkey" FOREIGN KEY ("used_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: mukaku_resource_bindings mukaku_resource_bindings_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'mukaku_resource_bindings_resource_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'mukaku_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."mukaku_resource_bindings"
    ADD CONSTRAINT "mukaku_resource_bindings_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: mukaku_tokens mukaku_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'mukaku_tokens_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'mukaku_tokens'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."mukaku_tokens"
    ADD CONSTRAINT "mukaku_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: panfx_resource_bindings panfx_resource_bindings_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'panfx_resource_bindings_resource_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'panfx_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."panfx_resource_bindings"
    ADD CONSTRAINT "panfx_resource_bindings_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: panfx_sessions panfx_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'panfx_sessions_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'panfx_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."panfx_sessions"
    ADD CONSTRAINT "panfx_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_links_cache pinglian_links_cache_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'pinglian_links_cache_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_links_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."pinglian_links_cache"
    ADD CONSTRAINT "pinglian_links_cache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_sessions pinglian_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'pinglian_sessions_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."pinglian_sessions"
    ADD CONSTRAINT "pinglian_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'profiles_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resource_bindings resource_bindings_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'resource_bindings_resource_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."resource_bindings"
    ADD CONSTRAINT "resource_bindings_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resources resources_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'resources_owner_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'resources'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."resources"
    ADD CONSTRAINT "resources_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_resource_bindings xn_resource_bindings_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'xn_resource_bindings_resource_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'xn_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."xn_resource_bindings"
    ADD CONSTRAINT "xn_resource_bindings_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_sessions xn_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'xn_sessions_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'xn_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."xn_sessions"
    ADD CONSTRAINT "xn_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_shares_cache xn_shares_cache_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'xn_shares_cache_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'xn_shares_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."xn_shares_cache"
    ADD CONSTRAINT "xn_shares_cache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_resource_bindings ya_resource_bindings_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'ya_resource_bindings_resource_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'ya_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."ya_resource_bindings"
    ADD CONSTRAINT "ya_resource_bindings_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_sessions ya_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'ya_sessions_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'ya_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."ya_sessions"
    ADD CONSTRAINT "ya_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles Admins have full access to profiles; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Admins have full access to profiles'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Admins have full access to profiles" ON "public"."profiles" TO "authenticated" USING (("public"."get_user_role"("auth"."uid"()) = 'admin'::"public"."user_role"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: change_history Owner can delete own history; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Owner can delete own history'
      AND n.nspname = 'public'
      AND c.relname = 'change_history'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Owner can delete own history" ON "public"."change_history" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resources Owner can delete own resources; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Owner can delete own resources'
      AND n.nspname = 'public'
      AND c.relname = 'resources'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Owner can delete own resources" ON "public"."resources" FOR DELETE TO "authenticated" USING (("owner_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: change_history Owner can insert own history; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Owner can insert own history'
      AND n.nspname = 'public'
      AND c.relname = 'change_history'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Owner can insert own history" ON "public"."change_history" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resources Owner can insert own resources; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Owner can insert own resources'
      AND n.nspname = 'public'
      AND c.relname = 'resources'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Owner can insert own resources" ON "public"."resources" FOR INSERT TO "authenticated" WITH CHECK (("owner_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resources Owner can update own resources; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Owner can update own resources'
      AND n.nspname = 'public'
      AND c.relname = 'resources'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Owner can update own resources" ON "public"."resources" FOR UPDATE TO "authenticated" USING (("owner_id" = "auth"."uid"())) WITH CHECK (("owner_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: change_history Owner can view own history; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Owner can view own history'
      AND n.nspname = 'public'
      AND c.relname = 'change_history'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Owner can view own history" ON "public"."change_history" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resources Owner can view own resources; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Owner can view own resources'
      AND n.nspname = 'public'
      AND c.relname = 'resources'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Owner can view own resources" ON "public"."resources" FOR SELECT TO "authenticated" USING (("owner_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: mukaku_resource_bindings Users can delete their own mukaku bindings; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users can delete their own mukaku bindings'
      AND n.nspname = 'public'
      AND c.relname = 'mukaku_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users can delete their own mukaku bindings" ON "public"."mukaku_resource_bindings" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "mukaku_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: mukaku_resource_bindings Users can insert their own mukaku bindings; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users can insert their own mukaku bindings'
      AND n.nspname = 'public'
      AND c.relname = 'mukaku_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users can insert their own mukaku bindings" ON "public"."mukaku_resource_bindings" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "mukaku_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: mukaku_resource_bindings Users can update their own mukaku bindings; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users can update their own mukaku bindings'
      AND n.nspname = 'public'
      AND c.relname = 'mukaku_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users can update their own mukaku bindings" ON "public"."mukaku_resource_bindings" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "mukaku_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles Users can update their own profile; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users can update their own profile'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users can update their own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id")) WITH CHECK ((NOT ("role" IS DISTINCT FROM "public"."get_user_role"("auth"."uid"()))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: mukaku_resource_bindings Users can view their own mukaku bindings; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users can view their own mukaku bindings'
      AND n.nspname = 'public'
      AND c.relname = 'mukaku_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users can view their own mukaku bindings" ON "public"."mukaku_resource_bindings" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "mukaku_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles Users can view their own profile; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Users can view their own profile'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "Users can view their own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: announcements admin_delete_announcements; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'admin_delete_announcements'
      AND n.nspname = 'public'
      AND c.relname = 'announcements'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "admin_delete_announcements" ON "public"."announcements" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_codes admin_full_access; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'admin_full_access'
      AND n.nspname = 'public'
      AND c.relname = 'invite_codes'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "admin_full_access" ON "public"."invite_codes" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_code_plans admin_full_access_plans; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'admin_full_access_plans'
      AND n.nspname = 'public'
      AND c.relname = 'invite_code_plans'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "admin_full_access_plans" ON "public"."invite_code_plans" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: announcements admin_insert_announcements; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'admin_insert_announcements'
      AND n.nspname = 'public'
      AND c.relname = 'announcements'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "admin_insert_announcements" ON "public"."announcements" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: announcements admin_update_announcements; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'admin_update_announcements'
      AND n.nspname = 'public'
      AND c.relname = 'announcements'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "admin_update_announcements" ON "public"."announcements" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: login_config admin_update_login_config; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'admin_update_login_config'
      AND n.nspname = 'public'
      AND c.relname = 'login_config'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "admin_update_login_config" ON "public"."login_config" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: announcements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."announcements" ENABLE ROW LEVEL SECURITY;

--
-- Name: invite_code_plans anyone_read_active_plans; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'anyone_read_active_plans'
      AND n.nspname = 'public'
      AND c.relname = 'invite_code_plans'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "anyone_read_active_plans" ON "public"."invite_code_plans" FOR SELECT USING (("is_active" = true));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_code_orders anyone_read_order; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'anyone_read_order'
      AND n.nspname = 'public'
      AND c.relname = 'invite_code_orders'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "anyone_read_order" ON "public"."invite_code_orders" FOR SELECT USING (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_codes anyone_read_valid_code; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'anyone_read_valid_code'
      AND n.nspname = 'public'
      AND c.relname = 'invite_codes'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "anyone_read_valid_code" ON "public"."invite_codes" FOR SELECT USING ((("used_by" IS NULL) AND ("is_revoked" = false)));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resource_bindings binding_owner_all; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'binding_owner_all'
      AND n.nspname = 'public'
      AND c.relname = 'resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "binding_owner_all" ON "public"."resource_bindings" USING ((EXISTS ( SELECT 1
   FROM "public"."resources"
  WHERE (("resources"."id" = "resource_bindings"."resource_id") AND ("resources"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."resources"
  WHERE (("resources"."id" = "resource_bindings"."resource_id") AND ("resources"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_links_cache cache_delete_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'cache_delete_own'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_links_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "cache_delete_own" ON "public"."pinglian_links_cache" FOR DELETE USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_links_cache cache_insert_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'cache_insert_own'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_links_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "cache_insert_own" ON "public"."pinglian_links_cache" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_links_cache cache_select_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'cache_select_own'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_links_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "cache_select_own" ON "public"."pinglian_links_cache" FOR SELECT USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_links_cache cache_update_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'cache_update_own'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_links_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "cache_update_own" ON "public"."pinglian_links_cache" FOR UPDATE USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: change_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."change_history" ENABLE ROW LEVEL SECURITY;

--
-- Name: framehdr_resource_bindings framehdr_rb_delete_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'framehdr_rb_delete_own'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "framehdr_rb_delete_own" ON "public"."framehdr_resource_bindings" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "framehdr_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_resource_bindings framehdr_rb_insert_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'framehdr_rb_insert_own'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "framehdr_rb_insert_own" ON "public"."framehdr_resource_bindings" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "framehdr_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_resource_bindings framehdr_rb_select_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'framehdr_rb_select_own'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "framehdr_rb_select_own" ON "public"."framehdr_resource_bindings" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "framehdr_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_resource_bindings framehdr_rb_update_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'framehdr_rb_update_own'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "framehdr_rb_update_own" ON "public"."framehdr_resource_bindings" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "framehdr_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_resource_bindings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."framehdr_resource_bindings" ENABLE ROW LEVEL SECURITY;

--
-- Name: framehdr_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."framehdr_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: framehdr_sessions framehdr_sessions_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'framehdr_sessions_own'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "framehdr_sessions_own" ON "public"."framehdr_sessions" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: framehdr_sync_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."framehdr_sync_logs" ENABLE ROW LEVEL SECURITY;

--
-- Name: framehdr_sync_logs framehdr_sync_logs_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'framehdr_sync_logs_own'
      AND n.nspname = 'public'
      AND c.relname = 'framehdr_sync_logs'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "framehdr_sync_logs_own" ON "public"."framehdr_sync_logs" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: invite_code_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."invite_code_orders" ENABLE ROW LEVEL SECURITY;

--
-- Name: invite_code_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."invite_code_plans" ENABLE ROW LEVEL SECURITY;

--
-- Name: invite_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."invite_codes" ENABLE ROW LEVEL SECURITY;

--
-- Name: login_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."login_config" ENABLE ROW LEVEL SECURITY;

--
-- Name: mukaku_resource_bindings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."mukaku_resource_bindings" ENABLE ROW LEVEL SECURITY;

--
-- Name: mukaku_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."mukaku_tokens" ENABLE ROW LEVEL SECURITY;

--
-- Name: panfx_resource_bindings panfx_rb_delete_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'panfx_rb_delete_own'
      AND n.nspname = 'public'
      AND c.relname = 'panfx_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "panfx_rb_delete_own" ON "public"."panfx_resource_bindings" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "panfx_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: panfx_resource_bindings panfx_rb_insert_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'panfx_rb_insert_own'
      AND n.nspname = 'public'
      AND c.relname = 'panfx_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "panfx_rb_insert_own" ON "public"."panfx_resource_bindings" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "panfx_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: panfx_resource_bindings panfx_rb_select_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'panfx_rb_select_own'
      AND n.nspname = 'public'
      AND c.relname = 'panfx_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "panfx_rb_select_own" ON "public"."panfx_resource_bindings" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "panfx_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: panfx_resource_bindings panfx_rb_update_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'panfx_rb_update_own'
      AND n.nspname = 'public'
      AND c.relname = 'panfx_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "panfx_rb_update_own" ON "public"."panfx_resource_bindings" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "panfx_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: panfx_resource_bindings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."panfx_resource_bindings" ENABLE ROW LEVEL SECURITY;

--
-- Name: panfx_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."panfx_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: panfx_sessions panfx_sessions_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'panfx_sessions_own'
      AND n.nspname = 'public'
      AND c.relname = 'panfx_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "panfx_sessions_own" ON "public"."panfx_sessions" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_links_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pinglian_links_cache" ENABLE ROW LEVEL SECURITY;

--
-- Name: pinglian_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pinglian_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

--
-- Name: announcements public_read_announcements; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'public_read_announcements'
      AND n.nspname = 'public'
      AND c.relname = 'announcements'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "public_read_announcements" ON "public"."announcements" FOR SELECT TO "authenticated", "anon" USING (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: login_config public_read_login_config; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'public_read_login_config'
      AND n.nspname = 'public'
      AND c.relname = 'login_config'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "public_read_login_config" ON "public"."login_config" FOR SELECT TO "authenticated", "anon" USING (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resource_bindings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."resource_bindings" ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."resource_submissions" ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_submissions resource_submissions_insert; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'resource_submissions_insert'
      AND n.nspname = 'public'
      AND c.relname = 'resource_submissions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "resource_submissions_insert" ON "public"."resource_submissions" FOR INSERT WITH CHECK (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resource_submissions resource_submissions_select_admin; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'resource_submissions_select_admin'
      AND n.nspname = 'public'
      AND c.relname = 'resource_submissions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "resource_submissions_select_admin" ON "public"."resource_submissions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resource_submissions resource_submissions_update_admin; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'resource_submissions_update_admin'
      AND n.nspname = 'public'
      AND c.relname = 'resource_submissions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "resource_submissions_update_admin" ON "public"."resource_submissions" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: resources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."resources" ENABLE ROW LEVEL SECURITY;

--
-- Name: pinglian_sessions session_delete_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'session_delete_own'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "session_delete_own" ON "public"."pinglian_sessions" FOR DELETE USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_sessions session_insert_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'session_insert_own'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "session_insert_own" ON "public"."pinglian_sessions" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_sessions session_select_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'session_select_own'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "session_select_own" ON "public"."pinglian_sessions" FOR SELECT USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: pinglian_sessions session_update_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'session_update_own'
      AND n.nspname = 'public'
      AND c.relname = 'pinglian_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "session_update_own" ON "public"."pinglian_sessions" FOR UPDATE USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_shares_cache xn_cache_delete_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'xn_cache_delete_own'
      AND n.nspname = 'public'
      AND c.relname = 'xn_shares_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "xn_cache_delete_own" ON "public"."xn_shares_cache" FOR DELETE USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_shares_cache xn_cache_insert_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'xn_cache_insert_own'
      AND n.nspname = 'public'
      AND c.relname = 'xn_shares_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "xn_cache_insert_own" ON "public"."xn_shares_cache" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_shares_cache xn_cache_select_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'xn_cache_select_own'
      AND n.nspname = 'public'
      AND c.relname = 'xn_shares_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "xn_cache_select_own" ON "public"."xn_shares_cache" FOR SELECT USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_shares_cache xn_cache_update_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'xn_cache_update_own'
      AND n.nspname = 'public'
      AND c.relname = 'xn_shares_cache'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "xn_cache_update_own" ON "public"."xn_shares_cache" FOR UPDATE USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_sessions xn_session_delete_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'xn_session_delete_own'
      AND n.nspname = 'public'
      AND c.relname = 'xn_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "xn_session_delete_own" ON "public"."xn_sessions" FOR DELETE USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_sessions xn_session_insert_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'xn_session_insert_own'
      AND n.nspname = 'public'
      AND c.relname = 'xn_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "xn_session_insert_own" ON "public"."xn_sessions" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_sessions xn_session_select_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'xn_session_select_own'
      AND n.nspname = 'public'
      AND c.relname = 'xn_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "xn_session_select_own" ON "public"."xn_sessions" FOR SELECT USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_sessions xn_session_update_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'xn_session_update_own'
      AND n.nspname = 'public'
      AND c.relname = 'xn_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "xn_session_update_own" ON "public"."xn_sessions" FOR UPDATE USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: xn_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."xn_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: xn_shares_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."xn_shares_cache" ENABLE ROW LEVEL SECURITY;

--
-- Name: ya_resource_bindings ya_bindings_delete_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'ya_bindings_delete_own'
      AND n.nspname = 'public'
      AND c.relname = 'ya_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "ya_bindings_delete_own" ON "public"."ya_resource_bindings" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "ya_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_resource_bindings ya_bindings_insert_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'ya_bindings_insert_own'
      AND n.nspname = 'public'
      AND c.relname = 'ya_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "ya_bindings_insert_own" ON "public"."ya_resource_bindings" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "ya_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_resource_bindings ya_bindings_select_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'ya_bindings_select_own'
      AND n.nspname = 'public'
      AND c.relname = 'ya_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "ya_bindings_select_own" ON "public"."ya_resource_bindings" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "ya_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_resource_bindings ya_bindings_update_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'ya_bindings_update_own'
      AND n.nspname = 'public'
      AND c.relname = 'ya_resource_bindings'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "ya_bindings_update_own" ON "public"."ya_resource_bindings" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "ya_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."resources" "r"
  WHERE (("r"."id" = "ya_resource_bindings"."resource_id") AND ("r"."owner_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_resource_bindings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ya_resource_bindings" ENABLE ROW LEVEL SECURITY;

--
-- Name: ya_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ya_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: ya_sessions ya_sessions_delete_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'ya_sessions_delete_own'
      AND n.nspname = 'public'
      AND c.relname = 'ya_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "ya_sessions_delete_own" ON "public"."ya_sessions" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_sessions ya_sessions_insert_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'ya_sessions_insert_own'
      AND n.nspname = 'public'
      AND c.relname = 'ya_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "ya_sessions_insert_own" ON "public"."ya_sessions" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_sessions ya_sessions_select_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'ya_sessions_select_own'
      AND n.nspname = 'public'
      AND c.relname = 'ya_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "ya_sessions_select_own" ON "public"."ya_sessions" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: ya_sessions ya_sessions_update_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'ya_sessions_update_own'
      AND n.nspname = 'public'
      AND c.relname = 'ya_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "ya_sessions_update_own" ON "public"."ya_sessions" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- PostgreSQL database dump complete
--




-- ============================================================
-- SECTION: DIFF FILTER OBJECTS
-- ============================================================
-- Objects that match diff-filter.json but cannot be represented
-- precisely by pg_dump --filter.

-- auth.users trigger: on_auth_user_created
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND t.tgname = 'on_auth_user_created'
      AND n.nspname = 'auth'
      AND c.relname = 'users'
  ) THEN
    EXECUTE 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();';
  END IF;
END
$pg_schema_restore$;
-- policy: "Anyone can read covers" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Anyone can read covers'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "Anyone can read covers" ON storage.objects AS PERMISSIVE FOR SELECT TO PUBLIC USING ((bucket_id = ''covers''::text));';
  END IF;
END
$pg_schema_restore$;
-- policy: "Authenticated users can upload covers" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Authenticated users can upload covers'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "Authenticated users can upload covers" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = ''covers''::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));';
  END IF;
END
$pg_schema_restore$;
-- policy: "Owner can delete covers" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Owner can delete covers'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "Owner can delete covers" ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated USING (((bucket_id = ''covers''::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));';
  END IF;
END
$pg_schema_restore$;
-- policy: "Owner can update covers" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'Owner can update covers'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "Owner can update covers" ON storage.objects AS PERMISSIVE FOR UPDATE TO authenticated USING (((bucket_id = ''covers''::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));';
  END IF;
END
$pg_schema_restore$;
-- policy: admin_delete_login_assets on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'admin_delete_login_assets'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY admin_delete_login_assets ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated USING (((bucket_id = ''login-assets''::text) AND (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ''admin''::public.user_role))))));';
  END IF;
END
$pg_schema_restore$;
-- policy: admin_update_login_assets on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'admin_update_login_assets'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY admin_update_login_assets ON storage.objects AS PERMISSIVE FOR UPDATE TO authenticated USING (((bucket_id = ''login-assets''::text) AND (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ''admin''::public.user_role))))));';
  END IF;
END
$pg_schema_restore$;
-- policy: admin_upload_login_assets on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'admin_upload_login_assets'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY admin_upload_login_assets ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = ''login-assets''::text) AND (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ''admin''::public.user_role))))));';
  END IF;
END
$pg_schema_restore$;
-- policy: public_read_login_assets on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'public_read_login_assets'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY public_read_login_assets ON storage.objects AS PERMISSIVE FOR SELECT TO PUBLIC USING ((bucket_id = ''login-assets''::text));';
  END IF;
END
$pg_schema_restore$;

-- ============================================================
-- SECTION: STORAGE BUCKETS DATA
-- ============================================================

INSERT INTO "storage"."buckets" ("id", "name", "owner", "created_at", "updated_at", "public", "avif_autodetection", "file_size_limit", "allowed_mime_types", "owner_id", "type") VALUES ('covers', 'covers', NULL, '2026-08-29 01:17:30.73853+00', '2026-08-29 01:17:30.73853+00', 'true', 'false', '5242880', '{image/jpeg,image/png,image/webp,image/gif,image/avif}', NULL, 'STANDARD') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "owner" = EXCLUDED."owner", "created_at" = EXCLUDED."created_at", "updated_at" = EXCLUDED."updated_at", "public" = EXCLUDED."public", "avif_autodetection" = EXCLUDED."avif_autodetection", "file_size_limit" = EXCLUDED."file_size_limit", "allowed_mime_types" = EXCLUDED."allowed_mime_types", "owner_id" = EXCLUDED."owner_id", "type" = EXCLUDED."type";
INSERT INTO "storage"."buckets" ("id", "name", "owner", "created_at", "updated_at", "public", "avif_autodetection", "file_size_limit", "allowed_mime_types", "owner_id", "type") VALUES ('login-assets', 'login-assets', NULL, '2026-09-04 02:53:30.794665+00', '2026-09-04 02:53:30.794665+00', 'true', 'false', NULL, NULL, NULL, 'STANDARD') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "owner" = EXCLUDED."owner", "created_at" = EXCLUDED."created_at", "updated_at" = EXCLUDED."updated_at", "public" = EXCLUDED."public", "avif_autodetection" = EXCLUDED."avif_autodetection", "file_size_limit" = EXCLUDED."file_size_limit", "allowed_mime_types" = EXCLUDED."allowed_mime_types", "owner_id" = EXCLUDED."owner_id", "type" = EXCLUDED."type";

-- ============================================================
-- SECTION: API KEYS（API 管理：开放接口密钥）
-- 管理员在「管理后台 → API 管理」创建密钥（绑定归属账号），供第三方程序调用
-- /functions/v1/resource-api，只能读取该账号自己的资源（更新中 / 已完结）。
-- ============================================================

CREATE TABLE IF NOT EXISTS "public"."api_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL PRIMARY KEY,
    "name" "text" DEFAULT '未命名应用'::"text" NOT NULL,
    "api_key" "text" NOT NULL UNIQUE,
    "remark" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "expires_at" timestamp with time zone,
    "owner_id" "uuid" NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
    "created_by" "uuid" REFERENCES "auth"."users"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone,
    "call_count" bigint DEFAULT 0 NOT NULL,
    "last_ip" "text"
);

ALTER TABLE "public"."api_keys" ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS "idx_api_keys_created_at" ON "public"."api_keys" USING "btree" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_api_keys_owner_id" ON "public"."api_keys" USING "btree" ("owner_id");

--
-- Name: api_keys admin_full_access_api_keys; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'admin_full_access_api_keys'
      AND n.nspname = 'public'
      AND c.relname = 'api_keys'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "admin_full_access_api_keys" ON "public"."api_keys" FOR ALL TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;

--
-- Name: touch_api_key(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."touch_api_key"("p_id" "uuid", "p_ip" "text" DEFAULT NULL) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  UPDATE api_keys
  SET last_used_at = now(),
      call_count   = call_count + 1,
      last_ip      = COALESCE(p_ip, last_ip)
  WHERE id = p_id;
$$;

--
-- Name: resource_last_changes(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."resource_last_changes"("p_ids" "uuid"[]) RETURNS TABLE("resource_id" "uuid", "field_label" "text", "changed_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT DISTINCT ON (h.resource_id)
         h.resource_id,
         h.field_label,
         h.changed_at
  FROM change_history h
  WHERE h.resource_id = ANY (p_ids)
  ORDER BY h.resource_id, h.changed_at DESC;
$$;

-- ============================================================
-- SECTION: SITE CREDENTIALS（站点登录凭据云端加密存储）
-- 各站点会话失效后，用这里存的账号密码 / Cookie 自动重新登录，
-- 减少同步失败。密文由 pgcrypto 加密，密钥 SITE_CRED_KEY 只存在于
-- Edge Function 环境变量（site-credential）中。
-- ============================================================

CREATE TABLE IF NOT EXISTS "public"."site_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL PRIMARY KEY,
    "user_id" "uuid" NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
    "site" "text" NOT NULL,
    "username" "text",
    "secret_enc" "text",
    "secret_kind" "text" DEFAULT 'password'::"text" NOT NULL,
    "auto_login" boolean DEFAULT true NOT NULL,
    "last_success_at" timestamp with time zone,
    "last_error" "text",
    "fail_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "site_credentials_kind_check" CHECK (("secret_kind" = ANY (ARRAY['password'::"text", 'cookie'::"text"]))),
    CONSTRAINT "site_credentials_user_site_key" UNIQUE ("user_id", "site")
);

CREATE INDEX IF NOT EXISTS "idx_site_credentials_user" ON "public"."site_credentials" USING "btree" ("user_id");

ALTER TABLE "public"."site_credentials" ENABLE ROW LEVEL SECURITY;

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'own_site_credentials' AND n.nspname = 'public' AND c.relname = 'site_credentials'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "own_site_credentials" ON "public"."site_credentials" FOR ALL TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;

-- 列级权限：前端只可读元信息，读不到密文列 secret_enc
REVOKE ALL ON "public"."site_credentials" FROM "anon";
REVOKE ALL ON "public"."site_credentials" FROM "authenticated";
GRANT SELECT (id, user_id, site, username, secret_kind, auto_login, last_success_at, last_error, fail_count, created_at, updated_at)
  ON "public"."site_credentials" TO "authenticated";
GRANT ALL ON "public"."site_credentials" TO "service_role";

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'site_credentials_updated_at') THEN
    CREATE TRIGGER site_credentials_updated_at BEFORE UPDATE ON "public"."site_credentials"
      FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();
  END IF;
END
$pg_schema_restore$;

--
-- Name: site_secret_encrypt / site_secret_decrypt / save_site_credential /
--       load_site_credential / mark_site_credential; Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."site_secret_encrypt"("p_plain" "text", "p_key" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE SECURITY DEFINER SET "search_path" TO 'public'
    AS $$ SELECT encode(extensions.pgp_sym_encrypt(p_plain, p_key), 'base64'); $$;

CREATE OR REPLACE FUNCTION "public"."site_secret_decrypt"("p_enc" "text", "p_key" "text") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER SET "search_path" TO 'public'
    AS $$ SELECT extensions.pgp_sym_decrypt(decode(p_enc, 'base64'), p_key); $$;

CREATE OR REPLACE FUNCTION "public"."save_site_credential"("p_user_id" "uuid", "p_site" "text", "p_username" "text", "p_secret" "text", "p_kind" "text", "p_auto_login" boolean, "p_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO site_credentials (user_id, site, username, secret_enc, secret_kind, auto_login)
  VALUES (
    p_user_id, p_site, NULLIF(p_username, ''),
    CASE WHEN p_secret IS NULL OR p_secret = '' THEN NULL
         ELSE encode(extensions.pgp_sym_encrypt(p_secret, p_key), 'base64') END,
    COALESCE(NULLIF(p_kind, ''), 'password'),
    COALESCE(p_auto_login, true)
  )
  ON CONFLICT (user_id, site) DO UPDATE SET
    username   = COALESCE(NULLIF(EXCLUDED.username, ''), site_credentials.username),
    secret_enc = COALESCE(EXCLUDED.secret_enc, site_credentials.secret_enc),
    secret_kind = EXCLUDED.secret_kind,
    auto_login = EXCLUDED.auto_login,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION "public"."load_site_credential"("p_user_id" "uuid", "p_site" "text", "p_key" "text") RETURNS TABLE("username" "text", "secret" "text", "secret_kind" "text", "auto_login" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT c.username,
         CASE WHEN c.secret_enc IS NULL THEN NULL
              ELSE extensions.pgp_sym_decrypt(decode(c.secret_enc, 'base64'), p_key) END,
         c.secret_kind, c.auto_login
  FROM site_credentials c
  WHERE c.user_id = p_user_id AND c.site = p_site;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."mark_site_credential"("p_user_id" "uuid", "p_site" "text", "p_ok" boolean, "p_error" "text" DEFAULT NULL) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER SET "search_path" TO 'public'
    AS $$
  UPDATE site_credentials
  SET last_success_at = CASE WHEN p_ok THEN now() ELSE last_success_at END,
      last_error      = CASE WHEN p_ok THEN NULL ELSE NULLIF(p_error, '') END,
      fail_count      = CASE WHEN p_ok THEN 0 ELSE fail_count + 1 END,
      updated_at      = now()
  WHERE user_id = p_user_id AND site = p_site;
$$;

REVOKE ALL ON FUNCTION "public"."site_secret_encrypt"("text", "text") FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."site_secret_decrypt"("text", "text") FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."save_site_credential"("uuid", "text", "text", "text", "text", boolean, "text") FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."load_site_credential"("uuid", "text", "text") FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."mark_site_credential"("uuid", "text", boolean, "text") FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."site_secret_encrypt"("text", "text") TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."site_secret_decrypt"("text", "text") TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."save_site_credential"("uuid", "text", "text", "text", "text", boolean, "text") TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."load_site_credential"("uuid", "text", "text") TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."mark_site_credential"("uuid", "text", boolean, "text") TO "service_role";

-- ============================================================
-- SECTION: SUBSCRIPTIONS（订阅转存：RSS/网页更新页 → 网盘转存 → 自动入库）
-- 详见 supabase/migrations/00045_create_subscriptions.sql（含加解密与读写函数）
-- ============================================================

CREATE TABLE IF NOT EXISTS "public"."pan_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL PRIMARY KEY,
    "user_id" "uuid" NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
    "pan" "text" NOT NULL,
    "username" "text",
    "cookie_enc" "text",
    "root_dir" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_check_at" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pan_accounts_user_pan_key" UNIQUE ("user_id", "pan"),
    CONSTRAINT "pan_accounts_pan_check" CHECK (("pan" = ANY (ARRAY['guangya'::"text", 'quark'::"text"]))),
    CONSTRAINT "pan_accounts_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'expired'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL PRIMARY KEY,
    "user_id" "uuid" NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
    "name" "text" DEFAULT '未命名订阅'::"text" NOT NULL,
    "source_url" "text" NOT NULL,
    "source_type" "text" DEFAULT 'auto'::"text" NOT NULL,
    "source_passcode" "text",
    "clean_mode" "text" DEFAULT 'none'::"text" NOT NULL,
    "target_dir_name" "text",
    "keyword" "text",
    "pan" "text" DEFAULT 'guangya'::"text" NOT NULL,
    "target_dir" "text",
    "auto_publish" boolean DEFAULT false NOT NULL,
    "resource_id" "uuid" REFERENCES "public"."resources"("id") ON DELETE SET NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "interval_minutes" integer DEFAULT 1 NOT NULL,
    "last_run_at" timestamp with time zone,
    "last_status" "text",
    "last_message" "text",
    "run_lock_at" timestamp with time zone,
    "stats" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscriptions_type_check" CHECK (("source_type" = ANY (ARRAY['auto'::"text", 'rss'::"text", 'page'::"text", 'pan_share'::"text"]))),
    CONSTRAINT "subscriptions_pan_check" CHECK (("pan" = ANY (ARRAY['guangya'::"text", 'quark'::"text"]))),
    CONSTRAINT "subscriptions_user_url_key" UNIQUE ("user_id", "source_url")
);

-- ---------- 订阅改了资源后的「待推送站点」任务（详见 migrations/00051_subscription_resource_binding.sql）----------
-- 服务端改完资源后登记一条；由服务端 worker（resource-sync-worker，pg_cron 每分钟触发）无人值守推送到各站点，
-- 前端打开资源管理页时也会补推（作为 worker 未部署/失败时的兜底）。
CREATE TABLE IF NOT EXISTS "public"."resource_sync_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL PRIMARY KEY,
    "user_id" "uuid" NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
    "resource_id" "uuid" NOT NULL REFERENCES "public"."resources"("id") ON DELETE CASCADE,
    "resource_name" "text" DEFAULT ''::"text" NOT NULL,
    "reason" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "last_attempt_at" timestamp with time zone,
    "claimed_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_resource_sync_queue_resource" ON "public"."resource_sync_queue" USING "btree" ("resource_id");
CREATE INDEX IF NOT EXISTS "idx_resource_sync_queue_user" ON "public"."resource_sync_queue" USING "btree" ("user_id", "created_at" DESC);

ALTER TABLE "public"."resource_sync_queue" ENABLE ROW LEVEL SECURITY;

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'own_resource_sync_queue' AND n.nspname = 'public' AND c.relname = 'resource_sync_queue'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "own_resource_sync_queue" ON "public"."resource_sync_queue" FOR ALL TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;

CREATE TABLE IF NOT EXISTS "public"."subscription_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL PRIMARY KEY,
    "subscription_id" "uuid" NOT NULL REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE,
    "user_id" "uuid" NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
    "title" "text" DEFAULT ''::"text" NOT NULL,
    "source_url" "text",
    "share_url" "text",
    "share_passcode" "text",
    "pan" "text",
    "fingerprint" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "transfer_url" "text",
    "resource_id" "uuid" REFERENCES "public"."resources"("id") ON DELETE SET NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscription_items_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'transferred'::"text", 'imported'::"text", 'failed'::"text", 'skipped'::"text"]))),
    CONSTRAINT "subscription_items_dedupe" UNIQUE ("subscription_id", "fingerprint")
);

CREATE INDEX IF NOT EXISTS "idx_subscriptions_user" ON "public"."subscriptions" USING "btree" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_subscriptions_enabled" ON "public"."subscriptions" USING "btree" ("enabled", "last_run_at");
CREATE INDEX IF NOT EXISTS "idx_subscription_items_user" ON "public"."subscription_items" USING "btree" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_subscription_items_sub" ON "public"."subscription_items" USING "btree" ("subscription_id", "status");

ALTER TABLE "public"."pan_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."subscription_items" ENABLE ROW LEVEL SECURITY;

DO $pg_schema_restore$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pan_accounts', 'subscriptions', 'subscription_items'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE pol.polname = 'own_' || t AND n.nspname = 'public' AND c.relname = t
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())',
        'own_' || t, t
      );
    END IF;
  END LOOP;
END
$pg_schema_restore$;

REVOKE ALL ON "public"."pan_accounts" FROM "anon";
REVOKE ALL ON "public"."pan_accounts" FROM "authenticated";
GRANT SELECT (id, user_id, pan, username, root_dir, status, last_check_at, last_error, created_at, updated_at)
  ON "public"."pan_accounts" TO "authenticated";
GRANT ALL ON "public"."pan_accounts" TO "service_role";
GRANT ALL ON "public"."subscriptions" TO "authenticated";
GRANT ALL ON "public"."subscriptions" TO "service_role";
GRANT ALL ON "public"."subscription_items" TO "authenticated";
GRANT ALL ON "public"."subscription_items" TO "service_role";

DO $pg_schema_restore$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pan_accounts', 'subscriptions', 'subscription_items'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_updated_at') THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
        t || '_updated_at', t
      );
    END IF;
  END LOOP;
END
$pg_schema_restore$;

-- 网盘账号加解密与读写函数（save_pan_account / load_pan_account / mark_pan_account）
-- 与站点凭据共用 extensions.pgp_sym_*，定义见 migrations/00045_create_subscriptions.sql

-- ---------- 光鸭 OAuth 扫码绑定（详见 migrations/00046_pan_oauth_binding.sql）----------
ALTER TABLE "public"."pan_accounts" ADD COLUMN IF NOT EXISTS "token_enc" "text";
ALTER TABLE "public"."pan_accounts" ADD COLUMN IF NOT EXISTS "root_dir_id" "text";
ALTER TABLE "public"."pan_accounts" ADD COLUMN IF NOT EXISTS "credential_type" "text" DEFAULT 'cookie'::"text" NOT NULL;

CREATE TABLE IF NOT EXISTS "public"."pan_bind_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL PRIMARY KEY,
    "user_id" "uuid" NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
    "pan" "text" DEFAULT 'guangya'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "device_code" "text" NOT NULL,
    "interval" integer DEFAULT 2 NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "last_poll_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pan_bind_sessions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'success'::"text", 'expired'::"text", 'failed'::"text"])))
);

CREATE INDEX IF NOT EXISTS "idx_pan_bind_sessions_user" ON "public"."pan_bind_sessions" USING "btree" ("user_id", "created_at" DESC);

ALTER TABLE "public"."pan_bind_sessions" ENABLE ROW LEVEL SECURITY;

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'own_pan_bind_sessions' AND n.nspname = 'public' AND c.relname = 'pan_bind_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "own_pan_bind_sessions" ON "public"."pan_bind_sessions" FOR ALL TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pan_bind_sessions_updated_at') THEN
    CREATE TRIGGER pan_bind_sessions_updated_at BEFORE UPDATE ON "public"."pan_bind_sessions"
      FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();
  END IF;
END
$pg_schema_restore$;

-- OAuth 令牌加解密读写函数：save_pan_oauth / load_pan_oauth / update_pan_oauth_token
-- 定义见 migrations/00046_pan_oauth_binding.sql

-- ============================================================
-- SECTION: CRON JOBS
-- ============================================================
-- 订阅转存定时任务：每分钟触发 subscription-run（函数内按每个订阅的「检查时间」判断是否到点）
-- SELECT cron.schedule('subscription-run-1min', '* * * * *', $$ SELECT net.http_post(...) $$);
-- 用户自定义 pg_cron 任务。


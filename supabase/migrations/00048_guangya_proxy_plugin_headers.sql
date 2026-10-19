-- ============================================================
-- 光鸭代理请求头对齐官方插件实现
--
-- 依据：用户提供的《光鸭接入机器插件-优化版》（main.py，AstrBot 插件）
--   · 账号域换令牌 POST https://account.guangyapan.com/v1/auth/token
--     body（JSON）：{ client_id, grant_type: "refresh_token", refresh_token }
--     头：Content-Type: application/json / Accept: */* / Origin / Referer /
--         User-Agent / X-Client-Id / X-Client-Version: 0.0.1 / X-Action: 401 /
--         X-Protocol-Version: 301 / X-Sdk-Version: 9.0.2
--   · 业务域 POST https://api.guangyapan.com/userres/v1/...
--     头：Authorization: Bearer <access_token> + 上面同一组 SDK 头（无 X-Action）
--
-- 结论：业务接口不认「缺 X-Client-Id / X-Sdk-Version 等 SDK 头」的请求，
--       会返回 401 + code=117「无效token」——这正是此前的根因；
--       而 did / dt 两个头是早期推测，插件实现里根本不存在，故一并去掉。
-- ============================================================

CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;

-- 旧签名先删除，否则会变成「重载」而不是替换
DROP FUNCTION IF EXISTS public.guangya_proxy(text, jsonb, text, integer, text);
DROP FUNCTION IF EXISTS public.guangya_proxy_account(text, text, integer);

-- ── 业务域代理：Bearer + 官方 SDK 头 ──────────────────────────────
CREATE OR REPLACE FUNCTION public.guangya_proxy(
  p_path text,
  p_body jsonb,
  p_bearer text,
  p_timeout_ms integer DEFAULT 12000,
  p_did text DEFAULT NULL::text,      -- 兼容旧签名，不再使用
  p_client_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  cid  text := coalesce(nullif(p_client_id, ''), 'aMe-8VSlkrbQXpUR');
  resp extensions.http_response;
  t0   timestamptz := clock_timestamp();
BEGIN
  BEGIN
    PERFORM extensions.http_set_curlopt(
      'CURLOPT_TIMEOUT',
      greatest(1, least(coalesce(p_timeout_ms, 12000), 30000) / 1000)::text
    );
  EXCEPTION WHEN others THEN NULL;
  END;

  PERFORM extensions.http_header('accept', '*/*');
  PERFORM extensions.http_header('authorization', 'Bearer ' || coalesce(p_bearer, ''));
  PERFORM extensions.http_header('origin', 'https://www.guangyapan.com');
  PERFORM extensions.http_header('referer', 'https://www.guangyapan.com/');
  PERFORM extensions.http_header(
    'User-Agent',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
  );
  PERFORM extensions.http_header('X-Client-Id', cid);
  PERFORM extensions.http_header('X-Client-Version', '0.0.1');
  PERFORM extensions.http_header('X-Protocol-Version', '301');
  PERFORM extensions.http_header('X-Sdk-Version', '9.0.2');

  resp := extensions.http_post(
    uri := 'https://api.guangyapan.com' || p_path,
    content := coalesce(p_body, '{}'::jsonb)::text,
    content_type := 'application/json'
  );

  RETURN jsonb_build_object(
    '_status', resp.status,
    '_waited_ms', (extract(epoch FROM (clock_timestamp() - t0)) * 1000)::int,
    'body', coalesce(NULLIF(resp.content, ''), '{}')::jsonb
  );
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('_proxy_error', sqlerrm);
END
$function$;

-- ── 账号域代理：支持 JSON body + 官方 SDK 头（换令牌用）─────────────
-- 保留原有 form 调用方式（p_json_body 为空时走 form），避免影响既有调用。
CREATE OR REPLACE FUNCTION public.guangya_proxy_account(
  p_path text,
  p_form_body text DEFAULT NULL::text,
  p_timeout_ms integer DEFAULT 12000,
  p_json_body jsonb DEFAULT NULL::jsonb,
  p_client_id text DEFAULT NULL::text,
  p_action text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  cid  text := coalesce(nullif(p_client_id, ''), 'aMe-8VSlkrbQXpUR');
  resp extensions.http_response;
  t0   timestamptz := clock_timestamp();
BEGIN
  BEGIN
    PERFORM extensions.http_set_curlopt(
      'CURLOPT_TIMEOUT',
      greatest(1, least(coalesce(p_timeout_ms, 12000), 30000) / 1000)::text
    );
  EXCEPTION WHEN others THEN NULL;
  END;

  PERFORM extensions.http_header('accept', '*/*');
  PERFORM extensions.http_header('origin', 'https://www.guangyapan.com');
  PERFORM extensions.http_header('referer', 'https://www.guangyapan.com/');
  PERFORM extensions.http_header(
    'User-Agent',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
  );

  IF p_json_body IS NOT NULL THEN
    -- 官方插件的方式：JSON body + SDK 头
    PERFORM extensions.http_header('X-Client-Id', cid);
    PERFORM extensions.http_header('X-Client-Version', '0.0.1');
    PERFORM extensions.http_header('X-Protocol-Version', '301');
    PERFORM extensions.http_header('X-Sdk-Version', '9.0.2');
    IF p_action IS NOT NULL AND p_action <> '' THEN
      PERFORM extensions.http_header('X-Action', p_action);
    END IF;

    resp := extensions.http_post(
      uri := 'https://account.guangyapan.com' || p_path,
      content := p_json_body::text,
      content_type := 'application/json'
    );
  ELSE
    PERFORM extensions.http_header('authorization', '');
    resp := extensions.http_post(
      uri := 'https://account.guangyapan.com' || p_path,
      content := coalesce(p_form_body, ''),
      content_type := 'application/x-www-form-urlencoded'
    );
  END IF;

  RETURN jsonb_build_object(
    '_status', resp.status,
    '_waited_ms', (extract(epoch FROM (clock_timestamp() - t0)) * 1000)::int,
    'body', coalesce(NULLIF(resp.content, ''), '{}')::jsonb
  );
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('_proxy_error', sqlerrm);
END
$function$;

REVOKE ALL ON FUNCTION public.guangya_proxy(text, jsonb, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guangya_proxy(text, jsonb, text, integer, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.guangya_proxy_account(text, text, integer, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guangya_proxy_account(text, text, integer, jsonb, text, text) TO service_role;

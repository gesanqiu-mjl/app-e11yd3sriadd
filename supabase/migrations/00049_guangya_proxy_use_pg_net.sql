-- ============================================================
-- 光鸭代理改用 pg_net 发送请求（根因修复）
--
-- 问题：原先用 `http` 扩展的 http_header() 设置请求头，实测【完全无效】——
--   用回显服务（httpbin / postman-echo）验证，服务端只收到 curl 默认头，
--   `Authorization` / `X-Client-Id` / `User-Agent` 等自定义头一个都没发出去。
--   因此所有带鉴权的业务接口都被判 401 + code=117「无效token」
--   （而无鉴权的分享摘要接口一直是 200，所以看起来"代理是通的"）。
--
-- 修复：改用 pg_net（net.http_post，支持 headers jsonb）发送请求，
--   已用回显服务验证 Authorization / X-Client-Id / X-Sdk-Version 等均可正常送达。
--   pg_net 是异步的，这里在同一函数内轮询 net._http_response 取回结果。
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA net;

-- ── 业务域代理：Bearer + 官方 SDK 头 ──────────────────────────────
CREATE OR REPLACE FUNCTION public.guangya_proxy(
  p_path text,
  p_body jsonb,
  p_bearer text,
  p_timeout_ms integer DEFAULT 12000,
  p_did text DEFAULT NULL::text,     -- 兼容旧签名，官方客户端不使用
  p_client_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'net', 'pg_temp'
AS $function$
DECLARE
  cid    text := coalesce(nullif(p_client_id, ''), 'aMe-8VSlkrbQXpUR');
  rid    bigint;
  st     integer;
  ct     text;
  too    boolean;
  err    text;
  i      integer;
  hdrs   jsonb;
BEGIN
  hdrs := jsonb_build_object(
    'accept', '*/*',
    'content-type', 'application/json',
    'origin', 'https://www.guangyapan.com',
    'referer', 'https://www.guangyapan.com/',
    'user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'X-Client-Id', cid,
    'X-Client-Version', '0.0.1',
    'X-Protocol-Version', '301',
    'X-Sdk-Version', '9.0.2',
    'Authorization', 'Bearer ' || coalesce(p_bearer, '')
  );

  SELECT net.http_post(
    url := 'https://api.guangyapan.com' || p_path,
    body := coalesce(p_body, '{}'::jsonb),
    headers := hdrs,
    timeout_milliseconds := greatest(1000, least(coalesce(p_timeout_ms, 12000), 30000))
  ) INTO rid;

  FOR i IN 1..160 LOOP
    SELECT status_code, content, timed_out, error_msg
      INTO st, ct, too, err
      FROM net._http_response WHERE id = rid;
    EXIT WHEN ct IS NOT NULL OR too OR err IS NOT NULL;
    PERFORM pg_sleep(0.25);
  END LOOP;

  IF err IS NOT NULL THEN
    RETURN jsonb_build_object('_proxy_error', err);
  END IF;
  IF too THEN
    RETURN jsonb_build_object('_proxy_error', 'pg_net 请求超时');
  END IF;
  IF ct IS NULL THEN
    RETURN jsonb_build_object('_proxy_error', 'pg_net 未返回响应（可能仍在队列中）');
  END IF;

  RETURN jsonb_build_object(
    '_status', coalesce(st, 0),
    'body', coalesce(NULLIF(ct, ''), '{}')::jsonb
  );
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('_proxy_error', sqlerrm);
END
$function$;

-- ── 账号域代理：JSON body + 官方 SDK 头（换令牌 / 校验）─────────────
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
SET search_path TO 'public', 'extensions', 'net', 'pg_temp'
AS $function$
DECLARE
  cid  text := coalesce(nullif(p_client_id, ''), 'aMe-8VSlkrbQXpUR');
  rid  bigint;
  st   integer;
  ct   text;
  too  boolean;
  err  text;
  i    integer;
  hdrs jsonb;
BEGIN
  -- pg_net 的 body 必须是 jsonb，form 编码无法直接表达；项目里账号域调用已全部改为 JSON。
  IF p_json_body IS NULL THEN
    RETURN jsonb_build_object('_proxy_error', '账号域代理只支持 JSON body（p_json_body）');
  END IF;

  hdrs := jsonb_build_object(
    'accept', '*/*',
    'content-type', 'application/json',
    'origin', 'https://www.guangyapan.com',
    'referer', 'https://www.guangyapan.com/',
    'user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'X-Client-Id', cid,
    'X-Client-Version', '0.0.1',
    'X-Protocol-Version', '301',
    'X-Sdk-Version', '9.0.2'
  );
  IF p_action IS NOT NULL AND p_action <> '' THEN
    hdrs := hdrs || jsonb_build_object('X-Action', p_action);
  END IF;

  SELECT net.http_post(
    url := 'https://account.guangyapan.com' || p_path,
    body := p_json_body,
    headers := hdrs,
    timeout_milliseconds := greatest(1000, least(coalesce(p_timeout_ms, 12000), 30000))
  ) INTO rid;

  FOR i IN 1..160 LOOP
    SELECT status_code, content, timed_out, error_msg
      INTO st, ct, too, err
      FROM net._http_response WHERE id = rid;
    EXIT WHEN ct IS NOT NULL OR too OR err IS NOT NULL;
    PERFORM pg_sleep(0.25);
  END LOOP;

  IF err IS NOT NULL THEN
    RETURN jsonb_build_object('_proxy_error', err);
  END IF;
  IF too THEN
    RETURN jsonb_build_object('_proxy_error', 'pg_net 请求超时');
  END IF;
  IF ct IS NULL THEN
    RETURN jsonb_build_object('_proxy_error', 'pg_net 未返回响应（可能仍在队列中）');
  END IF;

  RETURN jsonb_build_object(
    '_status', coalesce(st, 0),
    'body', coalesce(NULLIF(ct, ''), '{}')::jsonb
  );
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('_proxy_error', sqlerrm);
END
$function$;

REVOKE ALL ON FUNCTION public.guangya_proxy(text, jsonb, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guangya_proxy(text, jsonb, text, integer, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.guangya_proxy_account(text, text, integer, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guangya_proxy_account(text, text, integer, jsonb, text, text) TO service_role;

-- 清理排查期间建的临时探针函数
DROP FUNCTION IF EXISTS public._probe_headers();
DROP FUNCTION IF EXISTS public._probe_net();

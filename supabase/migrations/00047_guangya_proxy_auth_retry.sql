-- ============================================================
-- 光鸭业务域代理：鉴权被拒时自动换请求头重试
--
-- 背景：线上 `POST /userres/v1/file/get_file_list` 一直返回
--   401 + { code: 117, msg: "无效token" }
-- 且刷新令牌后仍然如此。光鸭会把令牌与请求头里的设备号（did）关联，
-- 绑定不一致就会被判无效。
--
-- 该函数在被鉴权拒绝（HTTP 401 或业务码 112/117）时，依次用
--   ① 调用方传入的 did  →  ② 不带 did  →  ③ 随机 did
-- 重新请求，返回第一个「非鉴权拒绝」的响应；全部被拒则返回第一次的响应。
-- 由于重试只发生在服务端明确拒绝（未执行任何写操作）之后，对转存等写操作同样安全。
--
-- 注：本函数原先只存在于线上库、仓库内没有定义，这里一并纳入版本管理。
-- ============================================================

CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.guangya_proxy(
  p_path text,
  p_body jsonb,
  p_bearer text,
  p_timeout_ms integer DEFAULT 12000,
  p_did text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  base_did     text := COALESCE(NULLIF(p_did, ''), replace(gen_random_uuid()::text, '-', ''));
  variants     text[] := ARRAY[base_did, '', replace(gen_random_uuid()::text, '-', '')];
  v            text;
  resp         extensions.http_response;
  first_status integer;
  first_body   jsonb;
  code_txt     text;
  t0           timestamptz := clock_timestamp();
BEGIN
  BEGIN
    PERFORM extensions.http_set_curlopt(
      'CURLOPT_TIMEOUT',
      greatest(1, least(coalesce(p_timeout_ms, 12000), 30000) / 1000)::text
    );
  EXCEPTION WHEN others THEN NULL;
  END;

  FOREACH v IN ARRAY variants LOOP
    PERFORM extensions.http_header('accept', 'application/json, text/plain, */*');
    PERFORM extensions.http_header('accept-encoding', 'identity');
    PERFORM extensions.http_header('authorization', 'Bearer ' || coalesce(p_bearer, ''));
    PERFORM extensions.http_header('did', coalesce(v, ''));
    PERFORM extensions.http_header('dt', '4');
    PERFORM extensions.http_header('origin', 'https://www.guangyapan.com');
    PERFORM extensions.http_header('referer', 'https://www.guangyapan.com/');
    PERFORM extensions.http_header(
      'User-Agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );

    resp := extensions.http_post(
      uri := 'https://api.guangyapan.com' || p_path,
      content := coalesce(p_body, '{}'::jsonb)::text,
      content_type := 'application/json'
    );

    -- 业务码解析失败（非 JSON 响应）时按“非鉴权拒绝”处理，保留原样返回
    BEGIN
      code_txt := coalesce((NULLIF(resp.content, '')::jsonb) ->> 'code', '');
    EXCEPTION WHEN others THEN
      code_txt := '';
    END;

    IF first_body IS NULL THEN
      first_status := resp.status;
      first_body := coalesce(NULLIF(resp.content, ''), '{}')::jsonb;
    END IF;

    IF resp.status <> 401 AND code_txt NOT IN ('112', '117') THEN
      RETURN jsonb_build_object(
        '_status', resp.status,
        '_waited_ms', (extract(epoch FROM (clock_timestamp() - t0)) * 1000)::int,
        'body', coalesce(NULLIF(resp.content, ''), '{}')::jsonb
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    '_status', first_status,
    '_waited_ms', (extract(epoch FROM (clock_timestamp() - t0)) * 1000)::int,
    'body', first_body
  );
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('_proxy_error', sqlerrm);
END
$function$;

REVOKE ALL ON FUNCTION public.guangya_proxy(text, jsonb, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guangya_proxy(text, jsonb, text, integer, text) TO service_role;

/**
 * Edge Function: update-resource
 * 中转鸭影臻藏(guangya.xyz.hr)的 api_update_resource RPC，
 * 在服务端注入脚本密钥 p_api_key，避免密钥暴露给前端。
 *
 * 鉴权模型（与鸭影后端一致）：
 *   - 前端登录鸭影拿 access_token，放入 Authorization: Bearer <token>
 *   - 本函数校验该 token 存在后，转发请求到鸭影 Supabase，
 *     请求头同时带用户 Bearer token + 服务端注入的 p_api_key
 *   - 鸭影后端校验"登录态有效 + 秘钥有效"双通过才执行修改
 *
 * 部署前需在 Supabase 项目设置 secrets：
 *   supabase secrets set GUANGYA_ANON_KEY=<鸭影anon key>
 *   supabase secrets set GUANGYA_P_API_KEY=<sk_脚本密钥>
 *   supabase functions deploy update-resource
 */

// 鸭影 Supabase 实例（由 secrets 注入，避免硬编码）
const GUANGYA_BASE_URL = Deno.env.get("GUANGYA_SUPABASE_URL") ?? "https://houhvngggkkcqcjmzafx.supabase.co";
// GUANGYA_ANON_KEY 未单独配置时，回退读取历史 YA_ANON_KEY（同一凭证）
const GUANGYA_ANON_KEY = Deno.env.get("GUANGYA_ANON_KEY") ?? Deno.env.get("YA_ANON_KEY") ?? "";
const GUANGYA_P_API_KEY = Deno.env.get("GUANGYA_P_API_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 1. 提取用户登录态（鸭影的 access_token）
  const authHeader = req.headers.get("Authorization") ?? "";
  const userToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!userToken) {
    return json(
      { success: false, error: "缺少用户登录态，请先登录鸭影账号" },
      401,
    );
  }

  // 2. 读取请求体（只允许白名单字段）
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "请求体必须是合法 JSON" }, 400);
  }
  const p_link_id = body.p_link_id;
  if (p_link_id === undefined || p_link_id === null) {
    return json({ success: false, error: "p_link_id 为必填参数" }, 400);
  }

  const payload: Record<string, unknown> = {
    p_api_key: GUANGYA_P_API_KEY,
    p_link_id,
  };
  // 可选字段：仅当显式传入时透传（保持部分更新能力）
  if (body.p_name !== undefined) payload.p_name = body.p_name;
  if (body.p_url !== undefined) payload.p_url = body.p_url;
  if (body.p_extract_code !== undefined) payload.p_extract_code = body.p_extract_code;

  // 3. 转发到鸭影后端
  const resp = await fetch(
    `${GUANGYA_BASE_URL}/rest/v1/rpc/api_update_resource`,
    {
      method: "POST",
      headers: {
        apikey: GUANGYA_ANON_KEY,
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
        "x-client-info": "marvis-edge-proxy",
      },
      body: JSON.stringify(payload),
    },
  );

  const text = await resp.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // 保留原文
  }

  return json(
    {
      success: resp.ok,
      status: resp.status,
      data,
    },
    resp.ok ? 200 : resp.status,
  );
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

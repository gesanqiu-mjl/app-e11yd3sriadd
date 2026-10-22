// ============================================================
// Supabase Edge Function: resource-sync
// 资源同步更新代理（与观影 xnshare-proxy 同构）
//
// 作用：把本站资源接口（api_search_videos / api_add_resource）
//       封装为统一入口，供脚本/前端调用，隐藏 anon key。
//       鉴权模型与你的 API 文档一致：登录态 + API 秘钥 双重鉴权。
//
// 部署：supabase functions deploy resource-sync
// 环境变量：
//   ANON_KEY   必填，本站 anon key
//   API_KEY    可选，本站下发脚本的 sk_ 秘钥；配置后自动注入
//              p_api_key，调用方无需再传
//   SITE_URL   可选，CORS 白名单，默认 *
//
// 调用方式：
//   POST /resource-sync?action=search_videos
//   Authorization: Bearer <access_token>
//   body: { p_title, p_category?, p_limit?, p_api_key? }
// ============================================================

const ANON_KEY = Deno.env.get("ANON_KEY") ?? "";
const API_KEY = Deno.env.get("API_KEY") ?? "";
const SITE_URL = Deno.env.get("SITE_URL") ?? "*";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// action → RPC 映射（仅资源同步更新相关）
const RPC_ACTIONS: Record<string, string> = {
  search_videos: "api_search_videos",   // 查询片源 + 全部有效资源链接
  add_resource:  "api_add_resource",    // 添加一条网盘资源到片源
};

const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_URL,
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!ANON_KEY) {
    return json({ error: "服务端未配置 ANON_KEY 环境变量" }, 500);
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "";
    const rpc = RPC_ACTIONS[action];
    if (!rpc) {
      return json(
        { error: `不支持的 action: ${action}`, actions: Object.keys(RPC_ACTIONS) },
        400
      );
    }

    // ---------- 鉴权：登录态（必）+ 秘钥（自动注入或手动传） ----------
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "请先登录：缺少 Authorization: Bearer <access_token>" }, 401);
    }

    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      body = await req.json().catch(() => ({}));
    } else {
      for (const [k, v] of url.searchParams.entries()) {
        if (k !== "action") body[k] = v;
      }
    }

    if (API_KEY) {
      body.p_api_key = API_KEY; // 环境变量优先，自动注入
    } else if (!body.p_api_key) {
      return json({ error: "缺少 API 密钥：请求体需带 p_api_key" }, 401);
    }

    // ---------- 转发到本站 RPC ----------
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpc}`, {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await rpcRes.text();
    return new Response(text || JSON.stringify({ success: rpcRes.ok }), {
      status: rpcRes.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

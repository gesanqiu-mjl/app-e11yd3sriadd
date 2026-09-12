// ============================================================
// Supabase Edge Function: xnshare-proxy
// https://www.xn--wcv59z.com/ 网盘分享 API 服务端代理
//
// 部署：supabase functions deploy xnshare-proxy
// 环境变量：SITE_URL（你的网站域名，用于 CORS，可留空默认 *）
//
// 安全模型：
//  1. 请求必须携带 Supabase 登录用户的 access_token（Authorization: Bearer xxx）
//  2. Edge Function 用 service role 读取该用户绑定的站点 Cookie
//  3. Cookie 永不返回前端，只在服务端转发给目标站点
//
// 失效检测（本站 Cookie 为 PHPSESSID 纯 Session 级，无 Max-Age，浏览器关闭即弃）：
//  每次转发后检查目标站响应 —— 若返回登录页 HTML / 非 JSON /
//  登录错误信息，判定 Cookie 失效，自动把 xn_sessions.status 置为
//  'expired'，并向前端返回 code=COOKIE_EXPIRED 以便提示重新绑定。
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SITE_BASE = "https://www.xn--wcv59z.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// 把对象转成目标站期望的 form-urlencoded 字符串（支持 binds 数组）
// 例：{title:"x", binds:[{dir:"mv",id:"g7b3"}]}
//  → title=x&binds[0][dir]=mv&binds[0][id]=g7b3
function toForm(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === "object") {
          for (const [ik, iv] of Object.entries(item as Record<string, unknown>)) {
            params.append(`binds[${i}][${ik}]`, String(iv ?? ""));
          }
        } else {
          params.append(`binds[${i}]`, String(item ?? ""));
        }
      });
    } else if (v !== undefined && v !== null) {
      params.append(k, String(v));
    }
  }
  return params.toString();
}

// 检测目标站响应是否表示 Cookie 已失效
// 判定条件（任一命中即失效）：
//  1. Content-Type 为 text/html（被重定向到登录页）
//  2. body 不是合法 JSON
//  3. JSON 中 msg 含"登录/未登录/login/auth"等关键词
async function isSessionExpired(res: Response): Promise<boolean> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/html")) return true;

  const text = await res.clone().text();
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return true;

  try {
    const data = JSON.parse(trimmed);
    if (
      data &&
      /登录|未登录|请先登录|login|auth/i.test(data.msg ?? data.message ?? "")
    ) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

// 统一转发：对目标站发起请求，返回原始 Response（不吞 body）
async function proxy(
  method: "GET" | "POST",
  pathWithQuery: string,
  cookie: string,
  formBody?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    Cookie: cookie,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    Referer: `${SITE_BASE}/user/content_list`,
    "X-Requested-With": "XMLHttpRequest",
  };
  if (formBody) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const res = await fetch(`${SITE_BASE}${pathWithQuery}`, {
    method,
    headers,
    body: formBody || undefined,
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`目标站返回 ${res.status}`);
  }
  return res;
}

Deno.serve(async (req) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---------- 1. 验证 Supabase 登录态 ----------
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "未登录" }, 401);
    }
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return json({ error: "登录态无效" }, 401);
    }

    // ---------- 2. 读取该用户绑定的 Cookie ----------
    const { data: session, error: sessionError } = await supabase
      .from("xn_sessions")
      .select("cookie")
      .eq("user_id", user.id)
      .maybeSingle();

    if (sessionError || !session) {
      return json(
        { error: "未绑定站点账号，请先在设置页绑定 Cookie" },
        400
      );
    }

    // ---------- 3. 解析 action 并转发 ----------
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    // GET 类 action：list / search（透传查询参数）
    const GET_ACTIONS: Record<string, { path: string; queryKeys: string[] }> = {
      list: {
        path: "/res/user/content_list",
        queryKeys: ["page", "search", "pan", "dirid"],
      },
      search: {
        path: "/res/search_suggest",
        queryKeys: ["q", "type", "num"],
      },
    };

    // POST 类 action：add / edit / del
    const POST_ACTIONS: Record<
      string,
      { path: (body: Record<string, unknown>) => string; form?: (body: Record<string, unknown>) => Record<string, unknown> }
    > = {
      add: {
        path: () => "/res/pan/add",
        form: (b) => ({
          title: b.title ?? "",
          panurl: b.panurl ?? "",
          panpw: b.panpw ?? "",
          is: b.is ?? 0,
          binds: Array.isArray(b.binds) ? b.binds : [],
        }),
      },
      edit: {
        path: (b) => `/res/pan/edit/${b.id ?? ""}`,
        form: (b) => ({
          title: b.title ?? "",
          panurl: b.panurl ?? "",
          panpw: b.panpw ?? "",
          is: b.is ?? 0,
          binds: Array.isArray(b.binds) ? b.binds : [],
        }),
      },
      del: {
        path: (b) => `/res/pan/del/${b.id ?? ""}`,
        form: () => ({}),
      },
    };

    let targetPath: string | null = null;
    let formBody: string | undefined;

    const getCfg = GET_ACTIONS[action ?? ""];
    if (getCfg) {
      const qs = new URLSearchParams();
      for (const key of getCfg.queryKeys) {
        const v = url.searchParams.get(key);
        if (v !== null) qs.set(key, v);
      }
      targetPath = getCfg.path + (qs.toString() ? "?" + qs.toString() : "");
    } else {
      const postCfg = POST_ACTIONS[action ?? ""];
      if (postCfg && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        targetPath = postCfg.path(body);
        const form = postCfg.form ? postCfg.form(body) : {};
        formBody = toForm(form);
      }
    }

    if (!targetPath) {
      return json({ error: `不支持的 action: ${action}` }, 400);
    }

    const res = await proxy(
      formBody !== undefined ? "POST" : "GET",
      targetPath,
      session.cookie,
      formBody
    );

    // ---------- 4. Cookie 失效检测 ----------
    const expired = await isSessionExpired(res);
    const now = new Date().toISOString();

    if (expired) {
      await supabase
        .from("xn_sessions")
        .update({ status: "expired", last_check_at: now })
        .eq("user_id", user.id);

      return json(
        {
          success: false,
          code: "COOKIE_EXPIRED",
          message: "站点登录已过期，请重新绑定 Cookie",
        },
        401
      );
    }

    await supabase
      .from("xn_sessions")
      .update({ status: "active", last_check_at: now })
      .eq("user_id", user.id);

    const data = await res.json();
    return json(data);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

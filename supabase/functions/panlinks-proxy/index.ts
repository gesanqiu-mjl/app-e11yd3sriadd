// ============================================================
// Supabase Edge Function: panlinks-proxy
// pinglian.lol「我的网盘」API 服务端代理（v4 接口）
//
// 部署：supabase functions deploy panlinks-proxy
// 环境变量：SITE_URL（你的网站域名，用于 CORS，可留空默认 *）
//
// v4 接口契约（2026-09-10 实测）：
//  - 登录：POST /api/auth/login，application/x-www-form-urlencoded，
//    body: username/password/remember=1；失败 401 + {"success":false,...}
//  - 状态：GET /api/auth/status
//  - 链接列表：GET /api/videos/links?page=&page_size=
//  - 链接详情：GET /api/videos/links/{id}（返回 data.link）
//  - 新增：POST /api/videos/{video_id}/links（JSON）
//  - 修改：PUT /api/videos/links/{id}（JSON）
//  - 删除：DELETE /api/videos/links/{id}（JSON）
//  - 未登录态：GET /api/videos/link-quota 返回 401
// 统一响应包裹 {success, data, message, timestamp}
//
// 安全模型：
//  1. 请求必须携带 Supabase 登录用户的 access_token（Authorization: Bearer xxx）
//  2. action=login 时服务端模拟登录 pinglian.lol，成功后把 Cookie 写入
//     pinglian_sessions；账号明文存 username，密码不落库
//  3. 其余 action 用 service role 读取该用户绑定的 pinglian.lol Cookie
//  4. Cookie 永不返回前端，只在服务端转发给 pinglian.lol
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const PINGLIAN_BASE = "https://pinglian.lol";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// 把对象转成 pinglian.lol 期望的 form-urlencoded 字符串
function toForm(body: Record<string, string | number>): string {
  return new URLSearchParams(
    Object.entries(body).map(([k, v]) => [k, String(v)])
  ).toString();
}

// ---------- 账号密码登录（替代手动粘贴 Cookie） ----------

// 从 Response 提取 Set-Cookie（Edge Runtime 中 set-cookie 为受限头，须用 getSetCookie()）
function parseSetCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    try {
      return h.getSetCookie();
    } catch {
      /* fallthrough */
    }
  }
  const raw = h.get("set-cookie");
  return raw ? [raw] : [];
}

// 把新下发的 Set-Cookie 合并进 cookie jar（同名以新值为准，忽略 path/expires 等属性）
function mergeCookie(jar: string, setCookies: string[]): string {
  const map = new Map<string, string>();
  if (jar) {
    for (const part of jar.split(";")) {
      const i = part.indexOf("=");
      if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  for (const sc of setCookies) {
    const kv = sc.split(";")[0].trim();
    const i = kv.indexOf("=");
    if (i > 0) map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// 用账号密码模拟登录 pinglian.lol，返回登录后的 Cookie 串。
// v4：POST /api/auth/login（form: username/password/remember=1），无验证码。
// 流程：GET 首页建立初始会话 → 携带同一会话 POST 登录 → 合并 Set-Cookie。
async function loginWithPassword(
  username: string,
  password: string
): Promise<{ ok: boolean; cookie?: string; message?: string }> {
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  let jar = "";

  // 1) 打开首页，建立初始会话
  const page = await fetch(`${PINGLIAN_BASE}/`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  jar = mergeCookie(jar, parseSetCookies(page));

  // 2) 提交账号密码（v4：remember=1）
  const loginRes = await fetch(`${PINGLIAN_BASE}/api/auth/login`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${PINGLIAN_BASE}/`,
      Origin: PINGLIAN_BASE,
      ...(jar ? { Cookie: jar } : {}),
    },
    body: new URLSearchParams({
      username,
      password,
      remember: "1",
    }).toString(),
  });

  const raw = await loginRes.text();
  let data: { success?: boolean; message?: string };
  try {
    data = JSON.parse(raw);
  } catch {
    data = { success: false, message: "pinglian.lol 登录接口返回异常" };
  }

  if (data.success !== true) {
    return { ok: false, message: data.message || "登录失败，请检查账号密码" };
  }

  // 3) 合并登录后的 Set-Cookie（会话可能被重新签发）
  jar = mergeCookie(jar, parseSetCookies(loginRes));
  return { ok: true, cookie: jar };
}

// 检测 pinglian.lol 响应是否表示 Cookie 已失效
// v4：未登录态下受保护接口返回 HTTP 401 + {"success":false,"message":"..."}
// 判定条件（必须确凿，避免误伤）：
//  1. HTTP 401
//  2. JSON 中 success=false 且 message 含"登录/未登录/login/auth"等关键词
//  3. 200 + text/html 且页面为登录页（含 login 等特征）
// 注意：5xx/429、空 body、非登录页 HTML 一律视为站点繁忙/响应异常，不判定过期
async function isSessionExpired(res: Response): Promise<boolean> {
  if (res.status === 401) return true;

  const ct = res.headers.get("content-type") ?? "";
  const text = await res.clone().text();
  const trimmed = text.trim();

  if (ct.includes("text/html")) {
    return /login|请先登录|账号登录/i.test(text.slice(0, 3000));
  }

  if (!trimmed) return false;

  try {
    const data = JSON.parse(trimmed);
    if (
      data &&
      data.success === false &&
      /登录|未登录|请先登录|login|auth/i.test(data.message ?? "")
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// 统一转发：对 pinglian.lol 发起请求，返回原始 Response（不吞 body）
async function proxy(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  cookie: string,
  payload?: { form?: string; json?: string }
): Promise<Response> {
  const headers: Record<string, string> = {
    Cookie: cookie,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    Referer: `${PINGLIAN_BASE}/`,
  };
  if (payload?.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (payload?.json) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${PINGLIAN_BASE}${path}`, {
    method,
    headers,
    body: payload?.form || payload?.json || undefined,
    redirect: "follow",
  });

  if (!res.ok) {
    // 400/401/404 由调用方按业务语义处理（会话过期 / 无变化修改 / 旧 ID 失效），不在此抛错
    if (res.status === 400 || res.status === 401 || res.status === 404) return res;
    throw new Error(
      res.status >= 500 || res.status === 429
        ? `盘链站点繁忙（HTTP ${res.status}），请稍后重试`
        : `盘链站点返回异常（HTTP ${res.status}）`
    );
  }
  return res;
}

// v4 对「无任何变化」的修改返回 400 VALIDATION（「…均未修改，无需保存」）。
// 语义上等同于保存成功（幂等），必须归一化为成功，否则用户保存未影响站点
// 字段的内容时会被误报「盘链站点返回异常（HTTP 400）」
async function isNoopUpdate(res: Response): Promise<boolean> {
  if (res.status !== 400) return false;
  const d = await res.clone().json().catch(() => null);
  return !!(d && d.success === false && /未修改|无需保存/.test(String(d.message ?? "")));
}

// 站点升级 v4 后，旧系统时期的 link_id 在新接口全部 404；v4 迁移数据保留了
// source_link_id（= 旧系统 link_id）。按 source_link_id 在用户自己的发布列表
// 中查找旧 ID 对应的新 ID：
//  1) 先用当前标题做服务端搜索（资源未改名时站点标题与我们一致，通常 1 次命中）
//  2) 未命中再全量翻页扫描（page_size=200，最多 40 页，列表非严格 id 排序，
//     不能假设旧数据集中在某几页）
async function findV4LinkBySourceId(
  cookie: string,
  oldId: number,
  currentTitle?: string
): Promise<number | null> {
  if (currentTitle && currentTitle.trim()) {
    try {
      const sr = await proxy(
        "GET",
        `/api/videos/links?search=${encodeURIComponent(currentTitle.trim())}&page=1&page_size=200`,
        cookie
      );
      if (sr.ok) {
        const sd = await sr.json().catch(() => null);
        const hit = (sd?.data?.list ?? []).find(
          (l: Record<string, unknown>) =>
            String(l.source_link_id ?? "") === String(oldId)
        );
        if (hit) return Number(hit.id);
      }
    } catch {
      /* 搜索失败则继续全量扫描 */
    }
  }
  let page = 1;
  const maxPages = 40;
  let seen = 0;
  let total = Number.POSITIVE_INFINITY;
  while (page <= maxPages && seen < total) {
    const r = await proxy(
      "GET",
      `/api/videos/links?page=${page}&page_size=200`,
      cookie
    );
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    const list: Record<string, unknown>[] = d?.data?.list ?? [];
    if (!Array.isArray(list) || list.length === 0) return null;
    const hit = list.find(
      (l) => String(l.source_link_id ?? "") === String(oldId)
    );
    if (hit) return Number(hit.id);
    const ps = Number(d?.data?.page_size) || 200;
    total = Number(d?.data?.total) || 0;
    seen += list.length;
    if (list.length < ps) return null; // 已到最后一页
    page += 1;
  }
  return null;
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

    // ---------- 2. 账号密码登录（action=login，无需已绑定 Cookie） ----------
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action === "login") {
      if (req.method !== "POST") {
        return json({ error: "login 需要 POST 请求" }, 405);
      }
      const { username, password } = await req.json().catch(() => ({}));
      if (!username || !password) {
        return json({ error: "请输入 pinglian.lol 的账号和密码" }, 400);
      }

      const result = await loginWithPassword(
        String(username).trim(),
        String(password)
      );
      if (!result.ok || !result.cookie) {
        return json(
          { success: false, message: result.message || "登录失败，请检查账号密码" },
          401
        );
      }

      const now = new Date().toISOString();
      await supabase.from("pinglian_sessions").upsert(
        {
          user_id: user.id,
          username: String(username).trim(),
          cookie: result.cookie,
          remark: String(username).trim(),
          status: "active",
          last_check_at: now,
          updated_at: now,
        },
        { onConflict: "user_id" }
      );

      return json({ success: true, message: "盘链账号登录成功" });
    }

    // ---------- 3. 读取该用户绑定的 pinglian Cookie ----------
    const { data: session, error: sessionError } = await supabase
      .from("pinglian_sessions")
      .select("cookie")
      .eq("user_id", user.id)
      .maybeSingle();

    if (sessionError || !session) {
      return json(
        { error: "未绑定 pinglian.lol 账号，请先在设置页登录绑定盘链账号" },
        400
      );
    }

    // ---------- 4. 解析 action 并转发（v4 路由） ----------
    let targetPath: string | null = null;
    let method: "GET" | "POST" | "PUT" | "DELETE" = "GET";
    let payload: { form?: string; json?: string } | undefined;
    // update 专用：记录旧 link_id 与完整 payload，供 404 自动迁移重试使用
    let updateCtx: { oldId: number; title: string; payload: { json: string } } | null =
      null;

    // GET 读操作
    const getActions: Record<string, string> = {
      list: "/api/videos/links?page=1&page_size=200",
      status: "/api/auth/status",
      quota: "/api/videos/link-quota",
    };

    if (action === "search") {
      // 站点服务端搜索：突破 list 单页 200 条的上限（发布量大的用户首屏不全）
      const kw = (url.searchParams.get("keyword") ?? "").trim();
      targetPath = kw
        ? `/api/videos/links?search=${encodeURIComponent(kw)}&page=1&page_size=200`
        : getActions.list;
      method = "GET";
    } else if (getActions[action ?? ""]) {
      targetPath = getActions[action ?? ""];
      method = "GET";
    }

    // 写操作（POST body 为 JSON）
    if (!targetPath) {
      const body = await req.json().catch(() => ({}));

      if (action === "add") {
        const videoId = Number(body.vod_id ?? 0);
        if (!videoId) {
          return json({ error: "新增盘链需要有效的 vod_id（站点视频 ID）" }, 400);
        }
        targetPath = `/api/videos/${videoId}/links`;
        method = "POST";
        payload = {
          json: JSON.stringify({
            url: body.link_url ?? "",
            title: body.link_title ?? "",
            note: body.note ?? "",
            pan_type: body.pan_type ?? "others",
            password: body.link_password ?? "",
          }),
        };
      } else if (action === "update") {
        const linkId = Number(body.link_id ?? 0);
        if (!linkId) {
          return json({ error: "修改盘链需要有效的 link_id" }, 400);
        }
        const updateJson: Record<string, string> = {
          url: body.link_url ?? "",
          title: body.link_title ?? "",
          pan_type: body.pan_type ?? "others",
          password: body.link_password ?? "",
        };
        // note 仅在有值时提交：v4 按「只传变更字段」处理，空 note 会清空站点备注
        const note = typeof body.note === "string" ? body.note.trim() : "";
        if (note) updateJson.note = note;
        targetPath = `/api/videos/links/${linkId}`;
        method = "PUT";
        payload = { json: JSON.stringify(updateJson) };
        updateCtx = {
          oldId: linkId,
          title: String(body.link_title ?? ""),
          payload: { json: JSON.stringify(updateJson) },
        };
      } else if (action === "delete") {
        const linkId = Number(body.link_id ?? 0);
        if (!linkId) {
          return json({ error: "删除盘链需要有效的 link_id" }, 400);
        }
        targetPath = `/api/videos/links/${linkId}`;
        method = "DELETE";
        payload = { json: JSON.stringify({ id: linkId }) };
      } else if (action === "detail") {
        const linkId = Number(body.link_id ?? 0);
        if (!linkId) {
          return json({ error: "查询盘链详情需要有效的 link_id" }, 400);
        }
        targetPath = `/api/videos/links/${linkId}`;
        method = "GET";
      }
    }

    if (!targetPath) {
      return json({ error: `不支持的 action: ${action}` }, 400);
    }

    const res = await proxy(method, targetPath, session.cookie, payload);

    // ---------- 5. Cookie 失效检测 ----------
    const expired = await isSessionExpired(res);
    const now = new Date().toISOString();

    if (expired) {
      await supabase
        .from("pinglian_sessions")
        .update({ status: "expired", last_check_at: now })
        .eq("user_id", user.id);

      return json(
        {
          success: false,
          code: "PINGLIAN_COOKIE_EXPIRED",
          message: "盘链登录已过期，请在设置页重新登录盘链账号",
        },
        401
      );
    }

    // ---------- 6. update 语义处理 ----------
    if (updateCtx) {
      // 6a. v4 语义：无变化的修改返回 400「…未修改，无需保存」→ 归一化为成功
      if (await isNoopUpdate(res)) {
        await supabase
          .from("pinglian_sessions")
          .update({ status: "active", last_check_at: now })
          .eq("user_id", user.id);
        return json({ success: true, data: { id: updateCtx.oldId }, noop: true });
      }

      // 6b. 404：站点改版（v4）导致旧系统 link_id 失效 → 按 source_link_id 自动迁移
      if (res.status === 404) {
        // 仅自动迁移改版日（2026-09-10）前创建的绑定，避免误改 v4 新绑定
        const { data: legacyRows } = await supabase
          .from("resource_bindings")
          .select("id")
          .eq("link_id", updateCtx.oldId)
          .lt("created_at", "2026-09-10T00:00:00Z")
          .limit(1);

        if (legacyRows && legacyRows.length > 0) {
          const newId = await findV4LinkBySourceId(
            session.cookie,
            updateCtx.oldId,
            updateCtx.title
          );
          if (newId) {
            const retry = await proxy(
              "PUT",
              `/api/videos/links/${newId}`,
              session.cookie,
              updateCtx.payload
            );
            if (await isSessionExpired(retry)) {
              await supabase
                .from("pinglian_sessions")
                .update({ status: "expired", last_check_at: now })
                .eq("user_id", user.id);
              return json(
                {
                  success: false,
                  code: "PINGLIAN_COOKIE_EXPIRED",
                  message: "盘链登录已过期，请在设置页重新登录盘链账号",
                },
                401
              );
            }
            if (retry.ok || (await isNoopUpdate(retry))) {
              await supabase
                .from("pinglian_sessions")
                .update({ status: "active", last_check_at: now })
                .eq("user_id", user.id);
              // 服务端把本地绑定迁移到新 ID（仅限改版前的旧绑定），下次同步直接命中
              await supabase
                .from("resource_bindings")
                .update({ link_id: newId })
                .eq("link_id", updateCtx.oldId)
                .lt("created_at", "2026-09-10T00:00:00Z");
              const d = await retry.json().catch(() => null);
              return json(d ?? { success: true, data: { id: newId } });
            }
            if (retry.status === 400) {
              // 迁移后的 ID 提交仍 400（非无变化）：透传站点校验信息
              const bd = await retry.json().catch(() => null);
              return json(
                bd ?? { success: false, message: "盘链站点返回异常（HTTP 400）" }
              );
            }
            // 迁移后又被删除等场景：按绑定失效处理
          }
        }
        return json(
          {
            success: false,
            code: "PINGLIAN_LINK_NOT_FOUND",
            message: "该盘链绑定在站点已失效（站点已升级改版），请解绑后重新绑定",
          },
          404
        );
      }
    }

    // 有效：刷新状态 + 返回 pinglian.lol 的 JSON
    await supabase
      .from("pinglian_sessions")
      .update({ status: "active", last_check_at: now })
      .eq("user_id", user.id);

    const data = await res.json();
    return json(data);
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : String(e) },
      500
    );
  }
});

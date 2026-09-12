// ============================================================
// Supabase Edge Function: framehdr-proxy
// framehdr.com 网盘分享代理（盘链同构）
//
// 作用：在 Supabase 登录态下，读取用户绑定的 framehdr Cookie，
//       代理操作「我的链接」（查询/编辑/删除/豆瓣导入），
//       Cookie 不返前端，规避 CORS。
//
// 部署：supabase functions deploy framehdr-proxy
// 环境变量：SITE_URL（可选，CORS 白名单，默认 *）
//
// 调用：POST /framehdr-proxy?action=<action>
//   Authorization: Bearer <access_token>   （本站 Supabase 登录态）
//
// actions:
//   list            GET  my_links.php?page=&search=  解析 SSR 表格 → JSON
//   edit            POST edit_link.php?id={id}       name/url/password/description
//   del             POST delete_link.php             id 或 ids[]（批量 batch=1）
//   douban_search   GET  douban_import.php?action=search&keyword=
//   douban_import   POST douban_import.php           douban_id + poster_url
//
// 失效检测：响应落回 /login.php 或出现登录页特征 → 置 status=expired
//           返回 code=COOKIE_EXPIRED，前端据此提示重新绑定。
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SITE_URL = Deno.env.get("SITE_URL") ?? "*";
const BASE = "https://framehdr.com";

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

// ---------- 工具 ----------

function encodeForm(obj: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      v.forEach((item) => params.append(k, item as string));
    } else if (v !== undefined && v !== null) {
      params.append(k, String(v));
    }
  }
  return params.toString();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

// 从 HTML 提取 csrf_token（表单内嵌隐藏字段，顺序可能 name 在前/value 在后）
function extractCsrf(html: string): string | null {
  const m = html.match(/name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i)
    ?? html.match(/value=["']([^"']+)["'][^>]*name=["']csrf_token["']/i);
  return m ? m[1] : null;
}

// 解析 my_links.php 表格 → 行对象数组
// 列（8 列）：复选框 | ID | 资源标题 | 网盘名称 | 链接 | 提取码 | 上传时间 | 操作
function parseLinksTable(html: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const tr = m[1];
    if (!/<td/i.test(tr)) continue; // 跳过表头
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    if (tds.length < 7) continue;

    // 首列可能是复选框（<input ...>），此时 ID 在第 2 列，整体偏移 1
    const offset = /<input[^>]*type=["']checkbox/i.test(tds[0]) ? 1 : 0;
    const idRaw = stripTags(tds[offset]);
    const id = parseInt(idRaw, 10);
    if (!Number.isFinite(id)) continue;

    const titleTd = tds[offset + 1];
    const driveTd = tds[offset + 2];
    const linkTd = tds[offset + 3];
    const codeTd = tds[offset + 4];
    const dateTd = tds[offset + 5];
    const titleTag = titleTd.match(/href="([^"]+)"/i);
    const linkTag = linkTd.match(/href="([^"]+)"/i);

    rows.push({
      id,
      title: stripTags(titleTd),
      detail_url: titleTag ? titleTag[1] : null,
      drive_name: stripTags(driveTd),
      url: linkTag ? linkTag[1] : stripTags(linkTd),
      extract_code: stripTags(codeTd),
      created_at: stripTags(dateTd),
    });
  }
  return rows;
}

// 从编辑表单 HTML 提取字段当前值，用于未传字段时保留原值
// input/textarea 用 value/内容；select 取 selected option 的 value
function extractFormValue(html: string, field: string): string | null {
  // select：取 selected 的 option value，无 selected 则取第一个非空 option
  const selRe = new RegExp(
    `<select[^>]*name=["']${field}["'][\\s\\S]*?<\\/select>`,
    "i"
  );
  const selMatch = html.match(selRe);
  if (selMatch) {
    const selHtml = selMatch[0];
    const selected = selHtml.match(/<option[^>]*selected[^>]*value=["']([^"']*)["']/i);
    if (selected) return selected[1].trim();
    const firstOpt = selHtml.match(/<option[^>]*value=["']([^"']+)["']/i);
    return firstOpt ? firstOpt[1].trim() : "";
  }
  const inputRe = new RegExp(
    `<input[^>]*name=["']${field}["'][^>]*value=["']([^"']*)["']`,
    "i"
  );
  const inputRe2 = new RegExp(
    `<input[^>]*value=["']([^"']*)["'][^>]*name=["']${field}["']`,
    "i"
  );
  const taRe = new RegExp(
    `<textarea[^>]*name=["']${field}["'][^>]*>([\\s\\S]*?)</textarea>`,
    "i"
  );
  const m = html.match(inputRe) ?? html.match(inputRe2) ?? html.match(taRe);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .trim();
}

// 从 login.php 页面提取登录失败 flash 提示（"账号或密码错误" / "锁定" 等）
function parseFlashError(html: string): string | null {
  const patterns = [
    /账号或密码错误[^<]{0,60}/i,
    /密码错误[^<]{0,60}/i,
    /已锁定[^<]{0,40}/i,
    /锁定[^<]{0,40}/i,
    /还可以尝试\s*\d+\s*次[^<]{0,20}/i,
    /尝试[^<]{0,40}/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

// Cookie Jar（模拟浏览器会话，供账号密码登录用）
function buildCookieJar() {
  const store = new Map<string, string>();
  return {
    get(): string {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    absorb(res: Response): void {
      const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] })
        .getSetCookie?.() ?? [];
      for (const sc of setCookies) {
        const i = sc.indexOf("=");
        if (i <= 0) continue;
        const name = sc.slice(0, i).trim();
        const value = sc.slice(i + 1).split(";")[0].trim();
        if (name) store.set(name, value);
      }
    },
  };
}

// ---------- 主处理 ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. 验证本站登录态（service role 客户端，绕过 RLS 读写 sessions）
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "请先登录" }, 401);
    }
    const appClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    // getUser 期望纯 JWT（不含 "Bearer " 前缀），否则内部会拼成 "Bearer Bearer xxx" 导致验证失败
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: { user: me }, error: userErr } = await appClient.auth.getUser(token);
    if (userErr || !me?.id) return json({ error: "登录态无效或已过期" }, 401);

    // 2. 读绑定的 framehdr Cookie
    const { data: sessions } = await appClient
      .from("framehdr_sessions")
      .select("cookie,status,updated_at")
      .eq("user_id", me.id)
      .maybeSingle();
    const session = sessions ?? null;
    if (!session?.cookie) {
      return json({ error: "未绑定 framehdr 账号，请先绑定 Cookie" }, 400);
    }
    if (session.status === "expired") {
      return json({ error: "framehdr Cookie 已失效，请重新绑定", code: "COOKIE_EXPIRED" }, 401);
    }

    const cookie = session.cookie;
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "";
    const baseHeaders = {
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      Referer: BASE + "/",
      "X-Requested-With": "XMLHttpRequest",
    };

    // 标记失效（供内部复用）
    const markExpired = async () => {
      await appClient
        .from("framehdr_sessions")
        .update({ status: "expired", last_check_at: new Date().toISOString() })
        .eq("user_id", me.id);
    };

    // 判断响应是否落回登录页（失效特征）—— 精准匹配，避免业务页误判：
    //  1. 最终 URL 落在 /login.php（302 跳转）
    //  2. 登录页独有特征：引用 css/auth.css 或存在 login 专属表单
    const isLoginPage = (res: Response, text: string): boolean => {
      if (res.url && /\/login\.php/i.test(res.url)) return true;
      if (/css\/auth\.css/i.test(text)) return true;
      if (/action=["'][^"']*login\.php/i.test(text) && /name=["']password/i.test(text)) return true;
      return false;
    };

    const parseBody = async (res: Response): Promise<{ text: string; login: boolean }> => {
      const text = await res.text();
      return { text, login: isLoginPage(res, text) };
    };

    // ---------- Cookie 续期：合并响应下发的 Set-Cookie ----------
    function mergeCookies(oldCookie: string, setCookies: string[]): string {
      if (!setCookies.length) return oldCookie;
      const map = new Map<string, string>();
      for (const part of oldCookie.split(";")) {
        const i = part.indexOf("=");
        if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
      }
      for (const sc of setCookies) {
        const i = sc.indexOf("=");
        if (i <= 0) continue;
        const name = sc.slice(0, i).trim();
        const value = sc.slice(i + 1).split(";")[0].trim(); // 去掉 Path/Expires 等
        map.set(name, value);
      }
      return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }

    // 每次转发后尝试续期（有新 Cookie 且距上次更新 >=60s 才写库）
    async function refreshCookie(
      res: Response,
      session: { cookie: string; updated_at?: string | null }
    ): Promise<void> {
      const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] })
        .getSetCookie?.() ?? [];
      if (!setCookies.length) return;
      const merged = mergeCookies(session.cookie, setCookies);
      if (merged === session.cookie) return;
      const last = session.updated_at ? new Date(session.updated_at).getTime() : 0;
      if (Date.now() - last < 60_000) return;
      await appClient
        .from("framehdr_sessions")
        .update({
          cookie: merged,
          updated_at: new Date().toISOString(),
          last_check_at: new Date().toISOString(),
        })
        .eq("user_id", me.id);
    }

    // ---------- action: login（账号密码登录绑定，无需已有 session） ----------
    // body: { username, password, remember_me? }
    // 流程：GET login.php 拿初始会话 → POST 表单登录 → 用 cookie jar 验证 my_links.php
    // 成功则保存完整 Cookie 到 framehdr_sessions；密码不落库。
    if (action === "login") {
      const body: Record<string, unknown> = await req.json().catch(() => ({}));
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      if (!username || !password) {
        return json({ error: "请输入帧影账号和密码" }, 400);
      }
      const rememberMe = body.remember_me === false || body.remember_me === "off" ? "" : "on";

      const jar = buildCookieJar();
      const cleanHeaders = {
        Cookie: "",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
        Referer: `${BASE}/login.php`,
      };

      // 1. GET 登录页拿初始 wangpan_session / _security_token
      const pre = await fetch(`${BASE}/login.php`, { headers: cleanHeaders });
      jar.absorb(pre);

      // 2. POST 表单登录（不传 X-Requested-With，避免服务端按 AJAX 处理）
      const payload: Record<string, unknown> = {
        url_08df6d: "", // 蜜罐字段，留空
        login_mode: "password",
        username,
        password,
      };
      if (rememberMe) payload.remember_me = "on";
      const loginRes = await fetch(`${BASE}/login.php`, {
        method: "POST",
        headers: { ...cleanHeaders, Cookie: jar.get(), "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeForm(payload),
        redirect: "manual",
      });
      jar.absorb(loginRes);

      // 3. 用 jar 验证登录态
      const verifyRes = await fetch(`${BASE}/user/my_links.php`, {
        headers: {
          ...cleanHeaders,
          Cookie: jar.get(),
          Referer: BASE + "/",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      const vText = await verifyRes.text();
      jar.absorb(verifyRes);

      if (isLoginPage(verifyRes, vText)) {
        // 登录失败：解析 flash 错误 + 剩余尝试次数
        let reason = "账号或密码错误，请检查后重试";
        try {
          const lp = await fetch(`${BASE}/login.php`, { headers: { ...cleanHeaders, Cookie: jar.get() } });
          const lpText = await lp.text();
          const flash = parseFlashError(lpText);
          if (flash) reason = flash;
          const st = await fetch(`${BASE}/api/login_status.php?action=login_status`, {
            headers: { ...cleanHeaders, Cookie: jar.get() },
          });
          const stJson = await st.json().catch(() => null);
          if (stJson) {
            if (stJson.is_locked) {
              reason = "账号已锁定，请稍后再试（或去帧影站找回密码）";
            } else if (typeof stJson.attempts_left === "number") {
              reason += `（还可尝试 ${stJson.attempts_left} 次）`;
            }
          }
        } catch {
          /* 保留默认 reason */
        }
        return json({ error: `帧影登录失败：${reason}` }, 401);
      }

      // 4. 登录成功：写入绑定（upsert）
      const now = new Date().toISOString();
      const { error: upErr } = await appClient
        .from("framehdr_sessions")
        .upsert(
          {
            user_id: me.id,
            cookie: jar.get(),
            username,
            status: "active",
            last_check_at: now,
            updated_at: now,
          },
          { onConflict: "user_id" }
        );
      if (upErr) return json({ error: "保存会话失败：" + upErr.message }, 500);

      return json({
        success: true,
        username,
        hint: "账号密码登录成功，会话已保存；代理每次转发会自动续期 _security_token",
      });
    }

    // ---------- action: list ----------
    if (action === "list") {
      const page = url.searchParams.get("page") ?? "1";
      const search = url.searchParams.get("search") ?? "";
      const qs = new URLSearchParams({ page, search });
      const res = await fetch(`${BASE}/user/my_links.php?${qs}`, {
        headers: baseHeaders,
        redirect: "follow",
      });
      const { text, login } = await parseBody(res);
      if (login) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      const links = parseLinksTable(text);
      // 粗略分页信息：取"共 X 条"或页数文本
      const pageInfo = text.match(/共\s*(\d+)\s*条/i) ?? text.match(/page=(\d+)/g);
      await refreshCookie(res, session);
      return json({ success: true, links, page: parseInt(page, 10), page_info: pageInfo ? pageInfo[0] : null });
    }

    // ---------- action: replace（新建更新后的链接 + 删除旧链接，返回新 id） ----------
    // 帧影 edit_link.php?id={id} 的 POST 实为「新建」（忽略 ?id=），站点无真正的编辑接口。
    // 为实现「修改原有资源」的效果：先用旧 id 预填表单并 POST 新建一条更新后的链接，
    // 从列表按新 url 取回新 id，再删除旧 id。始终保持单条资源。
    if (action === "replace") {
      const oldId = url.searchParams.get("id") ?? "";
      if (!oldId) return json({ error: "缺少 id" }, 400);
      let body: Record<string, unknown> = {};
      if (req.method === "POST") body = await req.json().catch(() => ({}));
      const newUrl = String(body.url ?? "").trim();
      if (!newUrl) return json({ error: "缺少 url" }, 400);

      // 1. GET 旧编辑页拿 csrf_token（旧 id 仍存在）
      const editRes = await fetch(`${BASE}/user/edit_link.php?id=${oldId}`, { headers: baseHeaders, redirect: "follow" });
      const { text: editText, login: editLogin } = await parseBody(editRes);
      if (editLogin) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      await refreshCookie(editRes, session);
      const csrf = extractCsrf(editText);
      if (!csrf) return json({ error: "未找到 csrf_token，编辑页结构可能变化" }, 500);

      // 2. 新建更新后的链接（edit_link.php POST = 新建，url 用新值）
      const name = String(body.name ?? extractFormValue(editText, "name") ?? "光鸭云盘");
      const password = String(body.password ?? extractFormValue(editText, "password") ?? "");
      const description = String(body.description ?? extractFormValue(editText, "description") ?? "");
      const createRes = await fetch(`${BASE}/user/edit_link.php?id=${oldId}`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeForm({ csrf_token: csrf, name, url: newUrl, password, description }),
        redirect: "manual",
      });
      const createText = await createRes.text();
      if (isLoginPage(createRes, createText)) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      await refreshCookie(createRes, session);

      // 3. 从列表页按新 url 取回新链接 id
      const listRes = await fetch(`${BASE}/user/my_links.php?page=1&search=`, { headers: baseHeaders, redirect: "follow" });
      const listText = await listRes.text();
      await refreshCookie(listRes, session);
      const links = parseLinksTable(listText);
      const matched = links.find((l) => String(l.url ?? "") === newUrl);
      const newId = matched ? (matched.id as number) : null;
      if (!newId) {
        return json({ error: "帧影新建后未找到新链接，请刷新发布记录查看" }, 500);
      }

      // 4. 删除旧链接
      const delCsrf = extractCsrf(listText) ?? csrf;
      const delRes = await fetch(`${BASE}/user/delete_link.php`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeForm({ csrf_token: delCsrf, id: oldId }),
        redirect: "manual",
      });
      const delText = await delRes.text();
      if (isLoginPage(delRes, delText)) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }

      return json({ success: true, old_id: parseInt(oldId, 10), new_id: newId });
    }

    // ---------- action: edit ----------
    if (action === "edit") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return json({ error: "缺少 id" }, 400);
      // 先 GET 编辑页取 csrf_token
      const getRes = await fetch(`${BASE}/user/edit_link.php?id=${id}`, { headers: baseHeaders, redirect: "follow" });
      const { text, login } = await parseBody(getRes);
      if (login) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      await refreshCookie(getRes, session);
      const csrf = extractCsrf(text);
      if (!csrf) return json({ error: "未找到 csrf_token，编辑页结构可能变化" }, 500);

      let body: Record<string, unknown> = {};
      if (req.method === "POST") body = await req.json().catch(() => ({}));
      // 未传字段用编辑页当前值回填，避免同步标题/链接时清空提取码、描述
      const payload = {
        csrf_token: csrf,
        name: body.name ?? extractFormValue(text, "name") ?? "",
        url: body.url ?? extractFormValue(text, "url") ?? "",
        password: body.password ?? extractFormValue(text, "password") ?? "",
        description: body.description ?? extractFormValue(text, "description") ?? "",
      };
      const res = await fetch(`${BASE}/user/edit_link.php?id=${id}`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeForm(payload),
        redirect: "follow",
      });
      const rText = await res.text();
      if (isLoginPage(res, rText)) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      await refreshCookie(res, session);
      return json({ success: true, id: parseInt(id, 10), result: rText.slice(0, 500) });
    }

    // ---------- action: del ----------
    if (action === "del") {
      // 先 GET 我的链接页取 csrf_token
      const getRes = await fetch(`${BASE}/user/my_links.php`, { headers: baseHeaders, redirect: "follow" });
      const { text, login } = await parseBody(getRes);
      if (login) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      await refreshCookie(getRes, session);
      const csrf = extractCsrf(text);
      if (!csrf) return json({ error: "未找到 csrf_token" }, 500);

      let body: Record<string, unknown> = {};
      if (req.method === "POST") body = await req.json().catch(() => ({}));
      const ids = Array.isArray(body.ids) ? body.ids : [body.id];
      if (!ids.length || !ids[0]) return json({ error: "缺少 id / ids" }, 400);
      const payload: Record<string, unknown> = { csrf_token: csrf };
      if (ids.length === 1) {
        payload.id = ids[0];
      } else {
        payload.ids = ids;
        payload.batch = 1;
      }
      const res = await fetch(`${BASE}/user/delete_link.php`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeForm(payload),
        redirect: "follow",
      });
      const rText = await res.text();
      if (isLoginPage(res, rText)) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      await refreshCookie(res, session);
      return json({ success: true, deleted: ids });
    }

    // ---------- action: douban_search ----------
    if (action === "douban_search") {
      const keyword = url.searchParams.get("keyword") ?? "";
      if (!keyword) return json({ error: "缺少 keyword" }, 400);
      const res = await fetch(
        `${BASE}/user/douban_import.php?action=search&keyword=${encodeURIComponent(keyword)}`,
        { headers: baseHeaders, redirect: "follow" }
      );
      const { text, login } = await parseBody(res);
      if (login) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      await refreshCookie(res, session);
      return json({ success: true, html: text.slice(0, 20000) });
    }

    // ---------- action: douban_import ----------
    if (action === "douban_import") {
      let body: Record<string, unknown> = {};
      if (req.method === "POST") body = await req.json().catch(() => ({}));
      const doubanId = body.douban_id ?? url.searchParams.get("douban_id") ?? "";
      const posterUrl = body.poster_url ?? url.searchParams.get("poster_url") ?? "";
      if (!doubanId) return json({ error: "缺少 douban_id" }, 400);
      // 先 GET 详情页取 csrf_token
      const getRes = await fetch(
        `${BASE}/user/douban_import.php?action=detail&douban_id=${encodeURIComponent(String(doubanId))}`,
        { headers: baseHeaders, redirect: "follow" }
      );
      const { text, login } = await parseBody(getRes);
      if (login) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      await refreshCookie(getRes, session);
      const csrf = extractCsrf(text);
      if (!csrf) return json({ error: "未找到 csrf_token" }, 500);
      const payload = { csrf_token: csrf, douban_id: String(doubanId), poster_url: String(posterUrl ?? "") };
      const res = await fetch(`${BASE}/user/douban_import.php`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeForm(payload),
        redirect: "follow",
      });
      const rText = await res.text();
      if (isLoginPage(res, rText)) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      await refreshCookie(res, session);
      return json({ success: true, result: rText.slice(0, 500) });
    }

    return json(
      { error: `不支持的 action: ${action}`, actions: ["list", "edit", "del", "douban_search", "douban_import"] },
      400
    );
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

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
import { resolveCallerId } from "../_shared/internalAuth.ts";

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

/**
 * 抓取表单 input（name → value），用于登录时原样带回
 * 蜜罐字段与 csrf_token —— 字段名由站点模板决定，硬编码会随站点改版失效。
 *
 * formId：只取指定 id 的表单。站点登录页含两个表单 —— loginForm（账号密码）与
 * codeLoginForm（邮箱验证码）。若合并提交，验证码表单的 login_email / login_code
 * 会以空值一并发出；站点用 isset($_POST[...]) 判断登录方式，空字符串同样为 true，
 * 会误判为「验证码登录」而导致密码登录失败，因此必须只取密码表单。
 */
function extractFormInputs(html: string, formId?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const forms = html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) ?? [];
  let scope = forms.length ? forms.join("\n") : html;
  if (formId) {
    const one = forms.find((f) => new RegExp(`id=["']${formId}["']`, "i").test(f));
    if (one) scope = one;
  }
  const re = /<input\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    const tag = m[0];
    const nameM = tag.match(/name=["']([^"']+)["']/i);
    if (!nameM) continue;
    const name = nameM[1];
    // 这几个由本函数自行赋值，避免覆盖
    if (!name || /^(username|password|login_mode|remember_me)$/i.test(name)) continue;
    // 验证码登录专属字段：即便退化到全表单合并也绝不提交，避免站点误判登录方式
    if (/^(login_email|login_code)$/i.test(name)) continue;
    if (/type=["'](submit|button|image)["']/i.test(tag)) continue;
    const valM = tag.match(/value=["']([^"']*)["']/i);
    out[name] = valM ? valM[1] : "";
  }
  return out;
}

/** 帧影封面多为站内相对路径（/uploads/posters/...），统一补成绝对地址 */
function absUrl(u: string): string {
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  return BASE + (u.startsWith("/") ? u : `/${u}`);
}

// 提取 csrf_token（接口文档 §0：帧影 SSR 每页内联注入 _csrfToken 变量）：
//  1) 页面内联 JS 变量 _csrfToken（主）
//  2) 表单隐藏字段 name="csrf_token"（兼容旧结构）
function extractCsrf(html: string): string | null {
  const inline =
    html.match(/_csrfToken\s*[:=]\s*["']([^"']+)["']/i) ??
    html.match(/["']_csrfToken["']\s*[:=]\s*["']([^"']+)["']/i);
  if (inline) return inline[1];
  const m = html.match(/name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i)
    ?? html.match(/value=["']([^"']+)["'][^>]*name=["']csrf_token["']/i);
  return m ? m[1] : null;
}

// 从 admin_session（JWT，payload.d = {user_id, role, username...}）解析站点用户 ID，
// 删除接口需要 user_id（接口文档 §3.4）
function extractSiteUserId(cookie: string): number | null {
  try {
    const m = cookie.match(/admin_session=([^;]+)/);
    if (!m) return null;
    const payload = m[1].split(".")[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const d = JSON.parse(json)?.d;
    const uid = d?.user_id ?? d?.id;
    return Number.isFinite(Number(uid)) ? Number(uid) : null;
  } catch {
    return null;
  }
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
// 站点把锁定提示写在内联 <script> 里：
//   alertDiv.innerHTML = '🔒 登录已锁定，请 ' + data.lock_remaining + ' 分钟后再试';
// 直接对整页做正则会把这段 JS 源码当成文案抓出来（漏出 '+ data.lock_remaining +'），
// 因此先剥离 script/style，再过滤仍带 JS 语法特征的片段。
function parseFlashError(html: string): string | null {
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const patterns = [
    /账号或密码错误[^<]{0,60}/i,
    /密码错误[^<]{0,60}/i,
    /已锁定[^<]{0,40}/i,
    /锁定[^<]{0,40}/i,
    /还可以尝试\s*\d+\s*次[^<]{0,20}/i,
    /尝试[^<]{0,40}/i,
  ];
  for (const re of patterns) {
    const m = visible.match(re);
    if (!m) continue;
    const text = m[0].replace(/\s+/g, " ").trim();
    // 丢弃 JS 表达式残留，例如 "已锁定，请 ' + data.lock_remaining + ' 分钟后再试"
    if (/[+;{}`]|\bdata\.|\$\(|\bfunction\b|\bvar\b/.test(text)) continue;
    return text;
  }
  return null;
}

/** 读取站点登录状态（公开接口）：锁定情况、剩余锁定分钟、剩余尝试次数 */
async function fetchFramehdrLoginStatus(
  headers: Record<string, string>
): Promise<{ is_locked?: boolean; lock_remaining?: number; attempts_left?: number } | null> {
  try {
    const res = await fetch(`${BASE}/api/login_status.php?action=login_status`, { headers });
    const j = (await res.json().catch(() => null)) as
      | { data?: { is_locked?: boolean; lock_remaining?: number; attempts_left?: number } }
      | null;
    // 站点返回 { success, data: { is_locked, lock_remaining, fail_count, attempts_left, max_attempts } }
    return j?.data ?? null;
  } catch {
    return null;
  }
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
    const appClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    // 鉴权：用户 JWT，或服务端 worker/定时任务的内部通道
    //（x-internal-secret + x-user-id，见 _shared/internalAuth.ts；未配置密钥时该通道关闭）
    // getUser 期望纯 JWT（不含 "Bearer " 前缀），前缀由 resolveCallerId 处理
    const callerId = await resolveCallerId(req, async (t) => {
      const { data, error } = await appClient.auth.getUser(t);
      return error ? null : (data?.user?.id ?? null);
    });
    if (!callerId) return json({ error: "登录态无效或已过期" }, 401);
    const me = { id: callerId };

    // 2. 读绑定的 framehdr Cookie
    const { data: sessions } = await appClient
      .from("framehdr_sessions")
      .select("cookie,status,updated_at")
      .eq("user_id", me.id)
      .maybeSingle();
    const session = sessions ?? null;
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "";

    // 无需站点登录态的 action：
    //  - login：登录本身就是为了产生会话，不能在前面要求已有会话，否则永远走不到
    //  - search / resource_list / login_status：接口文档 §2.1/§2.2/§1.3 为公开接口
    const PUBLIC_ACTIONS = new Set(["login", "search", "resource_list", "login_status"]);

    if (!PUBLIC_ACTIONS.has(action)) {
      if (!session?.cookie) {
        return json({ error: "未绑定 framehdr 账号，请先绑定 Cookie" }, 400);
      }
      if (session.status === "expired") {
        return json({ error: "framehdr Cookie 已失效，请重新绑定", code: "COOKIE_EXPIRED" }, 401);
      }
    }

    const cookie = session?.cookie ?? "";
    const baseHeaders = {
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      Referer: BASE + "/",
      "X-Requested-With": "XMLHttpRequest",
    };

    // 页面渲染模式请求头：站点对带 X-Requested-With 的请求走 AJAX 分支
    //（未登录返回 401 JSON；已登录返回 JSON），而解析链接表格 / csrf_token /
    // 表单当前值需要的是 SSR 完整 HTML，因此这些 GET 页面请求必须去掉该头，
    // 否则列表永远解析出 0 行、csrf 永远取不到。
    const pageHeaders: Record<string, string> = { ...baseHeaders };
    delete pageHeaders["X-Requested-With"];

    // 标记失效（供内部复用）
    const markExpired = async () => {
      await appClient
        .from("framehdr_sessions")
        .update({ status: "expired", last_check_at: new Date().toISOString() })
        .eq("user_id", me.id);
    };

    // 站点对未登录的 AJAX 请求返回 401 + JSON：
    //   {"success":false,"message":"请先登录","redirect":"/login.php"}
    // 它既不含登录页 HTML 特征、最终 URL 也不落在 login.php，且中文被转义成 \uXXXX，
    // 靠中文字面匹配不到 —— 必须显式识别，否则会被误判成「已登录但列表为空」。
    const isAuthFailureText = (text: string): boolean => {
      const t = text.trim();
      if (!t.startsWith("{") && !t.startsWith("[")) return false;
      try {
        const j = JSON.parse(t) as { success?: boolean; redirect?: unknown };
        if (j && typeof j === "object" && j.success === false) return true;
        if (typeof j?.redirect === "string" && /login\.php/i.test(j.redirect)) return true;
      } catch { /* 非 JSON，忽略 */ }
      return false;
    };

    const isAuthFailure = (res: Response, text: string): boolean =>
      res.status === 401 || res.status === 403 || isAuthFailureText(text);

    // 判断响应是否代表「站点侧未登录 / 会话失效」—— 精准匹配，避免业务页误判：
    //  1. HTTP 401/403，或 AJAX 未登录 JSON（success:false / redirect → login.php）
    //  2. 最终 URL 落在 /login.php（302 跳转）
    //  3. 登录页独有特征：引用 css/auth.css 或存在 login 专属表单
    const isLoginPage = (res: Response, text: string): boolean => {
      if (isAuthFailure(res, text)) return true;
      if (res.url && /\/login\.php/i.test(res.url)) return true;
      if (/css\/auth\.css/i.test(text)) return true;
      if (/action=["'][^"']*login\.php/i.test(text) && /name=["']password/i.test(text)) return true;
      return false;
    };

    const parseBody = async (res: Response): Promise<{ text: string; login: boolean }> => {
      const text = await res.text();
      return { text, login: isLoginPage(res, text) };
    };

    // 页面内联 _isLoggedIn=false、出现登录表单、未登录 JSON → 判定为未登录态
    const looksLoggedOut = (text: string): boolean =>
      isAuthFailureText(text) ||
      /_isLoggedIn\s*[:=]\s*(?:false|0|["']false["']|["']0["'])/i.test(text) ||
      (/action=["'][^"']*login\.php/i.test(text) && /name=["']password/i.test(text)) ||
      /请先登录|请登录账号|登录后查看/i.test(text);

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
      session: { cookie: string; updated_at?: string | null } | null
    ): Promise<void> {
      // 未绑定会话（公开接口调用）时无需续期
      if (!session) return;
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
      // 接口文档 §1.1：remember_me 取值 1
      const rememberMe = body.remember_me === false ? "" : "1";

      const jar = buildCookieJar();
      const cleanHeaders = {
        Cookie: "",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
        Referer: `${BASE}/login.php`,
      };

      // 0. 预检锁定状态：锁定期间继续提交只会反复失败（且可能重置锁定计时），
      //    直接给出明确提示。login_status 为公开接口，异常时不影响正常登录流程。
      const preStatus = await fetchFramehdrLoginStatus(cleanHeaders);
      if (preStatus?.is_locked) {
        const mins = typeof preStatus.lock_remaining === "number" && preStatus.lock_remaining > 0
          ? `，请 ${preStatus.lock_remaining} 分钟后再试`
          : "，请稍后再试";
        return json({ error: `帧影登录失败：账号已被站点锁定${mins}（或去帧影站找回密码）` }, 401);
      }

      // 1. GET 登录页拿初始会话，并抓取表单全部 input（含蜜罐字段与 csrf_token）
      const pre = await fetch(`${BASE}/login.php`, { headers: cleanHeaders });
      jar.absorb(pre);
      const preText = await pre.text();

      // 2. POST 表单登录（不传 X-Requested-With，避免服务端按 AJAX 处理）
      //    原样带回页面隐藏字段，避免蜜罐/CSRF 字段名变化导致登录失败
      const payload: Record<string, unknown> = { ...extractFormInputs(preText, "loginForm") };
      payload.login_mode = "password";
      payload.username = username;
      payload.password = password;
      if (rememberMe) payload.remember_me = "1";
      const loginRes = await fetch(`${BASE}/login.php`, {
        method: "POST",
        headers: { ...cleanHeaders, Cookie: jar.get(), "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeForm(payload),
        redirect: "manual",
      });
      jar.absorb(loginRes);

      // 3. 判定登录是否成功：
      //    实测普通账号只下发 wangpan_session / _security_token，不下发 admin_session
      //    （文档 §0 的 admin_session 并非所有账号都有），因此不能以单一 Cookie 判定。
      //    先看下发的 Cookie，拿不到再以「受保护页是否跳回登录页」为准。
      let loggedIn = /admin_session=/i.test(jar.get());
      if (!loggedIn) {
        // 不带 X-Requested-With：走 SSR 页面分支，未登录时会 302 回 login.php，
        // 使 isLoginPage 能准确判定；带该头站点会返回 401 JSON，干扰判定
        const verifyRes = await fetch(`${BASE}/user/my_links.php`, {
          headers: {
            ...cleanHeaders,
            Cookie: jar.get(),
            Referer: BASE + "/",
          },
          redirect: "follow",
        });
        const vText = await verifyRes.text();
        jar.absorb(verifyRes);
        loggedIn = !isLoginPage(verifyRes, vText);
      }

      if (!loggedIn) {
        // 登录失败：优先采用站点 login_status 的真实字段（锁定 / 剩余尝试次数），
        // 再回退到登录页 flash 文案
        let reason = "账号或密码错误，请检查后重试";
        const status = await fetchFramehdrLoginStatus({ ...cleanHeaders, Cookie: jar.get() });
        if (status?.is_locked) {
          const mins = typeof status.lock_remaining === "number" && status.lock_remaining > 0
            ? `，请 ${status.lock_remaining} 分钟后再试`
            : "，请稍后再试";
          reason = `账号已被站点锁定${mins}（或去帧影站找回密码）`;
        } else {
          try {
            const lp = await fetch(`${BASE}/login.php`, { headers: { ...cleanHeaders, Cookie: jar.get() } });
            const flash = parseFlashError(await lp.text());
            if (flash) reason = flash;
          } catch { /* 保留默认文案 */ }
          if (typeof status?.attempts_left === "number") {
            reason += `（还可尝试 ${status.attempts_left} 次）`;
          }
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
      // 用 pageHeaders 拿 SSR HTML 表格；带 XHR 会走 AJAX 返回 JSON，表格解析必为空
      const res = await fetch(`${BASE}/user/my_links.php?${qs}`, {
        headers: pageHeaders,
        redirect: "follow",
      });
      const { text, login } = await parseBody(res);
      if (login) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新登录", code: "COOKIE_EXPIRED" }, 401);
      }
      const links = parseLinksTable(text);

      // 会话失效时站点仍返回 200（页面渲染成未登录态），只会解析出 0 条，
      // 容易被误认为「没有数据」。这里显式识别未登录特征并标记过期，
      // 让前端提示重新登录，而不是展示空列表。
      if (links.length === 0 && looksLoggedOut(text)) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新登录", code: "COOKIE_EXPIRED" }, 401);
      }

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
      const listRes = await fetch(`${BASE}/user/my_links.php?page=1&search=`, { headers: pageHeaders, redirect: "follow" });
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
      const getRes = await fetch(`${BASE}/user/edit_link.php?id=${id}`, { headers: pageHeaders, redirect: "follow" });
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
      // 接口文档 §3.3：编辑端点为 /api/edit_link.php，id 放在 body 里
      const payload = {
        csrf_token: csrf,
        id: parseInt(id, 10),
        name: body.name ?? extractFormValue(text, "name") ?? "",
        url: body.url ?? extractFormValue(text, "url") ?? "",
        password: body.password ?? extractFormValue(text, "password") ?? "",
        description: body.description ?? extractFormValue(text, "description") ?? "",
      };
      let res = await fetch(`${BASE}/api/edit_link.php`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeForm(payload),
        redirect: "follow",
      });
      let rText = await res.text();
      // 文档 §3.3 的 /api/edit_link.php 并非所有环境都可用（404 或返回 HTML 页面），
      // 此时回退到「我的链接」页表单端点 /user/edit_link.php?id=
      if (res.status === 404 || /^\s*<!DOCTYPE/i.test(rText)) {
        res = await fetch(`${BASE}/user/edit_link.php?id=${id}`, {
          method: "POST",
          headers: { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded" },
          body: encodeForm(payload),
          redirect: "follow",
        });
        rText = await res.text();
      }
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
      const getRes = await fetch(`${BASE}/user/my_links.php`, { headers: pageHeaders, redirect: "follow" });
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
      // 实测：/admin/api/delete_link_with_reason.php 是管理员专用（普通账号返回「无权限」）。
      // 「我的链接」页的真实删除表单为 POST /user/delete_link.php（id + csrf_token），逐条删除。
      const results: unknown[] = [];
      for (const rawId of ids) {
        const res = await fetch(`${BASE}/user/delete_link.php`, {
          method: "POST",
          headers: { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded" },
          body: encodeForm({ csrf_token: csrf, id: rawId }),
          redirect: "follow",
        });
        const rText = await res.text();
        if (isLoginPage(res, rText)) {
          await markExpired();
          return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
        }
        await refreshCookie(res, session);
        results.push({ id: rawId, raw: rText.slice(0, 200) });
      }
      return json({ success: true, deleted: ids, results });
    }

    // ---------- action: douban_search ----------
    if (action === "douban_search") {
      const keyword = url.searchParams.get("keyword") ?? "";
      if (!keyword) return json({ error: "缺少 keyword" }, 400);
      const res = await fetch(
        `${BASE}/user/douban_import.php?action=search&keyword=${encodeURIComponent(keyword)}`,
        { headers: pageHeaders, redirect: "follow" }
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
        { headers: pageHeaders, redirect: "follow" }
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

    // 解析 search.php 的 SSR 结果卡片（interface 文档 §2.2：结果卡片为 resource-card）
    function parseSearchCards(html: string): Record<string, unknown>[] {
      const out: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const cardRe =
        /class=["'][^"']*resource-card[^"']*["']([\s\S]{0,2500}?)(?=class=["'][^"']*resource-card|<\/body)/gi;
      let m: RegExpExecArray | null;
      while ((m = cardRe.exec(html)) !== null) {
        const chunk = m[1];
        const idM = chunk.match(/detail\.php\?id=(\d+)/i) ?? chunk.match(/data-id=["'](\d+)/i);
        if (!idM) continue;
        const id = idM[1];
        if (seen.has(id)) continue;
        seen.add(id);
        // 卡片结构：<div class="resource-card" onclick="location.href='detail.php?id=N'">
        //            <img src="/uploads/posters/x.webp" alt="标题">
        // 标题优先取 img 的 alt
        const imgM = chunk.match(/<img[^>]*src=["']([^"']+)["']/i);
        const altM = chunk.match(/<img[^>]*alt=["']([^"']+)["']/i);
        const titleM =
          altM ??
          chunk.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) ??
          chunk.match(/title=["']([^"']{2,})["']/i);
        out.push({
          id: Number(id),
          title: titleM ? stripTags(titleM[1]).trim() : "",
          cover: imgM ? absUrl(imgM[1]) : null,
        });
      }
      return out;
    }

    // ---------- action: resource_list（公开 JSON 片库，接口文档 §2.1） ----------
    if (action === "resource_list") {
      const qs = new URLSearchParams({
        category: url.searchParams.get("category") ?? "all",
        year: url.searchParams.get("year") ?? "all",
        page: url.searchParams.get("page") ?? "1",
      });
      const res = await fetch(`${BASE}/api/resource_list.php?${qs}`, {
        headers: baseHeaders,
        redirect: "follow",
      });
      const text = await res.text();
      let j: Record<string, unknown> | null = null;
      try {
        j = JSON.parse(text);
      } catch { /* 非 JSON */ }
      if (!j) return json({ error: "帧影片库返回非 JSON，接口可能变更" }, 502);
      // 封面为站内相对路径，补成绝对地址便于前端直接展示
      if (Array.isArray((j as { resources?: unknown[] }).resources)) {
        const jr = j as { resources: Record<string, unknown>[] };
        jr.resources = jr.resources.map((r) => ({
          ...r,
          cover_url: r.cover_url ? absUrl(String(r.cover_url)) : r.cover_url,
        }));
      }
      return json({ success: true, ...j });
    }

    // ---------- action: search（SSR 关键词搜索，接口文档 §2.2） ----------
    if (action === "search") {
      const q = url.searchParams.get("q") ?? "";
      if (!q) return json({ error: "缺少 q" }, 400);
      const category = url.searchParams.get("category") ?? "";
      const qs = new URLSearchParams({ q });
      if (category) qs.set("category", category);
      const res = await fetch(`${BASE}/search.php?${qs}`, {
        headers: baseHeaders,
        redirect: "follow",
      });
      const text = await res.text();
      await refreshCookie(res, session);
      return json({ success: true, list: parseSearchCards(text) });
    }

    // ---------- action: add（新增分享链接，接口文档 §3.2） ----------
    if (action === "add") {
      let body: Record<string, unknown> = {};
      if (req.method === "POST") body = await req.json().catch(() => ({}));
      const resourceId = String(body.resource_id ?? "").trim();
      const linkUrl = String(body.url ?? "").trim();
      if (!resourceId) return json({ error: "缺少 resource_id" }, 400);
      if (!linkUrl) return json({ error: "缺少 url" }, 400);

      // detail.php 内联注入 resourceId / _csrfToken，是 add 表单的来源页
      const pageRes = await fetch(`${BASE}/detail.php?id=${encodeURIComponent(resourceId)}`, {
        headers: pageHeaders,
        redirect: "follow",
      });
      const { text: pageText, login: pageLogin } = await parseBody(pageRes);
      if (pageLogin) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      await refreshCookie(pageRes, session);
      const csrf = extractCsrf(pageText);
      if (!csrf) return json({ error: "未取到 csrf_token，详情页结构可能变化" }, 500);

      const res = await fetch(`${BASE}/user/add_link.php`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeForm({
          csrf_token: csrf,
          resource_id: resourceId,
          name: String(body.name ?? "光鸭云盘"),
          url: linkUrl,
          password: String(body.password ?? ""),
          description: String(body.description ?? ""),
        }),
        redirect: "manual",
      });
      const rText = await res.text();
      if (isLoginPage(res, rText)) {
        await markExpired();
        return json({ error: "framehdr 登录已过期，请重新绑定 Cookie", code: "COOKIE_EXPIRED" }, 401);
      }
      await refreshCookie(res, session);

      let ok = res.ok;
      let message = "";
      try {
        const j = JSON.parse(rText) as { success?: boolean; message?: string };
        if (typeof j?.success === "boolean") ok = j.success;
        message = String(j?.message ?? "");
      } catch { /* 非 JSON：按 HTTP 状态判定 */ }
      if (!ok) {
        // 站点提示未登录：标记会话过期，便于前端引导重新登录而不是只报失败
        if (/登录|未授权|身份/i.test(message)) {
          await markExpired();
          return json({ error: `framehdr 登录已过期：${message}`, code: "COOKIE_EXPIRED" }, 401);
        }
        return json({ error: message || "帧影新增链接失败" }, 400);
      }

      // 站点 add 只回 {success,message}，不含新链接 ID；
      // 从「我的链接」按 url 反查，供前端落地「资源 × 帧影链接」绑定
      let linkId: number | null = null;
      try {
        const lr = await fetch(`${BASE}/user/my_links.php?page=1&search=`, {
          headers: pageHeaders,
          redirect: "follow",
        });
        const lt = await lr.text();
        await refreshCookie(lr, session);
        const rows = parseLinksTable(lt);
        const hit = rows.find((r) => String(r.url ?? "").trim() === linkUrl);
        if (hit) linkId = hit.id as number;
      } catch { /* 回查失败：linkId 保持 null，前端会跳过绑定并提示 */ }

      return json({ success: true, resource_id: Number(resourceId), link_id: linkId, message });
    }

    // ---------- action: login_status（公开，接口文档 §1.3） ----------
    if (action === "login_status") {
      const res = await fetch(`${BASE}/api/login_status.php?action=login_status`, {
        headers: baseHeaders,
        redirect: "follow",
      });
      const text = await res.text();
      let j: Record<string, unknown> = {};
      try {
        j = JSON.parse(text);
      } catch { /* 非 JSON */ }
      return json({ success: true, ...j });
    }

    return json(
      {
        error: `不支持的 action: ${action}`,
        actions: ["list", "search", "resource_list", "add", "edit", "del", "replace", "login", "login_status", "douban_search", "douban_import"],
      },
      400
    );
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

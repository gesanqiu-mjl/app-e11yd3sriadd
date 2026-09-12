// ============================================================
// Supabase Edge Function: panfx-proxy
// 123panfx.com 网盘分享代理（盘链同构）
//
// 站点特征：Xiuno BBS 4.0.4，SSR + jQuery AJAX
//   - 鉴权仅靠 Cookie：bbs_token（非 HttpOnly）+ bbs_sid（HttpOnly）
//   - JSON 输出开关：请求头 X-Requested-With: XMLHttpRequest
//   - 登录表单带极验验证码 → 无法服务端模拟登录
//   - 绑定方式：浏览器/脚本猫提取 Cookie 后调 update_cookie
//
// actions:
//   list            GET  ?my-thread.htm       我的帖子列表
//   detail          GET  ?thread-{tid}.htm    帖子详情 + 正文网盘链接提取
//   edit            POST ?post-update-{pid}.htm  编辑帖子
//   del             POST ?post-delete-{pid}.htm  删除帖子
//   update_cookie   POST 绑定/刷新 Cookie
//   check           验证 Cookie 是否有效
// ============================================================

const SITE_URL = Deno.env.get("SITE_URL") ?? "*";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const BASE = "https://123panfx.com";

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

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&rarr;/g, "→")
    .replace(/&hellip;/g, "…");
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

const DRIVE_HOSTS = [
  "123pan.cn", "123pan.com", "123684.com", "123865.com", "123912.com",
  "share.123pan", "quark.cn", "pan.quark", "xunlei.com", "pan.xunlei",
  "lanzou", "lanzn", "aliyundrive.com", "alipan.com", "uc.cn", "pan.uc",
  "115.com", "anxia.com", "pan.baidu.com", "cloud.189.cn", "caiyun.com",
  "feishu.cn", "wwi.lanzoup", "pan.huang1111", "pan.10jqka",
  "guangyapan.com", "guangya",
];

function extractLinks(message: string): {
  drive_links: { url: string; label?: string }[];
  raw_links: string[];
} {
  const all = new Set<string>();
  const re = /https?:\/\/[^\s"'<>()）\]【】]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (/^https?:\/\/123panfx\.com\//i.test(url)) continue;
    all.add(url);
  }
  const raw_links = [...all];
  const drive_links: { url: string; label?: string }[] = [];
  for (const url of raw_links) {
    const host = url.toLowerCase();
    if (DRIVE_HOSTS.some((h) => host.includes(h))) {
      const labelMatch = message.match(new RegExp(
        `.{0,40}${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.{0,20}`,
      ));
      drive_links.push({ url, label: labelMatch ? labelMatch[0] : undefined });
    }
  }
  return { drive_links, raw_links };
}

// ---------- 主处理 ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. 验证本站登录态
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "请先登录" }, 401);
    }
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        Authorization: authHeader,
      },
    });
    if (!meRes.ok) return json({ error: "登录态无效或已过期" }, 401);
    const me = await meRes.json();

    // 2. 读绑定的 123panfx Cookie
    const sRes = await fetch(
      `${SUPABASE_URL}/rest/v1/panfx_sessions?select=cookie,status,updated_at,username&user_id=eq.${me.id}`,
      {
        headers: {
          apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
          Authorization: authHeader,
        },
      }
    );
    const sessions = await sRes.json();
    const session = Array.isArray(sessions) ? sessions[0] : null;

    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "";

    // update_cookie 不需要已有 session
    if (action !== "update_cookie") {
      if (!session?.cookie) {
        return json({ error: "未绑定 123panfx 账号，请先绑定 Cookie" }, 400);
      }
      if (session.status === "expired") {
        return json({ error: "123panfx Cookie 已失效，请重新绑定", code: "COOKIE_EXPIRED" }, 401);
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

    const markExpired = async () => {
      await fetch(
        `${SUPABASE_URL}/rest/v1/panfx_sessions?user_id=eq.${me.id}`,
        {
          method: "PATCH",
          headers: {
            apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
            Authorization: authHeader,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            status: "expired",
            last_check_at: new Date().toISOString(),
          }),
        }
      );
    };

    function isLoginPage(res: Response, text: string): boolean {
      if (res.url && res.url.includes("user-login.htm")) return true;
      if (!text) return false;
      return /登录|login/i.test(text) && /form/i.test(text) && text.length < 6000;
    }

    const parseBody = async (
      res: Response
    ): Promise<{ text: string; login: boolean }> => {
      const text = await res.text();
      return { text, login: isLoginPage(res, text) };
    };

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
        const value = sc.slice(i + 1).split(";")[0].trim();
        map.set(name, value);
      }
      return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }

    async function refreshCookie(
      res: Response,
      sess: { cookie: string; updated_at?: string | null }
    ): Promise<void> {
      const setCookies = (
        res.headers as unknown as { getSetCookie?: () => string[] }
      ).getSetCookie?.() ?? [];
      if (!setCookies.length) return;
      const merged = mergeCookies(sess.cookie, setCookies);
      if (merged === sess.cookie) return;
      const last = sess.updated_at ? new Date(sess.updated_at).getTime() : 0;
      if (Date.now() - last < 60_000) return;
      await fetch(
        `${SUPABASE_URL}/rest/v1/panfx_sessions?user_id=eq.${me.id}`,
        {
          method: "PATCH",
          headers: {
            apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
            Authorization: authHeader,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            cookie: merged,
            updated_at: new Date().toISOString(),
            last_check_at: new Date().toISOString(),
          }),
        }
      );
    }

    // ---------- action: update_cookie ----------
    if (action === "update_cookie") {
      const body: Record<string, unknown> = await req.json().catch(() => ({}));
      const raw = String(body.cookie ?? "").trim();
      if (!raw || !/bbs_token\s*=/.test(raw)) {
        return json({ error: "Cookie 格式不正确，缺少 bbs_token" }, 400);
      }
      const cookieStr = raw
        .replace(/^Cookie\s*:\s*/i, "")
        .replace(/^["']|["']$/g, "")
        .trim();
      const now = new Date().toISOString();
      await fetch(
        `${SUPABASE_URL}/rest/v1/panfx_sessions?user_id=eq.${me.id}`,
        {
          method: "PATCH",
          headers: {
            apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
            Authorization: authHeader,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates",
          },
          body: JSON.stringify({
            user_id: me.id,
            cookie: cookieStr,
            status: "active",
            username: body.username
              ? String(body.username).slice(0, 64)
              : (session?.username ?? null),
            last_check_at: now,
            updated_at: now,
          }),
        }
      );
      // 若不存在则 upsert
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/panfx_sessions?select=id&user_id=eq.${me.id}`,
        {
          headers: {
            apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
            Authorization: authHeader,
          },
        }
      );
      const existing = await checkRes.json();
      if (!Array.isArray(existing) || existing.length === 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/panfx_sessions`, {
          method: "POST",
          headers: {
            apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
            Authorization: authHeader,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates",
          },
          body: JSON.stringify({
            user_id: me.id,
            cookie: cookieStr,
            status: "active",
            username: body.username ? String(body.username).slice(0, 64) : null,
            last_check_at: now,
            updated_at: now,
          }),
        });
      }
      return json({ ok: true, message: "Cookie 已保存" });
    }

    // ---------- action: check ----------
    if (action === "check") {
      const res = await fetch(`${BASE}/?my-thread.htm`, {
        headers: baseHeaders,
      });
      const { text, login } = await parseBody(res);
      if (login) {
        await markExpired();
        return json(
          { ok: false, code: "COOKIE_EXPIRED", error: "Cookie 已失效，请重新绑定" },
          401
        );
      }
      await refreshCookie(res, session);
      return json({ ok: true, status: "active", username: session.username ?? null });
    }

    // ---------- action: list ----------
    if (action === "list") {
      const res = await fetch(`${BASE}/?my-thread.htm`, {
        headers: baseHeaders,
      });
      const { text, login } = await parseBody(res);
      if (login) {
        await markExpired();
        return json(
          { code: "COOKIE_EXPIRED", error: "Cookie 已失效，请重新绑定" },
          401
        );
      }
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text);
      } catch { /* 非 JSON */ }
      if (!parsed || parsed.code !== "0" || !parsed.message) {
        return json(
          { error: "列表获取失败，站点返回异常", raw: text.slice(0, 200) },
          502
        );
      }
      await refreshCookie(res, session);
      const msg = parsed.message as Record<string, unknown>;
      const threadlist = (msg.threadlist ?? {}) as Record<string, unknown>;
      const items = Object.values(threadlist).map((t) => {
        const tt = t as Record<string, unknown>;
        return {
          tid: tt.tid,
          fid: tt.fid,
          subject: tt.subject,
          posts: tt.posts,
          views: tt.views,
          create_date: tt.create_date,
          last_date: tt.last_date,
          closed: tt.closed,
          top: tt.top,
          digest: tt.digest,
          firstpid: tt.firstpid,
        };
      });
      return json({
        ok: true,
        user: {
          uid: (msg.user as Record<string, unknown>)?.uid,
          username: (msg.user as Record<string, unknown>)?.username,
          groupname: (msg.user as Record<string, unknown>)?.groupname,
          threads: (msg.user as Record<string, unknown>)?.threads,
        },
        items,
      });
    }

    // ---------- action: detail ----------
    if (action === "detail") {
      const tid = url.searchParams.get("tid")?.trim();
      if (!tid || !/^\d+$/.test(tid)) {
        return json({ error: "缺少有效的 tid" }, 400);
      }
      const res = await fetch(`${BASE}/?thread-${tid}.htm`, {
        headers: baseHeaders,
      });
      const { text, login } = await parseBody(res);
      if (login) {
        await markExpired();
        return json(
          { code: "COOKIE_EXPIRED", error: "Cookie 已失效，请重新绑定" },
          401
        );
      }

      let thread: Record<string, unknown> | null = null;
      let firstPost: Record<string, unknown> | null = null;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text);
      } catch { /* 非 JSON */ }

      if (parsed && parsed.code === "0" && parsed.message) {
        const msg = parsed.message as Record<string, unknown>;
        thread = (msg.thread ?? null) as Record<string, unknown> | null;
        const pl = msg.postlist as unknown;
        const posts = Array.isArray(pl)
          ? (pl as Record<string, unknown>[])
          : Object.values((pl ?? {}) as Record<string, unknown>);
        firstPost =
          posts.find((p) => String(p.isfirst) === "1") ?? posts[0] ?? null;
      }

      let message = firstPost ? String(firstPost.message ?? "") : "";
      let messageHtml = firstPost ? String(firstPost.message_fmt ?? "") : "";
      if (!message && !login) {
        const htmlRes = await fetch(`${BASE}/?thread-${tid}.htm`, {
          headers: { ...baseHeaders, "X-Requested-With": "" },
        });
        const htmlText = await htmlRes.text();
        const m = htmlText.match(
          /class="message[^"]*"[^>]*isfirst="1">([\s\S]*?)(?=<div class="card-body"|<div class="card-footer")/i
        );
        if (m) {
          messageHtml = m[1];
          message = stripTags(messageHtml);
        }
      }
      message = decodeEntities(message);
      messageHtml = decodeEntities(messageHtml);

      const { drive_links, raw_links } = extractLinks(
        message + "\n" + messageHtml
      );
      await refreshCookie(res, session);
      return json({
        ok: true,
        thread: thread
          ? {
              tid: thread.tid,
              fid: thread.fid,
              firstpid: thread.firstpid,
              subject: thread.subject,
              posts: thread.posts,
              views: thread.views,
              create_date: thread.create_date,
              last_date: thread.last_date,
            }
          : null,
        message,
        message_html: messageHtml,
        drive_links,
        raw_links,
        source: firstPost?.message ? "json" : "html",
      });
    }

    // ---------- action: edit ----------
    if (action === "edit") {
      const body: Record<string, unknown> = await req.json().catch(() => ({}));
      const pid = String(body.pid ?? "").trim();
      const subject = String(body.subject ?? "").trim();
      const message = String(body.message ?? "");
      const fid = String(body.fid ?? "").trim();
      if (!/^\d+$/.test(pid) || !subject || !message) {
        return json({ error: "缺少 pid / subject / message" }, 400);
      }

      let finalFid = fid;
      let tagids = Array.isArray(body.tagids)
        ? body.tagids.map(String)
        : [];
      if (!finalFid || tagids.length === 0) {
        const tidParam = url.searchParams.get("tid") ?? "";
        if (tidParam) {
          const dRes = await fetch(`${BASE}/?thread-${tidParam}.htm`, {
            headers: baseHeaders,
          });
          if (dRes.ok) {
            const dText = await dRes.text();
            try {
              const dj = JSON.parse(dText);
              if (dj?.code === "0" && dj?.message?.thread) {
                const t = dj.message.thread as Record<string, unknown>;
                if (!finalFid) finalFid = String(t.fid ?? "");
                const tagRaw = t.tagids as unknown;
                if (tagids.length === 0) {
                  if (Array.isArray(tagRaw)) {
                    tagids = tagRaw.map(String);
                  } else if (typeof tagRaw === "string" && tagRaw.trim()) {
                    tagids = tagRaw
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean);
                  } else if (tagRaw && typeof tagRaw === "object") {
                    tagids = Object.keys(tagRaw as Record<string, unknown>);
                  }
                }
              }
            } catch { /* 忽略 */ }
          }
        }
      }
      if (!finalFid) return json({ error: "无法确定 fid，请传入" }, 400);

      const payload: Record<string, unknown> = {
        doctype: 0,
        quotepid: 0,
        subject,
        message,
        vod_url: body.vod_url ?? "",
        http_url: body.http_url ?? "",
        fid: finalFid,
        "tagid[]": tagids,
      };
      const res = await fetch(`${BASE}/?post-update-${pid}.htm`, {
        method: "POST",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: encodeForm(payload),
        redirect: "follow",
      });
      const { text, login } = await parseBody(res);
      if (login) {
        await markExpired();
        return json(
          { code: "COOKIE_EXPIRED", error: "Cookie 已失效，请重新绑定" },
          401
        );
      }
      try {
        const j = JSON.parse(text);
        if (j.code === "0" || j.code === 0) {
          await refreshCookie(res, session);
          return json({ ok: true, message: "编辑成功" });
        }
        return json(
          { error: "编辑失败", raw: j.message ?? text.slice(0, 200) },
          502
        );
      } catch {
        if (
          res.status >= 200 &&
          res.status < 400 &&
          /thread-\d+\.htm/.test(res.url)
        ) {
          return json({ ok: true, message: "编辑成功" });
        }
        return json(
          { error: "编辑失败，站点返回异常", raw: text.slice(0, 200) },
          502
        );
      }
    }

    // ---------- action: del ----------
    if (action === "del") {
      const body: Record<string, unknown> = await req.json().catch(() => ({}));
      const pid = String(body.pid ?? "").trim();
      if (!/^\d+$/.test(pid)) return json({ error: "缺少有效的 pid" }, 400);
      const res = await fetch(`${BASE}/?post-delete-${pid}.htm`, {
        method: "POST",
        headers: baseHeaders,
        redirect: "follow",
      });
      const { text, login } = await parseBody(res);
      if (login) {
        await markExpired();
        return json(
          { code: "COOKIE_EXPIRED", error: "Cookie 已失效，请重新绑定" },
          401
        );
      }
      try {
        const j = JSON.parse(text);
        if (j.code === "0" || j.code === 0) {
          return json({ ok: true, message: "删除成功" });
        }
        return json(
          { error: "删除失败", raw: j.message ?? text.slice(0, 200) },
          502
        );
      } catch {
        return json(
          { error: "删除失败，站点返回异常", raw: text.slice(0, 200) },
          502
        );
      }
    }

    return json(
      {
        error: `不支持的 action: ${action}`,
        actions: ["list", "detail", "edit", "del", "update_cookie", "check"],
      },
      400
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: "服务器内部错误", detail: msg }, 500);
  }
});

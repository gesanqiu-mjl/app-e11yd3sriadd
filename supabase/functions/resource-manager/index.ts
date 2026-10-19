/**
 * resource-manager: 鸭影臻藏站点资源管理 Edge Function
 *
 * 鉴权链路（按照鸭影臻藏官方提供的「update-resource」中转模式，双重鉴权）：
 *   1. 本 App 用户携带 Authorization: Bearer <app_token> 验证身份
 *   2. 服务端从 ya_sessions 读取该用户绑定的鸭影臻藏凭证（access_token）
 *   3. 以 Authorization: Bearer <ya_token> + 服务端注入的 p_api_key 调用鸭影臻藏 RPC，
 *      鸭影后端校验「登录态有效 + 密钥有效」双通过才执行
 *
 * 支持的 action（POST JSON）：
 *   login                       - 账号密码登录并绑定（lookup_email_by_username → auth token）
 *   searchVideos                - 站内片源搜索（直查 videos + resource_links，供绑定用）
 *   searchMyVideos              - 查询片源与本人提交的有效资源链接（api_search_videos）
 *   addResource                 - 添加网盘资源（api_add_resource）
 *   updateResource              - 修改本人资源（api_update_resource）
 *   accountStatus               - 查看账号状态（api_get_account_status）
 *   checkIn                     - 每日签到（do_check_in）
 *   draw                        - 积分抽奖（do_draw）
 *   buyLuckyTicket              - 幸运抽签（buy_lucky_ticket）
 *   luckyDraw                   - 抽签池状态（api_get_lucky_draw）
 *   subscribeLink               - 订阅资源（api_subscribe_link）
 *   unsubscribeLink             - 取消订阅（api_unsubscribe_link）
 *   listSubscriptions           - 我的订阅列表（api_list_subscriptions）
 *   getSubscriptionNotifications- 拉取订阅更新通知（api_get_subscription_notifications）
 *   markNotificationsRead       - 标记通知已读（api_mark_notifications_read）
 *
 * 说明：所有业务 RPC 均由服务端注入 p_api_key（sk_ 开头），前端不接触密钥。
 *   searchVideos 与 searchMyVideos 用途不同：
 *     - searchVideos   查「站内有哪些片源/链接」，用于把本地资源绑定到站点已有片源
 *     - searchMyVideos 查「本人提交的资源」，返回 link_id 供订阅/修改定位
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveCallerId } from "../_shared/internalAuth.ts";

// 本 App Supabase（平台自动注入）
const APP_URL = Deno.env.get("SUPABASE_URL")!;
const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// 鸭影臻藏的 Supabase 实例（GUANGYA_* 为官方部署指南命名，兼容旧 YA_* secrets）
const YA_URL =
  Deno.env.get("GUANGYA_SUPABASE_URL") ?? Deno.env.get("YA_SUPABASE_URL") ??
  "https://houhvngggkkcqcjmzafx.supabase.co";
const YA_ANON = Deno.env.get("GUANGYA_ANON_KEY") ?? Deno.env.get("YA_ANON_KEY") ?? "";
const SCRIPT_KEY = Deno.env.get("GUANGYA_P_API_KEY") ?? Deno.env.get("SCRIPT_API_KEY") ?? "";

const YA_REST = `${YA_URL}/rest/v1/rpc`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const res = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** 调用鸭影臻藏业务 RPC（双重鉴权：Bearer ya_token + p_api_key） */
async function yaRpc(token: string, rpc: string, body: Record<string, unknown>) {
  const r = await fetch(`${YA_REST}/${rpc}`, {
    method: "POST",
    headers: { apikey: YA_ANON, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, p_api_key: SCRIPT_KEY }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.message || d?.error_description || `${rpc} 失败 (HTTP ${r.status})`);
  return d;
}

/** 用 refresh_token 静默续签鸭影臻藏 token */
async function refreshYaToken(rt: string) {
  const r = await fetch(`${YA_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: YA_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("token 已过期，请重新绑定账号");
  return { access_token: d.access_token as string, refresh_token: d.refresh_token as string };
}

/** 用户名 → 邮箱 → 密码登录，返回 tokens */
async function loginYa(username: string, password: string) {
  const er = await fetch(`${YA_REST}/lookup_email_by_username`, {
    method: "POST",
    headers: { apikey: YA_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ p_username: username }),
  });
  const email = await er.json();
  if (!er.ok || !email) throw new Error("账号不存在或用户名错误");

  const ar = await fetch(`${YA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: YA_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const auth = await ar.json();
  if (!ar.ok) throw new Error(auth.error_description || auth.msg || "密码错误，请检查账号密码");
  return {
    access_token: auth.access_token as string,
    refresh_token: auth.refresh_token as string,
    expires_in: auth.expires_in as number,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const appClient = createClient(APP_URL, SVC_KEY);
    // 鉴权：用户 JWT，或服务端 worker/定时任务的内部通道
    //（x-internal-secret + x-user-id，见 _shared/internalAuth.ts；未配置密钥时该通道关闭）
    const callerId = await resolveCallerId(req, async (t) => {
      const { data } = await appClient.auth.getUser(t);
      return data?.user?.id ?? null;
    });
    if (!callerId) return res({ success: false, error: "登录态无效，请重新登录" }, 401);
    const uid = callerId;

    const body = await req.json();
    const { action, ...p } = body;

    // 服务端密钥前置检查：缺失时给出可操作提示，
    // 否则调用站点只会得到「密钥无效」这类看不出根因的报错
    if (!YA_ANON) {
      return res(
        { success: false, error: "服务端未配置鸭影站点公钥（YA_ANON_KEY / GUANGYA_ANON_KEY），请先在 Supabase secrets 中配置" },
        500
      );
    }
    if (action !== "login" && !SCRIPT_KEY) {
      return res(
        { success: false, error: "服务端未配置鸭影 API 密钥（SCRIPT_API_KEY / GUANGYA_P_API_KEY，sk_ 开头），请先在鸭影站点后台创建密钥并配置" },
        500
      );
    }

    // ── login：账号密码登录，校验并存储鸭影臻藏 token ──────────────────────
    if (action === "login") {
      if (!p.username || !p.password) return res({ success: false, error: "缺少账号或密码" }, 400);
      const tokens = await loginYa(p.username, p.password);
      const { error: upErr } = await appClient.from("ya_sessions").upsert({
        user_id: uid,
        username: p.username,
        password: p.password,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        remark: typeof p.remark === "string" ? p.remark : "",
        status: "active",
        last_check_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (upErr) return res({ success: false, error: `保存绑定信息失败：${upErr.message}` }, 500);
      return res({ success: true, data: { bound: true } });
    }

    // ── 其余 action：读取存储的鸭影臻藏 token ──────────────────────────────
    const { data: session } = await appClient
      .from("ya_sessions").select("access_token, refresh_token").eq("user_id", uid).maybeSingle();
    if (!session?.access_token) return res({ success: false, error: "未绑定鸭影臻藏账号，请先绑定" }, 400);

    let yaToken = session.access_token;

    // 带自动续签的 RPC 包装
    const call = async (rpc: string, rpcBody: Record<string, unknown>) => {
      try {
        return await yaRpc(yaToken, rpc, rpcBody);
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (session.refresh_token && (msg.includes("JWT") || msg.includes("expired") || msg.includes("401"))) {
          const fresh = await refreshYaToken(session.refresh_token);
          yaToken = fresh.access_token;
          await appClient.from("ya_sessions").update({
            access_token: fresh.access_token,
            refresh_token: fresh.refresh_token,
            status: "active",
          }).eq("user_id", uid);
          return await yaRpc(yaToken, rpc, rpcBody);
        }
        throw e;
      }
    };

    let result: unknown;
    switch (action) {
      case "searchVideos": {
        // 归一化关键词：压缩连续空格（含全角）+ trim，空则报错
        const norm = (s: string) => s.replace(/[\s\u3000]+/g, " ").trim().toLowerCase();
        const kw = String(p.title ?? "").replace(/[\s\u3000]+/g, " ").trim();
        if (!kw) return res({ success: false, error: "缺少 title" }, 400);

        // 包含匹配：直接查鸭影 REST（videos 标题 ilike 命中即返回）
        // ilike 忽略大小写；精确匹配结果由下方排序置顶
        // 关键词含多空格时 ilike 可能不命中，先原样查，未命中再用去空格版本兜底重查
        const likeEsc = (s: string) => s.replace(/([%_\\])/g, "\\$1");
        const compact = (s: string) => s.replace(/[\s\u3000]/g, "");

        // 解析 yaToken JWT 取鸭影平台 user_id（即 resource_links.submitter_id）
        const decodeJwtSub = (token: string): string | null => {
          try {
            const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
            const decoded = JSON.parse(atob(payload));
            return typeof decoded.sub === "string" ? decoded.sub : null;
          } catch { return null; }
        };
        const yaSubmitterId = decodeJwtSub(yaToken);

        const fetchVideos = async (kwLike: string): Promise<unknown[]> => {
          const q = new URLSearchParams();
          // 使用正确的 PostgREST 嵌套资源语法，过滤条件通过 query params 传递
          q.set("select", "id,title,category,cover_url,resource_links(id,url,name,drive_type,extract_code,created_at)");
          q.set("title", `ilike.*${likeEsc(kwLike)}*`);
          q.set("limit", "20");
          // 只返回有效链接
          q.set("resource_links.is_valid", "is.true");
          // 关键：只返回当前绑定账号自己发布的链接（submitter_id 过滤）
          if (yaSubmitterId) q.set("resource_links.submitter_id", `eq.${yaSubmitterId}`);
          const vr = await fetch(`${YA_URL}/rest/v1/videos?${q.toString()}`, {
            headers: { apikey: YA_ANON, Authorization: `Bearer ${yaToken}` },
          });
          const vd = await vr.json().catch(() => []);
          if (!vr.ok) {
            const msg = Array.isArray(vd)
              ? `search_videos 失败 (HTTP ${vr.status})`
              : (vd as { message?: string })?.message;
            throw new Error(msg || `search_videos 失败 (HTTP ${vr.status})`);
          }
          return Array.isArray(vd) ? vd : [];
        };

        let videos = await fetchVideos(kw);
        const kwCompact = compact(kw);
        if (videos.length === 0 && kwCompact !== kw) {
          // 兜底：多空格输入（如「凡人 修仙传」）与标题空格不一致时，用去空格关键词重查
          videos = await fetchVideos(kwCompact);
        }
        // 本地二次过滤：归一化（去空格+小写）后的标题必须包含归一化关键词（容错全半角空格差异）
        if (kwCompact && videos.length > 0) {
          videos = videos.filter(
            (v: { title?: string }) => compact(v.title ?? "").toLowerCase().includes(kwCompact.toLowerCase())
          );
        }

        // 精确匹配（忽略大小写/去全部空格后相等）置顶。
        // 注意：这里**不再**要求片源必须带「本人」的云盘链接 ——
        // 搜索的用途是「确认站点是否存在该片源，以便在其下发布资源」，
        // 而 resource_links 只挂本人提交的链接（submitter_id 过滤），
        // 若据此丢弃片源，则「自己没发过的片子」一律搜不到，绝大多数场景直接失效。
        const isCloud = (l: { drive_type?: string }) => l.drive_type !== "magnet";
        const isExact = (v: { title?: string }) => norm(v.title ?? "") === norm(kw) ||
          compact(v.title ?? "").toLowerCase() === kwCompact.toLowerCase();
        const ordered = [
          ...videos.filter((v: { title?: string }) => isExact(v)),
          ...videos.filter((v: { title?: string }) => !isExact(v)),
        ];
        result = {
          found: ordered.length > 0,
          videos: ordered.map(
            (v: { id: number; title: string; category: string | null; cover_url?: string | null; resource_links?: unknown[] }) => ({
              video: { id: v.id, title: v.title, category: v.category, cover_url: v.cover_url ?? null },
              // links 仅保留本人提交的云盘链接（过滤磁力链），可能为空数组
              links: Array.isArray(v.resource_links)
                ? (v.resource_links as { drive_type?: string }[]).filter(isCloud)
                : [],
            })
          ),
        };
        break;
      }

      case "addResource": {
        if (!p.title || !p.name || !p.url) return res({ success: false, error: "缺少必要参数(title/name/url)" }, 400);
        result = await call("api_add_resource", {
          p_title: p.title,
          p_category: p.category ?? "anime",
          p_name: p.name,
          p_url: p.url,
          ...(p.extractCode ? { p_extract_code: p.extractCode } : {}),
        });
        break;
      }

      case "updateResource": {
        if (!p.linkId) return res({ success: false, error: "未找到鸭影片源 ID，请重新在「绑定站点」中绑定鸭影资源" }, 400);
        const ub: Record<string, unknown> = { p_link_id: p.linkId };
        if (p.name !== undefined) ub.p_name = p.name;
        if (p.url !== undefined) ub.p_url = p.url;
        if (p.extractCode !== undefined) ub.p_extract_code = p.extractCode;
        result = await call("api_update_resource", ub);
        break;
      }

      case "accountStatus":
        result = await call("api_get_account_status", {});
        break;

      // ── 每日签到（do_check_in）→ { points_earned, consecutive } ──────────
      case "checkIn":
        result = await call("do_check_in", {});
        break;

      // ── 积分抽奖（do_draw）：count 次数、cost 单次消耗积分（以站点规则为准）──
      case "draw": {
        const count = Number(p.count ?? 1);
        const cost = Number(p.cost ?? NaN);
        if (!Number.isFinite(count) || count < 1) {
          return res({ success: false, error: "抽奖次数不合法" }, 400);
        }
        if (!Number.isFinite(cost) || cost < 0) {
          return res({ success: false, error: "缺少 cost（单次抽奖消耗的积分，以站点当前规则为准）" }, 400);
        }
        // 站点要求 p_cost 为本次实际消耗总量，需与 p_count 匹配
        result = await call("do_draw", { p_count: count, p_cost: cost * count });
        break;
      }

      // ── 幸运抽签（buy_lucky_ticket）：每日限一次，消耗 15 积分 ────────────
      case "buyLuckyTicket":
        result = await call("buy_lucky_ticket", {});
        break;

      // ── 抽签池状态（api_get_lucky_draw）────────────────────────────────
      case "luckyDraw":
        result = await call("api_get_lucky_draw", {});
        break;

      // ── 查询片源与本人提交的有效资源链接（api_search_videos）──────────────
      case "searchMyVideos": {
        const title = String(p.title ?? "").trim();
        if (!title) return res({ success: false, error: "缺少 title" }, 400);
        const rpcBody: Record<string, unknown> = { p_title: title };
        if (p.category) rpcBody.p_category = String(p.category);
        if (p.limit) rpcBody.p_limit = Number(p.limit);
        result = await call("api_search_videos", rpcBody);
        break;
      }

      // ── 订阅资源（api_subscribe_link）：p_link_id 精确 或 p_title 模糊 ────
      case "subscribeLink": {
        const rpcBody: Record<string, unknown> = {};
        if (p.linkId !== undefined && p.linkId !== null) rpcBody.p_link_id = Number(p.linkId);
        if (p.title) {
          rpcBody.p_title = String(p.title);
          if (p.category) rpcBody.p_category = String(p.category);
          if (p.keyword) rpcBody.p_keyword = String(p.keyword);
        }
        if (rpcBody.p_link_id === undefined && !rpcBody.p_title) {
          return res({ success: false, error: "缺少 p_link_id（推荐）或 p_title" }, 400);
        }
        if (p.active !== undefined) rpcBody.p_active = Boolean(p.active);
        result = await call("api_subscribe_link", rpcBody);
        break;
      }

      // ── 取消订阅（api_unsubscribe_link）─────────────────────────────────
      case "unsubscribeLink": {
        const rpcBody: Record<string, unknown> = {};
        if (p.linkId !== undefined && p.linkId !== null) rpcBody.p_link_id = Number(p.linkId);
        if (p.title) rpcBody.p_title = String(p.title);
        if (rpcBody.p_link_id === undefined && !rpcBody.p_title) {
          return res({ success: false, error: "缺少 p_link_id 或 p_title" }, 400);
        }
        result = await call("api_unsubscribe_link", rpcBody);
        break;
      }

      // ── 我的订阅列表（api_list_subscriptions）───────────────────────────
      case "listSubscriptions": {
        const rpcBody: Record<string, unknown> = {};
        if (p.activeOnly !== undefined) rpcBody.p_active_only = Boolean(p.activeOnly);
        if (p.limit) rpcBody.p_limit = Number(p.limit);
        result = await call("api_list_subscriptions", rpcBody);
        break;
      }

      // ── 拉取订阅更新通知（api_get_subscription_notifications）────────────
      case "getSubscriptionNotifications": {
        const rpcBody: Record<string, unknown> = {};
        if (p.limit) rpcBody.p_limit = Number(p.limit);
        if (p.onlyUnread !== undefined) rpcBody.p_only_unread = Boolean(p.onlyUnread);
        if (p.markRead !== undefined) rpcBody.p_mark_read = Boolean(p.markRead);
        if (p.since) rpcBody.p_since = String(p.since);
        result = await call("api_get_subscription_notifications", rpcBody);
        break;
      }

      // ── 标记通知已读（api_mark_notifications_read）：ids 批量 或 all ──────
      case "markNotificationsRead": {
        const rpcBody: Record<string, unknown> = {};
        if (Array.isArray(p.ids) && p.ids.length) rpcBody.p_ids = p.ids.map((i: unknown) => Number(i));
        if (p.all) rpcBody.p_all = true;
        if (!rpcBody.p_ids && !rpcBody.p_all) {
          return res({ success: false, error: "请提供 ids（数组）或 all=true" }, 400);
        }
        result = await call("api_mark_notifications_read", rpcBody);
        break;
      }

      default:
        return res({ success: false, error: `未知 action: ${action}` }, 400);
    }

    await appClient.from("ya_sessions")
      .update({ last_check_at: new Date().toISOString(), status: "active" }).eq("user_id", uid);

    return res({ success: true, data: result });
  } catch (e) {
    return res({ success: false, error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/**
 * site-credential: 站点登录凭据云端加密存储 + 会话巡检 + 失效自动重登
 *
 * 背景：各站点会话（ya_sessions / jying_sessions / ... ）失效后，原先只能由用户
 *       手动重新登录。本函数把「账号密码 / Cookie」加密存到 site_credentials，
 *       巡检发现会话失效时用凭据自动重新登录，降低同步失败率。
 *
 * 调用：POST /site-credential?action=<action>，Authorization: Bearer <本应用登录态>
 *   save      保存/更新凭据  { site, username?, password? | cookie?, autoLogin? }
 *   list      本人凭据元信息（不含密文）
 *   forget    删除某站点凭据     { site }
 *   ensure    巡检单个站点       { site }
 *   ensureAll 巡检全部已绑定站点（用户登录后由前端自动调用）
 *
 * 单站点结果 status：
 *   ok        会话有效
 *   relogged  已用云端凭据自动重新登录成功
 *   manual    无法自动重登（仅 Cookie 站点 / 登录需图形验证码 / 未保存凭据 / 已关闭自动重登）
 *   failed    自动重登失败（账号密码可能已失效）
 *   unbound   未绑定该站点
 *
 * 安全：密码/Cookie 用 pgcrypto 加密后落库，密钥只在本函数环境变量（SITE_CRED_KEY）；
 *       数据库只存密文，前端连密文列都无权读取。
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveCallerId } from "../_shared/internalAuth.ts";

const APP_URL = Deno.env.get("SUPABASE_URL")!;
const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRED_KEY = Deno.env.get("SITE_CRED_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SITE_TIMEOUT_MS = 25000;

type SiteKey = "ya" | "jying" | "hdhaven" | "framehdr" | "mukaku" | "pinglian" | "panfx" | "xn" | "st1";

interface SiteSpec {
  label: string;
  /** 对应边缘函数 */
  fn: string;
  /** 会话表（判断是否已绑定） */
  sessionTable: string;
  /** 巡检用的轻量 action */
  probe: { action: string; body?: Record<string, unknown> };
  /** 账号密码登录 action；null = 该站点只能人工粘贴 Cookie */
  login: string | null;
  /** 登录需要图形验证码 → 无法无人值守重登 */
  captcha: boolean;
  /** captcha=true 时给用户看的具体原因（不填则用通用文案） */
  manualReason?: string;
  /** 失效错误码（与前端常量保持一致） */
  codes: string[];
}

const SITES: Record<SiteKey, SiteSpec> = {
  ya: {
    label: "鸭影臻藏",
    fn: "resource-manager",
    sessionTable: "ya_sessions",
    probe: { action: "accountStatus" },
    login: "login",
    captcha: false,
    codes: [],
  },
  jying: {
    label: "聚影",
    fn: "jying-proxy",
    sessionTable: "jying_sessions",
    probe: { action: "status" },
    login: "login",
    captcha: false,
    codes: ["JYING_COOKIE_EXPIRED", "JYING_NOT_BOUND"],
  },
  hdhaven: {
    label: "栖影 HDHaven",
    fn: "hdhaven-proxy",
    sessionTable: "hdhaven_sessions",
    probe: { action: "status" },
    // 2026-10 起改用站点官方 OpenAPI OAuth：用户在浏览器点一次授权，
    // access_token 长期有效，不需要账号密码、也没有会话过期重登的概念
    //（旧的 Cookie + Turnstile + 图形验证码那套已从 hdhaven-proxy 中整体移除）。
    // 失效只发生在用户在 OPENAPI 页面撤销授权、重新授权或账号不可用，
    // 此时无法自动恢复，必须重新走一次授权流程。
    login: null,
    captcha: false,
    manualReason:
      "栖影授权已失效（用户撤销授权或账号不可用），请到「站点同步 → 栖影 HDHaven」重新授权",
    codes: ["HDHAVEN_TOKEN_EXPIRED", "HDHAVEN_NOT_BOUND", "HDHAVEN_RATE_LIMITED"],
  },
  framehdr: {
    label: "帧影",
    fn: "framehdr-proxy",
    sessionTable: "framehdr_sessions",
    probe: { action: "list" },
    login: "login",
    captcha: false,
    codes: ["COOKIE_EXPIRED"],
  },
  mukaku: {
    label: "不太灵",
    fn: "mukaku-proxy",
    sessionTable: "mukaku_tokens",
    probe: { action: "status" },
    login: "login",
    captcha: true,
    codes: ["MUKAKU_TOKEN_EXPIRED", "MUKAKU_NOT_BOUND"],
  },
  pinglian: {
    label: "盘链",
    fn: "panlinks-proxy",
    sessionTable: "pinglian_sessions",
    // 注意：pinglian 的 action=status 是站点公开接口，未登录也返回 200，不能用来判失效；
    // 必须用 list（未登录时返回 401 + PINGLIAN_COOKIE_EXPIRED）
    probe: { action: "list" },
    login: "login",
    captcha: true,
    codes: ["PINGLIAN_COOKIE_EXPIRED"],
  },
  panfx: {
    label: "123社区",
    fn: "panfx-proxy",
    sessionTable: "panfx_sessions",
    // 注意：panfx 的 action=check 只读本地会话、不向站点校验，会假阳性；改用 list
    probe: { action: "list" },
    login: null,
    captcha: false,
    codes: ["COOKIE_EXPIRED"],
  },
  xn: {
    label: "观影站点",
    fn: "xnshare-proxy",
    sessionTable: "xn_sessions",
    probe: { action: "list" },
    login: null,
    captcha: false,
    codes: ["COOKIE_EXPIRED"],
  },
  st1: {
    label: "1号站点",
    fn: "st1-proxy",
    sessionTable: "st1_sessions",
    // 本质是「开放 API 令牌」型站点（站点「开放API」标签里生成 pat_…）；
    // 另有站点账号密码登录（带图形验证码），仅用于站点内部接口，不能无人值守重登。
    probe: { action: "status" },
    login: "login",
    captcha: true,
    manualReason:
      "1号站点登录需要图形验证码，无法自动重登：令牌失效时请到站点「开放API」标签重新生成后，在「站点同步 → 1号站点」里重新绑定",
    codes: ["ST1_TOKEN_EXPIRED", "ST1_NOT_BOUND"],
  },
};

const SITE_KEYS = Object.keys(SITES) as SiteKey[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

const ok = (data: unknown) => json({ success: true, data });
const fail = (message: string, status = 400, code?: string) =>
  json({ success: false, code: code ?? null, message }, status);

type SiteStatus = "ok" | "relogged" | "manual" | "failed" | "unbound";

interface SiteResult {
  site: SiteKey;
  label: string;
  status: SiteStatus;
  reason: string;
  account?: string | null;
  /** 自动重登是否发生过 */
  relogged?: boolean;
}

/** 转发给站点代理的身份：用户 JWT，或内部通道（服务端 worker 代跑时使用） */
interface SiteAuth {
  userToken?: string;
  internalSecret?: string;
  userId: string;
}

/** 调用站点代理边缘函数（转原本应用登录态，站点侧会话逻辑不变） */
async function callSite(
  spec: SiteSpec,
  action: string,
  auth: SiteAuth,
  body: Record<string, unknown>
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth.userToken) headers.Authorization = `Bearer ${auth.userToken}`;
  // 服务端 worker 调用时没有用户 JWT：改带内部通道头，让代理按指定用户执行
  if (auth.internalSecret) {
    headers["x-internal-secret"] = auth.internalSecret;
    headers["x-user-id"] = auth.userId;
  }
  const res = await fetch(
    `${APP_URL}/functions/v1/${spec.fn}?action=${encodeURIComponent(action)}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...body }),
      signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
    }
  );
  const text = await res.text().catch(() => "");
  return { status: res.status, text };
}

/** 判断响应是否代表「会话失效 / 未授权」 */
function looksExpired(spec: SiteSpec, status: number, text: string): boolean {
  if (spec.codes.some((c) => text.includes(c))) return true;
  if (spec.codes.length === 0 && /(未绑定|重新绑定|token 已过期|登录态无效)/i.test(text)) return true;
  if (status === 401 || status === 403) return true;
  if (/"valid"\s*:\s*false/i.test(text)) return true;
  if (/"status"\s*:\s*"expired"/i.test(text)) return true;
  return false;
}

type ProbeOutcome = "healthy" | "expired" | "indeterminate";

/**
 * 探测结果分三档：
 *   healthy       会话有效
 *   expired       明确失效（错误码 / 401 / 403）
 *   indeterminate 站点异常（5xx、网关 5xx、接口软报错）→ 不能当成有效，
 *                 也不能当成失效（避免站点故障时误触发重登、白白消耗登录次数）
 */
function classifyProbe(spec: SiteSpec, status: number, text: string): ProbeOutcome {
  if (looksExpired(spec, status, text)) return "expired";
  const softError =
    /"success"\s*:\s*false/i.test(text) ||
    /"ok"\s*:\s*false/i.test(text) ||
    /^\s*\{\s*"(error|code)"\s*:/i.test(text);
  if (status >= 200 && status < 300 && !softError) return "healthy";
  return "indeterminate";
}

/** 判断响应是否代表「凭据本身不对」（账号密码错误 / 需要验证码等） */
function describeLoginFailure(text: string): string {
  if (/TOTP|两步验证|动态码|totp/i.test(text)) return "站点开启了两步验证，需要动态码，请手动登录一次";
  if (/验证码|captcha/i.test(text)) return "站点登录需要图形验证码，请手动登录一次";
  if (/密码|password|账号|用户名/i.test(text)) return "账号或密码已失效，请重新登录并保存凭据";
  return "自动重新登录失败，请手动登录一次";
}

const notBlank = (v: unknown) => typeof v === "string" && v.trim().length > 0;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("仅支持 POST 请求", 405);

  const svc = createClient(APP_URL, SVC_KEY, { auth: { persistSession: false } });

  // ── 1. 登录态校验 ──
  // 用户 JWT，或服务端 worker/定时任务的内部通道
  //（x-internal-secret + x-user-id，见 _shared/internalAuth.ts；未配置密钥时该通道关闭）。
  // 所有操作只作用于解析出的该用户。
  const userId = await resolveCallerId(req, async (t) => {
    const { data } = await svc.auth.getUser(t);
    return data?.user?.id ?? null;
  });
  if (!userId) return fail("登录态无效，请重新登录", 401);

  // 转发给站点代理的身份：浏览器调用时沿用用户 JWT；服务端 worker 调用时改带内部通道头
  const siteAuth: SiteAuth = {
    userToken:
      (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim() || undefined,
    internalSecret: req.headers.get("x-internal-secret") ?? undefined,
    userId,
  };

  if (!CRED_KEY) return fail("服务端缺少 SITE_CRED_KEY 密钥，无法读写站点凭据", 500, "NO_CRED_KEY");

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch { /* 允许空 body */ }
  const url = new URL(req.url);
  const action = (url.searchParams.get("action") ?? String(body.action ?? "")).trim();

  const readCred = async (site: SiteKey) => {
    const { data, error } = await svc.rpc("load_site_credential", {
      p_user_id: userId,
      p_site: site,
      p_key: CRED_KEY,
    });
    if (error) throw new Error(`读取凭据失败：${error.message}`);
    const rows = (data ?? []) as Array<{ username: string | null; secret: string | null; secret_kind: string; auto_login: boolean }>;
    return rows[0] ?? null;
  };

  /** 单个站点巡检：先探测，失效则用云端凭据自动重登 */
  async function checkSite(site: SiteKey): Promise<SiteResult> {
    const spec = SITES[site];

    // 未绑定 → 直接跳过（不打扰站点）
    const { data: sessionRow } = await svc
      .from(spec.sessionTable)
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!sessionRow) return { site, label: spec.label, status: "unbound", reason: "未绑定该站点账号" };

    let probe: { status: number; text: string };
    try {
      probe = await callSite(spec, spec.probe.action, siteAuth, spec.probe.body ?? {});
    } catch (e) {
      return {
        site,
        label: spec.label,
        status: "failed",
        reason: `检测失败：${(e as Error).message || "站点无响应"}`,
      };
    }

    const outcome = classifyProbe(spec, probe.status, probe.text);
    if (outcome === "healthy") {
      return { site, label: spec.label, status: "ok", reason: "会话有效" };
    }
    if (outcome === "indeterminate") {
      return {
        site,
        label: spec.label,
        status: "failed",
        reason: `检测未完成：站点返回 HTTP ${probe.status}，请稍后重试或到「站点同步」页确认`,
      };
    }

    // 会话已失效 → 尝试自动重登
    if (!spec.login) {
      return {
        site,
        label: spec.label,
        status: "manual",
        // 无账号密码登录的站点（Cookie 型 / OAuth 型）各自的处置文案不同，优先取站点自定义说明
        reason:
          spec.manualReason ?? "该站点不支持自动重登，请重新获取凭据后更新绑定",
      };
    }

    let cred: Awaited<ReturnType<typeof readCred>> = null;
    try {
      cred = await readCred(site);
    } catch (e) {
      return { site, label: spec.label, status: "failed", reason: (e as Error).message };
    }

    if (!cred?.secret) {
      return {
        site,
        label: spec.label,
        status: "manual",
        reason: "云端未保存登录凭据，请手动登录一次以启用自动重登",
      };
    }
    if (cred.secret_kind !== "password") {
      return {
        site,
        label: spec.label,
        status: "manual",
        reason: "该站点仅保存了 Cookie，请重新获取 Cookie 后更新绑定",
      };
    }
    if (cred.auto_login === false) {
      return {
        site,
        label: spec.label,
        status: "manual",
        reason: "已关闭该站点的自动重登",
        account: cred.username,
      };
    }
    if (spec.captcha) {
      return {
        site,
        label: spec.label,
        status: "manual",
        reason:
          spec.manualReason ??
          "该站点登录需要图形验证码，请在「站点同步」页手动登录一次",
        account: cred.username,
      };
    }

    // 用云端凭据重新登录（走站点代理原有的 login action，会话由代理回写）
    let retry: { status: number; text: string };
    try {
      retry = await callSite(spec, spec.login, siteAuth, {
        username: cred.username ?? "",
        password: cred.secret,
      });
    } catch (e) {
      const reason = `自动重登失败：${(e as Error).message || "站点无响应"}`;
      await svc.rpc("mark_site_credential", { p_user_id: userId, p_site: site, p_ok: false, p_error: reason });
      return { site, label: spec.label, status: "failed", reason, account: cred.username };
    }

    const success = classifyProbe(spec, retry.status, retry.text) === "healthy";
    if (success) {
      await svc.rpc("mark_site_credential", { p_user_id: userId, p_site: site, p_ok: true, p_error: null });
      return {
        site,
        label: spec.label,
        status: "relogged",
        reason: "会话已失效，已用云端凭据自动重新登录",
        account: cred.username,
        relogged: true,
      };
    }

    const reason = describeLoginFailure(retry.text);
    await svc.rpc("mark_site_credential", { p_user_id: userId, p_site: site, p_ok: false, p_error: reason });
    return { site, label: spec.label, status: "failed", reason, account: cred.username };
  }

  try {
    switch (action) {
      // ── 保存 / 更新凭据 ──
      case "save": {
        const site = String(body.site ?? "").trim() as SiteKey;
        if (!SITES[site]) return fail(`不支持的站点：${body.site}`, 400);
        const password = notBlank(body.password) ? String(body.password) : "";
        const cookie = notBlank(body.cookie) ? String(body.cookie) : "";
        // API 令牌型站点（1号站点 pat_…）
        const token = notBlank(body.token) ? String(body.token) : "";
        const username = notBlank(body.username) ? String(body.username).trim() : "";
        const secret = password || cookie || token;
        const kind = password ? "password" : cookie ? "cookie" : token ? "token" : "";
        if (!secret && !username) return fail("缺少登录信息（账号 / 密码 / Cookie / API 令牌）", 400);

        const { error } = await svc.rpc("save_site_credential", {
          p_user_id: userId,
          p_site: site,
          p_username: username,
          p_secret: secret,
          p_kind: kind || "password",
          p_auto_login: body.autoLogin !== false,
          p_key: CRED_KEY,
        });
        if (error) return fail(`保存凭据失败：${error.message}`, 500);
        return ok({ site, label: SITES[site].label, saved: true, kind: kind || "unchanged" });
      }

      // ── 列出凭据元信息（不含密文） ──
      case "list": {
        const { data, error } = await svc
          .from("site_credentials")
          .select("site, username, secret_kind, auto_login, last_success_at, last_error, fail_count, created_at, updated_at")
          .eq("user_id", userId);
        if (error) return fail(`读取凭据失败：${error.message}`, 500);
        const rows = (data ?? []) as Array<{ site: string }>;
        return ok({
          items: rows.map((r) => ({ ...r, label: SITES[r.site as SiteKey]?.label ?? r.site })),
        });
      }

      // ── 删除凭据（不再自动重登） ──
      case "forget": {
        const site = String(body.site ?? "").trim();
        if (!SITES[site as SiteKey]) return fail(`不支持的站点：${body.site}`, 400);
        const { error } = await svc
          .from("site_credentials")
          .delete()
          .eq("user_id", userId)
          .eq("site", site);
        if (error) return fail(`删除凭据失败：${error.message}`, 500);
        return ok({ site, forgotten: true });
      }

      // ── 关闭 / 开启某站点的自动重登 ──
      case "toggle": {
        const site = String(body.site ?? "").trim();
        if (!SITES[site as SiteKey]) return fail(`不支持的站点：${body.site}`, 400);
        const { error } = await svc
          .from("site_credentials")
          .update({ auto_login: body.autoLogin !== false })
          .eq("user_id", userId)
          .eq("site", site);
        if (error) return fail(`更新失败：${error.message}`, 500);
        return ok({ site, autoLogin: body.autoLogin !== false });
      }

      // ── 巡检单个站点 ──
      case "ensure": {
        const site = String(body.site ?? "").trim() as SiteKey;
        if (!SITES[site]) return fail(`不支持的站点：${body.site}`, 400);
        return ok(await checkSite(site));
      }

      // ── 巡检全部已绑定站点（登录后自动巡检入口） ──
      case "ensureAll": {
        const only = Array.isArray(body.sites)
          ? (body.sites as string[]).filter((s) => SITES[s as SiteKey]) as SiteKey[]
          : SITE_KEYS;
        const boundFlags = await Promise.all(
          only.map(async (site) => {
            const { data } = await svc
              .from(SITES[site].sessionTable)
              .select("user_id")
              .eq("user_id", userId)
              .maybeSingle();
            return { site, bound: !!data };
          })
        );
        const targets = boundFlags.filter((b) => b.bound).map((b) => b.site);
        const results = await Promise.all(targets.map((site) => checkSite(site)));

        const summary = {
          checked: results.length,
          ok: results.filter((r) => r.status === "ok").length,
          relogged: results.filter((r) => r.status === "relogged").length,
          manual: results.filter((r) => r.status === "manual").length,
          failed: results.filter((r) => r.status === "failed").length,
        };
        return ok({
          checkedAt: new Date().toISOString(),
          account: { id: userId },
          results,
          // 需要用户处理的站点（失败 / 需手动重登）
          needsAttention: results.filter((r) => r.status === "failed" || r.status === "manual"),
          summary,
        });
      }

      default:
        return fail(`不支持的 action: ${action}`, 400);
    }
  } catch (e) {
    return fail((e as Error).message || "站点凭据服务异常", 500);
  }
});

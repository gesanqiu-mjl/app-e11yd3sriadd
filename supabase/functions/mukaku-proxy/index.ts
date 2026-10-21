// ============================================================
// Supabase Edge Function: mukaku-proxy
// web3.mukaku.com（不太灵 / MUKAKU 影视资源站）代理
//
// 目标站接口体系：
//   前缀   /prod/api/v1
//   鉴权   query 三元组 app_id + identity + access_token（无 CSRF，Bearer 头无效）
//   包裹   { requestId, path, success, message, code, data }
//   HTTP   恒为 200，成败看 body.code
//   code   200 成功 | 2150 参数/接口异常 | 10103 缺 token | 10104 token 无效
//          10101 应用级参数缺失 | 500 业务失败（验证码不正确 / 用户不存在 / 资源不存在）
//
// 本代理提供的 action：
//   captcha      GET  取图形验证码（算术题，需人工填写答案）
//   login        POST 账号密码 + 验证码登录，换取 access_token（密码不落库）
//   status       GET  校验当前 token 是否有效并返回绑定信息
//   unbind       POST 解除绑定并清空本地 token
//   list         GET  我的发布（getUserWpList，支持 page/type/seed_name/created_at）
//   search       GET  搜索片源（getVideoList，仅首屏 24 条，服务端忽略分页）
//   videoDetail  GET  影片详情（getVideoDetail?id=<豆瓣ID>），取站内影片主键
//   add          POST 发布资源（addWpResource，自动由 link 推导 type）
//   update       POST 修改资源（editWpResource，需 id）
//   delete       GET  删除资源（delWpResource?id=）
//   dict         GET  网盘平台字典（getWpDictList?code=wpan_type）
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveCallerId } from "../_shared/internalAuth.ts";

const BASE = "https://web3.mukaku.com";
const API = "/prod/api/v1";
const APP_ID = "83768d9ad4";
const IDENTITY = "23734adac0301bccdcb107c4aa21f96c";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// JWT 实测有效期 7 天，用于写库时估算过期时间
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

// ------------------------------------------------------------
// 网盘平台 type 推导（原样移植自站点前端 wpResource 页内联规则）
// 注意：提交给 add/edit 的 type 一律是平台字符串，
//      不是整数、也不是字典 id；字典 id 仅用于 list 的筛选参数。
// ------------------------------------------------------------
function derivePanType(link: string): string {
  const l = String(link || "");
  if (/(https?:\/\/pan\.baidu\.com\/s\/[\w-]+)(?:\?pwd=([\w]+))?|(https?:\/\/pan\.baidu\.com\/share\/init\?[\w-]+)/i.test(l)) return "baidu";
  if (/(https?:\/\/(?:www\.)?(?:aliyundrive|alipan)\.com\/s\/[\w-]+)(?:\?[\w-]+)?/i.test(l)) return "ali";
  if (/(https?:\/\/pan\.quark\.cn\/s\/[\w]+)/i.test(l)) return "quark";
  if (/(https?:\/\/115\.com\/s\/[\w]+)/i.test(l)) return "115";
  if (/(https?:\/\/(?:[a-z]+\.)?lanzou[xyiv]\.com\/[a-z]?[\w-]+)/i.test(l)) return "lanzou";
  if (/(https?:\/\/pan\.xunlei\.com\/s\/[\w]+)/i.test(l)) return "xunlei";
  if (/(https?:\/\/(?:web\.disk\.uc\.cn|drive\.uc\.cn)\/s\/[\w-]+)(?:\?public=\d)?/i.test(l)) return "uc";
  if (/(https?:\/\/www\.123pan\.com\/s\/[\w]+)/i.test(l)) return "123";
  if (/(https?:\/\/cloud\.189\.cn\/t\/[\w]+)/i.test(l)) return "tianyi";
  if (/(https?:\/\/www\.123912\.com\/s\/[\w-]+)/i.test(l)) return "123";
  if (/(https?:\/\/(?:www\.)?guangyapan\.com\/s\/[\w-]+)/i.test(l)) return "guangya";
  return "other";
}

interface ApiResult {
  code: number;
  message: string;
  data: unknown;
  raw: string;
  parseOk: boolean;
}

async function callApi(
  urlPath: string,
  opts: {
    method?: "GET" | "POST";
    params?: Record<string, string | number | undefined>;
    body?: Record<string, unknown>;
    token?: string | null;
  } = {}
): Promise<ApiResult> {
  const { method = "GET", params = {}, body = undefined, token = null } = opts;

  const qs = new URLSearchParams();
  qs.set("app_id", APP_ID);
  qs.set("identity", IDENTITY);
  if (token) qs.set("access_token", token);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }

  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    Origin: BASE,
    Referer: `${BASE}/`,
  };
  let payload: string | undefined;
  if (body !== undefined && method === "POST") {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${API}${urlPath}?${qs.toString()}`, {
    method,
    headers,
    body: payload,
    redirect: "follow",
  });

  const text = await res.text();
  let parsed: { code?: number; message?: string; data?: unknown } | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  return {
    code: parsed?.code ?? -1,
    message: parsed?.message ?? `非 JSON 响应（HTTP ${res.status}）`,
    data: parsed?.data ?? null,
    raw: text,
    parseOk: parsed !== null,
  };
}

function isTokenInvalid(r: ApiResult): boolean {
  return r.code === 10103 || r.code === 10104;
}

function tidyMessage(msg: string): string {
  if (!msg) return "站点未返回错误信息";
  if (msg.includes("验证码不正确")) return "验证码不正确，请点击验证码图片刷新后重新输入";
  if (msg.includes("用户不存在")) return "账号不存在，请检查用户名";
  if (msg.includes("密码")) return msg;
  return msg.replace(/^接口异常\s*/, "");
}

interface LoginOutcome {
  ok: boolean;
  token?: string;
  message?: string;
}

async function loginWithPassword(
  username: string,
  password: string,
  code: string,
  key: string
): Promise<LoginOutcome> {
  const r = await callApi("/login", {
    method: "POST",
    body: { username, password, code, key },
  });

  if (!r.parseOk) {
    return { ok: false, message: `web3.mukaku.com 登录接口返回异常（${r.message}）` };
  }
  if (r.code !== 200) {
    return { ok: false, message: tidyMessage(r.message) };
  }

  const data = r.data as { access_token?: string } | null;
  if (!data?.access_token) {
    return { ok: false, message: "登录成功但未取得 access_token，站点鉴权方式可能已变更" };
  }
  return { ok: true, token: data.access_token };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---------- 1. 验证 Supabase 登录态 ----------
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // 鉴权：用户 JWT，或服务端 worker/定时任务的内部通道
    //（x-internal-secret + x-user-id，见 _shared/internalAuth.ts；未配置密钥时该通道关闭）
    const callerId = await resolveCallerId(req, async (t) => {
      const { data, error } = await supabase.auth.getUser(t);
      return error ? null : (data?.user?.id ?? null);
    });
    if (!callerId) return json({ error: "登录态无效" }, 401);
    const user = { id: callerId };

    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "";

    // ---------- 2. 取图形验证码（登录前置步骤） ----------
    if (action === "captcha") {
      const r = await callApi("/getCaptcha");
      if (!r.parseOk || r.code !== 200) {
        return json({ error: `获取验证码失败：${tidyMessage(r.message)}` }, 502);
      }
      const d = r.data as { key?: string; img?: string } | null;
      if (!d?.key || !d?.img) {
        return json({ error: "验证码响应结构异常，站点接口可能已变更" }, 502);
      }
      return json({ success: true, data: { key: d.key, img: d.img } });
    }

    // ---------- 3. 登录（账号密码 + 验证码答案） ----------
    if (action === "login") {
      if (req.method !== "POST") return json({ error: "login 需要 POST 请求" }, 405);

      const body = (await req.json().catch(() => ({}))) as Record<string, string>;
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      const code = String(body.code ?? "").trim();
      const key = String(body.key ?? "").trim();

      if (!username || !password) {
        return json({ error: "请输入 web3.mukaku.com 的账号和密码" }, 400);
      }
      if (!key) {
        return json({ error: "验证码已失效，请重新获取验证码图片" }, 400);
      }
      if (!code) {
        return json({ error: "请输入验证码答案（图片中的算式结果）" }, 400);
      }

      const result = await loginWithPassword(username, password, code, key);
      if (!result.ok || !result.token) {
        return json(
          { success: false, message: result.message || "登录失败，请检查账号密码与验证码" },
          401
        );
      }

      const now = new Date();
      const { error: upsertError } = await supabase.from("mukaku_tokens").upsert(
        {
          user_id: user.id,
          username,
          access_token: result.token,
          token_expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
          status: "active",
          last_check_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        { onConflict: "user_id" }
      );
      if (upsertError) {
        return json({ error: `保存绑定失败：${upsertError.message}` }, 500);
      }

      return json({ success: true, message: "不太灵站点 (MUKAKU) 账号登录成功" });
    }

    // ---------- 4. 解绑（退出） ----------
    if (action === "unbind") {
      await supabase.from("mukaku_tokens").delete().eq("user_id", user.id);
      return json({ success: true, message: "已解除不太灵站点账号绑定" });
    }

    // ---------- 5. 读取该用户绑定的 token ----------
    const { data: session } = await supabase
      .from("mukaku_tokens")
      .select("access_token, username, status, token_expires_at, last_check_at")
      .eq("user_id", user.id)
      .maybeSingle();

    // 仅针对管理个人发布及写操作强制要求绑定；搜索片源与详情支持公开凭据调用
    const requiresBinding = !["search", "videoDetail"].includes(action ?? "");
    if (requiresBinding && !session?.access_token) {
      return json(
        { error: "未绑定 web3.mukaku.com 账号，请先在设置页登录绑定", code: "MUKAKU_NOT_BOUND" },
        400
      );
    }
    const tk: string | null = session?.access_token ?? null;

    // 统一收集 query 透传参数（action 除外）
    const passthrough: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      if (k !== "action") passthrough[k] = v;
    });
    const body =
      req.method === "GET"
        ? ({} as Record<string, unknown>)
        : ((await req.json().catch(() => ({}))) as Record<string, unknown>);

    // ---------- 6. action 映射 ----------
    let result: ApiResult;
    let extra: Record<string, unknown> = {};

    switch (action) {
      case "status": {
        if (!tk) {
          return json({ success: true, data: { valid: false, status: "unbound" } });
        }
        result = await callApi("/getUserWpList", {
          params: { page: 1 },
          token: tk,
        });
        if (isTokenInvalid(result)) break;
        await supabase
          .from("mukaku_tokens")
          .update({ status: "active", last_check_at: new Date().toISOString() })
          .eq("user_id", user.id);
        return json({
          success: true,
          data: {
            username: session?.username,
            valid: true,
            status: "active",
            token_expires_at: session?.token_expires_at,
          },
        });
      }

      case "list": {
        result = await callApi("/getUserWpList", {
          params: {
            page: passthrough.page ?? 1,
            type: passthrough.type ?? "",
            seed_name: passthrough.seed_name ?? "",
            created_at: passthrough.created_at ?? "",
          },
          token: tk,
        });
        break;
      }

      case "search": {
        const rawSb = String(passthrough.sb ?? body.sb ?? "").trim();
        if (!rawSb) return json({ error: "请输入搜索关键词" }, 400);

        // 辅助判断结果列表长度
        const extractList = (r: ApiResult): unknown[] => {
          if (!r || r.code !== 200) return [];
          const d = r.data as Record<string, unknown> | null;
          if (Array.isArray(d)) return d;
          if (Array.isArray(d?.data)) return d.data;
          if (Array.isArray(d?.list)) return d.list;
          return [];
        };

        // 1. 先尝试原始关键词
        result = await callApi("/getVideoList", {
          params: { sb: rawSb, page: 1, limit: 24 },
          token: tk,
        });

        // 2. 如果未命中，且关键词包含书名号、括号年份等，自动去噪重试
        let hitList = extractList(result);
        if (hitList.length === 0) {
          const cleanedSb = rawSb
            .replace(/[《》【】\[\]]/g, " ")
            .replace(/[\(（]\s*(19|20)\d{2}\s*[\)）]/g, " ")
            .replace(/[\(（][^\)）]*[\)）]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

          if (cleanedSb && cleanedSb !== rawSb) {
            const retryRes = await callApi("/getVideoList", {
              params: { sb: cleanedSb, page: 1, limit: 24 },
              token: tk,
            });
            const retryList = extractList(retryRes);
            if (retryList.length > 0) {
              result = retryRes;
            }
          }
        }
        break;
      }

      case "videoDetail": {
        const id = String(passthrough.id ?? body.id ?? "").trim();
        if (!id) return json({ error: "缺少 id（豆瓣 ID）" }, 400);
        result = await callApi("/getVideoDetail", { params: { id }, token: tk });
        if (result.code === 200) {
          const d = result.data as { id?: number; title?: string } | null;
          extra = { movies_id: d?.id ?? null, title: d?.title ?? "" };
        }
        break;
      }

      case "add": {
        const seedName = String(body.seed_name ?? "").trim();
        const link = String(body.link ?? "").trim();
        const shareCode = String(body.code ?? "");
        const moviesId = Number(body.movies_id ?? 0);

        if (!moviesId) {
          return json(
            { error: "缺少 movies_id：请先选择影片以取得站内影片主键" },
            400
          );
        }
        if (!seedName || !link) {
          return json({ error: "请填写资源标题和网盘链接" }, 400);
        }

        const derivedType = derivePanType(link);
        result = await callApi("/addWpResource", {
          method: "POST",
          body: {
            id: "",
            seed_name: seedName,
            link,
            code: shareCode,
            movies_id: moviesId,
            type: derivedType,
          },
          token: tk,
        });

        if (result.code === 200) {
          const verify = await callApi("/getUserWpList", {
            params: { page: 1, seed_name: seedName },
            token: tk,
          });
          const items = (verify.data as { items?: Array<Record<string, unknown>> } | null)?.items ?? [];
          const hit = items.find((it) => String(it.link) === link);
          extra = { created_id: hit?.id ?? null, verified: Boolean(hit), pan_type: derivedType };
        }
        break;
      }

      case "update": {
        const id = Number(body.id ?? body.resource_id ?? 0);
        const seedName = String(body.seed_name ?? "").trim();
        const link = String(body.link ?? "").trim();
        const shareCode = String(body.code ?? "");
        const moviesId = Number(body.movies_id ?? 0);

        if (!id) return json({ error: "缺少 id（要修改的资源 id）" }, 400);
        if (!moviesId) {
          return json(
            { error: "缺少 movies_id：修改接口必带该字段" },
            400
          );
        }
        if (!seedName || !link) {
          return json({ error: "请填写资源标题和网盘链接" }, 400);
        }

        result = await callApi("/editWpResource", {
          method: "POST",
          body: {
            id,
            seed_name: seedName,
            link,
            code: shareCode,
            movies_id: moviesId,
            type: derivePanType(link),
          },
          token: tk,
        });
        break;
      }

      case "delete": {
        const rawIds = Array.isArray(body.ids)
          ? body.ids
          : [passthrough.id ?? body.id ?? 0];
        const ids = [...new Set(rawIds.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0))];
        if (!ids.length) return json({ error: "缺少 id" }, 400);

        // 归属校验：站点「我的发布」是分页返回的（实测 227 条 / 12 页，每页 20 条），
        // 原实现只翻第 1 页，导致第 2 页之后的资源被误判成「不属于你」而删不掉。
        // 这里一次把列表翻完，收集全部自有 ID；ids 传多个时只需翻一次页，批量删除时省大量请求。
        const owned = new Set<number>();
        const MAX_PAGES = 60;
        let page = 1;
        let totalPages = 1;
        do {
          const check = await callApi("/getUserWpList", { params: { page }, token: tk });
          const d = check.data as {
            items?: Array<{ id?: number }>;
            pageInfo?: { totalPage?: number };
          } | null;
          (d?.items ?? []).forEach((it) => {
            if (it?.id != null) owned.add(Number(it.id));
          });
          totalPages = Number(d?.pageInfo?.totalPage ?? page);
          page += 1;
        } while (page <= totalPages && page <= MAX_PAGES);

        const targets = ids.filter((i) => owned.has(i));
        const notOwned = ids.filter((i) => !owned.has(i));

        if (!targets.length) {
          result = {
            code: 500,
            message: `该资源不在你的发布列表中，未执行删除（共拉取 ${owned.size} 条自有记录）`,
            data: null,
            raw: "",
            parseOk: true,
          };
          break;
        }

        const deleted: number[] = [];
        const failed: number[] = [];
        for (const i of targets) {
          const r = await callApi("/delWpResource", { params: { id: i }, token: tk });
          if (r.code === 200) deleted.push(i);
          else failed.push(i);
        }
        result = {
          code: 200,
          message:
            `已删除 ${deleted.length} 条` +
            (failed.length ? `，失败 ${failed.length} 条` : "") +
            (notOwned.length ? `，${notOwned.length} 条不属于当前账号已跳过` : ""),
          data: { deleted, failed, notOwned },
          raw: "",
          parseOk: true,
        };
        break;
      }

      case "dict": {
        result = await callApi("/getWpDictList", {
          params: { code: "wpan_type" },
          token: tk,
        });
        break;
      }

      default:
        return json(
          {
            error: `不支持的 action: ${action}（可用：captcha / login / unbind / status / list / search / videoDetail / add / update / delete / dict）`,
          },
          400
        );
    }

    // ---------- 7. token 失效检测 ----------
    if (isTokenInvalid(result)) {
      await supabase
        .from("mukaku_tokens")
        .update({ status: "expired", last_check_at: new Date().toISOString() })
        .eq("user_id", user.id);

      return json(
        {
          success: false,
          code: "MUKAKU_TOKEN_EXPIRED",
          message: "不太灵站点 (MUKAKU) 登录已过期，请在设置页重新登录（需重新填写验证码）",
        },
        401
      );
    }

    // 有效：刷新检查时间
    await supabase
      .from("mukaku_tokens")
      .update({ status: "active", last_check_at: new Date().toISOString() })
      .eq("user_id", user.id);

    // ---------- 8. 原样透传站点响应 ----------
    if (!result.parseOk) {
      return json(
        { success: false, message: "站点返回了非 JSON 响应，接口可能已变更", raw: result.raw.slice(0, 500) },
        502
      );
    }
    const payload: Record<string, unknown> = {
      success: result.code === 200,
      code: result.code,
      message: result.message,
      ...extra,
    };
    if (result.data !== null && result.data !== undefined) {
      payload.data = result.data;
    }
    return json(payload);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

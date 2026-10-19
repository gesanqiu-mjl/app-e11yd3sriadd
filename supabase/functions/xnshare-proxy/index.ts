// ============================================================
// Supabase Edge Function: xnshare-proxy
// xn--wcv59z.com（观影站点）网盘分享 API 服务端代理
// 对齐 2026-09-13 实测接口契约
//
// 部署：supabase functions deploy xnshare-proxy --use-api
// 环境变量：SITE_URL（CORS 白名单，可留空默认 *）
//
// ── 站点契约（Base: https://www.xn--wcv59z.com）──
//  · 后端数据接口统一前缀 /res/（注意不是 /api/）
//  · 认证：Cookie 会话；所有 /res/* 与 /user/* 均需登录态
//  · 响应包裹：{code, msg, data}，code==200 为成功
//  · 列表结构：{page:{pages,curr,set}, inlist:{...列式数组...}}
//  · 反爬：接入 Pow（JS 工作量证明）挑战，页面级返回
//    {code:419, refresh:1, msg:"浏览器验证已过期...", worker/overlay/core}
//    —— 实测 /res/* 数据接口本身不触发 Pow，页面才会；但若 Cookie 失效
//       仍可能拿到 419，故单独识别并返回 POW_REQUIRED
//
// ── 接口清单 ──
//  登录/会话
//   · POST /user/login  —— 字段 username/password/cookietime/code/siteid=1/dosubmit=1
//      ⚠ 实测站点对非浏览器导航的服务端 /user/login 请求直接 RST 丢弃，
//        且登录页被 Pow 隔离 → 本代理不实现服务端登录，仍走「浏览器复制 Cookie 绑定」
//  片源
//   · GET  /res/search_suggest?q=        → [{title,id,year,type,dir,ename,score}]（裸数组）
//  分享管理
//   · GET  /res/user/content_list?search&pan&dirid
//   · GET  /res/pan/edit/{id}            → data:{title,panurl,panpw,is,binds[{dir,hid,...}]}
//   · POST /res/pan/add                  form: title/panurl/panpw/is/binds[i][dir]/binds[i][id]
//   · POST /res/pan/edit/{id}            同 add
//   · POST /res/pan/del/{id}             空 body
//   · POST /res/pan/heart/add|del        form: name=<panurl>
//  其它（文档 §4）
//   · GET  /res/downurl/{dir}/{id}
//   · GET  /res/favorite/add|del/{dir}/{id}
//   · GET  /res/historys
//   · POST /res/historys/delone | /res/historys/delete
//  未代理（原因见上/下）：/user/login、/res/captcha/2、/res/change/{ty}/{p}
//  （change 语义未明且会变更账号状态，为防误操作不暴露）
//
// ── 安全模型 ──
//  1. 入站请求必须携带 Supabase 登录用户 access_token（Authorization: Bearer）
//  2. Edge Function 用 service role 读取该用户绑定的站点 Cookie
//  3. Cookie 永不返回前端，只在服务端转发给站点
//  4. action=meta 为静态元数据，无需绑定站点账号
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveCallerId } from "../_shared/internalAuth.ts";

const SITE_BASE = "https://www.xn--wcv59z.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 文档 §6：网盘分类枚举（列表筛选项 pan 取值） */
const PAN_OPTIONS = [
  "迅雷网盘",
  "百度网盘",
  "夸克网盘",
  "天翼网盘",
  "移动网盘",
  "115网盘",
  "123网盘",
  "微云网盘",
  "UC网盘",
  "阿里网盘",
  "光鸭网盘",
];

/** 资源类型：dir（字母，search_suggest/binds 用） ↔ dirid（数字，列表筛选用） */
const DIRS = new Set(["mv", "tv", "ac"]);
const DIR_TO_DIRID: Record<string, string> = { mv: "1", tv: "2", ac: "3" };

/** 发布时 binds 数量约束（文档 §3：至少 1 个，最多 300 个） */
const BINDS_MIN = 1;
const BINDS_MAX = 300;

/** 静态元数据 action（不请求站点、无需绑定） */
const STATIC_ACTIONS = new Set(["meta"]);

/** 需要站点返回数据体的读操作（空 body 视为会话失效的依据之一） */
const READ_ACTIONS = new Set([
  "list",
  "search",
  "detail",
  "histories",
  "downurl",
]);

const ALL_ACTIONS = new Set([
  // 静态
  "meta",
  // 读
  "list",
  "search",
  "detail",
  "histories",
  "downurl",
  "favoriteAdd",
  "favoriteDel",
  // 写
  "add",
  "edit",
  "del",
  "heartAdd",
  "heartDel",
  "historiesDelOne",
  "historiesClear",
]);

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

// ---------- form-urlencoded 序列化 ----------

// 支持标量字段与 binds 数组：
//   {title:"x", binds:[{dir:"mv",id:"g7b3"}]}
//   → title=x&binds[0][dir]=mv&binds[0][id]=g7b3
function toForm(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === "object") {
          for (const [ik, iv] of Object.entries(item as Record<string, unknown>)) {
            params.append(`${k}[${i}][${ik}]`, String(iv ?? ""));
          }
        } else {
          params.append(`${k}[${i}]`, String(item ?? ""));
        }
      });
    } else if (v !== undefined && v !== null) {
      params.append(k, String(v));
    }
  }
  return params.toString();
}

/** is 归一化：公开 1 / 私有 0（文档 §3） */
function normalizeIs(v: unknown): string {
  if (v === 1 || v === "1" || v === true || v === "true") return "1";
  return "0";
}

/** binds 归一化 + 校验：元素须为 {dir:mv|tv|ac, id:<短码>}，数量 1..300 */
function normalizeBinds(v: unknown): { ok: true; binds: Array<{ dir: string; id: string }> } | { ok: false; message: string } {
  if (v === undefined || v === null) {
    return { ok: false, message: "发布分享前必须至少绑定 1 个资源" };
  }
  if (!Array.isArray(v)) {
    return { ok: false, message: "binds 必须是数组" };
  }
  if (v.length < BINDS_MIN) {
    return { ok: false, message: "发布分享前必须至少绑定 1 个资源" };
  }
  if (v.length > BINDS_MAX) {
    return { ok: false, message: `绑定资源最多 ${BINDS_MAX} 个` };
  }
  const binds: Array<{ dir: string; id: string }> = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, message: "绑定资源格式不正确" };
    }
    const rec = raw as Record<string, unknown>;
    const dir = String(rec.dir ?? "").trim();
    const id = String(rec.id ?? rec.hid ?? "").trim();
    if (!DIRS.has(dir)) {
      return { ok: false, message: `绑定资源的 dir 非法：${dir}（应为 mv/tv/ac）` };
    }
    if (!id) {
      return { ok: false, message: "绑定资源缺少资源短码 id" };
    }
    binds.push({ dir, id });
  }
  return { ok: true, binds };
}

/**
 * edit 专用：binds 可选。
 * 调用方（syncResourceToXn / 编辑弹窗）只改标题、链接、密码时不应被迫绑定资源；
 * 未提供或为空数组时返回 null，表示「完全不提交 binds 字段」以保留站点原有绑定
 * （与旧实现 toForm 跳过空数组的行为一致）；提供时才按文档校验。
 */
function optionalBinds(
  v: unknown
): { ok: true; binds: Array<{ dir: string; id: string }> | null } | { ok: false; message: string } {
  if (v === undefined || v === null) return { ok: true, binds: null };
  if (Array.isArray(v) && v.length === 0) return { ok: true, binds: null };
  const r = normalizeBinds(v);
  return r.ok ? { ok: true, binds: r.binds } : { ok: false, message: r.message };
}

// ---------- 响应判定 ----------

type Inspect =
  | { kind: "ok"; text: string }
  | { kind: "pow" }
  | { kind: "expired" }
  | { kind: "unexpected"; text: string };

/**
 * 判定站点响应状态。
 * 依据（结合文档与实际探测）：
 *  1. text/html → 被重定向到「提示需登录」页 → 会话失效
 *  2. JSON code=419 → Pow 浏览器验证挑战（单独处理，提示方式不同）
 *  3. JSON code=401/403 或 msg 含登录语义 → 会话失效
 *  4. 非 JSON/非数组（含纯文本）= 异常 → 会话失效
 *  5. 空 body：读操作视为失效（实测无 Cookie 时 /res/search_suggest 返回空）；
 *     写操作不据此判定（避免把成功的空响应误报为过期）
 */
async function inspect(res: Response, expectData: boolean): Promise<Inspect> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const trimmed = text.trim();

  if (ct.includes("text/html")) {
    // 未登录时站点返回「提示」页（<title>提示</title>）；
    // 其它 HTML（如 PHP 报错页、站点不支持的请求产生的异常页）不应被误判为登录失效，
    // 否则会误导用户重新绑定 Cookie，并把仍有效的会话错误标记为 expired
    return /<title>\s*提示|请先登录|需要登录|登录后/.test(text)
      ? { kind: "expired" }
      : { kind: "unexpected", text };
  }

  if (!trimmed) return expectData ? { kind: "expired" } : { kind: "ok", text };

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { kind: "expired" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "expired" };
  }

  if (Array.isArray(parsed)) return { kind: "ok", text };

  if (parsed && typeof parsed === "object") {
    const rec = parsed as Record<string, unknown>;
    const code = Number(rec.code);
    if (code === 419) return { kind: "pow" };
    if (code === 401 || code === 403) return { kind: "expired" };
    const msg = String(rec.msg ?? rec.message ?? "");
    if (/登录|未登录|请先登录|login|auth/i.test(msg)) return { kind: "expired" };
  }
  return { kind: "ok", text };
}

// ---------- 统一转发 ----------

type Method = "GET" | "POST";

async function proxy(
  method: Method,
  pathWithQuery: string,
  cookie: string,
  formBody?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    Cookie: cookie,
    "User-Agent": UA,
    Referer: `${SITE_BASE}/user/content_list`,
    "X-Requested-With": "XMLHttpRequest",
  };
  if (formBody !== undefined && formBody !== "") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const res = await fetch(`${SITE_BASE}${pathWithQuery}`, {
    method,
    headers,
    body: formBody ? formBody : undefined,
    redirect: "follow",
  });

  if (res.status >= 500 || res.status === 429) {
    throw new Error(
      res.status === 429
        ? "站点请求过于频繁（HTTP 429），请稍后重试"
        : `站点繁忙（HTTP ${res.status}），请稍后重试`
    );
  }
  return res;
}

// ---------- 主入口 ----------

/** 由完整标题派生一组由长到短的检索词，规避站点对长标题检索不稳定的情况 */
function searchKeywords(title: string): string[] {
  const t = title.trim();
  if (!t) return [];
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.trim();
    if (v && !out.includes(v)) out.push(v);
  };
  push(t);
  const cleaned = t
    .replace(/[\[【(（][^\]】)）]*[\]】)）]/g, " ")
    .replace(/更新至?\s*第?\s*\d+\s*[集话期]/g, " ")
    .replace(/(4K|1080P|2160P|SDR|HDR|WEB-DL|国语配音|中文字幕|内嵌中字|纯净版|高码率|无水印)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  push(cleaned);
  for (const n of [12, 8, 6, 4]) push(t.slice(0, n));
  return out;
}

/**
 * 按「标题 + 链接」回查刚发布（或站点已存在）的分享 ID。
 * 站点列表存在索引延迟，故整体重试 4 次；标题可能被站点改写，
 * 故再用链接单独兜底匹配一次。
 */
async function findShareId(
  wantTitle: string,
  wantUrl: string,
  cookie: string
): Promise<string | null> {
  if (!wantUrl) return null;
  const keywords = searchKeywords(wantTitle);

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600));
    for (const kw of keywords) {
      const lr = await proxy(
        "GET",
        `/res/user/content_list?search=${encodeURIComponent(kw)}`,
        cookie
      );
      if (lr.status === 404) continue;
      const li = await inspect(lr, true);
      if (li.kind !== "ok") continue;
      try {
        const lj = JSON.parse(li.text) as { inlist?: Record<string, unknown[]> };
        const cols = lj?.inlist;
        const ids = cols?.id;
        const titles = cols?.title;
        const urls = cols?.url;
        if (!Array.isArray(ids) || !Array.isArray(urls)) continue;
        // 1) 标题 + 链接全等
        if (Array.isArray(titles)) {
          const idx = titles.findIndex(
            (t, i) => String(t).trim() === wantTitle && String(urls[i]).trim() === wantUrl
          );
          if (idx >= 0) return String(ids[idx]);
        }
        // 2) 仅按链接匹配（标题可能被站点改写/截断）
        const uidx = urls.findIndex((u) => String(u).trim() === wantUrl);
        if (uidx >= 0) return String(ids[uidx]);
      } catch {
        /* 解析失败：换下一个关键词 */
      }
    }
  }
  return null;
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
    if (!callerId) {
      return json({ error: "登录态无效" }, 401);
    }
    const user = { id: callerId };

    const url = new URL(req.url);
    const action = (url.searchParams.get("action") ?? "").trim();
    const now = new Date().toISOString();
    const qp = (k: string) => url.searchParams.get(k) ?? "";

    // ---------- 2. action 合法性前置校验 ----------
    if (!ALL_ACTIONS.has(action)) {
      return json({ error: `不支持的 action: ${action}` }, 400);
    }

    // ---------- 3. 静态元数据（不请求站点、无需绑定） ----------
    if (STATIC_ACTIONS.has(action)) {
      return json({
        success: true,
        data: {
          panOptions: PAN_OPTIONS,
          dirs: Array.from(DIRS),
          dirToDirid: DIR_TO_DIRID,
          bindsMin: BINDS_MIN,
          bindsMax: BINDS_MAX,
        },
      });
    }

    // ---------- 4. 读取该用户绑定的站点 Cookie ----------
    const { data: session } = await supabase
      .from("xn_sessions")
      .select("cookie, status")
      .eq("user_id", user.id)
      .maybeSingle();

    const cookie: string = session?.cookie ?? "";
    if (!cookie) {
      return json(
        { error: "未绑定观影站点账号，请先在设置页绑定 Cookie" },
        400
      );
    }

    // ---------- 5. 构建转发请求 ----------
    const body: Record<string, unknown> =
      req.method === "POST" ? await req.json().catch(() => ({})) : {};

    let targetPath: string | null = null;
    let method: Method = "GET";
    let formBody: string | undefined;
    let expectData = READ_ACTIONS.has(action);

    /** 校验 dir/id（用于 /{dir}/{id} 型路径） */
    const requireDirId = (): { dir: string; id: string } | Response => {
      const dir = (qp("dir") || String(body.dir ?? "")).trim();
      const id = (qp("id") || String(body.id ?? "")).trim();
      if (!DIRS.has(dir)) {
        return json({ error: `dir 非法：${dir || "(空)"}（应为 mv/tv/ac）` }, 400);
      }
      if (!id) return json({ error: "缺少资源短码 id" }, 400);
      return { dir, id };
    };

    switch (action) {
      // ---- 片源搜索建议（裸数组响应）----
      case "search": {
        const q = (qp("q") || qp("keyword")).trim();
        const num = qp("num");
        if (!q) return json({ error: "请输入搜索关键词" }, 400);
        const qs = new URLSearchParams({ q });
        if (num) qs.set("num", num);
        targetPath = `/res/search_suggest?${qs.toString()}`;
        break;
      }

      // ---- 我的分享列表 ----
      case "list": {
        const qs = new URLSearchParams();
        for (const k of ["page", "search", "pan"]) {
          const v = qp(k);
          if (v) qs.set(k, v);
        }
        // dirid 支持数字直传，也接受 dir 字母（mv/tv/ac）自动换算
        const dirid = qp("dirid") || DIR_TO_DIRID[qp("dir")] || "";
        if (dirid) qs.set("dirid", dirid);
        targetPath = `/res/user/content_list${qs.toString() ? `?${qs.toString()}` : ""}`;
        break;
      }

      // ---- 单条分享详情（编辑回填）----
      case "detail": {
        const id = (qp("id") || String(body.id ?? "")).trim();
        if (!id) return json({ error: "缺少分享记录 id" }, 400);
        targetPath = `/res/pan/edit/${encodeURIComponent(id)}`;
        break;
      }

      // ---- 新增分享 ----
      case "add": {
        const binds = normalizeBinds(body.binds);
        if (!binds.ok) return json({ error: binds.message }, 400);
        targetPath = "/res/pan/add";
        method = "POST";
        formBody = toForm({
          title: body.title ?? "",
          panurl: body.panurl ?? "",
          panpw: body.panpw ?? "",
          is: normalizeIs(body.is),
          binds: binds.binds,
        });
        break;
      }

      // ---- 修改分享（binds 可选：只改标题/链接时保留站点原有绑定）----
      case "edit": {
        const id = String(body.id ?? qp("id") ?? "").trim();
        if (!id) return json({ error: "缺少分享记录 id" }, 400);
        const ob = optionalBinds(body.binds);
        if (!ob.ok) return json({ error: ob.message }, 400);
        const form: Record<string, unknown> = {
          title: body.title ?? "",
          panurl: body.panurl ?? "",
          panpw: body.panpw ?? "",
          is: normalizeIs(body.is),
        };
        if (ob.binds) form.binds = ob.binds;
        targetPath = `/res/pan/edit/${encodeURIComponent(id)}`;
        method = "POST";
        formBody = toForm(form);
        break;
      }

      // ---- 删除分享（空 body）----
      case "del": {
        const id = String(body.id ?? qp("id") ?? "").trim();
        if (!id) return json({ error: "缺少分享记录 id" }, 400);
        targetPath = `/res/pan/del/${encodeURIComponent(id)}`;
        method = "POST";
        formBody = ""; // 站点要求空 body
        break;
      }

      // ---- 点赞 / 取消赞 ----
      case "heartAdd":
      case "heartDel": {
        const name = String(body.name ?? body.panurl ?? "").trim();
        if (!name) return json({ error: "缺少网盘链接（name）" }, 400);
        targetPath = action === "heartAdd" ? "/res/pan/heart/add" : "/res/pan/heart/del";
        method = "POST";
        formBody = toForm({ name });
        break;
      }

      // ---- 下载 / 解析链接 ----
      case "downurl": {
        const d = requireDirId();
        if (d instanceof Response) return d;
        targetPath = `/res/downurl/${d.dir}/${encodeURIComponent(d.id)}`;
        break;
      }

      // ---- 收藏 ----
      case "favoriteAdd":
      case "favoriteDel": {
        const d = requireDirId();
        if (d instanceof Response) return d;
        targetPath =
          (action === "favoriteAdd"
            ? `/res/favorite/add/${d.dir}/${encodeURIComponent(d.id)}`
            : `/res/favorite/del/${d.dir}/${encodeURIComponent(d.id)}`);
        break;
      }

      // ---- 观看历史 ----
      case "histories":
        targetPath = "/res/historys";
        break;
      case "historiesDelOne":
      case "historiesClear": {
        // 文档未给出请求体字段，原样透传调用方提供的字段
        targetPath =
          action === "historiesDelOne" ? "/res/historys/delone" : "/res/historys/delete";
        method = "POST";
        formBody = toForm(body);
        break;
      }

      default:
        return json({ error: `不支持的 action: ${action}` }, 400);
    }

    if (!targetPath) {
      return json({ error: `不支持的 action: ${action}` }, 400);
    }

    // ---------- 6. 转发 ----------
    const res = await proxy(method, targetPath, cookie, formBody);

    // 404 与登录态无关，单独返回，避免被误判成「Cookie 失效」
    if (res.status === 404) {
      const raw = await res.text().catch(() => "");
      return json(
        {
          success: false,
          code: "NOT_FOUND",
          message: "站点未找到该记录（HTTP 404），可能已被删除",
          raw: raw.slice(0, 300),
        },
        404
      );
    }

    // ---------- 7. 响应状态判定 ----------
    const ins = await inspect(res, expectData);

    if (ins.kind === "pow") {
      await supabase
        .from("xn_sessions")
        .update({ status: "expired", last_check_at: now })
        .eq("user_id", user.id);
      return json(
        {
          success: false,
          code: "POW_REQUIRED",
          message:
            "站点触发了浏览器安全验证（Pow）。请在浏览器打开该站点完成验证后，重新复制并绑定 Cookie。",
        },
        409
      );
    }

    if (ins.kind === "unexpected") {
      // 站点返回了非 JSON 的异常页面（例如不支持的请求组合），
      // 此时不标记会话失效，避免把仍有效的 Cookie 误报成过期、逼用户重新绑定
      return json(
        {
          success: false,
          code: "SITE_UNEXPECTED",
          message: "站点返回了非预期页面，该请求可能不被站点支持",
          snippet: ins.text.slice(0, 300),
        },
        502
      );
    }

    if (ins.kind === "expired") {
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

    // ---------- 8. 载荷归一化 ----------
    let payload: unknown = null;
    try {
      payload = JSON.parse(ins.text);
    } catch {
      payload = null;
    }

    if (action === "list" && payload && typeof payload === "object" && !Array.isArray(payload)) {
      const p = payload as Record<string, unknown>;
      const pageObj = p.page;
      // 站点返回 page={pages,curr,set}，前端期望 page 为数字 → 归一化，
      // 原始对象保留在 pageInfo，避免破坏其它消费方
      if (pageObj && typeof pageObj === "object" && !Array.isArray(pageObj)) {
        const po = pageObj as Record<string, unknown>;
        p.pageInfo = po;
        p.pages = Number(po.pages ?? 0) || 0;
        p.pageSize = Number(po.set ?? 0) || 0;
        p.page = Number(po.curr ?? 1) || 1;
      }
    }

    if (action === "detail" && payload && typeof payload === "object" && !Array.isArray(payload)) {
      // 详情响应的 binds 用 hid 表示资源短码，补一份 id 便于前端直接回填
      const data = (payload as Record<string, unknown>).data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const binds = (data as Record<string, unknown>).binds;
        if (Array.isArray(binds)) {
          for (const b of binds) {
            if (b && typeof b === "object") {
              const rec = b as Record<string, unknown>;
              if (rec.id === undefined && rec.hid !== undefined) rec.id = rec.hid;
            }
          }
        }
      }
    }

    // ---------- 9. 业务错误码上浮 ----------
    // 站点以 {code,msg} 表达业务失败；直接透传会让前端把失败当成功
    //（进而写入本地绑定记录，造成数据不一致），故转成 HTTP 400 让前端抛出。
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const rec = payload as Record<string, unknown>;
      const code = Number(rec.code);
      if (Number.isFinite(code) && code !== 200) {
        const msg = String(rec.msg ?? rec.message ?? "站点操作未成功");

        // 9.1 特例：add 时站点判定「链接已存在」（siteCode 444）会拒绝写入。
        // 这条链接在站点上本来就有对应分享，理应视为成功并回查出已有分享 ID，
        // 否则前端拿不到 share_id、无法完成绑定（表现为「未能取回分享 ID」）。
        if (action === "add" && (code === 444 || msg.includes("链接已存在"))) {
          const existing = await findShareId(
            String(body.title ?? "").trim(),
            String(body.panurl ?? "").trim(),
            cookie,
          );
          if (existing) {
            return json({
              code: 200,
              msg: "链接已存在，已关联到站点已有分享",
              data: { share_id: existing, reused: true },
            });
          }
        }

        return json(
          {
            success: false,
            code: "SITE_ERROR",
            siteCode: code,
            message: msg,
            error: msg,
            data: rec.data ?? null,
          },
          400
        );
      }
    }

    // ---------- 9.5 add 成功后回查新分享 ID ----------
    // 站点 add 只返回 {code:200,msg:"发布成功"}，不含新记录 ID，
    // 而前端需要 share_id 才能落地「资源 × 分享」本地绑定 → 用 (标题, 链接) 精确回查。
    // 回查失败不影响发布结果，只是 share_id 为 null，前端会跳过绑定并提示。
    if (
      action === "add" &&
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Number((payload as Record<string, unknown>).code) === 200
    ) {
      const rec = payload as Record<string, unknown>;
      const wantTitle = String(body.title ?? "").trim();
      const wantUrl = String(body.panurl ?? "").trim();
      let shareId: string | null = null;

      if (wantTitle && wantUrl) {
        shareId = await findShareId(wantTitle, wantUrl, cookie);
      }

      const prevData =
        rec.data && typeof rec.data === "object"
          ? (rec.data as Record<string, unknown>)
          : {};
      rec.data = { ...prevData, share_id: shareId };
    }

    // ---------- 10. 成功：刷新会话状态并回传 ----------
    await supabase
      .from("xn_sessions")
      .update({ status: "active", last_check_at: now })
      .eq("user_id", user.id);

    return json(payload);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

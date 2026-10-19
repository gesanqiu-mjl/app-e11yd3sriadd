#!/usr/bin/env node
/**
 * 光鸭中继（guangya-relay）
 *
 * 为什么要它：Supabase Edge 在境外，直连 account/api.guangyapan.com 会整体超时，
 * 所以光鸭请求一直走「数据库代理 pg_net」——但 pg_net 只有一个后台 worker、
 * 且批与批之间有屏障（一批全部完成才处理下一批），全站请求挤在同一条队列里，
 * 一个慢请求会拖住整批（历史上实测排队 36.6 秒）。放到国内/香港的一台中继上，
 * 并发与超时都由我们控制，光鸭本身单请求只要 0.5~0.65 秒（实测）。
 *
 * 用法（零依赖，需要 Node 18+）：
 *   RELAY_SECRET='换成一串足够长的随机串' PORT=8787 node guangya-relay.mjs
 *
 * 接口：
 *   GET  /ping          健康检查 → {"ok":true,...}（不需要密钥）
 *   POST /proxy         转发光鸭请求（需要请求头 x-relay-secret，必须与 RELAY_SECRET 一致）
 *        body: { host:"api"|"account", path:"/nd.bizuserres.s/v1/...", body:{...},
 *                bearer?:string, clientId?:string, action?:string, timeoutMs?:number }
 *        返回: { status:<上游 HTTP 状态>, body:<上游 JSON> }
 *
 * 安全说明：
 *   · 只允许转发到光鸭的两个域名，path 必须是单个以 / 开头的路径（防 SSRF）；
 *   · 请求体里可能含 access/refresh token（换令牌时在 body 里）→ 日志只记路径与耗时，绝不记 body；
 *   · 生产上请套一层 HTTPS（Caddy 自动证书最简单），否则令牌会以明文经过公网。
 *
 * 部署（Ubuntu/Debian 示例，Caddy 自动 HTTPS）：
 *   1) 安装 Node 18+ 与 Caddy
 *   2) 把本文件放到 /opt/guangya-relay/guangya-relay.mjs
 *   3) systemd 服务（见仓库说明），Environment 里放 RELAY_SECRET 与 PORT
 *   4) Caddyfile:  <域名或 sslip.io 域名> { reverse_proxy 127.0.0.1:8787 }
 *   5) 在 Supabase 给函数配环境变量：
 *        GUANGYA_RELAY_URL = https://<域名>
 *        GUANGYA_RELAY_SECRET = 与上面 RELAY_SECRET 相同
 *      未配置时函数会继续走原来的数据库代理，零风险回退。
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const SECRET = process.env.RELAY_SECRET ?? "";
/**
 * 轮换期间可临时接受一把旧密钥（RELAY_SECRET_OLD），这样换密钥时不会出现
 * 「Supabase 已用新密钥、中继还只认旧密钥」的 401 窗口；换完删掉这个环境变量即可。
 */
const SECRET_OLD = (process.env.RELAY_SECRET_OLD ?? "").trim();
const PORT = Number(process.env.PORT ?? 8787);
/** 监听地址：默认只监听本机（由 Caddy/stunnel 做 HTTPS 反代），不要直接暴露到公网 */
const BIND = process.env.BIND ?? "127.0.0.1";

/** 只允许这两个上游（与数据库代理 guangya_http_send 保持一致） */
const HOSTS = {
  account: "https://account.guangyapan.com",
  api: "https://api.guangyapan.com",
};

/** 与数据库代理完全一致的请求头：光鸭按这些头识别官方客户端，缺一个就可能 404/401 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

if (!SECRET || SECRET.length < 16) {
  console.error("[relay] 必须先设置 RELAY_SECRET（至少 16 个字符），否则拒绝启动");
  process.exit(1);
}

function matches(expected, got) {
  const a = Buffer.from(String(got ?? ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function secretOk(got) {
  if (matches(SECRET, got)) return true;
  return SECRET_OLD !== "" && matches(SECRET_OLD, got);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

/** 与 guangya_http_send 的头部规则一一对应 */
function buildHeaders({ host, clientId, bearer, action }) {
  const cid = clientId && String(clientId).trim() ? String(clientId) : "aMe-8VSlkrbQXpUR";
  const headers = {
    accept: "*/*",
    "content-type": "application/json",
    origin: "https://www.guangyapan.com",
    referer: "https://www.guangyapan.com/",
    "user-agent": UA,
    "X-Client-Id": cid,
    "X-Client-Version": "0.0.1",
    "X-Protocol-Version": "301",
    "X-Sdk-Version": "9.0.2",
  };
  // 账号域不带 Authorization（换令牌时还没令牌），业务域必须带
  if (host !== "account") headers.Authorization = `Bearer ${bearer ?? ""}`;
  if (action !== null && action !== undefined && String(action) !== "") headers["X-Action"] = String(action);
  return headers;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  // 健康检查：给监控 / 自检用，不泄露任何信息
  if (req.method === "GET" && url.pathname === "/ping") {
    return sendJson(res, 200, { ok: true, service: "guangya-relay", time: new Date().toISOString() });
  }

  if (req.method !== "POST" || url.pathname !== "/proxy") {
    return sendJson(res, 404, { error: "not found" });
  }

  if (!secretOk(req.headers["x-relay-secret"])) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  const started = Date.now();
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, 400, { error: `请求体不是合法 JSON：${e?.message ?? e}` });
  }

  const host = String(payload?.host ?? "");
  const path = String(payload?.path ?? "");
  const base = HOSTS[host];
  // 防 SSRF：只允许这两台上游 + 只允许单个以 / 开头的路径
  if (!base) return sendJson(res, 400, { error: `不支持的 host：${host}（可用 api / account）` });
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://") || path.includes("\n")) {
    return sendJson(res, 400, { error: `path 不合法：${path}` });
  }

  const timeoutMs = Math.max(1000, Math.min(Number(payload?.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const target = base + path;
  const deadline = started + timeoutMs;

  // 可重试：连接被上游 RST（日志里的 fetch failed）与 5xx/429 都是偶发，写操作也不会重复（接口由调用方保证幂等）
  const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const retryableErr = (e) =>
    e?.name === "TimeoutError" ||
    /fetch failed|timed out|aborted|socket|ECONN|EPIPE|EAI_AGAIN/i.test(e?.message ?? "");

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remain = deadline - Date.now();
    if (remain < 800) break;
    // 第一次最多 6s，给重试留预算；第二次用剩余全部预算
    const attemptTimeout = Math.max(800, Math.min(remain, attempt === 1 ? Math.min(timeoutMs, 6000) : remain));
    try {
      const upstream = await fetch(target, {
        method: "POST",
        headers: buildHeaders({
          host,
          clientId: payload?.clientId,
          bearer: payload?.bearer,
          action: payload?.action,
        }),
        body: JSON.stringify(payload?.body ?? {}),
        signal: AbortSignal.timeout(attemptTimeout),
      });

      const text = await upstream.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        // 上游偶尔返回非 JSON（网关错误页等）：包一层，调用方按 status 处理
        body = { _non_json: text.slice(0, 2000) };
      }

      if (RETRY_STATUS.has(upstream.status) && attempt === 1 && deadline - Date.now() > 1200) {
        console.warn(`[relay] ${host}${path} → ${upstream.status}，600ms 后重试一次 (${Date.now() - started}ms)`);
        await sleep(600);
        continue;
      }

      console.log(`[relay] ${host}${path} → ${upstream.status} (${Date.now() - started}ms)${attempt > 1 ? " 重试成功" : ""}`);
      return sendJson(res, 200, { status: upstream.status, body });
    } catch (e) {
      lastErr = e;
      if (attempt === 1 && retryableErr(e) && deadline - Date.now() > 1200) {
        console.warn(`[relay] ${host}${path} → ${e?.name ?? "失败"}，600ms 后重试一次 (${Date.now() - started}ms)：${e?.message ?? e}`);
        await sleep(600);
        continue;
      }
      break;
    }
  }

  const e = lastErr;
  const msg = e?.message ?? "上游多次重试仍失败";
  const timedOut = e?.name === "TimeoutError" || /timed out|aborted/i.test(String(msg));
  console.error(`[relay] ${host}${path} → ${timedOut ? "超时" : "失败"} (${Date.now() - started}ms，共 ${Math.round((Date.now() - started) / 1000)}s)：${msg}`);
  // 502 让调用方按「可重试的网络类错误」处理
  return sendJson(res, 502, { error: timedOut ? `上游超时（${timeoutMs}ms）` : msg });
});

server.listen(PORT, BIND, () => {
  console.log(`[relay] guangya-relay 已启动：http://${BIND}:${PORT}（生产环境用 HTTPS 反代对外）`);
});

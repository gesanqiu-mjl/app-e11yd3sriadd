import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * 手机浏览器（H5）友好：为 supabase 的请求加一层「瞬时网络错误自动重试」。
 *
 * 为什么需要：手机上有两类极常见的偶发失败 —— 
 *   ① 切换 App / 锁屏 / 后台唤醒时，请求被系统挂起，抛 `TypeError: Failed to fetch`（iOS Safari 报 `Load failed`）；
 *   ② 蜂窝网/Wi-Fi 切换瞬间连接中断。
 * 这些都是一过性的，重试一次基本就恢复；不重试就会让用户看到「加载失败，请刷新重试」。
 *
 * 安全边界（很重要）：
 *   · 只对「读请求」（GET / HEAD）重试 —— 天然幂等，重试无副作用；
 *   · POST / PATCH / PUT / DELETE 一律不重试 —— 避免网络抖动造成重复写入（重复插入资源、重复发帖等）；
 *   · 只在「网络层错误」与 502/503/504 网关上重试；4xx（含 401 未登录、403 无权限）不重试，直接交给上层处理。
 */
const RETRYABLE_PATTERN =
  /failed to fetch|load failed|networkerror|network error|network request failed|err_network|err_internet|err_empty_response|connection (closed|reset)|socket hang up/i;

/** 读请求最多尝试 3 次（首试 + 2 次重试），退避 400ms / 900ms（带抖动，避免同时重试打堆） */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 900];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const fromInit = init?.method;
  if (fromInit) return fromInit.toUpperCase();
  if (typeof input === "object" && "method" in input && typeof input.method === "string") {
    return input.method.toUpperCase();
  }
  return "GET";
}

function isRetryableError(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  const text = `${err?.name ?? ""} ${err?.message ?? ""}`;
  // 注意：主动取消（AbortController）不重试，避免调用方设定的超时被无限拉长
  if (err?.name === "AbortError") return false;
  return RETRYABLE_PATTERN.test(text);
}

async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = methodOf(input, init);
  const attempts = method === "GET" || method === "HEAD" ? MAX_ATTEMPTS : 1;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetch(input, init);
      // 网关瞬时错误（仅读请求）重试；4xx/5xx 业务响应原样返回给上层
      const gatewayFlaky = res.status === 502 || res.status === 503 || res.status === 504;
      if (gatewayFlaky && attempt < attempts - 1) {
        await sleep(BACKOFF_MS[attempt] + Math.random() * 200);
        continue;
      }
      return res;
    } catch (e) {
      lastError = e;
      if (!isRetryableError(e) || attempt >= attempts - 1) break;
      await sleep(BACKOFF_MS[attempt] + Math.random() * 200);
    }
  }
  throw lastError;
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: fetchWithRetry },
});

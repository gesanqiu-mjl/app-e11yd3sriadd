/**
 * 内部调用鉴权（服务端 worker / 定时任务 → 站点代理）
 *
 * 背景：所有站点代理（panlinks-proxy / xnshare-proxy / resource-manager / …）
 * 原先只认「本应用用户 JWT」（`svc.auth.getUser(token)`），而服务端任务没有用户 JWT，
 * 于是站点推送只能由浏览器发起 —— 用户关掉页面就永远不会执行。
 *
 * 这里加一条**受限**的内部通道：请求同时带
 *   x-internal-secret: <INTERNAL_SECRET>   （环境变量，仅服务端持有）
 *   x-user-id:         <目标用户 uuid>
 * 才被识别为内部调用；代理内部仍然一律按该 user_id 过滤会话/绑定，
 * 权限范围与「用户本人调用」完全一致，不会越权访问其它用户的数据。
 *
 * 未配置 INTERNAL_SECRET 时该通道整体关闭（返回 null），退化为只认用户 JWT。
 */

const INTERNAL_SECRET = Deno.env.get("INTERNAL_SECRET") ?? "";

/** 定长比较，避免按字符提前返回造成时序差异 */
function secretEquals(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 只判断「是不是合法的内部调用」（密钥是否匹配），不关心目标用户。
 * 供 worker / 定时任务这类「可能处理所有用户」的调用方使用。
 */
export function hasInternalSecret(req: Request): boolean {
  if (!INTERNAL_SECRET) return false;
  return secretEquals(req.headers.get("x-internal-secret") ?? "", INTERNAL_SECRET);
}

/**
 * 若本次请求是合法的内部调用，返回它代表的用户 id，否则返回 null。
 * 需要携带 x-user-id 指定目标用户（代理用）。只读取请求头，不做网络请求。
 */
export function internalUserId(req: Request): string | null {
  if (!hasInternalSecret(req)) return null;
  const uid = (req.headers.get("x-user-id") ?? "").trim();
  return UUID_RE.test(uid) ? uid : null;
}

/**
 * 解析调用者身份：优先内部通道，其次用户 JWT。
 * verifyJwt 由各函数传入自己惯用的校验方式（supabase.auth.getUser 或 REST /auth/v1/user）。
 */
export async function resolveCallerId(
  req: Request,
  verifyJwt: (token: string) => Promise<string | null>
): Promise<string | null> {
  const internal = internalUserId(req);
  if (internal) return internal;

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    return await verifyJwt(token);
  } catch {
    return null;
  }
}

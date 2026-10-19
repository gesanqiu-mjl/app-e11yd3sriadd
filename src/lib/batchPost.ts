/**
 * 批量发帖：上传 xlsx（剧名 / 文件名 / 链接）→ 站点片源自动匹配 → 发帖 → 本地入库 + 写绑定。
 *
 * 设计要点：
 *  - 匹配全自动：按「剧名」在站点片库搜索，标题完全一致优先，其次包含匹配，年份做二次校验；
 *  - 匹配不到的行直接跳过并在预览里给出原因，不阻断其它行；
 *  - 发帖成功后在本应用资源库插入一行（名称=文件名、链接=链接），再写入对应站点的绑定关系，
 *    之后即可在资源表格里按既有逻辑做增量同步；
 *  - 单行失败只记录原因，不中断整批，便于修正后重试。
 */

import type { XlsxSheet } from '@/lib/parseXlsx';
import { detectPanName, panNameMatchesType, PAN_TYPE_LABELS } from '@/lib/panUtils';
import { parseEpisodeCountFromName, parseHdhavenMetaFromName } from '@/lib/hdhavenMeta';
import { supabase } from '@/db/supabase';
import {
  bindResourceToFramehdr,
  bindResourceToHdhavenBySlug,
  bindResourceToJying,
  bindResourceToLink,
  bindResourceToMukaku,
  bindResourceToXnShare,
  bindResourceToYa,
  fetchResources,
  getMukakuMovieDetail,
  FRAMEHDR_COOKIE_EXPIRED_CODE,
  HDHAVEN_CHALLENGE_REQUIRED_CODE,
  HDHAVEN_EXPIRED_CODE,
  insertResources,
  JYING_EXPIRED_CODE,
  MUKAKU_TOKEN_EXPIRED_CODE,
  RESOURCE_QUOTA_EXCEEDED_CODE,
  searchFramehdrResources,
  searchHdhavenTmdb,
  searchJyingMovies,
  searchMukakuMovies,
  searchPinglianLibrary,
  searchXnVideos,
  searchYaVideos,
  XN_COOKIE_EXPIRED_CODE,
  YA_EXPIRED_CODE,
} from '@/services/api';

// ============================================================
// 站点定义
// ============================================================

/** 支持批量发帖的站点（123社区无「新建帖子」接口，未纳入） */
export type BatchPostSite =
  | 'pinglian'
  | 'xnsite'
  | 'ya'
  | 'framehdr'
  | 'mukaku'
  | 'jying'
  | 'hdhaven';

export const BATCH_POST_SITE_LABELS: Record<BatchPostSite, string> = {
  pinglian: '盘链站点',
  xnsite: '观影站点',
  ya: '鸭影臻藏',
  framehdr: '帧影站点',
  mukaku: '不太灵站点',
  jying: '聚影站点',
  hdhaven: '栖影站点',
};

/** 站点登录态失效错误码 → 友好提示 */
const EXPIRED_CODES: Partial<Record<BatchPostSite, { code: string; message: string }>> = {
  pinglian: { code: 'COOKIE_EXPIRED', message: '盘链登录已过期，请先在站点同步页重新登录' },
  xnsite: { code: XN_COOKIE_EXPIRED_CODE, message: '观影站点登录已过期，请重新绑定 Cookie' },
  ya: { code: YA_EXPIRED_CODE, message: '鸭影臻藏登录已过期，请重新绑定' },
  framehdr: { code: FRAMEHDR_COOKIE_EXPIRED_CODE, message: '帧影登录已过期，请重新登录' },
  mukaku: { code: MUKAKU_TOKEN_EXPIRED_CODE, message: '不太灵登录已过期，请重新登录' },
  jying: { code: JYING_EXPIRED_CODE, message: '聚影登录已过期，请重新登录' },
  hdhaven: { code: HDHAVEN_EXPIRED_CODE, message: '栖影登录已过期，请重新登录' },
};

function friendlyError(site: BatchPostSite, e: unknown): string {
  const err = e as Error & { code?: string };
  if (err?.code && err.code === EXPIRED_CODES[site]?.code) {
    return EXPIRED_CODES[site]!.message;
  }
  if (err?.code === HDHAVEN_CHALLENGE_REQUIRED_CODE) {
    return '栖影触发了图形验证码校验，请先在栖影站点页手动通过一次验证';
  }
  if (err?.code === RESOURCE_QUOTA_EXCEEDED_CODE) {
    return err.message || '资源库已超出配额，无法入库';
  }
  return err?.message || '未知错误';
}

// ============================================================
// 1. 解析 xlsx → 待发帖行
// ============================================================

/** 一行待发帖数据 */
export interface BatchPostRow {
  /** 原始行号（xlsx 中的行号，1 起） */
  rowNo: number;
  /** 剧名：用于在站点片库检索 */
  drama: string;
  /** 文件名：作为帖子标题与本地资源名 */
  fileName: string;
  /** 网盘分享链接 */
  link: string;
}

export interface BatchPostParseResult {
  rows: BatchPostRow[];
  /** 解析问题（缺链接、格式错误等），仍会展示给用户 */
  errors: string[];
}

const HEADER_ALIASES = {
  drama: ['剧名', '片名', '剧集名', '剧集', '名称'],
  fileName: ['文件名', '标题', '资源名', '资源名称', '种子名'],
  link: ['链接', '网盘链接', '分享链接', '地址', '下载链接'],
};

function findHeader(rows: string[][]): { headerRow: number; cols: { drama: number; fileName: number; link: number } } | null {
  const limit = Math.min(rows.length, 5);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map((c) => (c ?? '').trim());
    const pick = (aliases: string[]) =>
      cells.findIndex((c) => c && aliases.some((a) => c === a || c.includes(a)));
    const drama = pick(HEADER_ALIASES.drama);
    const fileName = pick(HEADER_ALIASES.fileName);
    const link = pick(HEADER_ALIASES.link);
    if (link >= 0 && (drama >= 0 || fileName >= 0)) {
      return {
        headerRow: i,
        cols: {
          drama: drama >= 0 ? drama : fileName,
          fileName: fileName >= 0 ? fileName : drama,
          link,
        },
      };
    }
  }
  return null;
}

/**
 * 从工作表解析待发帖数据。
 * 识别「剧名 / 文件名 / 链接」表头（顺序不拘）；识别不到表头时按前三列兜底。
 */
export function parseBatchPostSheets(sheets: XlsxSheet[]): BatchPostParseResult {
  const sheet = sheets.find((s) => s.rows.some((r) => r.some((c) => (c ?? '').trim()))) ?? sheets[0];
  if (!sheet) return { rows: [], errors: ['表格中没有可读取的内容'] };

  const header = findHeader(sheet.rows);
  const cols = header?.cols ?? { drama: 0, fileName: 1, link: 2 };
  const startRow = header ? header.headerRow + 1 : 0;
  const errors: string[] = [];
  if (!header) {
    errors.push('未识别到表头（剧名/文件名/链接），已按前三列顺序读取，请确认列顺序是否正确');
  }

  const rows: BatchPostRow[] = [];
  for (let i = startRow; i < sheet.rows.length; i++) {
    const cells = sheet.rows[i] ?? [];
    const drama = (cells[cols.drama] ?? '').trim();
    const fileName = (cells[cols.fileName] ?? '').trim();
    const link = (cells[cols.link] ?? '').trim();
    if (!drama && !fileName && !link) continue; // 空行

    const rowNo = i + 1;
    if (!link) {
      errors.push(`第 ${rowNo} 行：缺少链接，已跳过`);
      continue;
    }
    if (!/^https?:\/\//i.test(link)) {
      errors.push(`第 ${rowNo} 行：链接格式不正确（${link.slice(0, 40)}），已跳过`);
      continue;
    }
    if (!drama && !fileName) {
      errors.push(`第 ${rowNo} 行：剧名与文件名均为空，已跳过`);
      continue;
    }
    rows.push({ rowNo, drama: drama || coreTitleOf(fileName), fileName: fileName || drama, link });
  }

  if (rows.length === 0 && errors.length === 0) errors.push('表格中没有数据行');
  return { rows, errors };
}

// ============================================================
// 2. 标题匹配
// ============================================================

/** 归一化标题：去空白与常见标点，便于比较 */
function normTitle(value: string): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[[\]【】()（）〈〉《》:：·.,，。!！?？'"“”‘’\-_+~|/\\]/g, '');
}

/** 从文件名里取核心片名（去掉「[全48集]」等后缀） */
function coreTitleOf(fileName: string): string {
  const cut = (fileName ?? '').split(/[[(（【]/)[0].trim();
  return cut || (fileName ?? '').trim();
}

/** 0=不匹配，100=完全一致，70=包含 */
function titleScore(query: string, candidate: string): number {
  const q = normTitle(query);
  const c = normTitle(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.includes(q) || q.includes(c)) return 70;
  return 0;
}

function yearOf(text: string): string {
  const m = (text ?? '').match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}

/** 从候选中挑最佳匹配：标题分优先，同年份优先 */
function pickBest<T>(
  list: T[],
  titleOf: (item: T) => string,
  query: string,
  year: string,
  yearAt: (item: T) => string | number | null | undefined
): T | null {
  let best: { item: T; score: number; yearHit: boolean } | null = null;
  for (const item of list) {
    const score = titleScore(query, titleOf(item));
    if (score < 70) continue;
    const candidateYear = String(yearAt(item) ?? '');
    const yearHit = !!year && candidateYear.includes(year);
    if (
      !best ||
      score > best.score ||
      (score === best.score && yearHit && !best.yearHit)
    ) {
      best = { item, score, yearHit };
    }
  }
  return best?.item ?? null;
}

/** 站点侧匹配到的目标片源 */
export type BatchPostTarget =
  | { site: 'pinglian'; videoId: number; title: string; cover: string | null; year: string }
  | { site: 'xnsite'; dir: string; id: string; title: string; cover: string | null; year: string }
  | { site: 'ya'; videoTitle: string; category: string; videoId?: number; title: string; cover: string | null; year: string }
  | { site: 'framehdr'; resourceId: number; title: string; cover: string | null; year: string }
  | { site: 'mukaku'; moviesId: number; title: string; cover: string | null; year: string }
  | { site: 'jying'; movieId: number; title: string; cover: string | null; year: string }
  | { site: 'hdhaven'; tmdbId: string; mediaType: string; title: string; cover: string | null; year: string };

/** 预览/执行计划中的一行 */
export interface BatchPostPlanItem {
  row: BatchPostRow;
  status: 'ready' | 'skipped';
  /** skipped 时的原因 */
  reason?: string;
  /** ready 时匹配到的站点片源 */
  target?: BatchPostTarget;
}

/** 在站点片库搜索并匹配片源（剧名优先，其次文件名核心标题） */
async function matchTarget(site: BatchPostSite, row: BatchPostRow): Promise<BatchPostTarget | null> {
  const queries = [...new Set([row.drama, coreTitleOf(row.fileName)].filter(Boolean))];
  const year = yearOf(row.fileName) || yearOf(row.drama);

  for (const query of queries) {
    switch (site) {
      case 'pinglian': {
        const list = await searchPinglianLibrary(query);
        const hit = pickBest(list, (it) => it.video_title || it.title, query, year, (it) => it.video_year);
        if (hit?.video_id) {
          return {
            site, videoId: Number(hit.video_id), title: hit.video_title || hit.title,
            cover: hit.video_cover || null, year: String(hit.video_year ?? ''),
          };
        }
        break;
      }
      case 'xnsite': {
        const list = await searchXnVideos(query);
        const hit = pickBest(list, (it) => it.title, query, year, (it) => it.year);
        if (hit?.id && hit.dir) {
          return {
            site, dir: hit.dir, id: String(hit.id), title: hit.title,
            cover: hit.cover ?? null, year: String(hit.year ?? ''),
          };
        }
        break;
      }
      case 'ya': {
        const list = await searchYaVideos(query, { includeNoLink: true });
        const hit = pickBest(list, (it) => it.video_title || it.name || '', query, year, () => '');
        if (hit?.video_title) {
          return {
            site, videoTitle: hit.video_title, category: hit.video_category || '电视剧',
            videoId: hit.video_id, title: hit.video_title,
            cover: hit.video_cover ?? null, year: '',
          };
        }
        break;
      }
      case 'framehdr': {
        const list = await searchFramehdrResources(query);
        const hit = pickBest(list, (it) => it.title, query, year, (it) => it.year);
        if (hit?.id) {
          return { site, resourceId: hit.id, title: hit.title, cover: hit.cover ?? null, year: String(hit.year ?? '') };
        }
        break;
      }
      case 'mukaku': {
        const list = await searchMukakuMovies(query);
        const hit = pickBest(list, (it) => it.title, query, year, (it) => it.year);
        if (hit) {
          const moviesId = hit.id ?? (hit.doub_id ? (await getMukakuMovieDetail(hit.doub_id)).movies_id : 0);
          if (moviesId) {
            return { site, moviesId, title: hit.title, cover: hit.pic || null, year: String(hit.year ?? '') };
          }
        }
        break;
      }
      case 'jying': {
        const list = await searchJyingMovies(query);
        const hit = pickBest(list, (it) => it.title, query, year, (it) => it.release_year);
        if (hit?.id) {
          return { site, movieId: hit.id, title: hit.title, cover: hit.cover || null, year: String(hit.release_year ?? '') };
        }
        break;
      }
      case 'hdhaven': {
        const list = await searchHdhavenTmdb(query);
        const hit = pickBest(list, (it) => it.title || it.name || '', query, year, (it) =>
          (it.release_date || it.first_air_date || '').slice(0, 4)
        );
        if (hit?.id) {
          const mediaType = hit.media_type || (hit.first_air_date ? 'tv' : 'movie');
          return {
            site, tmdbId: String(hit.id), mediaType, title: hit.title || hit.name || '',
            cover: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null,
            year: (hit.release_date || hit.first_air_date || '').slice(0, 4),
          };
        }
        break;
      }
    }
  }
  return null;
}

/**
 * 生成发帖计划：逐行在站点片库匹配片源。
 * 匹配失败的行标记 skipped 并给出原因，其余标记 ready。
 */
export async function planBatchPost(
  site: BatchPostSite,
  rows: BatchPostRow[],
  options?: {
    concurrency?: number;
    onProgress?: (done: number, total: number, item: BatchPostPlanItem) => void;
    shouldStop?: () => boolean;
  }
): Promise<BatchPostPlanItem[]> {
  const total = rows.length;
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? 2, 4));
  const items: BatchPostPlanItem[] = new Array(total);
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    while (cursor < total) {
      const index = cursor++;
      const row = rows[index];
      if (options?.shouldStop?.()) return;
      let item: BatchPostPlanItem;
      try {
        const target = await matchTarget(site, row);
        item = target
          ? { row, status: 'ready', target }
          : { row, status: 'skipped', reason: `站点片库未匹配到「${row.drama}」` };
      } catch (e) {
        item = { row, status: 'skipped', reason: friendlyError(site, e) };
      }
      items[index] = item;
      done += 1;
      options?.onProgress?.(done, total, item);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return items.filter(Boolean);
}

// ============================================================
// 3. 发帖 + 入库 + 写绑定
// ============================================================

export interface BatchPostResult {
  rowNo: number;
  drama: string;
  fileName: string;
  ok: boolean;
  /** 站点侧是否已发布成功（入库失败时为 true） */
  posted: boolean;
  /** 失败原因 / 补充说明 */
  message?: string;
  /** 新入库的资源 ID */
  resourceId?: string;
}

/** 把链接映射为站点侧网盘类型代码（如 guangya / quark） */
export function panTypeCodeOf(url: string): string {
  const label = detectPanName(url);
  if (!label) return 'others';
  for (const code of Object.keys(PAN_TYPE_LABELS)) {
    if (code === 'others') continue;
    if (label === PAN_TYPE_LABELS[code] || panNameMatchesType(label, code)) return code;
  }
  return 'others';
}

/**
 * 发帖是否把网盘原链换成短链 —— **由调用方自定义选择**：
 *   · 界面：「批量发帖」弹窗里的开关会传下来；
 *   · 脚本 / 第三方：直接调 batch-post 时传 `useShortLink: true / false` 即可；
 *   · 不传：用服务端默认（管理员开、其它账号关）。
 * 实际替换在服务端完成（一份逻辑，界面与脚本行为一致；失败自动回退原链）。
 */
let useShortLinkForPost: boolean | undefined;

/**
 * 调用批量发帖专用边缘函数 batch-post（服务端会再次校验权限与账号状态）。
 * 该函数按站点转发给对应代理，故响应结构与被替换掉的原 api 函数一致。
 */
async function batchCreate(
  site: BatchPostSite,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('登录态已失效，请重新登录');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
  try {
    // 短链开关随请求上送（不传 = 服务端默认：管理员开、其它账号关）；替换由服务端统一完成
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/batch-post`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ site, payload, useShortLink: useShortLinkForPost }),
      signal: controller.signal,
    });

    if (res.status === 404) {
      throw new Error('批量发帖服务尚未部署（请先执行 supabase functions deploy batch-post）');
    }
    const data = (await res.json().catch(() => null)) as
      | (Record<string, unknown> & { success?: boolean; message?: string; code?: string })
      | null;
    if (!res.ok || data?.success === false) {
      const err = new Error(data?.message || `批量发帖失败（HTTP ${res.status}）`) as Error & { code?: string };
      if (data?.code) err.code = data.code;
      throw err;
    }
    return data as Record<string, unknown>;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new Error('站点响应超时，请稍后重试');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 站点发帖 + 写绑定（返回新资源 ID） */
async function postOne(site: BatchPostSite, item: BatchPostPlanItem, sortOrder: number): Promise<BatchPostResult> {
  const { row, target } = item;
  if (!target) {
    return { rowNo: row.rowNo, drama: row.drama, fileName: row.fileName, ok: false, posted: false, message: '缺少站点匹配结果' };
  }

  const title = row.fileName || row.drama;
  const panName = detectPanName(row.link);
  const panCode = panTypeCodeOf(row.link);

  // ① 站点发帖：统一走 batch-post（服务端校验批量发帖权限，前端无法绕过）
  // 返回 Promise<unknown>：各站点绑定函数返回值不同（部分返回 link_id）
  let bindTask: (resourceId: string) => Promise<unknown>;
  const cover: string | null = target.cover;

  try {
    switch (target.site) {
      case 'pinglian': {
        const data = await batchCreate('pinglian', {
          link_title: title,
          link_url: row.link,
          link_password: '',
          pan_type: panName || 'others',
          vod_id: target.videoId,
          note: '',
        }, 20000);
        const linkId = Number((data.data as { id?: number | string } | undefined)?.id);
        if (!Number.isFinite(linkId) || linkId <= 0) throw new Error('站点未返回链接记录 ID');
        bindTask = (resourceId) =>
          bindResourceToLink(resourceId, {
            id: linkId,
            title,
            video_title: target.title,
            pan_type: panCode,
            password: null,
          });
        break;
      }
      case 'xnsite': {
        const data = await batchCreate('xnsite', {
          title,
          panurl: row.link,
          panpw: '',
          is: 1,
          binds: [{ dir: target.dir, id: target.id }],
        }, 20000);
        const shareIdRaw = (data.data as { share_id?: string | number | null } | undefined)?.share_id;
        if (!shareIdRaw) throw new Error('站点未返回分享 ID');
        const shareId = String(shareIdRaw);
        bindTask = (resourceId) => bindResourceToXnShare(resourceId, { id: shareId, title, url: row.link });
        break;
      }
      case 'ya': {
        const data = await batchCreate('ya', {
          title: target.videoTitle,
          category: target.category,
          name: title,
          url: row.link,
        }, 20000);
        // resource-manager 统一包裹 { success, data }，取内层
        const yaRes = (data.data ?? data) as { link_id?: number; video_id?: number; drive_type?: string };
        if (!yaRes?.link_id) throw new Error('站点未返回发布记录 ID');
        const yaLinkId = yaRes.link_id;
        bindTask = (resourceId) =>
          bindResourceToYa(resourceId, {
            id: yaLinkId,
            name: title,
            url: row.link,
            extract_code: null,
            drive_type: yaRes.drive_type ?? null,
            drive_label: panName || null,
            video_title: target.videoTitle,
            video_id: yaRes.video_id ?? target.videoId,
            video_category: target.category,
            video_cover: target.cover,
          });
        break;
      }
      case 'framehdr': {
        const data = await batchCreate('framehdr', {
          resource_id: target.resourceId,
          url: row.link,
          ...(panName ? { name: panName } : {}),
          description: title,
        }, 20000);
        const linkId = data.link_id as number | null | undefined;
        if (!linkId) throw new Error((data.message as string) || '站点未返回发布记录 ID');
        bindTask = (resourceId) =>
          bindResourceToFramehdr(resourceId, {
            id: linkId,
            title: target.title,
            detail_url: null,
            drive_name: panName || null,
            url: row.link,
            extract_code: null,
            created_at: null,
          });
        break;
      }
      case 'mukaku': {
        const data = await batchCreate('mukaku', {
          movies_id: target.moviesId,
          seed_name: title,
          link: row.link,
        }, 20000);
        const createdId = (data.created_id ??
          (data.data as { id?: number } | undefined)?.id) as number | null | undefined;
        if (!createdId) throw new Error('站点未返回发布记录 ID');
        const sitePanType = data.pan_type as string | undefined;
        bindTask = (resourceId) =>
          bindResourceToMukaku(resourceId, {
            id: createdId,
            movies_id: target.moviesId,
            seed_name: title,
            vod_name: target.title,
            pan_type: sitePanType ?? panCode,
            code: null,
          });
        break;
      }
      case 'jying': {
        const data = await batchCreate('jying', {
          movie_id: target.movieId,
          share_link: row.link,
          description: title,
        }, 45000);
        const raw = ((data.data as {
          resource?: { id?: number; movie_id?: number; movie_title?: string; type?: string };
        } | undefined)?.resource) ?? {};
        const id = Number(raw.id ?? 0);
        if (!id) throw new Error('站点未返回发布记录 ID');
        bindTask = (resourceId) =>
          bindResourceToJying(resourceId, {
            id,
            movie_id: Number(raw.movie_id ?? target.movieId),
            title,
            vod_name: raw.movie_title ?? target.title,
            share_link: row.link,
            pan_label: raw.type ?? (panName || null),
          });
        break;
      }
      case 'hdhaven': {
        const meta = parseHdhavenMetaFromName(title, {
          isTv: target.mediaType === 'tv',
          episodeCount: parseEpisodeCountFromName(title),
        });
        const data = await batchCreate('hdhaven', {
          tmdb_id: target.tmdbId,
          media_type: target.mediaType,
          url: row.link,
          title,
          // 未命中的解析结果会被 JSON.stringify 丢弃
          video_resolution: meta.video_resolution,
          source: meta.source,
          subtitle_language: meta.subtitle_language,
          subtitle_type: meta.subtitle_type,
          episode_range: meta.episode_range,
        }, 120000);
        const res = (data.data ?? {}) as { slug?: string; title?: string; pan_type?: string };
        if (!res.slug) throw new Error('站点未返回分享 slug');
        const slug = res.slug;
        bindTask = (resourceId) =>
          bindResourceToHdhavenBySlug({
            resourceId,
            slug,
            linkTitle: title,
            vodName: res.title || target.title,
            panType: res.pan_type || panCode,
            mediaType: target.mediaType,
          });
        break;
      }
    }
  } catch (e) {
    return {
      rowNo: row.rowNo,
      drama: row.drama,
      fileName: row.fileName,
      ok: false,
      posted: false,
      message: friendlyError(site, e),
    };
  }

  // ② 本地入库（站点已发布成功，入库失败时保留 posted 标记，便于用户判断）
  let resourceId = '';
  try {
    const created = await insertResources([
      {
        name: title,
        episode_count: parseEpisodeCountFromName(title) ?? 0,
        link: row.link,
        links: [{ url: row.link, pan_name: panName || '其他' }],
        sort_order: sortOrder,
        cover_url: cover,
        // 批量发帖入库的资源统一归入「已完结」
        is_finished: true,
      },
    ]);
    resourceId = created[0]?.id ?? '';
    if (!resourceId) throw new Error('资源库未返回资源 ID');
  } catch (e) {
    return {
      rowNo: row.rowNo,
      drama: row.drama,
      fileName: row.fileName,
      ok: false,
      posted: true,
      message: `帖子已发布，但入库失败：${friendlyError(site, e)}`,
    };
  }

  // ③ 写绑定
  try {
    await bindTask(resourceId);
  } catch (e) {
    return {
      rowNo: row.rowNo,
      drama: row.drama,
      fileName: row.fileName,
      ok: false,
      posted: true,
      resourceId,
      message: `已发帖并入库，但绑定记录写入失败：${friendlyError(site, e)}`,
    };
  }

  return { rowNo: row.rowNo, drama: row.drama, fileName: row.fileName, ok: true, posted: true, resourceId };
}

/**
 * 按计划批量发帖。
 * sortOrder 从现有资源的最大排序值往后递增，保证新资源追加在列表末尾。
 */
export async function publishBatchPost(
  site: BatchPostSite,
  items: BatchPostPlanItem[],
  options?: {
    concurrency?: number;
    onProgress?: (done: number, total: number, result: BatchPostResult) => void;
    shouldStop?: () => boolean;
    /** 发帖时是否使用短链（true = 正文里换成短链；false / 不传 = 按账号默认） */
    useShortLink?: boolean;
  }
): Promise<{ results: BatchPostResult[]; posted: number; failed: number }> {
  // 本次发帖的短链选择（供内部的 batchCreate 统一读取，避免逐处传参）
  useShortLinkForPost = options?.useShortLink;
  const targets = items.filter((it) => it.status === 'ready');
  const total = targets.length;
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? 2, 4));

  let baseSortOrder = 0;
  try {
    const existing = await fetchResources();
    baseSortOrder = existing.reduce((max, r) => Math.max(max, r.sort_order ?? 0), 0);
  } catch {
    /* 取不到时从 0 开始编号 */
  }

  const results: BatchPostResult[] = new Array(total);
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    while (cursor < total) {
      const index = cursor++;
      if (options?.shouldStop?.()) return;
      const item = targets[index];
      const result = await postOne(site, item, baseSortOrder + (index + 1) * 10);
      results[index] = result;
      done += 1;
      options?.onProgress?.(done, total, result);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const list = results.filter(Boolean);
  return { results: list, posted: list.filter((r) => r.ok).length, failed: list.filter((r) => !r.ok).length };
}

// ============================================================
// 4. 批量发帖权限（管理员在后台授予，到期即锁定）
// ============================================================

/** 权限字段所在的用户资料（只取判断所需字段，便于单测） */
export interface BatchPostPermissionProfile {
  role?: string | null;
  batch_post_expires_at?: string | null;
}

/**
 * 是否拥有批量发帖权限。
 * 管理员默认可用；普通用户必须由管理员开通且未到期（无到期时间 = 未开通）。
 */
export function isBatchPostAllowed(profile: BatchPostPermissionProfile | null | undefined): boolean {
  if (!profile) return false;
  if (profile.role === 'admin') return true;
  if (!profile.batch_post_expires_at) return false;
  return new Date(profile.batch_post_expires_at).getTime() > Date.now();
}

/** 权限剩余天数（不足 1 天按 1 天计；未开通或已过期返回 0，管理员与无限期返回 null） */
export function batchPostRemainingDays(
  profile: BatchPostPermissionProfile | null | undefined
): number | null {
  const iso = profile?.batch_post_expires_at;
  if (!iso) return profile?.role === 'admin' ? null : 0;
  const remain = new Date(iso).getTime() - Date.now();
  return remain > 0 ? Math.ceil(remain / (24 * 60 * 60 * 1000)) : 0;
}
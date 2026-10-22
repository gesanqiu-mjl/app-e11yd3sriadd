/**
 * 云盘链接识别工具
 * 根据 URL 自动识别对应的云盘名称，支持优先级排序
 */

export interface PanLink {
  url: string;
  pan_name: string;
}

interface PanRule {
  name: string;
  patterns: RegExp[];
}

const PAN_RULES: PanRule[] = [
  { name: '迅雷云盘',  patterns: [/pan\.xunlei\.com/i] },
  { name: '百度云盘',  patterns: [/pan\.baidu\.com/i, /yun\.baidu\.com/i] },
  { name: '夸克云盘',  patterns: [/pan\.quark\.cn/i] },
  { name: '123云盘',   patterns: [/123pan\.cn/i, /123pan\.com/i] },
  { name: 'UC云盘',    patterns: [/drive\.uc\.cn/i] },
  { name: '阿里云盘',  patterns: [/alipan\.com/i, /aliyundrive\.com/i] },
  { name: '光鸭云盘',  patterns: [/guangyapan\.com/i, /guangya\.com/i] },
  { name: '天翼云盘',  patterns: [/cloud\.189\.cn/i] },
  { name: '移动云盘',  patterns: [/yun\.139\.com/i] },
];

/** 优先级：数字越小越靠前；光鸭 > 夸克 > 迅雷 > 其余 */
const PAN_PRIORITY: Record<string, number> = {
  '光鸭云盘': 1,
  '夸克云盘': 2,
  '迅雷云盘': 3,
};

/** 根据 URL 自动识别云盘名称，识别不到时返回空字符串 */
export function detectPanName(url: string): string {
  if (!url) return '';
  for (const rule of PAN_RULES) {
    if (rule.patterns.some((p) => p.test(url))) return rule.name;
  }
  return '';
}

/**
 * 从分享链接自带的查询参数里取提取码。
 * 百度 / 夸克「复制链接」都会把提取码带在链接上，例如：
 *   https://pan.baidu.com/s/1YnB-L5PmqdBcq9PjR9Z-Tw?pwd=8888
 * 这种链接不带提取码是打不开的，所以粘贴链接时应当自动填进「提取码」输入框。
 */
export function extractPasscodeFromUrl(url: string): string {
  if (!url) return '';
  const m = /[?&#](?:pwd|password|passcode|code)=([A-Za-z0-9]{1,16})/i.exec(url);
  return m ? m[1] : '';
}

/** 按优先级排序 PanLink 数组（不改变原数组） */
export function sortLinksByPriority(links: PanLink[]): PanLink[] {
  return [...links].sort((a, b) => {
    const pa = PAN_PRIORITY[a.pan_name] ?? 999;
    const pb = PAN_PRIORITY[b.pan_name] ?? 999;
    return pa - pb;
  });
}

// ─── 站点 pan_type 与资源链接 pan_name 的匹配 ─────────────────

export const PAN_TYPE_LABELS: Record<string, string> = {
  quark: '夸克', aliyun: '阿里云盘', baidu: '百度网盘', '123': '123 网盘',
  mobile: '移动云盘', tianyi: '天翼云盘', '115': '115 网盘', uc: 'UC 网盘',
  xunlei: '迅雷云盘', weiyun: '微云', lanzou: '蓝奏云', jianguoyun: '坚果云',
  pikpak: 'PikPak', guangya: '光雅', ed2k: 'ED2K', others: '其他',
};

const PAN_TYPE_ALIASES: Record<string, string[]> = {
  quark: ['夸克'], aliyun: ['阿里'], baidu: ['百度'], '123': ['123'],
  mobile: ['移动'], tianyi: ['天翼'], '115': ['115'], uc: ['uc'],
  xunlei: ['迅雷'], weiyun: ['微云', '腾讯'], lanzou: ['蓝奏'],
  jianguoyun: ['坚果'], pikpak: ['pikpak'], guangya: ['光雅', '光鸭'],
  ed2k: ['ed2k', '电驴'], others: [],
};

function normPanText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/(云盘|网盘|盘)$/, '');
}

/** 判断资源链接的网盘名（如「夸克云盘」）是否与站点 pan_type（如 quark）匹配 */
export function panNameMatchesType(panName: string, panType: string): boolean {
  const name = normPanText(panName ?? '');
  if (!name) return false;
  const aliases = [panType, ...(PAN_TYPE_ALIASES[panType] ?? [])]
    .map(normPanText)
    .filter(Boolean);
  return aliases.some((a) => name.includes(a) || a.includes(name));
}

/** 为某网盘类型在资源多链接中找到对应 URL：
 *  单链接直接返回；多链接按网盘类型匹配，无匹配返回 null（由调用方决定跳过或降级） */
export function matchLinkForPanType(
  panType: string | null | undefined,
  links: PanLink[],
  fallbackUrl: string
): string | null {
  const valid = links.filter((l) => l.url?.trim());
  const all = valid.length > 0
    ? valid
    : fallbackUrl.trim() ? [{ url: fallbackUrl.trim(), pan_name: '' }] : [];
  if (all.length === 0) return null;
  if (all.length === 1) return all[0].url;
  if (panType) {
    const matched = all.find((l) => panNameMatchesType(l.pan_name, panType));
    if (matched) return matched.url;
    // panType 有值但无匹配：直接返回 null，不再盲目 fallback 到夸克，
    // 防止把错误类型的链接 URL 写入其他网盘的绑定记录（数据污染）
    return null;
  }
  // panType 为空时的兜底策略：优先夸克，再回退主链接，避免直接判失败
  const quark = all.find((l) => panNameMatchesType(l.pan_name, 'quark'));
  if (quark) return quark.url;
  return fallbackUrl.trim() || all[0].url;
}

/** 从文本中提取所有 URL，自动识别云盘名称 */
export function extractPanLinks(text: string): PanLink[] {
  const urlRegex = /https?:\/\/[^\s\u3000，。、；；""''「」【】（）]+/g;
  const matches = text.match(urlRegex) ?? [];
  return matches.map((url) => ({
    url: url.trim().replace(/[，。、\s]+$/, ''),
    pan_name: detectPanName(url),
  }));
}

/**
 * 统一获取资源链接列表（含优先级排序）。
 * 优先使用 links 数组；回退时从 fallbackLink 中重新提取（兼容旧数据中含多个 URL 的拼接字符串）。
 */
export function resolveLinks(links: PanLink[] | undefined | null, fallbackLink: string): PanLink[] {
  if (Array.isArray(links) && links.length > 0) {
    // 补全缺失的 pan_name
    const normalized = links.map((l) => ({
      url: l.url,
      pan_name: l.pan_name || detectPanName(l.url),
    }));
    return sortLinksByPriority(normalized);
  }
  if (fallbackLink?.trim()) {
    // 旧 link 字段可能包含多个拼接 URL，尝试重新提取
    const extracted = extractPanLinks(fallbackLink);
    const result = extracted.length > 0
      ? extracted
      : [{ url: fallbackLink.trim(), pan_name: detectPanName(fallbackLink) }];
    return sortLinksByPriority(result);
  }
  return [];
}

/**
 * 将 PanLink 数组格式化为文本行（用于复制），已按优先级排序。
 * 格式：光鸭云盘链接：URL
 */
export function formatPanLinks(links: PanLink[]): string {
  return sortLinksByPriority(links)
    .filter((l) => l.url.trim())
    .map((l) => {
      const label = l.pan_name ? `${l.pan_name}链接` : '链接';
      return `${label}：${l.url}`;
    })
    .join('\n');
}

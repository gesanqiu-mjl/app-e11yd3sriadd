/**
 * 栖影（hdhaven.com）投稿属性解析：按「资源名称」自动匹配站点投稿表单字段。
 *
 * 站点「我来分享 / 修改投稿」表单的属性枚举（自站点前端 share-option-grid 提取，勿随意改动）：
 *   分辨率   480p / 720p / 1080p / 1440p(显示 2K) / 2160p(显示 4K) / 4320p(显示 8K)
 *   来源     蓝光原盘/ISO / 蓝光原盘/REMUX / BDRip/BluRayEncode / WEB-DL/WEBRip / HDTV/HDTVRip
 *   版本标签 SDR / HDR / DV —— 与「来源」同存于 source 数组，站点不列为勾选项，
 *            但会作为版本标签展示（如截图里的 SDR），因此这里一并写入 source
 *   字幕语言 生肉 / 简中 / 繁中 / 简日双语 / 繁日双语 / 简英双语
 *   字幕种类 外挂 / 内封 / 内嵌
 *   集数范围 文本，如「第1-21集」（仅剧集，站点要求 media_type=tv）
 *
 * 资源大小 / 文件清单不在这里解析：由服务端 inspect-link 读取网盘时得到，更准确。
 */

export interface HdhavenShareMeta {
  /** 分辨率（站点 value，如 2160p） */
  video_resolution: string[];
  /** 来源 + 版本标签（SDR/HDR/DV） */
  source: string[];
  /** 字幕语言 */
  subtitle_language: string[];
  /** 字幕种类 */
  subtitle_type: string[];
  /** 集数范围（仅剧集返回），如「第1-30集」 */
  episode_range?: string;
}

const RESOLUTION_RULES: Array<{ re: RegExp; value: string }> = [
  { re: /(?:^|[^0-9])(?:4320p|8k)(?![0-9])/i, value: '4320p' },
  { re: /(?:^|[^0-9])(?:2160p|4k)(?![0-9])/i, value: '2160p' },
  { re: /(?:^|[^0-9])(?:1440p|2k)(?![0-9])/i, value: '1440p' },
  { re: /(?:^|[^0-9])1080p(?![0-9])/i, value: '1080p' },
  { re: /(?:^|[^0-9])720p(?![0-9])/i, value: '720p' },
  { re: /(?:^|[^0-9])480p(?![0-9])/i, value: '480p' },
];

const SOURCE_RULES: Array<{ re: RegExp; value: string }> = [
  { re: /原盘\s*ISO|ISO\s*原盘|蓝光原盘\s*ISO/i, value: '蓝光原盘/ISO' },
  { re: /REMUX|原盘重制/i, value: '蓝光原盘/REMUX' },
  { re: /BDRip|BDRemux|BluRay|蓝光压制|蓝光原盘(?!\s*(?:ISO|REMUX))/i, value: 'BDRip/BluRayEncode' },
  { re: /WEB-?DL|WEBRip|WEB\b/i, value: 'WEB-DL/WEBRip' },
  { re: /HDTV/i, value: 'HDTV/HDTVRip' },
];

/** 版本标签：与来源同存于 source 数组 */
const VERSION_TAG_RULES: Array<{ re: RegExp; value: string }> = [
  { re: /杜比视界|Dolby\s*Vision|(?:^|[^A-Za-z])DV(?![A-Za-z])/i, value: 'DV' },
  { re: /HDR/i, value: 'HDR' },
  { re: /SDR/i, value: 'SDR' },
];

const SUBTITLE_LANG_RULES: Array<{ re: RegExp; value: string }> = [
  { re: /简日双语|简日/, value: '简日双语' },
  { re: /繁日双语|繁日/, value: '繁日双语' },
  { re: /简英双语|简英/, value: '简英双语' },
  { re: /生肉/, value: '生肉' },
  { re: /繁中|繁体|繁字/, value: '繁中' },
  { re: /简中|简体|中字|中文/, value: '简中' },
];

const SUBTITLE_TYPE_RULES: Array<{ re: RegExp; value: string }> = [
  { re: /内嵌|硬字幕|硬字/, value: '内嵌' },
  { re: /内封|软字幕/, value: '内封' },
  { re: /外挂/, value: '外挂' },
];

/** 从名称解析集数：全N集 / 共N集 / 更新至第N集 / 第N集 */
export function parseEpisodeCountFromName(name: string): number | null {
  const patterns = [/(?:全|共)\s*(\d{1,4})\s*集/, /更新至\s*第?\s*(\d{1,4})\s*集/, /第\s*(\d{1,4})\s*集/];
  for (const re of patterns) {
    const m = (name ?? '').match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function pick(rules: Array<{ re: RegExp; value: string }>, text: string): string[] {
  if (!text) return [];
  return [...new Set(rules.filter((r) => r.re.test(text)).map((r) => r.value))];
}

/**
 * 按资源名称解析栖影投稿属性。
 *
 * @param name         资源名称，如「师兄太稳健【2026国剧】已完结 全30集4K SDR 60帧杜比环绕声【纯净版】」
 * @param opts.isTv    是否剧集：只有剧集才提交「集数范围」（站点 media_type=tv 才会受理）
 * @param opts.episodeCount 资源行上的集数，名称里解析不到时用它兜底
 */
export function parseHdhavenMetaFromName(
  name: string,
  opts: { isTv?: boolean; episodeCount?: number | null } = {}
): HdhavenShareMeta {
  const text = (name ?? '').trim();

  // 来源在前、版本标签在后（站点内部也是把 SDR/HDR/DV 追加在 source 尾部）
  const source = pick([...SOURCE_RULES, ...VERSION_TAG_RULES], text);

  let episode_range: string | undefined;
  if (opts.isTv) {
    const count = parseEpisodeCountFromName(text) ?? (opts.episodeCount ?? 0);
    if (count > 1) episode_range = `第1-${count}集`;
    else if (count === 1) episode_range = '第1集';
  }

  return {
    video_resolution: pick(RESOLUTION_RULES, text),
    source,
    subtitle_language: pick(SUBTITLE_LANG_RULES, text),
    subtitle_type: pick(SUBTITLE_TYPE_RULES, text),
    ...(episode_range ? { episode_range } : {}),
  };
}

/**
 * 智能解析用户粘贴的资源文本，提取资源名称、集数、多云盘链接
 */
import { extractPanLinks, type PanLink } from '@/lib/panUtils';

export interface ParsedResource {
  name: string;
  episode_count: number;
  link: string;       // 第一条链接（向后兼容）
  links: PanLink[];   // 全部云盘链接（含自动识别名称）
}

export function parseResourceText(rawText: string, rawLink: string): ParsedResource {
  const text = (rawText ?? '').trim();
  const linkInput = (rawLink ?? '').trim();

  // 1. 从文本+单独链接框中提取所有 URL，自动识别云盘名称
  const combined = linkInput ? `${text}\n${linkInput}` : text;
  const links = extractPanLinks(combined);

  // 去重
  const seen = new Set<string>();
  const uniqueLinks: PanLink[] = [];
  for (const l of links) {
    if (!seen.has(l.url)) { seen.add(l.url); uniqueLinks.push(l); }
  }

  const link = uniqueLinks[0]?.url ?? '';

  // 2. 资源名称 = 原文，移除链接、「链接：」前缀
  const name = text
    .replace(/https?:\/\/[^\s\u3000，。、；；""''「」【】（）]+/g, '')
    .replace(/^([\u4e00-\u9fa5a-z0-9]+云盘)?链接[:：]?\s*/gim, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 3. 提取集数
  let episode_count = 0;
  const epPatterns = [
    /更新至\s*第?\s*(\d+)\s*集/,
    /更新到\s*第?\s*(\d+)\s*集/,
    /第\s*(\d+)\s*集/,
    /更新至\s*(\d+)\s*集/,
  ];
  for (const pattern of epPatterns) {
    const match = name.match(pattern);
    if (match) { episode_count = parseInt(match[1], 10) || 0; break; }
  }

  return { name, episode_count, link, links: uniqueLinks };
}

/**
 * 批量解析多行资源文本。
 */
export function parseMultipleResources(rawText: string): ParsedResource[] {
  const lines = (rawText ?? '').split(/\r?\n/).map((l) => l.trim());
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    current.push(line);
    const isLinkLine = /^([\u4e00-\u9fa5a-z0-9]+云盘)?链接[:：]/.test(line) || /https?:\/\/\S+/.test(line);
    if (isLinkLine) {
      blocks.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));

  return blocks
    .map((block) => parseResourceText(block, ''))
    .filter((r) => r.name.trim() !== '' || r.links.length > 0 || r.episode_count > 0);
}

import { Resource, DisplayFormat } from '@/types/index';
import { resolveLinks, formatPanLinks } from '@/lib/panUtils';

/**
 * 按云盘类型过滤 links
 * 'all' → 全部; 'guangya' → 光鸭云盘; 'quark' → 夸克云盘
 */
export function filterLinksByFormat(
  links: ReturnType<typeof resolveLinks>,
  format: DisplayFormat
) {
  if (format === 'all') return links;
  const nameMap: Record<string, string> = { guangya: '光鸭云盘', quark: '夸克云盘' };
  const target = nameMap[format];
  const filtered = links.filter((l) => l.pan_name === target);
  // 所选云盘无链接时降级显示全部
  return filtered.length > 0 ? filtered : links;
}

/**
 * 将资源格式化为可复制的文本
 * format: 'all'=全部链接; 'guangya'=仅光鸭; 'quark'=仅夸克
 */
export function formatResource(resource: Resource, format: DisplayFormat): string {
  const name = resource.name?.trim() ?? '';
  const lines: string[] = [];
  if (name) lines.push(name);

  const panLinks = resolveLinks(resource.links, resource.link ?? '');
  const filtered = filterLinksByFormat(panLinks, format);
  const linkText = formatPanLinks(filtered);
  if (linkText) lines.push(linkText);

  return lines.join('\n');
}

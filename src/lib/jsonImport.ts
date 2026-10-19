import { importResources, type ResourceExportItem } from '@/services/api';

/**
 * 解析并导入 JSON 资源包，供「首页工具栏」与「手机端标题栏」两处入口共用。
 *
 * 兼容两种形态（与旧环境导出的文件保持互通）：
 *  - 完整导出包：{ resources: [...] }
 *  - 裸数组：[...]
 *
 * 解析失败或找不到可导入内容时抛错，由调用方决定如何提示。
 */
export async function importJsonText(
  text: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ inserted: number; failed: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('JSON 解析失败，请确认文件格式');
  }

  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed as { resources?: unknown } | null)?.resources;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('文件里没有可导入的资源（未找到 resources 数组）');
  }

  const items: ResourceExportItem[] = arr.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      name: String(o.name ?? '').trim() || '未命名资源',
      episode_count: Number(o.episode_count ?? 0) || 0,
      link: String(o.link ?? ''),
      links: Array.isArray(o.links) ? (o.links as ResourceExportItem['links']) : [],
      cover_url: typeof o.cover_url === 'string' ? o.cover_url : null,
      is_finished: Boolean(o.is_finished),
      sort_order: Number(o.sort_order ?? 0) || 0,
      link_status: String(o.link_status ?? 'unknown'),
    };
  });

  const res = await importResources(items, onProgress);
  return { inserted: res.inserted, failed: res.failed };
}

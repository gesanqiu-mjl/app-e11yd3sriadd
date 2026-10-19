/**
 * 极简 XLSX 读取器（不引入第三方依赖）
 *
 * xlsx 本质是 ZIP + XML，本文件自行解析 ZIP 中央目录，用浏览器原生
 * DecompressionStream('deflate-raw') 解压 deflate 条目，再从 sharedStrings.xml
 * 与工作表 XML 中提取单元格文本（支持 sharedStrings / inlineStr / 数字 / 布尔）。
 * 与 src/lib/exportXlsx.ts（写入器）配套，保持项目「不引第三方 xlsx 库」的约定。
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** ZIP 条目（仅记录解压所需信息） */
interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** 一张工作表 */
export interface XlsxSheet {
  name: string;
  rows: string[][];
}

function readU16(buf: DataView, offset: number): number {
  return buf.getUint16(offset, true);
}

function readU32(buf: DataView, offset: number): number {
  return buf.getUint32(offset, true);
}

/** 解析 ZIP 中央目录，得到「文件名 → 条目」映射 */
function readZipEntries(buffer: ArrayBuffer): Map<string, ZipEntry> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // 从尾部向前找 EOCD（结尾可能有注释，最多 64KB）
  let eocd = -1;
  const minPos = Math.max(0, bytes.length - 22 - 65536);
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（未找到 ZIP 结尾标记）');

  const total = readU16(view, eocd + 10);
  let offset = readU32(view, eocd + 16);
  const entries = new Map<string, ZipEntry>();

  for (let i = 0; i < total; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== SIG_CENTRAL) break;
    const method = readU16(view, offset + 10);
    const compressedSize = readU32(view, offset + 20);
    const nameLen = readU16(view, offset + 28);
    const extraLen = readU16(view, offset + 30);
    const commentLen = readU16(view, offset + 32);
    const localOffset = readU32(view, offset + 42);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式的 xlsx，请用 Excel / WPS 重新另存为 .xlsx');
    }
    entries.set(name, { name, method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  if (entries.size === 0) throw new Error('xlsx 内容为空或已损坏');
  return entries;
}

/** 取出某个 ZIP 条目的原始字节 */
function readZipRaw(buffer: ArrayBuffer, entry: ZipEntry): Uint8Array {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (view.getUint32(entry.localOffset, true) !== SIG_LOCAL) {
    throw new Error(`xlsx 内部结构异常（${entry.name}）`);
  }
  const nameLen = readU16(view, entry.localOffset + 26);
  const extraLen = readU16(view, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  return bytes.subarray(start, start + entry.compressedSize);
}

/** 解压（method 0 = 存储，8 = deflate） */
async function inflateEntry(buffer: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const raw = readZipRaw(buffer, entry);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`不支持的压缩方式（${entry.method}），请另存为 .xlsx`);

  const Decompressor = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!Decompressor) {
    throw new Error('当前浏览器不支持解压 xlsx（需 Chrome 103+ / Edge），请更换浏览器或用 .json 导入');
  }
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new Decompressor('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readText(buffer: ArrayBuffer, entries: Map<string, ZipEntry>, name: string) {
  const entry = entries.get(name);
  if (!entry) return null;
  return new TextDecoder('utf-8').decode(await inflateEntry(buffer, entry));
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/** 解析 sharedStrings.xml → 字符串表 */
function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const list: string[] = [];
  for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlText(t[1]));
    list.push(texts.join(''));
  }
  return list;
}

/** A1 → 列号（0 起） */
function columnIndex(ref: string): number {
  const letters = (ref.match(/[A-Z]+/) ?? [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 解析工作表 XML → 二维字符串数组（空单元格补齐为 ''） */
function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  let maxCols = 0;
  const parsed: { rowNo: number; cells: Map<number, string> }[] = [];

  for (const rowMatch of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map<number, string>();
    for (const cellMatch of rowMatch[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[2];
      const inner = cellMatch[3] ?? '';
      const type = (attrs.match(/t="([^"]+)"/) ?? [])[1];
      let value = '';
      if (type === 's') {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? shared[Number(v[1])] ?? '' : '';
      } else if (type === 'inlineStr') {
        value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlText(t[1])).join('');
      } else {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? decodeXmlText(v[1]) : '';
      }
      const col = columnIndex(cellMatch[1]);
      cells.set(col, value.trim());
      if (col + 1 > maxCols) maxCols = col + 1;
    }
    if (cells.size === 0) continue;
    parsed.push({ rowNo: Number(rowMatch[1]), cells });
  }

  // 按行号补空行，保持与表格行序一致（表头行号通常为 1）
  let expected = 1;
  for (const item of parsed) {
    while (expected < item.rowNo) {
      rows.push([]);
      expected += 1;
    }
    rows.push(Array.from({ length: maxCols }, (_, i) => item.cells.get(i) ?? ''));
    expected += 1;
  }
  return rows;
}

/**
 * 读取 .xlsx 文件，返回全部工作表（按工作簿内顺序）。
 * 失败时抛出带可读原因的 Error。
 */
export async function readXlsx(file: File): Promise<XlsxSheet[]> {
  const buffer = await file.arrayBuffer();
  const entries = readZipEntries(buffer);
  const shared = parseSharedStrings(await readText(buffer, entries, 'xl/sharedStrings.xml'));

  // 工作簿内的工作表顺序 + 名称（缺失时退化为按文件名排序）
  const workbookXml = await readText(buffer, entries, 'xl/workbook.xml');
  const relsXml = await readText(buffer, entries, 'xl/_rels/workbook.xml.rels');
  const relTargets = new Map<string, string>();
  if (relsXml) {
    for (const m of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      relTargets.set(m[1], m[2].replace(/^\/?xl\//, '').replace(/^\//, ''));
    }
  }

  const ordered: { name: string; path: string }[] = [];
  if (workbookXml) {
    for (const m of workbookXml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
      const target = relTargets.get(m[2]);
      if (target) ordered.push({ name: decodeXmlText(m[1]), path: `xl/${target}` });
    }
  }
  if (ordered.length === 0) {
    for (const name of [...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
      ordered.push({ name: name.replace(/^xl\/worksheets\/|\.xml$/g, ''), path: name });
    }
  }

  const sheets: XlsxSheet[] = [];
  for (const sheet of ordered) {
    const xml = await readText(buffer, entries, sheet.path);
    if (!xml) continue;
    sheets.push({ name: sheet.name, rows: parseSheet(xml, shared) });
  }
  if (sheets.length === 0) throw new Error('xlsx 中没有可读取的工作表');
  return sheets;
}

import type { Resource } from '@/types/index';
import { detectPanName } from '@/lib/panUtils';
import { fetchCoverBlob } from '@/lib/clipboardUtils';

// ============================================================
// 极简 XLSX 生成器（不引入第三方依赖）
//
// xlsx 本质是一个 ZIP 包，最少需要这些部件：
//   [Content_Types].xml、_rels/.rels、xl/workbook.xml、
//   xl/_rels/workbook.xml.rels、xl/styles.xml、xl/worksheets/sheet1.xml
// 需要内嵌封面图片时再加：
//   xl/worksheets/_rels/sheet1.xml.rels、xl/drawings/drawing1.xml、
//   xl/drawings/_rels/drawing1.xml.rels、xl/media/imageN.png
// 单元格文本用 inlineStr 写入，避免共享字符串表。
// ============================================================

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const EMU_PER_PX = 9525;
/** 封面缩略图尺寸（像素），按海报比例 2:3 */
const COVER_WIDTH = 72;
const COVER_HEIGHT = 108;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 列号：0 → A、25 → Z、26 → AA */
function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// ---------- ZIP（存储方式） ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** 打包 ZIP：全部使用「存储」方式（method 0），文件名 UTF-8 */
function zip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const size = entry.data.length;
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // 本地文件头
    lv.setUint16(4, 20, true); // 解压所需版本
    lv.setUint16(6, 0x0800, true); // 文件名使用 UTF-8
    lv.setUint16(8, 0, true); // 压缩方式：存储
    lv.setUint16(10, 0, true); // 修改时间
    lv.setUint16(12, 0, true); // 修改日期
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // 压缩后大小
    lv.setUint32(22, size, true); // 原始大小
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // 扩展字段长度
    local.set(nameBytes, 30);
    parts.push(local, entry.data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // 中央目录头
    cv.setUint16(4, 20, true); // 创建版本
    cv.setUint16(6, 20, true); // 解压所需版本
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // 扩展字段
    cv.setUint16(32, 0, true); // 注释
    cv.setUint16(34, 0, true); // 起始磁盘号
    cv.setUint16(36, 0, true); // 内部属性
    cv.setUint32(38, 0, true); // 外部属性
    cv.setUint32(42, offset, true); // 本地头偏移
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + size;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // 中央目录结束记录
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...centrals, end];
  const total = all.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of all) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

// ---------- 工作表 ----------

/** 内嵌图片：锚定在 (row, col) 单元格左上角 */
export interface XlsxImage {
  /** 0 基行号（含表头，即第 2 行 = 1） */
  row: number;
  /** 0 基列号 */
  col: number;
  /** PNG 字节 */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface XlsxSheet {
  name: string;
  rows: string[][];
  /** 需要「自动换行 + 顶端对齐」的列（0 基下标） */
  wrapColumns?: number[];
  /** 各列宽度（字符数） */
  columnWidths?: number[];
  images?: XlsxImage[];
}

const STYLES_XML = `${XML_DECL}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml(sheet: XlsxSheet): string {
  const wrap = new Set(sheet.wrapColumns ?? []);
  const images = sheet.images ?? [];
  const imageRows = new Set(images.map((img) => img.row));

  const cols = sheet.columnWidths?.length
    ? `<cols>${sheet.columnWidths
        .map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`)
        .join('')}</cols>`
    : '';

  const rows = sheet.rows
    .map((cells, rowIndex) => {
      const content = cells
        .map((value, colIndex) => {
          if (value === '') return '';
          // 0 普通 / 1 表头加粗 / 2 自动换行
          const style = rowIndex === 0 ? 1 : wrap.has(colIndex) ? 2 : 0;
          const ref = `${columnName(colIndex)}${rowIndex + 1}`;
          return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join('');
      // 有封面的行需要足够行高，否则图片会被相邻行遮住
      const height = imageRows.has(rowIndex)
        ? ` ht="${Math.round(COVER_HEIGHT * 0.75) + 4}" customHeight="1"`
        : '';
      return `<row r="${rowIndex + 1}"${height}>${content}</row>`;
    })
    .join('');

  const drawing = images.length > 0 ? '<drawing r:id="rId1"/>' : '';

  return `${XML_DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${cols}<sheetData>${rows}</sheetData>${drawing}</worksheet>`;
}

function drawingXml(images: XlsxImage[]): string {
  const anchors = images
    .map((image, index) => {
      const cx = image.width * EMU_PER_PX;
      const cy = image.height * EMU_PER_PX;
      return `<xdr:oneCellAnchor><xdr:from><xdr:col>${image.col}</xdr:col><xdr:colOff>19050</xdr:colOff><xdr:row>${image.row}</xdr:row><xdr:rowOff>9525</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${index + 1}" name="Cover ${index + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${index + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
    })
    .join('');

  return `${XML_DECL}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
}

/** 生成 xlsx Blob（单工作表，可选内嵌封面） */
export function buildXlsxBlob(sheet: XlsxSheet): Blob {
  const encoder = new TextEncoder();
  const images = sheet.images ?? [];
  /** OOXML relationship 命名空间 */
  const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  const contentTypes = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    images.length > 0 ? '<Default Extension="png" ContentType="image/png"/>' : '',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    images.length > 0
      ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
      : '',
  ]
    .filter(Boolean)
    .join('');

  const files: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: encoder.encode(`${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${contentTypes}</Types>`),
    },
    {
      name: '_rels/.rels',
      data: encoder.encode(
        `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: encoder.encode(
        `${XML_DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL_NS}"><sheets><sheet name="${escapeXml(sheet.name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: encoder.encode(
        `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`
      ),
    },
    { name: 'xl/styles.xml', data: encoder.encode(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheetXml(sheet)) },
  ];

  if (images.length > 0) {
    files.push({
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      data: encoder.encode(
        `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`
      ),
    });
    files.push({ name: 'xl/drawings/drawing1.xml', data: encoder.encode(drawingXml(images)) });
    files.push({
      name: 'xl/drawings/_rels/drawing1.xml.rels',
      data: encoder.encode(
        `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${images
          .map((_, index) => `<Relationship Id="rId${index + 1}" Type="${REL_NS}/image" Target="../media/image${index + 1}.png"/>`)
          .join('')}</Relationships>`
      ),
    });
    images.forEach((image, index) => {
      files.push({ name: `xl/media/image${index + 1}.png`, data: image.data });
    });
  }

  const bytes = zip(files);
  return new Blob([bytes.slice().buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

// ---------- 资源列表导出 ----------

/** 表头：标题 / 封面 / 网盘链接 / 状态 */
export const RESOURCE_XLSX_HEADER = ['标题', '封面', '网盘链接', '状态'] as const;

/** 把资源的网盘链接整理成「云盘名称：链接」，多条按行换行 */
export function formatResourceLinks(resource: Resource): string {
  const links = Array.isArray(resource.links) ? resource.links : [];
  const list = links.length > 0
    ? links
    : resource.link
      ? [{ url: resource.link, pan_name: detectPanName(resource.link) }]
      : [];

  return list
    .filter((link) => (link.url ?? '').trim() !== '')
    .map((link) => {
      const url = (link.url ?? '').trim();
      const name = (link.pan_name ?? '').trim() || detectPanName(url);
      return name ? `${name}：${url}` : url;
    })
    .join('\n');
}

/** 抓取封面并转为 PNG 字节（走 cover-import 中转兜底；失败返回 null） */
async function loadCoverPng(url: string): Promise<Uint8Array | null> {
  try {
    const blob = await fetchCoverBlob(url);
    const objectUrl = URL.createObjectURL(blob);
    return await new Promise<Uint8Array>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const scale = Math.min(
          COVER_WIDTH / (img.naturalWidth || COVER_WIDTH),
          COVER_HEIGHT / (img.naturalHeight || COVER_HEIGHT),
          1
        );
        const width = Math.max(1, Math.round((img.naturalWidth || COVER_WIDTH) * scale));
        const height = Math.max(1, Math.round((img.naturalHeight || COVER_HEIGHT) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas 不可用'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((out) => {
          if (!out) {
            reject(new Error('封面转码失败'));
            return;
          }
          void out.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)));
        }, 'image/png');
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('封面加载失败'));
      };
      img.src = objectUrl;
    });
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ResourceExportOptions {
  /** 是否把封面抓成图片内嵌（默认 true；抓取失败的行回退为封面链接文本） */
  withCovers?: boolean;
  /** 封面抓取并发数（默认 4） */
  concurrency?: number;
  /** 单张封面抓取超时（毫秒，默认 10000） */
  coverTimeoutMs?: number;
  /** 导出文件名（不含扩展名），默认 resources_<日期> */
  fileName?: string;
}

export interface ResourceExportResult {
  /** 已导出的资源条数 */
  exported: number;
  /** 成功内嵌的封面张数 */
  covers: number;
}

/**
 * 导出资源清单 XLSX：标题 / 封面（内嵌图片）/ 网盘链接（带云盘名称）/ 状态。
 * 传空数组时返回 null（由调用方提示「没有可导出的资源」）。
 */
export async function downloadResourcesXlsx(
  resources: Resource[],
  options: ResourceExportOptions = {}
): Promise<ResourceExportResult | null> {
  if (resources.length === 0) return null;

  const { withCovers = true, concurrency = 4, coverTimeoutMs = 10000 } = options;
  const covers: Array<Uint8Array | null> = new Array(resources.length).fill(null);

  if (withCovers) {
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(concurrency, resources.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < resources.length) {
        const index = cursor;
        cursor += 1;
        const url = resources[index]?.cover_url?.trim();
        if (!url) continue;
        covers[index] = await withTimeout(loadCoverPng(url), coverTimeoutMs);
      }
    });
    await Promise.all(workers);
  }

  const rows: string[][] = [[...RESOURCE_XLSX_HEADER]];
  const images: XlsxImage[] = [];
  let coverCount = 0;

  resources.forEach((resource, index) => {
    const cover = covers[index];
    if (cover) {
      coverCount += 1;
      images.push({
        row: index + 1,
        col: 1,
        data: cover,
        width: COVER_WIDTH,
        height: COVER_HEIGHT,
      });
    }
    rows.push([
      resource.name ?? '',
      // 抓不到封面时回退成封面链接文本，保证信息不丢
      cover ? '' : (resource.cover_url ?? ''),
      formatResourceLinks(resource),
      resource.is_finished ? '已完结' : '更新中',
    ]);
  });

  const blob = buildXlsxBlob({
    name: '资源列表',
    rows,
    wrapColumns: [2],
    columnWidths: [46, 16, 60, 10],
    images,
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${options.fileName ?? `resources_${new Date().toISOString().slice(0, 10)}`}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { exported: resources.length, covers: coverCount };
}

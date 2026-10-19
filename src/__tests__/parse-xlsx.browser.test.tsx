import { describe, expect, it } from 'vitest';
import { buildXlsxBlob } from '../lib/exportXlsx';
import { readXlsx } from '../lib/parseXlsx';
import { parseBatchPostSheets } from '../lib/batchPost';

/**
 * 批量发帖依赖自行实现的 xlsx 读取器（ZIP 解析 + DecompressionStream + XML）。
 * 这里用项目自带的 xlsx 生成器造出表格，再读回来校验解析与「剧名/文件名/链接」列映射。
 */
describe('xlsx 读取与批量发帖表格解析', () => {
  it('能读取 xlsx 并按表头映射三列，非法链接行跳过并提示', async () => {
    const rows = [
      ['剧名', '文件名', '链接'],
      [
        '主角',
        '主角[杜比视界版本][全48集][国语配音+中文字幕].The.Lead.S01.2026',
        'https://www.guangyapan.com/s/1927578582112178190_aeZIFqDoqz15G-J_',
      ],
      [
        '原罪',
        '原罪2：无光角落[全24集][国语配音+中文字幕].Original.Sin.S02.2026.2160p.WEB-DL.H265.HDR',
        'https://www.guangyapan.com/s/1927578577825611832_aeZIFqDoqz15G-J_',
      ],
      ['', '', ''],
      ['叵测', '叵测[全16集][中文字幕].The.Silent.Rift.S01.2026', 'not-a-url'],
    ];

    const blob = buildXlsxBlob({ name: 'Sheet1', rows });
    const sheets = await readXlsx(new File([blob], '批量发帖模版.xlsx'));

    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets[0].rows[0][0]).toBe('剧名');

    const parsed = parseBatchPostSheets(sheets);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ drama: '主角', rowNo: 2 });
    expect(parsed.rows[0].fileName).toContain('全48集');
    expect(parsed.rows[0].link).toContain('guangyapan.com');
    expect(parsed.rows[1].drama).toBe('原罪');
    // 非法链接行被跳过，且给出带行号的提示
    expect(parsed.errors.join(' ')).toContain('第 5 行');
  });

  it('列顺序变化（链接在最前）也能识别表头', async () => {
    const blob = buildXlsxBlob({
      name: 'Sheet1',
      rows: [
        ['链接', '剧名', '文件名'],
        ['https://www.guangyapan.com/s/abc', '主角', '主角[全48集]'],
      ],
    });

    const parsed = parseBatchPostSheets(await readXlsx(new File([blob], 't.xlsx')));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ drama: '主角', fileName: '主角[全48集]' });
  });
});

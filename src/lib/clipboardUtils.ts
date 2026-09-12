/**
 * 剪贴板工具：封面图片 + 资源文字，各自独立写入剪贴板。
 */

import { type PanLink } from '@/lib/panUtils';

export interface CardData {
  name: string;
  links: PanLink[];
  coverUrl?: string | null;
}

/** fetch 封面 URL → base64 data URI（经 canvas 统一转 PNG） */
async function toBase64Png(url: string): Promise<string> {
  const res = await fetch(url, { mode: 'cors', cache: 'no-cache' });
  if (!res.ok) throw new Error(`图片请求失败 ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);

  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('图片加载失败')); };
    img.src = objectUrl;
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 把一条 CardData 渲染成 HTML 片段 */
async function renderHtmlBlock(card: CardData): Promise<string> {
  const nameHtml = escHtml(card.name || '未命名资源');
  const nameDiv = `<div style="font-size:16px;font-weight:bold;color:#1a1a1a;margin:0;padding:0;line-height:1.4;">${nameHtml}</div>`;

  const linksHtml = card.links
    .filter((l) => l.url.trim())
    .map((l) => {
      const label = l.pan_name ? `${l.pan_name}链接` : '链接';
      return `<div style="font-size:14px;color:#1d4ed8;margin:2px 0 0;padding:0;line-height:1.4;word-break:break-all;">${escHtml(label)}：${escHtml(l.url)}</div>`;
    })
    .join('');

  const textBlock = nameDiv + linksHtml;

  if (card.coverUrl) {
    try {
      const dataUri = await toBase64Png(card.coverUrl);
      return (
        `<div style="display:block;margin:0;padding:0;">` +
        `<img src="${dataUri}" style="display:block;height:300px;width:auto;margin:0;padding:0;" />` +
        `<div style="margin:2px 0 0;padding:0;">${textBlock}</div>` +
        `</div>`
      );
    } catch { /* 封面加载失败，降级纯文字 */ }
  }
  return `<div style="margin:0;padding:0;">${textBlock}</div>`;
}

/** 生成资源卡片图（封面 + 文字），用于移动端分享/保存 */
export async function generateCardImage(card: CardData, text: string): Promise<Blob | null> {
  try {
    const SCALE = 2; // retina
    const WIDTH = 480;
    const PAD = 20;
    const COVER_W = card.coverUrl ? 120 : 0;
    const COVER_H = 180;
    const GAP = card.coverUrl ? 16 : 0;
    const TEXT_X = PAD + COVER_W + GAP;
    const TEXT_W = WIDTH - TEXT_X - PAD;

    const lines = text.split('\n').filter(Boolean);

    // 预测量文字高度
    const measurer = document.createElement('canvas').getContext('2d')!;
    measurer.font = `bold ${16 * SCALE}px sans-serif`;
    const titleWrapped = wrapText(measurer, lines[0] || '', TEXT_W * SCALE);
    measurer.font = `${13 * SCALE}px sans-serif`;
    const linkWrapped: string[] = [];
    lines.slice(1).forEach((l) => linkWrapped.push(...wrapText(measurer, l, TEXT_W * SCALE)));

    const textH = PAD + titleWrapped.length * 22 + (linkWrapped.length ? 8 + linkWrapped.length * 18 : 0) + PAD;
    const coverH = card.coverUrl ? PAD + COVER_H + PAD : 0;
    const HEIGHT = Math.max(textH, coverH, 80);

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH * SCALE;
    canvas.height = HEIGHT * SCALE;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(SCALE, SCALE);

    // 背景
    ctx.fillStyle = '#f9fafb';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, WIDTH - 1, HEIGHT - 1);

    // 封面
    if (card.coverUrl) {
      try {
        const dataUri = await toBase64Png(card.coverUrl);
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            ctx.save();
            ctx.beginPath();
            ctx.rect(PAD, PAD, COVER_W, COVER_H);
            ctx.clip();
            const s = Math.max(COVER_W / img.width, COVER_H / img.height);
            const dw = img.width * s, dh = img.height * s;
            ctx.drawImage(img, PAD + (COVER_W - dw) / 2, PAD + (COVER_H - dh) / 2, dw, dh);
            ctx.restore();
            resolve();
          };
          img.onerror = () => resolve();
          img.src = dataUri;
        });
      } catch { /* 封面加载失败，继续绘制文字 */ }
    }

    // 标题
    let y = PAD + 18;
    ctx.fillStyle = '#111827';
    ctx.font = 'bold 16px sans-serif';
    titleWrapped.forEach((line) => { ctx.fillText(line, TEXT_X, y); y += 22; });

    // 链接行
    if (linkWrapped.length) {
      y += 8;
      ctx.fillStyle = '#1d4ed8';
      ctx.font = '13px sans-serif';
      linkWrapped.forEach((line) => { ctx.fillText(line, TEXT_X, y); y += 18; });
    }

    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null;
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (!text.trim()) return [];
  const result: string[] = [];
  let line = '';
  for (const ch of text) {
    const candidate = line + ch;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      result.push(line);
      line = ch;
    } else {
      line = candidate;
    }
  }
  if (line) result.push(line);
  return result.length ? result : [text];
}

export async function copyCardsToClipboard(
  items: CardData[],
  fallbackText: string
): Promise<{ ok: boolean; withImage: boolean }> {
  const anyCover = items.some((i) => !!i.coverUrl);

  if (anyCover && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const htmlBlobPromise: Promise<Blob> = (async () => {
        const blocks = await Promise.all(items.map(renderHtmlBlock));
        const sep = '<div style="height:12px;border-top:1px solid #e5e7eb;margin:8px 0 0;padding:0;"></div>';
        const htmlBody = blocks.length > 1 ? blocks.join(sep) : blocks[0];
        const fullHtml = `<!DOCTYPE html><html><body style="font-family:sans-serif;margin:0;padding:0;line-height:1;">${htmlBody}</body></html>`;
        return new Blob([fullHtml], { type: 'text/html' });
      })();

      const textBlob = new Blob([fallbackText], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': htmlBlobPromise, 'text/plain': textBlob }),
      ]);
      return { ok: true, withImage: true };
    } catch { /* 降级纯文字 */ }
  }

  try {
    await navigator.clipboard.writeText(fallbackText);
    return { ok: true, withImage: false };
  } catch {
    return { ok: false, withImage: false };
  }
}

/**
 * 剪贴板工具：封面图片 + 资源文字，各自独立写入剪贴板。
 */

import { type PanLink } from '@/lib/panUtils';
import { supabase } from '@/db/supabase';

export interface CardData {
  name: string;
  links: PanLink[];
  coverUrl?: string | null;
}

/**
 * 取封面二进制。
 * 站点片库给的封面多为外站地址，其中一部分不返回 CORS 头，浏览器端 fetch 必失败；
 * 此时退回 cover-import 边缘函数做服务端中转（响应带 CORS 头，不会污染 canvas）。
 */
export async function fetchCoverBlob(url: string): Promise<Blob> {
  const direct = await fetch(url, { mode: 'cors', cache: 'no-cache' }).catch(() => null);
  if (direct && direct.ok) return direct.blob();

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('未登录，无法中转封面');
  const relayed = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cover-import`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ url, resourceId: 'clipboard', mode: 'proxy' }),
    }
  );
  if (!relayed.ok) throw new Error(`封面中转失败 ${relayed.status}`);
  return relayed.blob();
}

/** fetch 封面 URL → base64 data URI（经 canvas 统一转 PNG） */
async function toBase64Png(url: string): Promise<string> {
  const blob = await fetchCoverBlob(url);
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
      const url = l.url.trim();
      // 必须是 <a href>：纯文字即使带颜色也无法点击跳转
      return (
        `<div style="font-size:14px;margin:2px 0 0;padding:0;line-height:1.4;">` +
        `<a href="${escHtml(url)}" target="_blank" rel="noopener" ` +
        `style="color:#1d4ed8;text-decoration:underline;word-break:break-all;">` +
        `${escHtml(label)}：${escHtml(url)}</a></div>`
      );
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

/** 生成资源卡片图（**封面在上、文字在下**），用于移动端分享/保存 */
export async function generateCardImage(card: CardData, text: string): Promise<Blob | null> {
  try {
    const SCALE = 2; // retina
    const WIDTH = 480;
    const PAD = 20;
    const CONTENT_W = WIDTH - PAD * 2;

    const lines = text.split('\n').filter(Boolean);

    // 先加载封面：需要按原图比例决定它的显示高度
    let coverImg: HTMLImageElement | null = null;
    if (card.coverUrl) {
      try {
        const dataUri = await toBase64Png(card.coverUrl);
        coverImg = await new Promise<HTMLImageElement | null>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = dataUri;
        });
      } catch { coverImg = null; }
    }

    // 封面横向撑满内容区；高度按原图比例，上限 660 避免超长海报撑爆画布
    const coverH = coverImg
      ? Math.min(Math.round(CONTENT_W * (coverImg.height / coverImg.width)), 660)
      : 0;

    // 预测量文字高度
    const measurer = document.createElement('canvas').getContext('2d')!;
    measurer.font = `bold ${16 * SCALE}px sans-serif`;
    const titleWrapped = wrapText(measurer, lines[0] || '', CONTENT_W * SCALE);
    measurer.font = `${13 * SCALE}px sans-serif`;
    const linkWrapped: string[] = [];
    lines.slice(1).forEach((l) => linkWrapped.push(...wrapText(measurer, l, CONTENT_W * SCALE)));

    const textH = PAD + titleWrapped.length * 24 + (linkWrapped.length ? 10 + linkWrapped.length * 20 : 0) + PAD;
    const HEIGHT = (coverH ? coverH + PAD : 0) + textH;

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH * SCALE;
    canvas.height = HEIGHT * SCALE;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(SCALE, SCALE);

    // 背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    let y = 0;
    // 封面（上方，完整展示、不裁剪）
    if (coverImg && coverH) {
      ctx.drawImage(coverImg, PAD, 0, CONTENT_W, coverH);
      y = coverH;
    }

    // 标题
    y += PAD + 18;
    ctx.fillStyle = '#111827';
    ctx.font = 'bold 16px sans-serif';
    titleWrapped.forEach((line) => { ctx.fillText(line, PAD, y); y += 24; });

    // 链接行
    if (linkWrapped.length) {
      y += 10;
      ctx.fillStyle = '#1d4ed8';
      ctx.font = '13px sans-serif';
      linkWrapped.forEach((line) => { ctx.fillText(line, PAD, y); y += 20; });
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
  fallbackText: string,
  /**
   * text：只写 text/plain（默认）—— 粘贴到微信 / QQ / Word 等富文本接收方时
   *       得到的是可继续编辑的文字，不会被优先取成图片。
   * card：写 text/html + text/plain + image/png（封面原图或合成长图），
   *       适合需要「封面在上、文字在下」的分享场景。
   */
  mode: 'text' | 'card' = 'text'
): Promise<{
  ok: boolean;
  withImage: boolean;
  /** 未带图时的原因，供调用方给出可操作的提示 */
  reason?: 'insecure-context';
}> {
  // 纯文本模式：剪贴板里只放 text/plain。
  // 剪贴板若同时含 image/png，微信/QQ/飞书/Word 会优先取图片，
  // 于是出现「点了复制文字、粘贴出来却是图片」的现象。
  if (mode === 'text') {
    try {
      await navigator.clipboard.writeText(fallbackText);
      return { ok: true, withImage: false };
    } catch { /* 降级 execCommand 兜底 */ }
    if (legacyCopyText(fallbackText)) return { ok: true, withImage: false };
    return { ok: false, withImage: false };
  }

  // 非安全上下文（HTTP）下浏览器不提供 navigator.clipboard，富文本无法写入剪贴板
  const secure = typeof window !== 'undefined' && window.isSecureContext;
  const reason = (): 'insecure-context' | undefined => (secure ? undefined : 'insecure-context');

  if (secure && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const htmlBlobPromise: Promise<Blob> = (async () => {
        const blocks = await Promise.all(items.map(renderHtmlBlock));
        const sep = '<div style="height:12px;border-top:1px solid #e5e7eb;margin:8px 0 0;padding:0;"></div>';
        const htmlBody = blocks.length > 1 ? blocks.join(sep) : blocks[0];
        const fullHtml = `<!DOCTYPE html><html><body style="font-family:sans-serif;margin:0;padding:0;line-height:1;">${htmlBody}</body></html>`;
        return new Blob([fullHtml], { type: 'text/html' });
      })();

      // 只写 text/html + text/plain，刻意不写 image/png：
      // 剪贴板里一旦同时存在图片，微信 / QQ / 飞书会优先取图片，粘贴出来是一张
      // 「死图」—— 标题与网盘链接既不可选中也不可点击。走 HTML 才能保留
      // 「封面图 + 标题 + 可点击链接」。
      const payload: Record<string, Blob | Promise<Blob>> = {
        'text/html': htmlBlobPromise,
        'text/plain': new Blob([fallbackText], { type: 'text/plain' }),
      };
      await navigator.clipboard.write([new ClipboardItem(payload)]);
      return { ok: true, withImage: true };
    } catch { /* 降级纯文字 */ }
  }

  try {
    await navigator.clipboard.writeText(fallbackText);
    return { ok: true, withImage: false, reason: reason() };
  } catch { /* 降级 execCommand 兜底 */ }

  // 兜底：非 HTTPS（navigator.clipboard 不存在）或用户激活已过期时，
  // 用隐藏 textarea + execCommand 完成纯文本复制
  if (legacyCopyText(fallbackText)) return { ok: true, withImage: false, reason: reason() };
  return { ok: false, withImage: false };
}

/** execCommand 兜底复制：兼容非安全上下文（HTTP）与剪贴板权限受限场景 */
function legacyCopyText(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

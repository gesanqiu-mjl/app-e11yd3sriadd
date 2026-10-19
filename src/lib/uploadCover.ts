import { supabase } from '@/db/supabase';

// ============================================================
// 资源封面规格
//   横向封面：固定 630 × 270
//   竖屏封面：固定 333 × 500
//   两者均要求 ≤ 500 KB
// 上传时按原图方向自动判定（宽 ≥ 高 → 横版，否则竖版），
// 居中裁剪铺满目标尺寸（不变形），并压缩到 500 KB 以内，统一输出 WEBP。
// ============================================================

const MAX_SIZE = 500 * 1024; // 500 KB
const LANDSCAPE = { width: 630, height: 270 };
const PORTRAIT = { width: 333, height: 500 };

/** 封面方向：横版 / 竖版 */
export type CoverOrientation = 'landscape' | 'portrait';

/** 封面目标规格 */
export interface CoverSpec {
  width: number;
  height: number;
  orientation: CoverOrientation;
}

/** 按原图方向取目标规格：宽 ≥ 高 → 横版 630×270，否则竖版 333×500 */
export function coverSpecOf(width: number, height: number): CoverSpec {
  return width >= height
    ? { ...LANDSCAPE, orientation: 'landscape' }
    : { ...PORTRAIT, orientation: 'portrait' };
}

/**
 * 归一化封面：等比缩放到覆盖目标尺寸后居中裁掉多余部分（画面不变形），
 * 再按质量递减编码为 WEBP，直到 ≤ 500 KB。
 */
function normalizeCover(file: File): Promise<{ blob: Blob; spec: CoverSpec }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const naturalW = img.naturalWidth || img.width;
      const naturalH = img.naturalHeight || img.height;
      if (!naturalW || !naturalH) {
        reject(new Error('图片尺寸读取失败'));
        return;
      }

      const spec = coverSpecOf(naturalW, naturalH);
      const canvas = document.createElement('canvas');
      canvas.width = spec.width;
      canvas.height = spec.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas 不可用'));
        return;
      }

      // 居中裁剪铺满：缩放比例取「覆盖目标」的较大值，再把多余部分从两侧/上下裁掉
      const scale = Math.max(spec.width / naturalW, spec.height / naturalH);
      const drawW = naturalW * scale;
      const drawH = naturalH * scale;
      const dx = (spec.width - drawW) / 2;
      const dy = (spec.height - drawH) / 2;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, dx, dy, drawW, drawH);

      let quality = 0.9;
      const tryEncode = () => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('封面压缩失败'));
              return;
            }
            if (blob.size <= MAX_SIZE || quality <= 0.3) {
              resolve({ blob, spec });
              return;
            }
            quality = Number(Math.max(0.3, quality - 0.1).toFixed(2));
            tryEncode();
          },
          'image/webp',
          quality
        );
      };
      tryEncode();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片加载失败'));
    };
    img.src = url;
  });
}

/** 安全文件名：只保留字母数字，其余替换为下划线 */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
}

export interface UploadResult {
  url: string;
  /** 是否经过归一化处理（当前实现总是为 true） */
  compressed: boolean;
  finalSize: number;
  /** 落地封面的规格（固定尺寸与方向） */
  width: number;
  height: number;
  orientation: CoverOrientation;
}

/**
 * 上传封面图到 Supabase Storage covers bucket。
 * 统一归一化为「横版 630×270 / 竖版 333×500」并压缩到 500 KB 以内（输出 WEBP）。
 * 返回公开访问 URL。
 */
export async function uploadCover(
  file: File,
  resourceId: string,
  onProgress?: (pct: number) => void
): Promise<UploadResult> {
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
  if (!ALLOWED.includes(file.type)) {
    throw new Error('仅支持 JPEG / PNG / WEBP / GIF / AVIF 格式');
  }

  const { blob, spec } = await normalizeCover(file);
  onProgress?.(20);

  const { data: { user } } = await supabase.auth.getUser();
  const uid = user?.id ?? 'anon';
  const path = `${uid}/${resourceId}_${safeName(Date.now().toString())}.webp`;

  onProgress?.(30);

  const { error } = await supabase.storage
    .from('covers')
    .upload(path, blob, {
      contentType: 'image/webp',
      upsert: true,
    });

  if (error) throw new Error(error.message);

  onProgress?.(90);

  const { data } = supabase.storage.from('covers').getPublicUrl(path);
  onProgress?.(100);

  return {
    url: data.publicUrl,
    compressed: true,
    finalSize: blob.size,
    width: spec.width,
    height: spec.height,
    orientation: spec.orientation,
  };
}

/** 删除 covers bucket 中指定 URL 对应的文件 */
export async function deleteCover(publicUrl: string): Promise<void> {
  const marker = '/object/public/covers/';
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return;
  const path = decodeURIComponent(publicUrl.slice(idx + marker.length));
  await supabase.storage.from('covers').remove([path]);
}

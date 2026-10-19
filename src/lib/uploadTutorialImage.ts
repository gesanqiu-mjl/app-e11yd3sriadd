import { supabase } from '@/db/supabase';

/**
 * 教程配图上传：写入 tutorials 公开桶。
 *
 * 与登录页资源（login-assets）的区别：
 *   - 教程截图往往字很小，所以最长边放到 1600（登录页是 1080）；
 *   - 每张图独立文件名（带时间戳 + 随机串），不覆盖已有图片，
 *     否则编辑旧教程时会把前面用过的图覆盖掉。
 */

const BUCKET = 'tutorials';
const MAX_SIZE = 1 * 1024 * 1024; // 1MB，超过则压缩
const MAX_DIM = 1600;

async function compressToWebp(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const ratio = Math.min(MAX_DIM / Math.max(width, height), 1);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas 不可用'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      let quality = 0.85;
      const tryCompress = () => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('压缩失败'));
              return;
            }
            if (blob.size <= MAX_SIZE || quality <= 0.4) resolve(blob);
            else {
              quality -= 0.1;
              tryCompress();
            }
          },
          'image/webp',
          quality
        );
      };
      tryCompress();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片加载失败'));
    };
    img.src = url;
  });
}

export interface TutorialImageResult {
  url: string;
  finalSize: number;
  compressed: boolean;
}

const MARKER = '/storage/v1/object/public/tutorials/';

/** 上传一张教程配图，返回公开地址（带时间戳防缓存） */
export async function uploadTutorialImage(
  file: File,
  onProgress?: (pct: number) => void
): Promise<TutorialImageResult> {
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
  if (!ALLOWED.includes(file.type)) {
    throw new Error('仅支持 JPEG / PNG / WEBP / GIF / AVIF 格式');
  }

  let blob: Blob = file;
  let compressed = false;
  if (file.size > MAX_SIZE) {
    blob = await compressToWebp(file);
    compressed = true;
  }

  onProgress?.(40);

  const rand = Math.random().toString(36).slice(2, 8);
  const ext = compressed ? 'webp' : (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `t${Date.now()}${rand}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: compressed ? 'image/webp' : file.type, upsert: true });

  if (error) throw new Error(error.message);

  onProgress?.(90);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  onProgress?.(100);

  return {
    url: `${data.publicUrl}?t=${Date.now()}`,
    finalSize: blob.size,
    compressed,
  };
}

/** 删除教程桶里的图片（按公开地址反查对象 key；失败静默，不阻断主流程） */
export async function deleteTutorialImage(publicUrl: string): Promise<void> {
  const idx = publicUrl.indexOf(MARKER);
  if (idx === -1) return;
  const key = decodeURIComponent(publicUrl.slice(idx + MARKER.length).split('?')[0]);
  if (!key) return;
  await supabase.storage.from(BUCKET).remove([key]);
}

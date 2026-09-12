import { supabase } from '@/db/supabase';

const MAX_SIZE = 1 * 1024 * 1024; // 1 MB
const MAX_DIM = 1080;

/** 将 File 压缩为 WEBP，分辨率不超过 1080p，质量不低于 0.4 */
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
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, width, height);

      let quality = 0.8;
      const tryCompress = () => {
        canvas.toBlob(
          (blob) => {
            if (!blob) { reject(new Error('压缩失败')); return; }
            if (blob.size <= MAX_SIZE || quality <= 0.4) {
              resolve(blob);
            } else {
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
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片加载失败')); };
    img.src = url;
  });
}

/** 安全文件名：只保留字母数字，其余替换为下划线 */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
}

export interface UploadResult {
  url: string;
  compressed: boolean;
  finalSize: number;
}

/**
 * 上传封面图到 Supabase Storage covers bucket。
 * 超过 1 MB 自动压缩为 WEBP。
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

  let blob: Blob = file;
  let compressed = false;

  if (file.size > MAX_SIZE) {
    blob = await compressToWebp(file);
    compressed = true;
  }

  const ext = compressed ? 'webp' : file.name.split('.').pop() || 'jpg';
  const { data: { user } } = await supabase.auth.getUser();
  const uid = user?.id ?? 'anon';
  const path = `${uid}/${resourceId}_${safeName(Date.now().toString())}.${ext}`;

  onProgress?.(30);

  const { error } = await supabase.storage
    .from('covers')
    .upload(path, blob, {
      contentType: compressed ? 'image/webp' : file.type,
      upsert: true,
    });

  if (error) throw new Error(error.message);

  onProgress?.(90);

  const { data } = supabase.storage.from('covers').getPublicUrl(path);
  onProgress?.(100);

  return { url: data.publicUrl, compressed, finalSize: blob.size };
}

/** 删除 covers bucket 中指定 URL 对应的文件 */
export async function deleteCover(publicUrl: string): Promise<void> {
  const marker = '/object/public/covers/';
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return;
  const path = decodeURIComponent(publicUrl.slice(idx + marker.length));
  await supabase.storage.from('covers').remove([path]);
}

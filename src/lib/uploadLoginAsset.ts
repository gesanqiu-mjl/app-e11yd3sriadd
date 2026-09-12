import { supabase } from '@/db/supabase';

const MAX_SIZE = 1 * 1024 * 1024;
const MAX_DIM = 1080;
const BUCKET = 'login-assets';

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
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
      let quality = 0.8;
      const tryCompress = () => {
        canvas.toBlob(
          (blob) => {
            if (!blob) { reject(new Error('压缩失败')); return; }
            if (blob.size <= MAX_SIZE || quality <= 0.4) resolve(blob);
            else { quality -= 0.1; tryCompress(); }
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

export interface LoginAssetResult {
  url: string;
  compressed: boolean;
  finalSize: number;
}

/**
 * 上传登录页资源（logo 或背景图）到 login-assets bucket。
 * @param file 图片文件
 * @param slot  'logo' | 'background'
 */
export async function uploadLoginAsset(
  file: File,
  slot: 'logo' | 'background',
  onProgress?: (pct: number) => void
): Promise<LoginAssetResult> {
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

  const ext = compressed ? 'webp' : (file.name.split('.').pop() || 'jpg');
  const path = `${slot}.${ext}`;

  onProgress?.(30);

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: compressed ? 'image/webp' : file.type, upsert: true });

  if (error) throw new Error(error.message);

  onProgress?.(90);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  onProgress?.(100);

  // 追加时间戳防缓存
  return {
    url: `${data.publicUrl}?t=${Date.now()}`,
    compressed,
    finalSize: blob.size,
  };
}

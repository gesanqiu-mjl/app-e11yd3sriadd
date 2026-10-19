import { supabase } from '@/db/supabase';

const BUCKET = 'avatars';
const MAX_SIZE = 1 * 1024 * 1024;
/** 头像最长边（正方形裁切后再压缩，足够清晰又不浪费流量） */
const TARGET_DIM = 320;

/** 居中裁剪为正方形 + 压缩为 webp */
async function toSquareWebp(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.width, img.height);
      const sx = Math.round((img.width - side) / 2);
      const sy = Math.round((img.height - side) / 2);
      const dim = Math.min(TARGET_DIM, side);
      const canvas = document.createElement('canvas');
      canvas.width = dim;
      canvas.height = dim;
      canvas.getContext('2d')!.drawImage(img, sx, sy, side, side, 0, 0, dim, dim);
      let quality = 0.85;
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

export interface AvatarUploadResult {
  url: string;
  size: number;
}

/**
 * 上传当前用户头像到 avatars bucket 的「自己目录」下（avatars/<uid>/avatar.webp）。
 * 存储策略限定只能写自己的目录，因此这里的 userId 必须与登录账号一致。
 */
export async function uploadAvatar(
  file: File,
  userId: string,
  onProgress?: (pct: number) => void
): Promise<AvatarUploadResult> {
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
  if (!ALLOWED.includes(file.type)) {
    throw new Error('仅支持 JPEG / PNG / WEBP / GIF / AVIF 格式');
  }
  if (!userId) throw new Error('未登录，无法上传头像');

  onProgress?.(20);
  const blob = await toSquareWebp(file);
  onProgress?.(60);

  const path = `${userId}/avatar.webp`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'image/webp', upsert: true });
  if (error) throw new Error(error.message);

  onProgress?.(90);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  onProgress?.(100);

  // 追加时间戳防缓存
  return { url: `${data.publicUrl}?t=${Date.now()}`, size: blob.size };
}

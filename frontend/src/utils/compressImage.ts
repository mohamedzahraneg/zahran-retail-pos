/**
 * Compress an image File using a canvas. Returns a Blob (JPEG by default).
 * - Scales down so the longest side is <= maxDimension (px)
 * - Re-encodes to JPEG at the given quality (0..1)
 * - Skips when the file is already smaller than `skipIfSmallerThan` bytes
 */
export async function compressImage(
  file: File,
  opts: {
    maxDimension?: number;
    quality?: number;
    mimeType?: 'image/jpeg' | 'image/webp';
    skipIfSmallerThan?: number;
  } = {},
): Promise<Blob> {
  const {
    maxDimension = 1200,
    quality = 0.8,
    mimeType = 'image/jpeg',
    skipIfSmallerThan = 120 * 1024, // 120 KB
  } = opts;

  if (file.size < skipIfSmallerThan && file.type === mimeType) {
    return file;
  }

  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  const longest = Math.max(width, height);
  if (longest > maxDimension) {
    const scale = maxDimension / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('compression failed'));
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

import { api, unwrap } from './client';

export interface UploadedFile {
  filename: string;
  mimetype: string;
  size: number;
  url: string;
}

export const uploadsApi = {
  /** Upload a single image — returns the file's public URL (relative). */
  image: (file: File | Blob, filename?: string) => {
    const fd = new FormData();
    const name =
      filename || (file instanceof File ? file.name : `image-${Date.now()}.jpg`);
    fd.append('file', file, name);
    return unwrap<UploadedFile>(
      api.post('/uploads/image', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }),
    );
  },

  /** Upload multiple images at once (max 10). */
  images: (files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    return unwrap<{ files: UploadedFile[] }>(
      api.post('/uploads/images', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }),
    );
  },

  remove: (filename: string) =>
    unwrap<{ deleted: boolean }>(api.delete(`/uploads/${filename}`)),
};

/**
 * Resolve a stored image URL (relative path like `/uploads/abc.png`)
 * against the API base so the `<img>` loads correctly.
 */
export function resolveImageUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  const base = (import.meta.env.VITE_API_URL || '').replace(/\/api\/v1\/?$/, '');
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

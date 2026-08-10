import type { BlobPart } from './types.js';

/** Decode blob `content` as raw base64. Returns null on failure. */
export function decodeBlobContent(part: BlobPart): { bytes: Buffer } | null {
  const base64 = typeof part.content === 'string' ? part.content.trim() : '';
  if (!base64) return null;

  try {
    const bytes = Buffer.from(base64, 'base64');
    // Buffer.from is lenient; reject empty / clearly non-base64 garbage.
    if (bytes.length === 0) return null;
    return { bytes };
  } catch {
    return null;
  }
}

export function extFromMime(mime: string): string {
  const normalized = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  switch (normalized) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'image/svg+xml':
      return 'svg';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
      return 'wav';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

/** Infer modality from MIME type prefix; undefined when unknown. */
export function modalityFromMime(mime: string): 'image' | 'audio' | 'video' | undefined {
  const normalized = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  return undefined;
}

export function yyyymmddUTC(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * UTC YYYYMMDD from unix epoch milliseconds.
 * Falls back to current UTC day when missing/invalid.
 */
export function yyyymmddFromUnixMs(
  timeUnixMs: number | undefined,
  fallback = new Date(),
): string {
  if (typeof timeUnixMs === 'number' && Number.isFinite(timeUnixMs) && timeUnixMs > 0) {
    return yyyymmddUTC(new Date(timeUnixMs));
  }
  return yyyymmddUTC(fallback);
}

/** Join storageBasePath (oss://bucket/prefix) with relative targetPath. */
export function joinStorageUri(storageBasePath: string, targetPath: string): string {
  const base = storageBasePath.replace(/\/+$/, '');
  const rel = targetPath.replace(/^\/+/, '');
  return `${base}/${rel}`;
}

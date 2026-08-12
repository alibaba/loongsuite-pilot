import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BlobPart, PathBytes, PathStat } from './types.js';

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

export type { PathBytes, PathStat };

/** Decode blob `content` as raw base64. */
export function decodeBlobContent(part: BlobPart): { bytes: Buffer } | null {
  const base64 = typeof part.content === 'string' ? part.content.trim() : '';
  if (!base64) return null;

  try {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) return null;
    return { bytes };
  } catch {
    return null;
  }
}

/** True when the path has a known image file extension. */
export function isImageFilePath(filePath: string): boolean {
  return mimeFromImagePath(filePath) !== null;
}

/** MIME type from image extension. */
export function mimeFromImagePath(filePath: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  const bare = trimmed.split(/[?#]/)[0] ?? trimmed;
  const ext = path.extname(bare).toLowerCase();
  return IMAGE_EXT_TO_MIME[ext] ?? null;
}

/** Stat a local image path. */
export async function statImagePath(filePath: string): Promise<PathStat | null> {
  const mime = mimeFromImagePath(filePath);
  if (!mime) return null;

  const resolvedPath = path.resolve(filePath.trim().split(/[?#]/)[0] ?? filePath.trim());
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return { resolvedPath, mime_type: mime, size: stat.size };
}

/** Read bytes for a stated local image path. */
export async function readImagePathBytes(stated: PathStat): Promise<PathBytes | null> {
  try {
    const bytes = await fs.readFile(stated.resolvedPath);
    return { bytes, mime_type: stated.mime_type, size: bytes.length };
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

export function yyyymmddLocal(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Local YYYYMMDD from unix epoch milliseconds (event time when provided).
 * Falls back to the local calendar day of `fallback` (default: now) when missing/invalid.
 */
export function yyyymmddFromUnixMs(
  timeUnixMs: number | undefined,
  fallback = new Date(),
): string {
  if (typeof timeUnixMs === 'number' && Number.isFinite(timeUnixMs) && timeUnixMs > 0) {
    return yyyymmddLocal(new Date(timeUnixMs));
  }
  return yyyymmddLocal(fallback);
}

/** Join storageBasePath (oss://bucket/prefix) with relative targetPath. */
export function joinStorageUri(storageBasePath: string, targetPath: string): string {
  const base = storageBasePath.replace(/\/+$/, '');
  const rel = targetPath.replace(/^\/+/, '');
  return `${base}/${rel}`;
}

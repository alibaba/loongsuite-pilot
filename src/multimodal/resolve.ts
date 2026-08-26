import { constants as fsConstants, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import type { BlobPart, PathBytes, PathStat } from './types.js';
import { MAX_MULTIMODAL_DATA_SIZE, MAX_MULTIMODAL_PARTS, MAX_MULTIMODAL_PATH_CHARS } from './types.js';

const logger = createLogger('MultimodalResolve');

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

/** Decode raw base64. */
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

/** Image path by extension. */
export function isImageFilePath(filePath: string): boolean {
  return mimeFromImagePath(filePath) !== null;
}

/** Collect capture groups until MAX_MULTIMODAL_PARTS. Default pick is group 1. */
export function matchAll(
  re: RegExp,
  text: string,
  pick: (match: RegExpExecArray) => string | undefined = m => m[1],
): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const p = pick(match)?.trim();
    if (!p) continue;
    if (out.length >= MAX_MULTIMODAL_PARTS) {
      logger.debug('multimodal extract match cap reached');
      break;
    }
    out.push(p);
  }
  return out;
}

/** Dedup and cap extracted image paths. `normalize` can resolve; empty / non-image is skipped. */
export function takeUniqueExtractedPaths(
  rawPaths: string[],
  normalize?: (raw: string) => string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawPaths.length; i++) {
    if (out.length >= MAX_MULTIMODAL_PARTS) {
      logger.debug('multimodal extract path cap reached', {
        leftover: rawPaths.length - i,
      });
      break;
    }
    const raw = rawPaths[i] ?? '';
    const p = (normalize ? normalize(raw) : raw).trim();
    if (
      !p
      || p.length > MAX_MULTIMODAL_PATH_CHARS
      || seen.has(p)
      || !isImageFilePath(p)
    ) {
      continue;
    }
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** MIME from image extension. */
export function mimeFromImagePath(filePath: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  const bare = trimmed.split(/[?#]/)[0] ?? trimmed;
  const ext = path.extname(bare).toLowerCase();
  return IMAGE_EXT_TO_MIME[ext] ?? null;
}

/** UNC or Windows device path. */
export function isUncOrDevicePath(filePath: string): boolean {
  const trimmed = filePath.trim();
  if (!trimmed) return false;
  const win = trimmed.replace(/\//g, '\\');
  if (/^\\\\[.?]\\UNC\\/i.test(win)) return true;
  if (/^\\\\[.?]\\/i.test(win)) return false;
  if (win.startsWith('\\\\')) return true;
  if (/^\/\/[^/]/.test(trimmed)) return true;
  return false;
}

/** Resolve a local image path; reject UNC / non-image. */
export function normalizeLocalImagePath(filePath: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  const bare = trimmed.split(/[?#]/)[0] ?? trimmed;
  if (!bare || isUncOrDevicePath(bare) || !mimeFromImagePath(bare)) return null;
  return path.resolve(bare);
}

/** Absolute stays; relative joins cwd (win32 vs posix). */
export function resolveImagePath(raw: string, cwd?: string): string {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return '';

  if (process.platform === 'win32') {
    if (path.win32.isAbsolute(trimmed)) return path.win32.normalize(trimmed);
    if (cwd && cwd.trim()) return path.win32.resolve(cwd.trim(), trimmed);
    return path.win32.resolve(trimmed);
  }

  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  if (cwd && cwd.trim()) return path.resolve(cwd.trim(), trimmed);
  return path.resolve(trimmed);
}

/** Expand `~` and realpath a root. Missing paths stay lexical. */
export function canonicalizeRootPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const resolved = path.resolve(resolveHome(trimmed));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Merge and dedupe allowed roots. */
export function mergeAllowedRootPaths(
  defaultPaths: string[],
  userPaths?: string[],
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...defaultPaths, ...(userPaths ?? [])]) {
    const resolved = canonicalizeRootPath(raw);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    merged.push(resolved);
  }
  return merged;
}

/** Whether path is inside any root (lexical). */
export function isPathInsideRoots(absPath: string, roots: string[]): boolean {
  for (const root of roots) {
    if (!root) continue;
    const rel = path.relative(root, absPath);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

/** Whether the file's realpath is inside any root. */
export async function isRealPathInsideRoots(
  absPath: string,
  roots: string[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  let realFile: string;
  try {
    realFile = await fs.realpath(absPath);
  } catch {
    return false;
  }
  return !signal?.aborted && isPathInsideRoots(realFile, roots);
}

function sameFileId(
  a: { dev: number | bigint; ino: number | bigint },
  b: { dev: number | bigint; ino: number | bigint },
): boolean {
  return BigInt(a.dev) === BigInt(b.dev) && BigInt(a.ino) === BigInt(b.ino);
}

/** Opened handle must be the file that realpath currently says is inside roots. */
async function openedHandleMatchesAllowedPath(
  opened: { dev: number | bigint; ino: number | bigint },
  resolvedPath: string,
  roots: string[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (!(await isRealPathInsideRoots(resolvedPath, roots, signal))) return false;
  try {
    return sameFileId(opened, await fs.stat(resolvedPath));
  } catch {
    return false;
  }
}

/** Image MIME from magic bytes. */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const gif = bytes.subarray(0, 6).toString('ascii');
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return 'image/x-icon';
  }
  if (bytes.length >= 4
    && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0)
      || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a))) {
    return 'image/tiff';
  }
  const head = bytes.subarray(0, 256).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && /<svg[\s>]/i.test(head))) {
    return 'image/svg+xml';
  }
  return null;
}

export async function lstatRegularImageFile(resolvedPath: string, signal?: AbortSignal) {
  if (signal?.aborted) return null;
  let listed;
  try {
    listed = await fs.lstat(resolvedPath);
  } catch {
    return null;
  }
  if (signal?.aborted || listed.isSymbolicLink() || !listed.isFile()) return null;
  return listed;
}

/** Open and read an already-normalized local image path. */
export async function openNormalizedLocalImage(
  resolvedPath: string,
  maxBytes = MAX_MULTIMODAL_DATA_SIZE,
  allowedRootPaths?: string[],
  signal?: AbortSignal,
): Promise<(PathBytes & { mtimeMs: number; resolvedPath: string }) | null> {
  if (allowedRootPaths) {
    if (allowedRootPaths.length === 0) return null;
    if (!(await isRealPathInsideRoots(resolvedPath, allowedRootPaths, signal))) return null;
  }
  if (signal?.aborted) return null;

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
  const abortClose = () => {
    if (fh) void fh.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', abortClose, { once: true });
  try {
    fh = await fs.open(resolvedPath, flags);
    if (signal?.aborted) return null;
    const st = await fh.stat();
    if (!st.isFile() || st.size <= 0) return null;
    if (
      allowedRootPaths
      && !(await openedHandleMatchesAllowedPath(st, resolvedPath, allowedRootPaths, signal))
    ) {
      return null;
    }
    const toRead = Math.min(st.size, maxBytes + 1);
    const bytes = await readFileHandleFully(fh, toRead, signal);
    if (!bytes || bytes.length > maxBytes) return null;

    const after = await fh.stat();
    if (
      !after.isFile()
      || after.size !== st.size
      || after.mtimeMs !== st.mtimeMs
      || bytes.length !== st.size
    ) {
      return null;
    }

    const mime_type = sniffImageMime(bytes);
    if (!mime_type) return null;
    return { bytes, mime_type, size: bytes.length, mtimeMs: st.mtimeMs, resolvedPath };
  } catch {
    return null;
  } finally {
    signal?.removeEventListener('abort', abortClose);
    if (fh) {
      try {
        await fh.close();
      } catch {
        // already closed by abort
      }
    }
  }
}

/** Loop until `byteLength` or EOF. One `read` is not guaranteed to fill. */
async function readFileHandleFully(
  fh: Awaited<ReturnType<typeof fs.open>>,
  byteLength: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const buf = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    try {
      const { bytesRead } = await fh.read(buf, offset, byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    } catch {
      return null;
    }
  }
  if (offset <= 0 || signal?.aborted) return null;
  return Buffer.from(buf.subarray(0, offset));
}

/** lstat a local image (no follow). */
export async function statImagePath(filePath: string): Promise<PathStat | null> {
  const resolvedPath = normalizeLocalImagePath(filePath);
  if (!resolvedPath) return null;
  const listed = await lstatRegularImageFile(resolvedPath);
  const mime = mimeFromImagePath(resolvedPath);
  if (!listed || !mime) return null;
  return {
    resolvedPath,
    mime_type: mime,
    size: listed.size,
    mtimeMs: listed.mtimeMs,
  };
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

/** Modality from MIME prefix. */
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

/** YYYYMMDD (local) from event time. */
export function yyyymmddFromUnixMs(
  timeUnixMs: number | undefined,
  fallback = new Date(),
): string {
  if (typeof timeUnixMs === 'number' && Number.isFinite(timeUnixMs) && timeUnixMs > 0) {
    return yyyymmddLocal(new Date(timeUnixMs));
  }
  return yyyymmddLocal(fallback);
}

/** Join storage base URI with object key. */
export function joinStorageUri(storageBasePath: string, targetPath: string): string {
  const base = storageBasePath.replace(/\/+$/, '');
  const rel = targetPath.replace(/^\/+/, '');
  return `${base}/${rel}`;
}

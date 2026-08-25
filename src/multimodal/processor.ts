import { createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import {
  decodeBlobContent,
  extFromMime,
  isRealPathInsideRoots,
  joinStorageUri,
  lstatRegularImageFile,
  normalizeLocalImagePath,
  openNormalizedLocalImage,
  yyyymmddFromUnixMs,
} from './resolve.js';
import type {
  BlobToUriParams,
  PathToUriOptions,
  Uploader,
  UriConvertMeta,
  UriResult,
} from './types.js';
import {
  MAX_MULTIMODAL_BASE64_CHARS,
  MAX_MULTIMODAL_DATA_SIZE,
  MAX_MULTIMODAL_PATH_INFLIGHT,
  MAX_MULTIMODAL_PENDING_BYTES,
  MAX_MULTIMODAL_PENDING_UPLOADS,
  MULTIMODAL_SHUTDOWN_TIMEOUT_MS,
  PATH_TO_URI_DEADLINE_MS,
} from './types.js';
import { LruMap, MULTIMODAL_LRU_LIMIT } from './uploader/lru-set.js';

const logger = createLogger('MultimodalProcessor');

/** Race a promise; timeout does not cancel the underlying work. */
export async function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  onTimeout: () => T,
): Promise<T> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return promise;
  }

  let settled = false;
  const work = promise.then(
    value => {
      settled = true;
      return value;
    },
    err => {
      settled = true;
      throw err;
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(onTimeout()), deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!settled) {
      void work.catch(() => undefined);
    }
  }
}

interface PathUriCacheEntry {
  mtimeMs: number;
  size: number;
  result: UriResult | null;
}

function pathInflightKey(absPath: string, mtimeMs: number, size: number): string {
  return `${absPath}\0${mtimeMs}\0${size}`;
}

/** Convert blob/path to storage uri and enqueue async upload. */
export class MultimodalProcessor {
  private readonly pending = new Set<Promise<void>>();
  /** In-flight upload keys. */
  private readonly pendingKeys = new Set<string>();
  private pendingBytes = 0;
  private shuttingDown = false;
  private readonly storageBasePath: string;
  /** path→uri cache keyed by mtime+size. */
  private readonly pathUriCache = new LruMap<PathUriCacheEntry>(MULTIMODAL_LRU_LIMIT);
  /** In-flight path reads. */
  private readonly pathUriInflight = new Map<string, Promise<UriResult | null>>();

  constructor(
    storageBasePath: string,
    private readonly uploader: Uploader,
  ) {
    const base = (storageBasePath ?? '').trim().replace(/\/+$/, '');
    if (!base) {
      throw new Error('multimodal storageBasePath is required');
    }
    this.storageBasePath = base;
  }

  /** Local image path → uri. */
  async pathToUri(
    filePath: string,
    timeUnixMs?: number,
    opts?: PathToUriOptions,
  ): Promise<UriResult | null> {
    if (this.shuttingDown) {
      logger.warn('multimodal pathToUri rejected', { reason: 'shutting_down' });
      return null;
    }

    const deadlineMs = opts?.deadlineMs ?? PATH_TO_URI_DEADLINE_MS;
    return withDeadline(
      this.convertPathToUri(filePath, timeUnixMs, opts),
      deadlineMs,
      () => {
        logger.warn('multimodal pathToUri timed out', { path: filePath, deadlineMs });
        return null;
      },
    );
  }

  private async convertPathToUri(
    filePath: string,
    timeUnixMs?: number,
    opts?: PathToUriOptions,
  ): Promise<UriResult | null> {
    const key = normalizeLocalImagePath(filePath);
    if (!key) return null;

    const roots = (opts?.allowedRootPaths ?? []).map(r => r.trim()).filter(Boolean);
    if (roots.length === 0) {
      logger.warn('multimodal pathToUri rejected', { reason: 'no_allowed_roots' });
      return null;
    }

    const stated = await lstatRegularImageFile(key);
    if (!stated) return null;

    const cached = this.pathUriCache.get(key);
    if (
      cached
      && cached.mtimeMs === stated.mtimeMs
      && cached.size === stated.size
    ) {
      if (!(await isRealPathInsideRoots(key, roots))) return null;
      return cached.result;
    }

    const slotKey = pathInflightKey(key, stated.mtimeMs, stated.size);
    const inflight = this.pathUriInflight.get(slotKey);
    if (inflight) return inflight;

    if (this.pathUriInflight.size >= MAX_MULTIMODAL_PATH_INFLIGHT) {
      logger.warn('multimodal pathToUri rejected', {
        reason: 'path_inflight_full',
        pending: this.pathUriInflight.size,
        limit: MAX_MULTIMODAL_PATH_INFLIGHT,
      });
      return null;
    }

    const pending = (async (): Promise<UriResult | null> => {
      try {
        const loaded = await openNormalizedLocalImage(key, MAX_MULTIMODAL_DATA_SIZE, roots);
        if (!loaded) return null;

        const cachedFresh = this.pathUriCache.get(key);
        if (
          cachedFresh
          && cachedFresh.mtimeMs === loaded.mtimeMs
          && cachedFresh.size === loaded.size
        ) {
          return cachedFresh.result;
        }

        const result = this.bytesToUri(loaded.bytes, {
          mime_type: loaded.mime_type,
          modality: 'image',
          ...(typeof timeUnixMs === 'number' && Number.isFinite(timeUnixMs) && timeUnixMs > 0
            ? { time_unix_ms: timeUnixMs }
            : {}),
        });
        this.pathUriCache.set(key, {
          mtimeMs: loaded.mtimeMs,
          size: loaded.size,
          result,
        });
        return result;
      } catch (err) {
        logger.warn('multimodal pathToUri failed', { error: String(err) });
        return null;
      }
    })();

    this.pathUriInflight.set(slotKey, pending);
    try {
      return await pending;
    } finally {
      this.pathUriInflight.delete(slotKey);
    }
  }

  /** Raw base64 → uri (upload async). */
  blobToUri(params: BlobToUriParams): UriResult | null {
    try {
      if (this.shuttingDown) {
        logger.warn('multimodal blob rejected', { reason: 'shutting_down' });
        return null;
      }

      const content = typeof params.content === 'string' ? params.content : '';
      if (!content || content.length > MAX_MULTIMODAL_BASE64_CHARS) {
        logger.warn('multimodal blob rejected', {
          reason: !content ? 'decode_failed' : 'size_limit',
          base64Chars: content.length,
        });
        return null;
      }

      const decoded = decodeBlobContent({
        type: 'blob',
        content,
        mime_type: params.mime_type,
        modality: params.modality,
      });
      if (!decoded) {
        logger.warn('multimodal blob rejected', { reason: 'decode_failed' });
        return null;
      }

      return this.bytesToUri(decoded.bytes, params);
    } catch (err) {
      logger.warn('multimodal blobToUri failed', { error: String(err) });
      return null;
    }
  }

  /** Hash bytes → uri and enqueue upload. */
  private bytesToUri(bytes: Buffer, meta: UriConvertMeta = {}): UriResult | null {
    if (this.shuttingDown) {
      logger.warn('multimodal blob rejected', { reason: 'shutting_down' });
      return null;
    }

    if (!bytes || bytes.length === 0 || bytes.length > MAX_MULTIMODAL_DATA_SIZE) {
      logger.warn('multimodal blob rejected', {
        reason: !bytes || bytes.length === 0 ? 'decode_failed' : 'size_limit',
        size: bytes?.length,
      });
      return null;
    }

    const mime = meta.mime_type || 'application/octet-stream';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const day = yyyymmddFromUnixMs(meta.time_unix_ms);
    const targetPath = `${day}/${sha256}.${extFromMime(mime)}`;
    const uri = joinStorageUri(this.storageBasePath, targetPath);
    const size = bytes.length;

    const result: UriResult = {
      uri,
      mime_type: mime,
      ...(meta.modality ? { modality: meta.modality } : {}),
      size,
      sha256,
    };

    if (this.pendingKeys.has(targetPath)) {
      logger.debug('multimodal upload skipped (in-flight)', { uri });
      return result;
    }

    if (this.pending.size >= MAX_MULTIMODAL_PENDING_UPLOADS) {
      logger.warn('multimodal upload queue full, skipping enqueue', {
        reason: 'queue_full',
        uri,
        pending: this.pending.size,
        limit: MAX_MULTIMODAL_PENDING_UPLOADS,
      });
      return result;
    }
    if (
      MAX_MULTIMODAL_PENDING_BYTES > 0
      && this.pendingBytes + size > MAX_MULTIMODAL_PENDING_BYTES
    ) {
      logger.warn('multimodal upload queue bytes limit exceeded, skipping enqueue', {
        reason: 'queue_bytes_limit',
        uri,
        pendingBytes: this.pendingBytes,
        incoming: size,
        limit: MAX_MULTIMODAL_PENDING_BYTES,
      });
      return result;
    }

    this.pendingKeys.add(targetPath);
    this.pendingBytes += size;
    const uploadPromise = this.uploader.upload({
      targetPath,
      contentType: mime,
      meta: {
        mime_type: mime,
      },
      data: bytes,
      expectedSize: size,
    }).then(ok => {
      if (!ok) {
        logger.warn('multimodal upload failed (uri may be dangling)', {
          uri,
          size,
        });
      }
    }).catch(err => {
      logger.warn('multimodal upload failed (uri may be dangling)', {
        uri,
        error: String(err),
      });
    });
    this.pending.add(uploadPromise);
    void uploadPromise.finally(() => {
      this.pending.delete(uploadPromise);
      this.pendingKeys.delete(targetPath);
      this.pendingBytes = Math.max(0, this.pendingBytes - size);
    });

    return result;
  }

  async shutdown(timeoutMs = MULTIMODAL_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.shuttingDown) {
      logger.debug('multimodal shutdown skipped (already in progress or done)');
      return;
    }
    this.shuttingDown = true;
    this.pathUriCache.clear();
    this.pathUriInflight.clear();

    if (this.pending.size > 0) {
      await withDeadline(
        Promise.allSettled([...this.pending]).then(() => undefined),
        timeoutMs,
        () => undefined,
      );
      if (this.pending.size > 0) {
        logger.warn('multimodal shutdown timed out with uploads still in flight', {
          pending: this.pending.size,
          timeoutMs,
        });
      }
    }

    try {
      await this.uploader.shutdown();
    } catch (err) {
      logger.warn('multimodal uploader shutdown failed', { error: String(err) });
    }
  }
}

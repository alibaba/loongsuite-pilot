import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';
import {
  decodeBlobContent,
  extFromMime,
  isImageFilePath,
  joinStorageUri,
  readImagePathBytes,
  statImagePath,
  yyyymmddFromUnixMs,
} from './resolve.js';
import type {
  BlobToUriParams,
  Uploader,
  UriConvertMeta,
  UriResult,
} from './types.js';
import {
  MAX_MULTIMODAL_BASE64_CHARS,
  MAX_MULTIMODAL_DATA_SIZE,
  MAX_MULTIMODAL_PENDING_BYTES,
  MAX_MULTIMODAL_PENDING_UPLOADS,
  MULTIMODAL_SHUTDOWN_TIMEOUT_MS,
} from './types.js';
import { LruMap, MULTIMODAL_LRU_LIMIT } from './uploader/lru-set.js';

const logger = createLogger('MultimodalProcessor');

/**
 * Multimodal conversion service shared across agents.
 *
 * Two public entry points :
 * - `blobToUri`: raw base64 blob → decode → bytes → uri + upload
 * - `pathToUri`: local image path → read bytes → uri + upload
 */
export class MultimodalProcessor {
  private readonly pending = new Set<Promise<void>>();
  /** In-flight object relative paths (`day/sha.ext`); not the same as Uploader success LRU. */
  private readonly pendingKeys = new Set<string>();
  private pendingBytes = 0;
  private shuttingDown = false;
  private readonly storageBasePath: string;
  /** Absolute local path → uri result (incl. null misses); shared across collect cycles. */
  private readonly pathUriCache = new LruMap<UriResult | null>(MULTIMODAL_LRU_LIMIT);
  /** In-flight path reads so concurrent pathToUri for the same path share one IO. */
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

  /**
   * Local image path → storage uri. Path-level LRU + in-flight dedupe.
   * Reads file bytes directly (no base64 encode/decode).
   */
  async pathToUri(filePath: string, timeUnixMs?: number): Promise<UriResult | null> {
    if (this.shuttingDown) {
      logger.warn('multimodal pathToUri rejected', { reason: 'shutting_down' });
      return null;
    }

    const trimmed = filePath.trim().split(/[?#]/)[0] ?? '';
    if (!trimmed || !isImageFilePath(trimmed)) return null;
    const key = path.resolve(trimmed);

    if (this.pathUriCache.has(key)) {
      return this.pathUriCache.get(key) ?? null;
    }

    const inflight = this.pathUriInflight.get(key);
    if (inflight) return inflight;

    const pending = (async (): Promise<UriResult | null> => {
      try {
        const stated = await statImagePath(key);
        if (!stated) {
          this.pathUriCache.set(key, null);
          return null;
        }
        if (stated.size <= 0 || stated.size > MAX_MULTIMODAL_DATA_SIZE) {
          logger.warn('multimodal path rejected', {
            reason: 'size_limit',
            size: stated.size,
          });
          this.pathUriCache.set(key, null);
          return null;
        }

        const loaded = await readImagePathBytes(stated);
        if (!loaded) {
          this.pathUriCache.set(key, null);
          return null;
        }
        const result = this.bytesToUri(loaded.bytes, {
          mime_type: loaded.mime_type,
          modality: 'image',
          ...(typeof timeUnixMs === 'number' && Number.isFinite(timeUnixMs) && timeUnixMs > 0
            ? { time_unix_ms: timeUnixMs }
            : {}),
        });
        this.pathUriCache.set(key, result);
        return result;
      } catch (err) {
        logger.warn('multimodal pathToUri failed', { error: String(err) });
        this.pathUriCache.set(key, null);
        return null;
      }
    })();

    this.pathUriInflight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.pathUriInflight.delete(key);
    }
  }

  /**
   * Raw base64 blob → storage uri. Upload runs in the background; failure /
   * queue-full only logs a warning (uri may dangle).
   */
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

  /**
   * Shared path after bytes are available: hash → optimistic uri → enqueue upload.
   * `bytes` is the payload; meta reuses UriConvertMeta .
   */
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

    // Same key already uploading — return optimistic uri, do not double-enqueue.
    if (this.pendingKeys.has(targetPath)) {
      logger.debug('multimodal upload skipped (in-flight)', { uri });
      return result;
    }

    // Optimistic uri even when the upload queue is full (may dangle).
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...this.pending]),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
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

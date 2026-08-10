import { createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import { decodeBlobContent, extFromMime, joinStorageUri, yyyymmddFromUnixMs } from './resolve.js';
import type {
  BlobToUriParams,
  BlobToUriResult,
  Uploader,
} from './types.js';
import {
  MAX_MULTIMODAL_BASE64_CHARS,
  MAX_MULTIMODAL_DATA_SIZE,
  MAX_MULTIMODAL_PENDING_BYTES,
  MAX_MULTIMODAL_PENDING_UPLOADS,
  MULTIMODAL_SHUTDOWN_TIMEOUT_MS,
} from './types.js';

const logger = createLogger('MultimodalProcessor');

/**
 * Blob → uri service. Input owns message structure; this layer only
 * validates/hashes, returns an optimistic uri, and enqueues async upload.
 *
 * Queue backpressure lives here; post-success idempotency lives in Uploader
 * (`successKeys`). `pendingKeys` skips a second enqueue while the same
 * targetPath is already uploading, so concurrent identical blobs do not
 * double-PUT.
 *
 * Lifecycle: after `shutdown()` starts, `toUri` rejects new blobs. Shutdown
 * best-effort drains in-flight uploads then closes the Uploader (idempotent).
 */
export class MultimodalProcessor {
  private readonly pending = new Set<Promise<void>>();
  /** In-flight object relative paths (`day/sha.ext`); not the same as Uploader success LRU. */
  private readonly pendingKeys = new Set<string>();
  private pendingBytes = 0;
  private shuttingDown = false;
  private readonly storageBasePath: string;

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
   * Synchronously returns a storage uri (or null if the blob is invalid).
   * Upload runs in the background; failure / queue-full only logs a warning
   * (uri may dangle).
   */
  toUri(params: BlobToUriParams): BlobToUriResult | null {
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
      if (!decoded || decoded.bytes.length > MAX_MULTIMODAL_DATA_SIZE) {
        logger.warn('multimodal blob rejected', {
          reason: !decoded ? 'decode_failed' : 'size_limit',
          size: decoded?.bytes.length,
        });
        return null;
      }

      const mime = params.mime_type || 'application/octet-stream';
      const sha256 = createHash('sha256').update(decoded.bytes).digest('hex');
      const day = yyyymmddFromUnixMs(params.time_unix_ms);
      const targetPath = `${day}/${sha256}.${extFromMime(mime)}`;
      const uri = joinStorageUri(this.storageBasePath, targetPath);
      const size = decoded.bytes.length;

      const result: BlobToUriResult = {
        uri,
        mime_type: mime,
        ...(params.modality ? { modality: params.modality } : {}),
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
        data: decoded.bytes,
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
    } catch (err) {
      logger.warn('multimodal toUri failed', { error: String(err) });
      return null;
    }
  }

  /**
   * Stop accepting new blobs, wait briefly for in-flight uploads, then close
   * the uploader. Idempotent: later calls return immediately. Timed-out
   * uploads may still finish in the background; the uploader refuses new work
   * after close.
   */
  async shutdown(timeoutMs = MULTIMODAL_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.shuttingDown) {
      logger.debug('multimodal shutdown skipped (already in progress or done)');
      return;
    }
    this.shuttingDown = true;

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

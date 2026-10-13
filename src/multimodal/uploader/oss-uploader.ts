import { createLogger } from '../../utils/logger.js';
import type { MultimodalStorage, UploadItem, Uploader } from '../types.js';
import { LruMap, MULTIMODAL_LRU_LIMIT } from './lru-set.js';
import { ossPutObject, parseOssStorageBasePath } from './oss-client.js';
import {
  DEFAULT_MULTIMODAL_RETRY,
  MULTIMODAL_UPLOAD_TIMEOUT_MS,
  withRetries,
} from './retry.js';

const logger = createLogger('OssUploader');
const UPLOAD_FAILURE_WARN_INTERVAL_MS = 60_000;

export class OssUploader implements Uploader {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly successKeys = new LruMap<true>(MULTIMODAL_LRU_LIMIT);
  private readonly failureWarnAt = new LruMap<number>(MULTIMODAL_LRU_LIMIT);
  private readonly abort = new AbortController();
  private closed = false;

  constructor(
    private readonly storage: Extract<MultimodalStorage, { type: 'oss' }>,
  ) {
    const parsed = parseOssStorageBasePath(storage.target.storageBasePath);
    this.bucket = parsed.bucket;
    this.prefix = parsed.prefix;
  }

  async upload(item: UploadItem, opts?: { skipIfExists?: boolean }): Promise<boolean> {
    try {
      if (this.closed) {
        logger.warn('oss upload skipped: uploader closed');
        return false;
      }

      if (!item.data || item.data.length !== item.expectedSize) {
        logger.warn('oss upload skipped: invalid payload size', {
          expectedSize: item.expectedSize,
          actualSize: item.data?.length,
        });
        return false;
      }

      const objectKey = this.prefix
        ? `${this.prefix}/${item.targetPath}`
        : item.targetPath;

      if (opts?.skipIfExists !== false && this.successKeys.has(objectKey)) {
        logger.debug('oss upload skipped (idempotent)', { targetPath: item.targetPath, size: item.expectedSize });
        return true;
      }

      const result = await withRetries(DEFAULT_MULTIMODAL_RETRY, async () => {
        if (this.closed || this.abort.signal.aborted) {
          return { ok: false as const, retryable: false, error: 'uploader closed' };
        }
        const put = await ossPutObject({
          endpoint: this.storage.target.endpoint,
          bucket: this.bucket,
          objectKey,
          accessKeyId: this.storage.auth.accessKeyId,
          accessKeySecret: this.storage.auth.accessKeySecret,
          securityToken: this.storage.auth.securityToken,
          body: item.data!,
          contentType: item.contentType,
          timeoutMs: MULTIMODAL_UPLOAD_TIMEOUT_MS,
          meta: item.meta,
          signal: this.abort.signal,
        });
        if (put.ok) return { ok: true as const, value: true };
        return {
          ok: false as const,
          retryable: put.retryable !== false,
          error: put.error,
          statusCode: put.statusCode,
        };
      }, { signal: this.abort.signal });

      if (!result.ok) {
        this.warnUploadFailure(result.statusCode, {
          statusCode: result.statusCode,
          error: result.error,
          size: item.expectedSize,
        });
        return false;
      }

      if (this.closed) {
        logger.debug('oss upload completed after close', {
          targetPath: item.targetPath,
          size: item.expectedSize,
        });
        return true;
      }
      this.successKeys.set(objectKey, true);
      logger.debug('oss upload ok', {
        targetPath: item.targetPath,
        size: item.expectedSize,
      });
      return true;
    } catch (err) {
      this.warnUploadFailure(undefined, { error: String(err), size: item.expectedSize });
      return false;
    }
  }

  private warnUploadFailure(statusCode: number | undefined, fields: Record<string, unknown>): void {
    const reason = typeof fields.error === 'string' ? fields.error : '';
    const key = `${statusCode ?? 'none'}\0${reason}`;
    const now = Date.now();
    const previous = this.failureWarnAt.get(key) ?? 0;
    if (now - previous < UPLOAD_FAILURE_WARN_INTERVAL_MS) return;
    this.failureWarnAt.set(key, now);
    logger.warn('oss upload failed', fields);
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      logger.debug('oss uploader shutdown skipped (already closed)');
      return;
    }
    this.closed = true;
    this.abort.abort();
    this.successKeys.clear();
  }
}

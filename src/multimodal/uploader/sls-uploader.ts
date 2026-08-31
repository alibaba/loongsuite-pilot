import { createLogger } from '../../utils/logger.js';
import type { MultimodalStorage, UploadItem, Uploader } from '../types.js';
import { LruMap, MULTIMODAL_LRU_LIMIT } from './lru-set.js';
import {
  DEFAULT_MULTIMODAL_RETRY,
  MULTIMODAL_UPLOAD_TIMEOUT_MS,
  withRetries,
} from './retry.js';
import {
  slsPutObject,
  slsPutViaPresignedHttp,
  tryParseOssEventStorageBasePath,
  tryParseSlsStorageBasePath,
} from './sls-client.js';

const logger = createLogger('SlsUploader');

/** SLS-backed uploader (fail-open). sls=PutObject; delegatedOss=presign then raw PUT. */
export class SlsUploader implements Uploader {
  private readonly project: string;
  private readonly logstore: string;
  private readonly expectedBucket?: string;
  private readonly successKeys = new LruMap<true>(MULTIMODAL_LRU_LIMIT);
  private readonly abort = new AbortController();
  private closed = false;

  constructor(
    private readonly storage: Extract<MultimodalStorage, { type: 'sls' | 'delegatedOss' }>,
    storageBasePath: string,
    opts?: { eventStorageBasePath?: string },
  ) {
    const parsed = tryParseSlsStorageBasePath(storageBasePath);
    this.project = storage.target.project || parsed?.project || '';
    this.logstore = storage.target.logstore || parsed?.logstore || '';
    if (!this.project || !this.logstore) {
      throw new Error('multimodal.storage.target requires project and logstore');
    }
    const eventTarget = tryParseOssEventStorageBasePath(opts?.eventStorageBasePath ?? '');
    this.expectedBucket = eventTarget?.bucket ?? storage.target.ossBucket;
  }

  async upload(item: UploadItem, opts?: { skipIfExists?: boolean }): Promise<boolean> {
    try {
      if (this.closed) {
        logger.warn('sls upload skipped: uploader closed');
        return false;
      }

      if (!item.data || item.data.length !== item.expectedSize) {
        logger.warn('sls upload skipped: invalid payload size', {
          expectedSize: item.expectedSize,
          actualSize: item.data?.length,
        });
        return false;
      }

      const objectKey = item.targetPath;

      if (opts?.skipIfExists !== false && this.successKeys.has(objectKey)) {
        logger.debug('sls upload skipped (idempotent)', { targetPath: item.targetPath, size: item.expectedSize });
        return true;
      }

      const result = await withRetries(DEFAULT_MULTIMODAL_RETRY, async () => {
        if (this.closed || this.abort.signal.aborted) {
          return { ok: false as const, retryable: false, error: 'uploader closed' };
        }
        const put = await this.writeObject(objectKey, item);
        if (put.ok) return { ok: true as const, value: put.requestId };
        return {
          ok: false as const,
          retryable: put.retryable !== false,
          error: put.error,
          statusCode: put.statusCode,
        };
      }, { signal: this.abort.signal });

      if (!result.ok) {
        logger.warn('sls upload failed', {
          statusCode: result.statusCode,
          error: result.error,
          size: item.expectedSize,
          targetPath: item.targetPath,
        });
        return false;
      }

      if (this.closed) {
        logger.debug('sls upload completed after close', {
          targetPath: item.targetPath,
          size: item.expectedSize,
          requestId: result.value,
        });
        return true;
      }
      this.successKeys.set(objectKey, true);
      logger.debug('sls upload ok', {
        targetPath: item.targetPath,
        size: item.expectedSize,
        requestId: result.value,
      });
      return true;
    } catch (err) {
      logger.warn('sls upload failed', { error: String(err), size: item.expectedSize });
      return false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      logger.debug('sls uploader shutdown skipped (already closed)');
      return;
    }
    this.closed = true;
    this.abort.abort();
    this.successKeys.clear();
  }

  private writeObject(objectKey: string, item: UploadItem) {
    const auth = this.storage.auth;
    const params = {
      endpoint: this.storage.target.endpoint,
      project: this.project,
      logstore: this.logstore,
      objectKey,
      mode: auth.mode,
      ...(auth.mode === 'ak'
        ? {
          accessKeyId: auth.accessKeyId,
          accessKeySecret: auth.accessKeySecret,
          securityToken: auth.securityToken,
        }
        : { apiKey: auth.apiKey }),
      body: item.data!,
      contentType: item.contentType,
      timeoutMs: MULTIMODAL_UPLOAD_TIMEOUT_MS,
      meta: item.meta,
      signal: this.abort.signal,
    };
    return this.storage.type === 'delegatedOss'
      ? slsPutViaPresignedHttp({
        ...params,
        expectedBucket: this.expectedBucket,
      })
      : slsPutObject(params);
  }
}

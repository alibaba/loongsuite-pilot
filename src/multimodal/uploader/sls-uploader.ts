import { createLogger } from '../../utils/logger.js';
import type { MultimodalSlsConfig, UploadItem, Uploader } from '../types.js';
import { LruMap, MULTIMODAL_LRU_LIMIT } from './lru-set.js';
import {
  DEFAULT_MULTIMODAL_RETRY,
  MULTIMODAL_UPLOAD_TIMEOUT_MS,
  withRetries,
} from './retry.js';
import {
  slsPutObject,
  slsPutViaPresignedHttp,
  tryParseSlsStorageBasePath,
} from './sls-client.js';

const logger = createLogger('SlsUploader');

/** SLS uploader (fail-open). putObject: AK/ApiKey API write. http: ApiKey presign then raw PUT. */
export class SlsUploader implements Uploader {
  private readonly project: string;
  private readonly logstore: string;
  private readonly successKeys = new LruMap<true>(MULTIMODAL_LRU_LIMIT);
  private closed = false;

  constructor(
    private readonly sls: MultimodalSlsConfig,
    storageBasePath: string,
  ) {
    const parsed = tryParseSlsStorageBasePath(storageBasePath);
    this.project = sls.project || parsed?.project || '';
    this.logstore = sls.logstore || parsed?.logstore || '';
    if (!this.project || !this.logstore) {
      throw new Error('multimodal.sls requires project and logstore');
    }
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
        if (this.closed) {
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
      });

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
    this.successKeys.clear();
  }

  private writeObject(objectKey: string, item: UploadItem) {
    const params = {
      endpoint: this.sls.endpoint,
      project: this.project,
      logstore: this.logstore,
      objectKey,
      mode: this.sls.auth.mode,
      accessKeyId: this.sls.auth.accessKeyId,
      accessKeySecret: this.sls.auth.accessKeySecret,
      securityToken: this.sls.auth.securityToken,
      apiKey: this.sls.auth.apiKey,
      body: item.data!,
      contentType: item.contentType,
      timeoutMs: MULTIMODAL_UPLOAD_TIMEOUT_MS,
      meta: item.meta,
    };
    return this.sls.writeVia === 'http'
      ? slsPutViaPresignedHttp(params)
      : slsPutObject(params);
  }
}

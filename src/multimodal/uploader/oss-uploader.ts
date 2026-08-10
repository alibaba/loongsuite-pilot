import { createLogger } from '../../utils/logger.js';
import type { MultimodalOssConfig, UploadItem, Uploader } from '../types.js';
import { LruMap, MULTIMODAL_LRU_LIMIT } from './lru-set.js';
import { ossPutObject, parseOssStorageBasePath } from './oss-client.js';
import {
  DEFAULT_MULTIMODAL_RETRY,
  MULTIMODAL_UPLOAD_TIMEOUT_MS,
  withRetries,
} from './retry.js';

const logger = createLogger('OssUploader');

export class OssUploader implements Uploader {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly successKeys = new LruMap<true>(MULTIMODAL_LRU_LIMIT);

  constructor(
    private readonly oss: MultimodalOssConfig,
    private readonly storageBasePath: string,
  ) {
    const parsed = parseOssStorageBasePath(storageBasePath);
    this.bucket = parsed.bucket;
    this.prefix = parsed.prefix;
  }

  async upload(item: UploadItem, opts?: { skipIfExists?: boolean }): Promise<boolean> {
    try {
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
        const put = await ossPutObject({
          endpoint: this.oss.endpoint,
          bucket: this.bucket,
          objectKey,
          accessKeyId: this.oss.accessKeyId,
          accessKeySecret: this.oss.accessKeySecret,
          securityToken: this.oss.securityToken,
          body: item.data!,
          contentType: item.contentType,
          timeoutMs: MULTIMODAL_UPLOAD_TIMEOUT_MS,
          meta: item.meta,
        });
        if (put.ok) return { ok: true as const, value: true };
        return {
          ok: false as const,
          retryable: put.retryable !== false,
          error: put.error,
          statusCode: put.statusCode,
        };
      });

      if (!result.ok) {
        logger.warn('oss upload failed', {
          statusCode: result.statusCode,
          error: result.error,
          size: item.expectedSize,
        });
        return false;
      }

      this.successKeys.set(objectKey, true);
      return true;
    } catch (err) {
      logger.warn('oss upload failed', { error: String(err), size: item.expectedSize });
      return false;
    }
  }

  async shutdown(_timeoutMs?: number): Promise<void> {
    this.successKeys.clear();
  }
}

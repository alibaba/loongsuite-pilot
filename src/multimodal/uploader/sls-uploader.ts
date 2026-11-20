import { createLogger } from '../../utils/logger.js';
import type {
  MultimodalStorage,
  StorageBaseResult,
  UploadItem,
  UploadOptions,
  Uploader,
} from '../types.js';
import { LruMap, MULTIMODAL_LRU_LIMIT } from './lru-set.js';
import {
  DEFAULT_MULTIMODAL_RETRY,
  MULTIMODAL_UPLOAD_TIMEOUT_MS,
  withRetries,
} from './retry.js';
import {
  PRESIGN_ORIGIN_MISMATCH_ERROR,
  slsPutObject,
  slsPutViaPresignedHttp,
  slsStorageAuthFields,
  sniffSlsHttpEventStorageBasePath,
  tryParseSlsStorageBasePath,
  type SlsResult,
} from './sls-client.js';

const logger = createLogger('SlsUploader');
const UPLOAD_FAILURE_WARN_INTERVAL_MS = 60_000;

function xmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
}

/** Stable error identity: SLS errorCode/errorMessage, or OSS Code/Message. */
function stableFailureReason(error: unknown): string {
  if (typeof error !== 'string' || !error) return '';
  const jsonStart = error.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(error.slice(jsonStart)) as Record<string, unknown>;
      const code = typeof parsed.errorCode === 'string' ? parsed.errorCode : '';
      const message = typeof parsed.errorMessage === 'string' ? parsed.errorMessage : '';
      if (code || message) return `${code}\0${message}`;
    } catch {
      // Body is not JSON.
    }
  }
  const code = xmlTag(error, 'Code');
  const message = xmlTag(error, 'Message');
  if (code || message) return `${code}\0${message}`;
  return '';
}

/** SLS-backed uploader (fail-open). sls=PutObject; delegatedOss=presign then raw PUT. */
export class SlsUploader implements Uploader {
  private readonly project: string;
  private readonly logstore: string;
  private expectedOrigin?: string;
  private readonly successKeys = new LruMap<true>(MULTIMODAL_LRU_LIMIT);
  private readonly failureWarnAt = new LruMap<number>(MULTIMODAL_LRU_LIMIT);
  private readonly abort = new AbortController();
  private closed = false;

  constructor(
    private readonly storage: Extract<MultimodalStorage, { type: 'sls' | 'delegatedOss' }>,
    storageBasePath: string,
    opts?: { expectedPresignOrigin?: string },
  ) {
    const parsed = tryParseSlsStorageBasePath(storageBasePath);
    this.project = storage.target.project || parsed?.project || '';
    this.logstore = storage.target.logstore || parsed?.logstore || '';
    if (!this.project || !this.logstore) {
      throw new Error('multimodal.storage.target requires project and logstore');
    }
    if (storage.type === 'delegatedOss') {
      const origin = (opts?.expectedPresignOrigin ?? '').trim();
      if (origin) this.expectedOrigin = origin;
    }
  }

  /** OSS origin that a presigned PUT URL must match. */
  setExpectedPresignOrigin(origin: string): void {
    const trimmed = origin.trim();
    if (!trimmed) {
      throw new Error('delegatedOss requires expectedPresignOrigin');
    }
    if (this.expectedOrigin && this.expectedOrigin !== trimmed) {
      this.successKeys.clear();
    }
    this.expectedOrigin = trimmed;
  }

  /** Presign to learn the delegatedOss bucket and event URI prefix. */
  async discoverDelegatedOssBucket(): Promise<StorageBaseResult> {
    if (this.storage.type !== 'delegatedOss') {
      return { ok: false, error: 'delegatedOss bucket discovery requires delegatedOss storage' };
    }
    if (this.closed || this.abort.signal.aborted) {
      return { ok: false, error: 'uploader closed' };
    }
    try {
      const sniffed = await sniffSlsHttpEventStorageBasePath({
        endpoint: this.storage.target.endpoint,
        project: this.project,
        logstore: this.logstore,
        ...slsStorageAuthFields(this.storage.auth),
        signal: this.abort.signal,
      });
      if (!sniffed.ok) return { ok: false, error: sniffed.error };
      const storageBasePath = sniffed.storageBasePath.trim().replace(/\/+$/, '');
      if (!storageBasePath) return { ok: false, error: 'multimodal storageBasePath is required' };
      this.setExpectedPresignOrigin(sniffed.origin);
      return { ok: true, storageBasePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async upload(item: UploadItem, opts?: UploadOptions): Promise<boolean> {
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
          requestId: put.requestId,
        };
      }, { signal: this.abort.signal });

      if (!result.ok) {
        if (result.error === PRESIGN_ORIGIN_MISMATCH_ERROR) opts?.onStorageBaseInvalidated?.();
        this.warnUploadFailure(result.statusCode, {
          statusCode: result.statusCode,
          error: result.error,
          requestId: result.requestId,
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
      this.warnUploadFailure(undefined, { error: String(err), size: item.expectedSize });
      return false;
    }
  }

  private warnUploadFailure(statusCode: number | undefined, fields: Record<string, unknown>): void {
    const error = typeof fields.error === 'string' ? fields.error : '';
    const reason = statusCode === undefined ? error.slice(0, 200) : stableFailureReason(error);
    const key = `${statusCode ?? 'none'}\0${reason}`;
    const now = Date.now();
    const previous = this.failureWarnAt.get(key) ?? 0;
    if (now - previous < UPLOAD_FAILURE_WARN_INTERVAL_MS) return;
    this.failureWarnAt.set(key, now);
    logger.warn('sls upload failed', fields);
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

  private writeObject(objectKey: string, item: UploadItem): Promise<SlsResult> {
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
        : auth.mode === 'apiKey'
          ? { apiKey: auth.apiKey }
          : {}),
      body: item.data!,
      contentType: item.contentType,
      timeoutMs: MULTIMODAL_UPLOAD_TIMEOUT_MS,
      meta: item.meta,
      signal: this.abort.signal,
    };
    if (this.storage.type !== 'delegatedOss') return slsPutObject(params);
    if (!this.expectedOrigin) {
      return Promise.resolve({
        ok: false,
        error: 'delegatedOss bucket is unknown',
        retryable: false,
      });
    }
    return slsPutViaPresignedHttp({
      ...params,
      expectedOrigin: this.expectedOrigin,
    });
  }
}

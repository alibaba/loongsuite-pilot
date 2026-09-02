import type { MultimodalRuntimeConfig, Uploader } from '../types.js';
import { OssUploader } from './oss-uploader.js';
import { SlsUploader } from './sls-uploader.js';

/** Build configured Uploader; throws if credentials missing. */
export function createUploader(
  config: MultimodalRuntimeConfig,
  opts?: { expectedPresignOrigin?: string },
): Uploader {
  if (config.storage.type === 'oss') {
    return new OssUploader(config.storage);
  }
  if (config.storage.type === 'delegatedOss' && !(opts?.expectedPresignOrigin ?? '').trim()) {
    throw new Error('delegatedOss requires expectedPresignOrigin');
  }
  return new SlsUploader(config.storage, config.storageBasePath, opts);
}

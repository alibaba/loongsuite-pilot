import type { MultimodalRuntimeConfig, Uploader } from '../types.js';
import { OssUploader } from './oss-uploader.js';
import { SlsUploader } from './sls-uploader.js';

/** Build the uploader for the configured storage. */
export function createUploader(
  config: MultimodalRuntimeConfig,
  opts?: { expectedPresignOrigin?: string },
): Uploader {
  if (config.storage.type === 'oss') {
    return new OssUploader(config.storage);
  }
  return new SlsUploader(config.storage, config.storageBasePath, opts);
}

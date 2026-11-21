import type {
  MultimodalRuntimeConfig,
  MultimodalStorage,
  StorageBaseResult,
  Uploader,
} from '../types.js';
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

/** Build a delegatedOss uploader with its storage discovery function. */
export function createDelegatedOssUploader(
  storage: Extract<MultimodalStorage, { type: 'delegatedOss' }>,
  storageBasePath: string,
): { uploader: Uploader; resolveStorageBase: () => Promise<StorageBaseResult> } {
  const uploader = new SlsUploader(storage, storageBasePath);
  return {
    uploader,
    resolveStorageBase: () => uploader.discoverDelegatedOssBucket(),
  };
}

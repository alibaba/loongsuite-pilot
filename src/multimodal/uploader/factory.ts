import type { MultimodalRuntimeConfig, Uploader } from '../types.js';
import { OssUploader } from './oss-uploader.js';
import { SlsUploader } from './sls-uploader.js';

/**
 * Construct the configured Uploader. Throws on missing / invalid credentials
 * so orchestrator can disable multimodal for the process (fail-open to text).
 */
export function createUploader(config: MultimodalRuntimeConfig): Uploader {
  if (config.uploader === 'oss') {
    if (!config.oss) throw new Error('multimodal.oss config is required');
    return new OssUploader(config.oss, config.storageBasePath);
  }
  if (config.uploader === 'sls') {
    if (!config.sls) throw new Error('multimodal.sls config is required');
    return new SlsUploader(config.sls, config.storageBasePath);
  }
  throw new Error(`unsupported multimodal.uploader: ${config.uploader}`);
}

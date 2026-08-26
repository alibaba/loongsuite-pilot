export {
  anyAgentMultimodalEnabled,
  isAgentMultimodalEnabled,
  isMultimodalSupportedAgent,
} from './agent-gate.js';
export { MULTIMODAL_SUPPORTED_AGENT_IDS } from '../types/index.js';
export { MultimodalProcessor } from './processor.js';
export {
  decodeBlobContent,
  extFromMime,
  isImageFilePath,
  joinStorageUri,
  mimeFromImagePath,
  modalityFromMime,
  readImagePathBytes,
  statImagePath,
  yyyymmddFromUnixMs,
  yyyymmddLocal,
} from './resolve.js';
export {
  attachMultimodalMetadata,
  attachMultimodalMetadataForEntry,
  isUriPart,
} from './rewrite.js';
export { createUploader } from './uploader/factory.js';
export { resolveMultimodalEventStorageBasePath } from './uploader/sls-client.js';
export { OssUploader } from './uploader/oss-uploader.js';
export { SlsUploader } from './uploader/sls-uploader.js';
export type {
  BlobPart,
  BlobToUriFn,
  BlobToUriParams,
  MultimodalMetadataItem,
  MultimodalRuntimeConfig,
  PathBytes,
  PathStat,
  PathToUriFn,
  UploadItem,
  UploadMode,
  Uploader,
  UploaderKind,
  UriConvertMeta,
  UriPart,
  UriResult,
} from './types.js';
export {
  MAX_MULTIMODAL_BASE64_CHARS,
  MAX_MULTIMODAL_DATA_SIZE,
  MAX_MULTIMODAL_PARTS,
  MAX_MULTIMODAL_PATH_INFLIGHT,
  MAX_MULTIMODAL_PENDING_BYTES,
  MAX_MULTIMODAL_PENDING_UPLOADS,
  MULTIMODAL_METADATA_FIELD,
  MULTIMODAL_SHUTDOWN_TIMEOUT_MS,
} from './types.js';

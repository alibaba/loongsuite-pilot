export {
  anyAgentMultimodalEnabled,
  isAgentMultimodalEnabled,
} from './agent-gate.js';
export { MultimodalProcessor } from './processor.js';
export { matchAll, resolveImagePath, takeUniqueExtractedPaths } from './resolve.js';
export { attachMultimodalMetadataForEntry } from './rewrite.js';
export { createDelegatedOssUploader, createUploader } from './uploader/factory.js';
export type {
  PathToUriFn,
  UriPart,
} from './types.js';
export { MAX_MULTIMODAL_PARTS, MAX_MULTIMODAL_PATH_CHARS } from './types.js';

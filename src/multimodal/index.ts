export {
  anyAgentMultimodalEnabled,
  isAgentMultimodalEnabled,
} from './agent-gate.js';
export { MultimodalProcessor } from './processor.js';
export { isImageFilePath } from './resolve.js';
export { attachMultimodalMetadataForEntry } from './rewrite.js';
export { createUploader } from './uploader/factory.js';
export type {
  PathToUriFn,
  UriPart,
  UriResult,
} from './types.js';
export { MAX_MULTIMODAL_PARTS } from './types.js';

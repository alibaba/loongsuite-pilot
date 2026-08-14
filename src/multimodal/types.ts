export type {
  MultimodalOssConfig,
  MultimodalRuntimeConfig,
  MultimodalSlsConfig,
  MultimodalUploadMode as UploadMode,
  MultimodalUploaderKind as UploaderKind,
} from '../types/index.js';

export interface UploadItem {
  /** Object key: YYYYMMDD/<sha256>.ext */
  targetPath: string;
  contentType: string;
  meta: Record<string, string>;
  data?: Buffer;
  sourceUri?: string;
  expectedSize: number;
}

export interface Uploader {
  upload(item: UploadItem, opts?: { skipIfExists?: boolean }): Promise<boolean>;
  shutdown(): Promise<void>;
}

export interface UriConvertMeta {
  mime_type?: string;
  modality?: string;
  /** Event time for object-key date dir. */
  time_unix_ms?: number;
}

export interface UriResult {
  uri: string;
  mime_type: string;
  modality?: string;
  size: number;
  sha256: string;
}

export interface UriPart {
  type: 'uri';
  uri: string;
  mime_type?: string;
  modality?: string;
}

/** Item in gen_ai.input.multimodal_metadata. */
export interface MultimodalMetadataItem {
  uri: string;
  mime_type: string;
  modality?: string;
}

export interface BlobToUriParams extends UriConvertMeta {
  /** Raw base64 (not data-URL). */
  content: string;
  /** Replay reuse key, e.g. offset:partIndex. */
  reuseKey?: string;
}

/** base64 → uri (injected by callers like Codex). */
export type BlobToUriFn = (params: BlobToUriParams) => UriResult | null;

export interface BlobPart {
  type: 'blob';
  mime_type?: string;
  modality?: string;
  content: string;
}

/** Local path → uri (injected by callers like Qoder). */
export type PathToUriFn = (
  filePath: string,
  timeUnixMs?: number,
) => Promise<UriResult | null>;

export interface PathStat {
  resolvedPath: string;
  mime_type: string;
  size: number;
  mtimeMs: number;
}

export interface PathBytes {
  bytes: Buffer;
  mime_type: string;
  size: number;
}

export const MAX_MULTIMODAL_PARTS = 10;
export const MAX_MULTIMODAL_DATA_SIZE = 30 * 1024 * 1024;
export const MAX_MULTIMODAL_PENDING_UPLOADS = 1024;
export const MAX_MULTIMODAL_PENDING_BYTES = 1024 * 1024 * 1024;
/** Cap on concurrent pathToUri reads. */
export const MAX_MULTIMODAL_PATH_INFLIGHT = 1024;
/** Max base64 chars (~4/3 of MAX_MULTIMODAL_DATA_SIZE). */
export const MAX_MULTIMODAL_BASE64_CHARS = Math.ceil(MAX_MULTIMODAL_DATA_SIZE * 4 / 3) + 16;
export const MULTIMODAL_SHUTDOWN_TIMEOUT_MS = 1_500;
export const MULTIMODAL_METADATA_FIELD = 'gen_ai.input.multimodal_metadata';

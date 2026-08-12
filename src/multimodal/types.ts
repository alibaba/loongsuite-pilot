export type {
  MultimodalOssConfig,
  MultimodalRuntimeConfig,
  MultimodalSlsConfig,
  MultimodalUploadMode as UploadMode,
  MultimodalUploaderKind as UploaderKind,
} from '../types/index.js';

// ─── Upload ───────────────────────────────────────────────────────────────────

export interface UploadItem {
  /** Relative object key: YYYYMMDD/<sha256>.ext */
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

// ─── Shared (blob + path → uri) ───────────────────────────────────────────────

/** Optional metadata for write-time uri conversion. */
export interface UriConvertMeta {
  mime_type?: string;
  modality?: string;
  /** Unix ms for object-key date directory. */
  time_unix_ms?: number;
}

/** Result of blobToUri / pathToUri. */
export interface UriResult {
  uri: string;
  mime_type: string;
  modality?: string;
  size: number;
  sha256: string;
}

/** On-event GenAI uri part. */
export interface UriPart {
  type: 'uri';
  mime_type?: string;
  modality?: string;
  uri: string;
}

/** Summary item for gen_ai.input.multimodal_metadata. */
export interface MultimodalMetadataItem {
  uri: string;
  mime_type: string;
  modality?: string;
}

// ─── Blob (base64) ────────────────────────────────────────────────────────────

/** Input for MultimodalProcessor.blobToUri. */
export interface BlobToUriParams extends UriConvertMeta {
  /** Raw base64 (not a data-URL). */
  content: string;
}

/** Injected: base64 → uri (e.g. Codex). */
export type BlobToUriFn = (params: BlobToUriParams) => UriResult | null;

/** On-event GenAI blob part (legacy carrier). */
export interface BlobPart {
  type: 'blob';
  mime_type?: string;
  modality?: string;
  content: string;
}

// ─── Path (local file) ────────────────────────────────────────────────────────

/** Injected: local path → uri (e.g. Qoder IDE). */
export type PathToUriFn = (
  filePath: string,
  timeUnixMs?: number,
) => Promise<UriResult | null>;

/** Local image path after stat. */
export interface PathStat {
  resolvedPath: string;
  mime_type: string;
  size: number;
}

/** Local file bytes before bytes → uri. */
export interface PathBytes {
  bytes: Buffer;
  mime_type: string;
  size: number;
}

// ─── Limits ───────────────────────────────────────────────────────────────────

export const MAX_MULTIMODAL_PARTS = 10;
export const MAX_MULTIMODAL_DATA_SIZE = 30 * 1024 * 1024;
export const MAX_MULTIMODAL_PENDING_UPLOADS = 1024;
export const MAX_MULTIMODAL_PENDING_BYTES = 1024 * 1024 * 1024;
/** ~4/3 of MAX_MULTIMODAL_DATA_SIZE + padding. */
export const MAX_MULTIMODAL_BASE64_CHARS = Math.ceil(MAX_MULTIMODAL_DATA_SIZE * 4 / 3) + 16;
export const MULTIMODAL_SHUTDOWN_TIMEOUT_MS = 1_500;
export const MULTIMODAL_METADATA_FIELD = 'gen_ai.input.multimodal_metadata';

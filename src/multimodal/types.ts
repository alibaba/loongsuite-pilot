export type {
  MultimodalOssConfig,
  MultimodalRuntimeConfig,
  MultimodalSlsConfig,
  MultimodalUploadMode as UploadMode,
  MultimodalUploaderKind as UploaderKind,
} from '../types/index.js';

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
  shutdown(timeoutMs?: number): Promise<void>;
}

/** Raw base64 payload for MultimodalProcessor.toUri. */
export interface BlobToUriParams {
  content: string;
  mime_type?: string;
  modality?: string;
  /** Event time (unix ms) for object-key date directory; falls back to now. */
  time_unix_ms?: number;
}

/** Optimistic uri result; upload may still be in flight. */
export interface BlobToUriResult {
  uri: string;
  mime_type: string;
  modality?: string;
  size: number;
  sha256: string;
}

/** GenAI blob part (legacy carrier; Inputs should prefer write-time uri). */
export interface BlobPart {
  type: 'blob';
  mime_type?: string;
  modality?: string;
  content: string;
}

/** GenAI uri part after toUri. */
export interface UriPart {
  type: 'uri';
  mime_type?: string;
  modality?: string;
  uri: string;
}

export interface MultimodalMetadataItem {
  uri: string;
  mime_type: string;
  size: number;
  sha256: string;
}

/** Hard limits (not config-driven). */
export const MAX_MULTIMODAL_PARTS = 10;
export const MAX_MULTIMODAL_DATA_SIZE = 30 * 1024 * 1024;
/** Max in-flight upload tasks; when full, still return uri but skip enqueue. */
export const MAX_MULTIMODAL_PENDING_UPLOADS = 1024;
/**
 * Max total bytes held by in-flight uploads (sum of decoded payload sizes).
 * When exceeded, still return uri but skip enqueue. 0 would mean unlimited.
 */
export const MAX_MULTIMODAL_PENDING_BYTES = 1024 * 1024 * 1024;
/**
 * Max base64 character length before decode (~4/3 of MAX_MULTIMODAL_DATA_SIZE + padding).
 * Avoids allocating huge Buffers from oversized strings.
 */
export const MAX_MULTIMODAL_BASE64_CHARS = Math.ceil(MAX_MULTIMODAL_DATA_SIZE * 4 / 3) + 16;
/** Best-effort wait for in-flight uploads on shutdown; leftover uris may dangle. */
export const MULTIMODAL_SHUTDOWN_TIMEOUT_MS = 1_500;
export const MULTIMODAL_METADATA_FIELD = 'gen_ai.input.multimodal_metadata';

import type { AgentActivityEntry, JsonValue, MultimodalUploadMode } from '../../types/index.js';
import {
  multimodalUploadIncludesInput,
  multimodalUploadIncludesOutput,
} from '../../types/index.js';
import {
  asRecord,
  attachMultimodalMetadataForEntry,
  matchAll,
  takeUniqueExtractedPaths,
  timeUnixNanoToMillis,
  MAX_MULTIMODAL_PATH_CHARS,
  convertPathsToUriParts,
  type PathToUriFn,
  type UriPart,
} from '../../multimodal/index.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('QoderCliMultimodal');

const MEDIA_EXT = 'png|jpe?g|gif|webp|bmp|svg|ico|tif|tiff|mp4|mov|m4v|3gp|3g2|webm|mkv|avi';
const IMAGE_SOURCE_RE = new RegExp(
  `\\[Image:\\s*source:\\s*([^\\]]{1,${MAX_MULTIMODAL_PATH_CHARS}})\\]`,
  'gi',
);
const AT_IMAGE_RE = new RegExp(
  `@([^\\s@]{1,${MAX_MULTIMODAL_PATH_CHARS}}\\.(?:${MEDIA_EXT}))\\b`,
  'gi',
);
const FILE_CITATION_RE = new RegExp(
  `文件[:：]\\s*([^\\n\\r]{1,${MAX_MULTIMODAL_PATH_CHARS}}\\.(?:${MEDIA_EXT}))\\b`,
  'gi',
);
const READ_IMAGE_RE = new RegExp(`Read image:\\s*([^\\n\\r]{1,${MAX_MULTIMODAL_PATH_CHARS}})`, 'gi');
const IMAGE_FILE_RE = new RegExp(`Image file:\\s*([^\\n\\r]{1,${MAX_MULTIMODAL_PATH_CHARS}})`, 'gi');
const IMAGE_GEN_PATH_RE = new RegExp(
  `The absolute path of the image is:\\s*([^\\n\\r]{1,${MAX_MULTIMODAL_PATH_CHARS}})`,
  'gi',
);
const SIZE_SUFFIX_RE = /\s+\(\d+(?:\.\d+)?\s*[KMGT]?B\)\s*$/i;

interface EnrichStats {
  inputUri: number;
  toolUri: number;
  outputUri: number;
  skipped: number;
}

export interface EnrichCliMultimodalOptions {
  uploadMode: MultimodalUploadMode;
  pathToUri: PathToUriFn;
}

/**
 * CLI-only multimodal enrichment. Mutates entries in place.
 * Input: union of `agent.qoder.attachments[].filename`, `[Image: source:]`,
 * `@path`, and `文件：<image or video path>`, then unique-resolve.
 * Tool result: Read/ImageGen. Tool call: Read `file_path` (output mode).
 * Assistant finals do not embed images. Fail-open.
 */
export async function enrichCliMultimodal(
  entries: AgentActivityEntry[],
  opts: EnrichCliMultimodalOptions,
): Promise<void> {
  try {
    await enrichCliMultimodalInner(entries, opts);
  } catch (err) {
    logger.warn('qoder cli multimodal enrich failed; continuing without media', {
      error: String(err),
    });
  }
}

async function enrichCliMultimodalInner(
  entries: AgentActivityEntry[],
  opts: EnrichCliMultimodalOptions,
): Promise<void> {
  if (entries.length === 0) return;
  if (opts.uploadMode === 'none') return;

  const stats: EnrichStats = { inputUri: 0, toolUri: 0, outputUri: 0, skipped: 0 };
  const includeInput = multimodalUploadIncludesInput(opts.uploadMode);
  const includeOutput = multimodalUploadIncludesOutput(opts.uploadMode);
  let touchedEntries = 0;

  for (const entry of entries) {
    const name = entry['event.name'];
    let n = 0;
    if (includeInput && (name === 'llm.request' || name === 'other')) {
      n = await enrichInputImages(entry, opts.pathToUri, stats);
      stats.inputUri += n;
    } else if (includeInput && name === 'tool.result') {
      n = await enrichToolResultImages(entry, opts.pathToUri, stats);
      stats.toolUri += n;
    } else if (includeOutput && name === 'tool.call') {
      n = await enrichToolCallImages(entry, opts.pathToUri, stats);
      stats.outputUri += n;
    }
    if (n > 0) {
      touchedEntries += 1;
      try {
        attachMultimodalMetadataForEntry(entry);
      } catch (err) {
        logger.debug('attach multimodal metadata failed', { error: String(err) });
      }
    }
  }

  if (stats.inputUri > 0 || stats.toolUri > 0 || stats.outputUri > 0 || stats.skipped > 0) {
    logger.info('qoder cli multimodal enrich', {
      uploadMode: opts.uploadMode,
      sessionId: sessionIdOf(entries),
      ...stats,
      touchedEntries,
    });
  }
}

async function enrichInputImages(
  entry: AgentActivityEntry,
  pathToUri: PathToUriFn,
  stats: EnrichStats,
): Promise<number> {
  if (!Array.isArray(entry['gen_ai.input.messages_delta'])) return 0;
  const paths = extractInputImagePaths(entry, cwdOf(entry));
  if (paths.length === 0) return 0;
  return appendUriPartsToMessagesDelta(entry, paths, pathToUri, timeUnixNanoToMillis(entry.time_unix_nano), stats);
}

async function enrichToolResultImages(
  entry: AgentActivityEntry,
  pathToUri: PathToUriFn,
  stats: EnrichStats,
): Promise<number> {
  const raw = entry['gen_ai.tool.call.result'];
  if (typeof raw !== 'string' || !raw) return 0;
  const paths = extractToolImagePaths(raw, cwdOf(entry));
  if (paths.length === 0) return 0;
  const uriParts = await convertPathsToUriParts(paths, pathToUri, timeUnixNanoToMillis(entry.time_unix_nano), stats, logger);
  if (uriParts.length === 0) return 0;
  entry['gen_ai.tool.call.result'] = [
    { type: 'text', content: raw },
    ...uriParts,
  ] as unknown as JsonValue;
  return uriParts.length;
}

async function enrichToolCallImages(
  entry: AgentActivityEntry,
  pathToUri: PathToUriFn,
  stats: EnrichStats,
): Promise<number> {
  if (entry['gen_ai.tool.name'] !== 'Read') return 0;
  const raw = entry['gen_ai.tool.call.arguments'];
  if (raw === undefined || raw === null || raw === '') return 0;
  if (Array.isArray(raw)) return 0;
  const paths = extractToolCallImagePaths(raw, cwdOf(entry));
  if (paths.length === 0) return 0;
  const uriParts = await convertPathsToUriParts(paths, pathToUri, timeUnixNanoToMillis(entry.time_unix_nano), stats, logger);
  if (uriParts.length === 0) return 0;
  const original = typeof raw === 'string' ? raw : JSON.stringify(raw);
  entry['gen_ai.tool.call.arguments'] = [
    { type: 'text', content: original },
    ...uriParts,
  ] as unknown as JsonValue;
  return uriParts.length;
}

async function appendUriPartsToMessagesDelta(
  entry: AgentActivityEntry,
  paths: string[],
  pathToUri: PathToUriFn,
  timeMs: number,
  stats: EnrichStats,
): Promise<number> {
  const messages = entry['gen_ai.input.messages_delta'];
  if (!Array.isArray(messages) || messages.length === 0) {
    const uriParts = await convertPathsToUriParts(paths, pathToUri, timeMs, stats, logger);
    if (uriParts.length === 0) return 0;
    entry['gen_ai.input.messages_delta'] = [
      { role: 'user', parts: uriParts },
    ] as unknown as JsonValue;
    return uriParts.length;
  }

  const first = messages[0];
  if (!first || typeof first !== 'object') return 0;
  const record = first as Record<string, unknown>;
  const parts: unknown[] = Array.isArray(record.parts) ? record.parts : [];
  record.parts = parts;
  const uriParts = await convertPathsToUriParts(paths, pathToUri, timeMs, stats, logger);
  if (uriParts.length === 0) return 0;
  parts.push(...uriParts);
  return uriParts.length;
}

export function extractInputImagePaths(
  source: AgentActivityEntry | string,
  cwd?: string,
): string[] {
  const text = typeof source === 'string' ? source : collectMessageDeltaTexts(source);
  return takeUniqueExtractedPaths([
    ...(typeof source === 'string' ? [] : attachmentImageFilenames(source)),
    ...matchAll(IMAGE_SOURCE_RE, text).map(stripImageSourcePath),
    ...matchAll(AT_IMAGE_RE, text),
    ...matchAll(FILE_CITATION_RE, text),
  ], cwd);
}

export function attachmentImageFilenames(entry: AgentActivityEntry): string[] {
  const raw = (entry as Record<string, unknown>)['agent.qoder.attachments'];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (rec.type !== 'image_file') continue;
    if (typeof rec.filename !== 'string') continue;
    const filename = rec.filename.trim();
    if (filename) out.push(filename);
  }
  return out;
}

export function extractToolImagePaths(text: string, cwd?: string): string[] {
  return takeUniqueExtractedPaths([
    ...matchAll(READ_IMAGE_RE, text).map(stripSizeSuffix),
    ...matchAll(IMAGE_FILE_RE, text).map(stripSizeSuffix),
    ...matchAll(IMAGE_GEN_PATH_RE, text),
  ], cwd);
}

export function extractToolCallImagePaths(args: unknown, cwd?: string): string[] {
  const record = asRecord(args);
  const filePath = typeof record?.file_path === 'string' ? record.file_path.trim() : '';
  if (!filePath) return [];
  return takeUniqueExtractedPaths([filePath], cwd);
}

function stripSizeSuffix(raw: string): string {
  return raw.replace(SIZE_SUFFIX_RE, '').trim();
}

function stripImageSourcePath(raw: string): string {
  return raw.replace(/,\s*original\b.*$/i, '').trim();
}

function collectMessageDeltaTexts(entry: AgentActivityEntry): string {
  const messages = entry['gen_ai.input.messages_delta'];
  if (!Array.isArray(messages)) return '';
  const chunks: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const parts = (message as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p.type === 'text' && typeof p.content === 'string') chunks.push(p.content);
    }
  }
  return chunks.join('\n');
}

function cwdOf(entry: AgentActivityEntry): string | undefined {
  const cwd = (entry as Record<string, unknown>)['agent.qoder.cwd'];
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined;
}

function sessionIdOf(entries: AgentActivityEntry[]): string | undefined {
  for (const entry of entries) {
    const sid = entry['gen_ai.session.id'];
    if (typeof sid === 'string' && sid.trim()) return sid.trim();
  }
  return undefined;
}

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
  type PathToUriFn,
  type UriPart,
} from '../../multimodal/index.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('QwenWorkCNMultimodal');

/** Local path inside a pasted, selected, or dragged image tag. Extra attributes may follow `file`. */
const PASTED_IMAGE_RE = /<user-pasted-image\s+file="([^"]+)"[^>]*\/>/gi;

/** Internal class for an image-bearing tool. Mapped from the transcript tool name. */
enum ToolKind {
  READ,
  MEDIA_READ,
  MEDIA_TASK,
  PRESENT,
}

interface EnrichStats {
  inputUri: number;
  outputUri: number;
  skipped: number;
}

export interface EnrichQwenWorkCNMultimodalOptions {
  uploadMode: MultimodalUploadMode;
  pathToUri: PathToUriFn;
}

/**
 * Qwen Work CN multimodal enrichment. Mutates entries in place.
 * User text: `<user-pasted-image file="..."/>` only.
 * Tool calls and results are selected by tool name, then a single field.
 * A path is appended only after `pathToUri` succeeds. Fail-open.
 */
export async function enrichQwenWorkCNMultimodal(
  entries: AgentActivityEntry[],
  opts: EnrichQwenWorkCNMultimodalOptions,
): Promise<void> {
  try {
    await enrichInner(entries, opts);
  } catch (err) {
    logger.warn('qwen-work-cn multimodal enrich failed; continuing without media', {
      error: String(err),
    });
  }
}

async function enrichInner(
  entries: AgentActivityEntry[],
  opts: EnrichQwenWorkCNMultimodalOptions,
): Promise<void> {
  if (entries.length === 0) return;
  if (opts.uploadMode === 'none') return;

  const touched = new Set<AgentActivityEntry>();
  const stats: EnrichStats = { inputUri: 0, outputUri: 0, skipped: 0 };

  if (multimodalUploadIncludesInput(opts.uploadMode)) {
    await enrichInputImages(entries, opts.pathToUri, touched, stats);
    await enrichToolResultImages(entries, opts.pathToUri, touched, stats);
  }
  if (multimodalUploadIncludesOutput(opts.uploadMode)) {
    await enrichToolCallImages(entries, opts.pathToUri, touched, stats);
  }

  for (const entry of touched) {
    try {
      attachMultimodalMetadataForEntry(entry);
    } catch (err) {
      logger.debug('attach multimodal metadata failed', { error: String(err) });
    }
  }

  if (stats.inputUri > 0 || stats.outputUri > 0 || stats.skipped > 0) {
    logger.info('qwen-work-cn multimodal enrich', {
      uploadMode: opts.uploadMode,
      sessionId: sessionIdOf(entries),
      ...stats,
      touchedEntries: touched.size,
    });
  }
}

async function enrichInputImages(
  entries: AgentActivityEntry[],
  pathToUri: PathToUriFn,
  touched: Set<AgentActivityEntry>,
  stats: EnrichStats,
): Promise<void> {
  for (const entry of entries) {
    const name = entry['event.name'];
    if (name !== 'llm.request' && name !== 'other') continue;
    if (!Array.isArray(entry['gen_ai.input.messages_delta'])) continue;
    const paths = extractQwenWorkCNInputImagePaths(entry, cwdOf(entry));
    if (paths.length === 0) continue;
    const n = await appendUriPartsToMessagesDelta(entry, paths, pathToUri, timeUnixNanoToMillis(entry.time_unix_nano), stats);
    if (n > 0) {
      stats.inputUri += n;
      touched.add(entry);
    }
  }
}

async function enrichToolResultImages(
  entries: AgentActivityEntry[],
  pathToUri: PathToUriFn,
  touched: Set<AgentActivityEntry>,
  stats: EnrichStats,
): Promise<void> {
  for (const entry of entries) {
    if (entry['event.name'] !== 'tool.result') continue;
    const raw = entry['gen_ai.tool.call.result'];
    if (raw === undefined || raw === null || raw === '') continue;
    if (Array.isArray(raw)) continue;

    const paths = extractQwenWorkCNToolResultPaths(entry['gen_ai.tool.name'], raw, cwdOf(entry));
    if (paths.length === 0) continue;
    const uriParts = await convertPathsToUriParts(paths, pathToUri, timeUnixNanoToMillis(entry.time_unix_nano), stats);
    if (uriParts.length === 0) continue;

    const original = typeof raw === 'string' ? raw : JSON.stringify(raw);
    entry['gen_ai.tool.call.result'] = [
      { type: 'text', content: original },
      ...uriParts,
    ] as unknown as JsonValue;
    stats.inputUri += uriParts.length;
    touched.add(entry);
  }
}

async function enrichToolCallImages(
  entries: AgentActivityEntry[],
  pathToUri: PathToUriFn,
  touched: Set<AgentActivityEntry>,
  stats: EnrichStats,
): Promise<void> {
  for (const entry of entries) {
    if (entry['event.name'] !== 'tool.call') continue;
    const raw = entry['gen_ai.tool.call.arguments'];
    if (raw === undefined || raw === null || raw === '') continue;
    if (Array.isArray(raw)) continue;

    const paths = extractQwenWorkCNToolCallPaths(entry['gen_ai.tool.name'], raw, cwdOf(entry));
    if (paths.length === 0) continue;
    const uriParts = await convertPathsToUriParts(paths, pathToUri, timeUnixNanoToMillis(entry.time_unix_nano), stats);
    if (uriParts.length === 0) continue;

    const original = typeof raw === 'string' ? raw : JSON.stringify(raw);
    entry['gen_ai.tool.call.arguments'] = [
      { type: 'text', content: original },
      ...uriParts,
    ] as unknown as JsonValue;
    stats.outputUri += uriParts.length;
    touched.add(entry);
  }
}

export function extractQwenWorkCNInputImagePaths(
  source: AgentActivityEntry | string,
  cwd?: string,
): string[] {
  const text = typeof source === 'string' ? source : collectMessageDeltaTexts(source);
  return takeUniqueExtractedPaths(matchAll(PASTED_IMAGE_RE, text), cwd);
}

export function extractQwenWorkCNToolCallPaths(
  name: unknown,
  args: unknown,
  cwd?: string,
): string[] {
  const record = asRecord(args);
  if (!record) return [];
  const raw = toolCallRawPaths(toolKind(name), record);
  return takeUniqueExtractedPaths(raw, cwd);
}

export function extractQwenWorkCNToolResultPaths(
  name: unknown,
  result: unknown,
  cwd?: string,
): string[] {
  const record = asRecord(result);
  if (!record) return [];
  const raw = toolResultRawPaths(toolKind(name), record);
  return takeUniqueExtractedPaths(raw, cwd);
}

function toolKind(name: unknown): ToolKind | null {
  if (name === 'Read') return ToolKind.READ;
  if (isToolName(name, 'qwenwork_media_read')) return ToolKind.MEDIA_READ;
  if (isToolName(name, 'qwenwork_media_task')) return ToolKind.MEDIA_TASK;
  if (isToolName(name, 'qwenwork_file_present_files')) return ToolKind.PRESENT;
  return null;
}

function isToolName(name: unknown, suffix: string): boolean {
  return typeof name === 'string' && (name === suffix || name.endsWith(`__${suffix}`));
}

function toolCallRawPaths(kind: ToolKind | null, record: Record<string, unknown>): string[] {
  if (kind === ToolKind.READ) return stringValue(record.file_path);
  if (kind === ToolKind.MEDIA_READ) return stringList(record.files);
  if (kind === ToolKind.PRESENT) return fieldList(record.files, 'file_path');
  return [];
}

function toolResultRawPaths(kind: ToolKind | null, record: Record<string, unknown>): string[] {
  if (kind === ToolKind.MEDIA_READ) {
    return fieldList(asRecord(record.data)?.files, 'source', item => item.kind === 'image');
  }
  if (kind === ToolKind.MEDIA_TASK) {
    return record.status === 'completed' ? stringList(record.files) : [];
  }
  if (kind === ToolKind.PRESENT) return fieldList(record.artifacts, 'filePath');
  return [];
}

function stringValue(value: unknown): string[] {
  return typeof value === 'string' && value.trim() ? [value] : [];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(stringValue);
}

function fieldList(
  value: unknown,
  field: string,
  accept?: (item: Record<string, unknown>) => boolean,
): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (accept && !accept(record)) continue;
    out.push(...stringValue(record[field]));
  }
  return out;
}

async function appendUriPartsToMessagesDelta(
  entry: AgentActivityEntry,
  paths: string[],
  pathToUri: PathToUriFn,
  timeMs: number,
  stats: EnrichStats,
): Promise<number> {
  const messages = entry['gen_ai.input.messages_delta'];
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const first = messages[0];
  if (!first || typeof first !== 'object') return 0;
  const record = first as Record<string, unknown>;
  const parts: unknown[] = Array.isArray(record.parts) ? record.parts : [];
  const uriParts = await convertPathsToUriParts(paths, pathToUri, timeMs, stats);
  if (uriParts.length === 0) return 0;
  record.parts = [...parts, ...uriParts];
  return uriParts.length;
}

async function convertPathsToUriParts(
  paths: string[],
  pathToUri: PathToUriFn,
  timeMs: number,
  stats: EnrichStats,
): Promise<UriPart[]> {
  const parts: UriPart[] = [];
  for (const filePath of paths) {
    const trimmed = filePath.trim();
    let result;
    try {
      result = await pathToUri(trimmed, timeMs);
    } catch (err) {
      stats.skipped += 1;
      logger.warn('qwen-work-cn multimodal pathToUri threw; skipping image', {
        error: String(err),
        path: trimmed,
      });
      continue;
    }
    if (!result) {
      stats.skipped += 1;
      logger.warn('qwen-work-cn multimodal path skipped', { path: trimmed });
      continue;
    }
    parts.push({
      type: 'uri',
      mime_type: result.mime_type,
      modality: 'image',
      uri: result.uri,
    });
  }
  return parts;
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
  const cwd = (entry as Record<string, unknown>)['agent.qwenworkcn.cwd'];
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined;
}

function sessionIdOf(entries: AgentActivityEntry[]): string | undefined {
  for (const entry of entries) {
    const sid = entry['gen_ai.session.id'];
    if (typeof sid === 'string' && sid.trim()) return sid.trim();
  }
  return undefined;
}

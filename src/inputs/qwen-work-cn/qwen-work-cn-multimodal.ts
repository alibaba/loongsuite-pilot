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
import { LruMap, MULTIMODAL_LRU_LIMIT } from '../../multimodal/uploader/lru-set.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('QwenWorkCNMultimodal');

/** Pasted image only. Process-local LRU: `gen_ai.turn.id` + path → uri parts. An empty array means that pair already failed. */
const pathUriCache = new LruMap<UriPart[]>(MULTIMODAL_LRU_LIMIT);

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

  const stats: EnrichStats = { inputUri: 0, outputUri: 0, skipped: 0 };
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
      n = await rewriteToolResult(
        entry, 'gen_ai.tool.call.result', entry['gen_ai.tool.name'], entry,
        opts.pathToUri, stats,
      );
      stats.inputUri += n;
    } else if (includeOutput && name === 'tool.call') {
      n = await rewriteToolCall(
        entry, 'gen_ai.tool.call.arguments', entry['gen_ai.tool.name'], entry,
        opts.pathToUri, stats,
      );
      stats.outputUri += n;
    } else if (includeOutput && name === 'llm.response') {
      n = await enrichOutputImages(entry, opts.pathToUri, stats);
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

  if (stats.inputUri > 0 || stats.outputUri > 0 || stats.skipped > 0) {
    logger.info('qwen-work-cn multimodal enrich', {
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
  const cwd = cwdOf(entry);
  const timeMs = timeUnixNanoToMillis(entry.time_unix_nano);
  const grouped = partsByRole(entry['gen_ai.input.messages_delta']);
  let n = 0;
  if (grouped.user.length > 0) {
    const chunks: string[] = [];
    for (const part of grouped.user) {
      if (part.type === 'text' && typeof part.content === 'string') chunks.push(part.content);
    }
    const pasted = takeUniqueExtractedPaths(matchAll(PASTED_IMAGE_RE, chunks.join('\n')), cwd);
    if (pasted.length > 0) {
      n += await appendUriPartsToMessagesDelta(entry, pasted, pathToUri, timeMs, stats);
    }
  }
  const toolIdToName = new Map<string, string>();
  if (grouped.assistant.length > 0) {
    for (const partRecord of grouped.assistant) {
      if (partRecord.type !== 'tool_call') continue;
      if (typeof partRecord.id === 'string' && typeof partRecord.name === 'string') {
        toolIdToName.set(partRecord.id, partRecord.name);
      }
      n += await rewriteToolCall(partRecord, 'arguments', partRecord.name, entry, pathToUri, stats);
    }
  }
  if (grouped.tool.length > 0) {
    for (const partRecord of grouped.tool) {
      if (partRecord.type !== 'tool_call_response') continue;
      const name = typeof partRecord.id === 'string' ? toolIdToName.get(partRecord.id) : undefined;
      n += await rewriteToolResult(partRecord, 'response', name, entry, pathToUri, stats);
    }
  }
  return n;
}

async function enrichOutputImages(
  entry: AgentActivityEntry,
  pathToUri: PathToUriFn,
  stats: EnrichStats,
): Promise<number> {
  if (!Array.isArray(entry['gen_ai.output.messages'])) return 0;
  let n = 0;
  for (const partRecord of partsByRole(entry['gen_ai.output.messages']).assistant) {
    if (partRecord.type !== 'tool_call') continue;
    n += await rewriteToolCall(partRecord, 'arguments', partRecord.name, entry, pathToUri, stats);
  }
  return n;
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

function isValidValue(raw: unknown): raw is string | Record<string, unknown> {
  return raw !== undefined && raw !== null && raw !== '' && !Array.isArray(raw);
}

function uriPayload(raw: unknown, uriParts: UriPart[]): JsonValue {
  const original = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return [{ type: 'text', content: original }, ...uriParts] as unknown as JsonValue;
}

async function rewriteToolCall(
  record: { [key: string]: unknown },
  field: string,
  name: unknown,
  entry: AgentActivityEntry,
  pathToUri: PathToUriFn,
  stats: EnrichStats,
): Promise<number> {
  const raw = record[field];
  if (!isValidValue(raw)) return 0;
  const paths = extractQwenWorkCNToolCallPaths(name, raw, cwdOf(entry));
  if (paths.length === 0) return 0;
  const uriParts = await convertPathsToUriParts(paths, pathToUri, timeUnixNanoToMillis(entry.time_unix_nano), stats);
  if (uriParts.length === 0) return 0;
  record[field] = uriPayload(raw, uriParts);
  return uriParts.length;
}

async function rewriteToolResult(
  record: { [key: string]: unknown },
  field: string,
  name: unknown,
  entry: AgentActivityEntry,
  pathToUri: PathToUriFn,
  stats: EnrichStats,
): Promise<number> {
  const raw = record[field];
  if (!isValidValue(raw)) return 0;
  const paths = extractQwenWorkCNToolResultPaths(name, raw, cwdOf(entry));
  if (paths.length === 0) return 0;
  const uriParts = await convertPathsToUriParts(paths, pathToUri, timeUnixNanoToMillis(entry.time_unix_nano), stats);
  if (uriParts.length === 0) return 0;
  record[field] = uriPayload(raw, uriParts);
  return uriParts.length;
}

function partsByRole(messages: unknown[]): Record<'user' | 'assistant' | 'tool', Record<string, unknown>[]> {
  const grouped = {
    user: [] as Record<string, unknown>[],
    assistant: [] as Record<string, unknown>[],
    tool: [] as Record<string, unknown>[],
  };
  for (const message of messages) {
    const record = asRecord(message);
    if (!record || !Array.isArray(record.parts)) continue;
    const role = record.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    for (const part of record.parts) {
      const partRecord = asRecord(part);
      if (partRecord) grouped[role].push(partRecord);
    }
  }
  return grouped;
}

async function appendUriPartsToMessagesDelta(
  entry: AgentActivityEntry,
  paths: string[],
  pathToUri: PathToUriFn,
  timeMs: number,
  stats: EnrichStats,
): Promise<number> {
  const messages = entry['gen_ai.input.messages_delta'];
  const turnId = typeof entry['gen_ai.turn.id'] === 'string' ? entry['gen_ai.turn.id'].trim() : '';
  if (!Array.isArray(messages) || messages.length === 0 || paths.length === 0) return 0;
  const first = messages[0];
  if (!first || typeof first !== 'object') return 0;
  const record = first as Record<string, unknown>;
  const parts: unknown[] = Array.isArray(record.parts) ? record.parts : [];
  // `other` and `llm.request` carry the same pasted image. Reuse this uri so
  // deleting the file later does not leave one event with the image and the other without.
  const cacheKey = `${turnId}\0${paths.join('\0')}`;
  let uriParts = pathUriCache.get(cacheKey);
  if (!uriParts) {
    uriParts = await convertPathsToUriParts(paths, pathToUri, timeMs, stats);
    pathUriCache.set(cacheKey, uriParts);
  }
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

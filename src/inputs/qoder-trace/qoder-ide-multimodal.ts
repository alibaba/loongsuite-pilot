import type { AgentActivityEntry, JsonValue, MultimodalUploadMode } from '../../types/index.js';
import {
  multimodalUploadIncludesInput,
  multimodalUploadIncludesOutput,
  multimodalUploadIncludesTool,
} from '../../types/index.js';
import {
  attachMultimodalMetadataForEntry,
  matchAll,
  resolveImagePath,
  takeUniqueExtractedPaths,
  MAX_MULTIMODAL_PARTS,
  MAX_MULTIMODAL_PATH_CHARS,
  type PathToUriFn,
  type UriPart,
} from '../../multimodal/index.js';
import { LruMap, MULTIMODAL_LRU_LIMIT } from '../../multimodal/uploader/lru-set.js';
import { createLogger } from '../../utils/logger.js';
import { readAttachedImagePathsForRequestIds } from './sqlite-token-reader.js';

const logger = createLogger('QoderIdeMultimodal');

const MAX_MARKDOWN_ALT_CHARS = 200;
const MAX_MARKDOWN_TITLE_CHARS = 200;
const ATTACHED_IMAGE_LOOKUP_RETRY_DELAYS_MS = [25, 75] as const;
// Path patterns found in current Qoder IDE surfaces; extend when new scenes appear.
const IMAGE_FILE_RE = new RegExp(`Image file:\\s*([^\\n\\r]{1,${MAX_MULTIMODAL_PATH_CHARS}})`, 'gi');
const IMAGE_GEN_PATH_RE = new RegExp(
  `The absolute path of the image is:\\s*([^\\n\\r]{1,${MAX_MULTIMODAL_PATH_CHARS}})`,
  'gi',
);
const MARKDOWN_IMAGE_RE = new RegExp(
  `!\\[[^\\]]{0,${MAX_MARKDOWN_ALT_CHARS}}]\\((?:<([^>]{1,${MAX_MULTIMODAL_PATH_CHARS}})>|([^)\\s]{1,${MAX_MULTIMODAL_PATH_CHARS}}))(?:\\s+(?:"[^"]{0,${MAX_MARKDOWN_TITLE_CHARS}}"|'[^']{0,${MAX_MARKDOWN_TITLE_CHARS}}'))?\\)`,
  'g',
);

/**
 * request_id → attached paths. Process-local LRU.
 * Map values may be `[]` (confirmed empty or already attached). Ids absent from a lookup are not cached.
 */
const attachedPathsByRequestId = new LruMap<string[]>(MULTIMODAL_LRU_LIMIT);

/** Clear process-local attachedImagePaths cache. */
export function clearAttachedImagePathsCache(): void {
  attachedPathsByRequestId.clear();
}

interface EnrichStats {
  inputUri: number;
  toolUri: number;
  outputUri: number;
  skipped: number;
  attachedRequests: number;
}

export interface EnrichIdeMultimodalOptions {
  uploadMode: MultimodalUploadMode;
  pathToUri: PathToUriFn;
}

/**
 * IDE-only multimodal enrichment. Mutates entries in place.
 * Fail-open: never throws; individual image failures are skipped.
 */
export async function enrichIdeMultimodal(
  entries: AgentActivityEntry[],
  opts: EnrichIdeMultimodalOptions,
): Promise<void> {
  try {
    await enrichIdeMultimodalInner(entries, opts);
  } catch (err) {
    logger.warn('qoder ide multimodal enrich failed; continuing without media', {
      error: String(err),
    });
  }
}

async function enrichIdeMultimodalInner(
  entries: AgentActivityEntry[],
  opts: EnrichIdeMultimodalOptions,
): Promise<void> {
  if (entries.length === 0) return;
  if (opts.uploadMode === 'none') return;

  const touched = new Set<AgentActivityEntry>();
  const stats: EnrichStats = {
    inputUri: 0,
    toolUri: 0,
    outputUri: 0,
    skipped: 0,
    attachedRequests: 0,
  };

  if (multimodalUploadIncludesInput(opts.uploadMode)) {
    await enrichInputAttachedImages(entries, opts.pathToUri, touched, stats);
  }
  if (multimodalUploadIncludesTool(opts.uploadMode)) {
    await enrichToolResultImages(entries, opts.pathToUri, touched, stats);
  }
  if (multimodalUploadIncludesOutput(opts.uploadMode)) {
    await enrichOutputMarkdownImages(entries, opts.pathToUri, touched, stats);
  }

  for (const entry of touched) {
    try {
      attachMultimodalMetadataForEntry(entry);
    } catch (err) {
      logger.debug('attach multimodal metadata failed', { error: String(err) });
    }
  }

  const converted = stats.inputUri + stats.toolUri + stats.outputUri;
  if (converted > 0 || stats.skipped > 0 || stats.attachedRequests > 0) {
    logger.info('qoder ide multimodal enrich', {
      uploadMode: opts.uploadMode,
      sessionId: sessionIdOf(entries),
      ...stats,
      touchedEntries: touched.size,
    });
  }
}

async function enrichInputAttachedImages(
  entries: AgentActivityEntry[],
  pathToUri: PathToUriFn,
  touched: Set<AgentActivityEntry>,
  stats: EnrichStats,
): Promise<void> {
  const requestIds: string[] = [];
  for (const entry of entries) {
    const id = requestIdOf(entry);
    if (id) requestIds.push(id);
  }
  const uniqueIds = [...new Set(requestIds)];
  if (uniqueIds.length === 0) return;

  const byRequest = new Map<string, string[]>();
  const newIds: string[] = [];
  for (const id of uniqueIds) {
    const cached = attachedPathsByRequestId.get(id);
    if (cached !== undefined) {
      if (cached.length > 0) byRequest.set(id, cached);
    } else {
      newIds.push(id);
    }
  }

  if (newIds.length > 0) {
    try {
      const fetched = await readAttachedImagePathsWithRetry(newIds);
      for (const [id, found] of fetched) {
        attachedPathsByRequestId.set(id, found);
        if (found.length > 0) byRequest.set(id, found);
      }
    } catch (err) {
      logger.warn('qoder ide multimodal attachedImagePaths lookup failed', {
        error: String(err),
        requestIds: newIds.length,
      });
    }
  }
  if (byRequest.size === 0) return;
  stats.attachedRequests = byRequest.size;

  // Group input carriers by request_id (prefer llm.request; other rarely has request_id).
  const carriersByRequest = new Map<string, AgentActivityEntry>();
  for (const entry of entries) {
    const requestId = requestIdOf(entry);
    if (!requestId || !byRequest.has(requestId)) continue;
    const name = entry['event.name'];
    const hasDelta = Array.isArray(entry['gen_ai.input.messages_delta']);
    if (!hasDelta) continue;
    if (name === 'llm.request') {
      carriersByRequest.set(requestId, entry);
      continue;
    }
    if (name === 'other' && !carriersByRequest.has(requestId)) {
      carriersByRequest.set(requestId, entry);
    }
  }

  // When request_id is only on llm.response, fall back to same-turn input carrier.
  for (const [requestId, paths] of byRequest) {
    let carrier = carriersByRequest.get(requestId);
    if (!carrier) {
      const response = entries.find(
        e => e['event.name'] === 'llm.response' && requestIdOf(e) === requestId,
      );
      if (response) {
        const turnId = response['gen_ai.turn.id'];
        carrier = entries.find(e =>
          e['gen_ai.turn.id'] === turnId
          && e['event.name'] === 'llm.request'
          && Array.isArray(e['gen_ai.input.messages_delta']),
        ) ?? entries.find(e =>
          e['gen_ai.turn.id'] === turnId
          && e['event.name'] === 'other'
          && Array.isArray(e['gen_ai.input.messages_delta']),
        );
      }
    }
    if (!carrier) continue;
    const timeMs = entryTimeMs(carrier);
    const n = await appendUriPartsToMessagesDelta(carrier, paths, pathToUri, timeMs, stats);
    if (n > 0) {
      stats.inputUri += n;
      touched.add(carrier);
      // Consume paths so this request_id is not attached again on later batches.
      attachedPathsByRequestId.set(requestId, []);
    }
  }
}

/**
 * Qoder can append chat_record shortly after the transcript event becomes visible.
 * Retry only absent request ids; a present `[]` is an authoritative empty result.
 */
async function readAttachedImagePathsWithRetry(
  requestIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  let pending = requestIds;
  let lastError: unknown;

  for (let attempt = 0; attempt <= ATTACHED_IMAGE_LOOKUP_RETRY_DELAYS_MS.length; attempt += 1) {
    if (pending.length === 0) break;
    if (attempt > 0) {
      await delay(ATTACHED_IMAGE_LOOKUP_RETRY_DELAYS_MS[attempt - 1]);
    }

    try {
      const fetched = await readAttachedImagePathsForRequestIds(pending);
      for (const id of pending) {
        const paths = fetched.get(id);
        if (paths !== undefined) result.set(id, paths);
      }
      pending = pending.filter(id => !fetched.has(id));
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError !== undefined && pending.length > 0) {
    logger.warn('qoder ide multimodal attachedImagePaths lookup exhausted retries', {
      error: String(lastError),
      requestIds: pending.length,
    });
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    if (typeof raw !== 'string' || !raw) continue;

    const paths = extractToolImagePaths(raw);
    if (paths.length === 0) continue;

    const timeMs = entryTimeMs(entry);
    const uriParts = await convertPathsToUriParts(paths, pathToUri, timeMs, stats);
    if (uriParts.length === 0) continue;

    entry['gen_ai.tool.call.result'] = [
      { type: 'text', content: raw },
      ...uriParts,
    ] as unknown as JsonValue;
    stats.toolUri += uriParts.length;
    touched.add(entry);
  }
}

async function enrichOutputMarkdownImages(
  entries: AgentActivityEntry[],
  pathToUri: PathToUriFn,
  touched: Set<AgentActivityEntry>,
  stats: EnrichStats,
): Promise<void> {
  for (const entry of entries) {
    if (entry['event.name'] !== 'llm.response') continue;
    const messages = entry['gen_ai.output.messages'];
    if (!Array.isArray(messages)) continue;

    const timeMs = entryTimeMs(entry);
    let changed = false;
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const record = message as Record<string, unknown>;
      if (!Array.isArray(record.parts)) continue;

      const texts: string[] = [];
      for (const part of record.parts) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        if (p.type === 'text' && typeof p.content === 'string') texts.push(p.content);
      }
      if (texts.length === 0) continue;

      const paths = extractMarkdownImagePaths(texts.join('\n'), cwdOf(entry));
      if (paths.length === 0) continue;

      const uriParts = await convertPathsToUriParts(paths, pathToUri, timeMs, stats);
      if (uriParts.length === 0) continue;
      record.parts.push(...uriParts);
      stats.outputUri += uriParts.length;
      changed = true;
    }
    if (changed) touched.add(entry);
  }
}

/** @returns number of uri parts appended */
async function appendUriPartsToMessagesDelta(
  entry: AgentActivityEntry,
  paths: string[],
  pathToUri: PathToUriFn,
  timeMs: number,
  stats: EnrichStats,
): Promise<number> {
  const messages = entry['gen_ai.input.messages_delta'];
  if (!Array.isArray(messages) || messages.length === 0) {
    const uriParts = await convertPathsToUriParts(paths, pathToUri, timeMs, stats);
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
  const uriParts = await convertPathsToUriParts(paths, pathToUri, timeMs, stats);
  if (uriParts.length === 0) return 0;
  parts.push(...uriParts);
  return uriParts.length;
}

async function convertPathsToUriParts(
  paths: string[],
  pathToUri: PathToUriFn,
  timeMs: number,
  stats: EnrichStats,
): Promise<UriPart[]> {
  const parts: UriPart[] = [];
  const seen = new Set<string>();
  let attempted = 0;
  for (let i = 0; i < paths.length; i++) {
    const trimmed = paths[i]?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    if (attempted >= MAX_MULTIMODAL_PARTS) {
      const leftover = paths.length - i;
      stats.skipped += leftover;
      logger.debug('qoder ide multimodal attempt cap reached', {
        attempted,
        leftover,
      });
      break;
    }
    seen.add(trimmed);
    attempted += 1;
    let result: Awaited<ReturnType<PathToUriFn>>;
    try {
      result = await pathToUri(trimmed, timeMs);
    } catch (err) {
      stats.skipped += 1;
      logger.warn('qoder ide multimodal pathToUri threw; skipping image', {
        error: String(err),
        path: trimmed,
      });
      continue;
    }
    if (!result) {
      stats.skipped += 1;
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

export function extractToolImagePaths(text: string): string[] {
  return takeUniqueExtractedPaths([
    ...matchAll(IMAGE_FILE_RE, text),
    ...matchAll(IMAGE_GEN_PATH_RE, text),
  ]);
}

export function extractMarkdownImagePaths(text: string, cwd?: string): string[] {
  return takeUniqueExtractedPaths(
    matchAll(MARKDOWN_IMAGE_RE, text, m => m[1] ?? m[2]),
    cwd ? raw => resolveImagePath(raw, cwd) : undefined,
  );
}

function cwdOf(entry: AgentActivityEntry): string | undefined {
  const cwd = (entry as Record<string, unknown>)['agent.qoder.cwd'];
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined;
}

function requestIdOf(entry: AgentActivityEntry): string | undefined {
  const a = entry['gen_ai.request.id'];
  if (typeof a === 'string' && a.trim()) return a.trim();
  const b = (entry as Record<string, unknown>)['agent.request_id'];
  if (typeof b === 'string' && b.trim()) return b.trim();
  return undefined;
}

function sessionIdOf(entries: AgentActivityEntry[]): string | undefined {
  for (const entry of entries) {
    const sid = entry['gen_ai.session.id'];
    if (typeof sid === 'string' && sid.trim()) return sid.trim();
  }
  return undefined;
}

function entryTimeMs(entry: AgentActivityEntry): number {
  const nano = entry.time_unix_nano;
  if (typeof nano === 'string' && /^\d+$/.test(nano)) {
    try {
      return Number(BigInt(nano) / 1_000_000n);
    } catch {
      // fall through
    }
  }
  if (typeof nano === 'number' && Number.isFinite(nano)) {
    return Math.floor(nano / 1_000_000);
  }
  return Date.now();
}

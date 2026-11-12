import { uuidV5 } from '../../utils/uuid.js';
import type { AgentActivityEntry, JsonValue, MultimodalUploadMode } from '../../types/index.js';
import { AGENT_INPUT_EVENT_NAMESPACE } from '../../normalization/agent-input-dual-write.js';
import {
  multimodalUploadIncludesInput,
  multimodalUploadIncludesOutput,
} from '../../types/index.js';
import {
  asRecord,
  attachMultimodalMetadataForEntry,
  convertPathsToUriParts,
  matchAll,
  takeUniqueExtractedPaths,
  timeUnixNanoToMillis,
  MAX_MULTIMODAL_PATH_CHARS,
  type PathToUriFn,
  type UriPart,
} from '../../multimodal/index.js';
import { LruMap, MULTIMODAL_LRU_LIMIT } from '../../multimodal/uploader/lru-set.js';
import { createLogger } from '../../utils/logger.js';
import {
  readAttachedImagePathsForRequestIds,
  type AttachedImageLookup,
} from './sqlite-token-reader.js';

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
 * request_id → attached lookup. Process-local LRU.
 * `paths: []` means confirmed empty or already attached. Ids absent from a lookup are not cached.
 */
const attachedLookupByRequestId = new LruMap<AttachedImageLookup>(MULTIMODAL_LRU_LIMIT);

/** Clear process-local attachedImagePaths cache. */
export function clearAttachedImagePathsCache(): void {
  attachedLookupByRequestId.clear();
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

  const stats: EnrichStats = {
    inputUri: 0,
    toolUri: 0,
    outputUri: 0,
    skipped: 0,
    attachedRequests: 0,
  };
  const includeInput = multimodalUploadIncludesInput(opts.uploadMode);
  const includeOutput = multimodalUploadIncludesOutput(opts.uploadMode);
  let touchedEntries = 0;

  if (includeInput) {
    touchedEntries += await enrichInputAttachedImages(entries, opts.pathToUri, stats);
  }

  for (const entry of entries) {
    const name = entry['event.name'];
    let n = 0;
    if (includeInput && name === 'tool.result') {
      n = await enrichToolResultImages(entry, opts.pathToUri, stats);
      stats.toolUri += n;
    } else if (includeOutput && name === 'tool.call') {
      n = await enrichToolCallImages(entry, opts.pathToUri, stats);
      stats.outputUri += n;
    } else if (includeOutput && name === 'llm.response') {
      n = await enrichOutputMarkdownImages(entry, opts.pathToUri, stats);
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

  const converted = stats.inputUri + stats.toolUri + stats.outputUri;
  if (converted > 0 || stats.skipped > 0 || stats.attachedRequests > 0) {
    logger.info('qoder ide multimodal enrich', {
      uploadMode: opts.uploadMode,
      sessionId: sessionIdOf(entries),
      ...stats,
      touchedEntries,
    });
  }
}

async function enrichInputAttachedImages(
  entries: AgentActivityEntry[],
  pathToUri: PathToUriFn,
  stats: EnrichStats,
): Promise<number> {
  const requestIds: string[] = [];
  for (const entry of entries) {
    const id = requestIdOf(entry);
    if (id) requestIds.push(id);
  }
  const uniqueIds = [...new Set(requestIds)];
  if (uniqueIds.length === 0) return 0;

  const byRequest = new Map<string, AttachedImageLookup>();
  const newIds: string[] = [];
  for (const id of uniqueIds) {
    const cached = attachedLookupByRequestId.get(id);
    if (cached !== undefined) {
      if (cached.paths.length > 0) byRequest.set(id, cached);
    } else {
      newIds.push(id);
    }
  }

  if (newIds.length > 0) {
    try {
      const fetched = await readAttachedImagePathsWithRetry(newIds);
      for (const [id, found] of fetched) {
        attachedLookupByRequestId.set(id, found);
        if (found.paths.length > 0) byRequest.set(id, found);
      }
    } catch (err) {
      logger.warn('qoder ide multimodal attachedImagePaths lookup failed', {
        error: String(err),
        requestIds: newIds.length,
      });
    }
  }
  if (byRequest.size === 0) return 0;
  stats.attachedRequests = byRequest.size;
  let touchedEntries = 0;

  const carriersByRequest = new Map<string, AgentActivityEntry>();
  for (const entry of entries) {
    const requestId = requestIdOf(entry);
    if (!requestId || !byRequest.has(requestId)) continue;
    if (entry['event.name'] !== 'llm.request') continue;
    if (!Array.isArray(entry['gen_ai.input.messages_delta'])) continue;
    if (!carriersByRequest.has(requestId)) {
      carriersByRequest.set(requestId, entry);
    }
  }

  // When request_id is only on llm.response, fall back to same-turn input carrier.
  for (const [requestId, lookup] of byRequest) {
    let carrier = carriersByRequest.get(requestId);
    let synthesized = false;
    let response: AgentActivityEntry | undefined;
    if (!carrier) {
      response = entries.find(
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
        if (!carrier) {
          carrier = synthesizeUriOnlyRequest(response, requestId, lookup.startMs);
          entries.push(carrier);
          synthesized = true;
        }
      }
    }
    if (!carrier) continue;
    // Also attach the same-turn other, which has no request_id.
    const siblingName = carrier['event.name'] === 'other' ? 'llm.request' : 'other';
    const sibling = entries.find(e =>
      e !== carrier
      && e['gen_ai.turn.id'] === carrier['gen_ai.turn.id']
      && e['event.name'] === siblingName
      && Array.isArray(e['gen_ai.input.messages_delta'])
      && (!requestIdOf(e) || requestIdOf(e) === requestId),
    );
    const uriParts = await convertPathsToUriParts(
      lookup.paths, pathToUri, timeUnixNanoToMillis(carrier.time_unix_nano), stats, logger,
    );

    let requestAttached = 0;
    for (const target of [carrier, sibling]) {
      if (!target) continue;
      const n = applyUriPartsToMessagesDelta(target, uriParts);
      if (n <= 0) continue;
      stats.inputUri += n;
      touchedEntries += 1;
      try {
        attachMultimodalMetadataForEntry(target);
      } catch (err) {
        logger.debug('attach multimodal metadata failed', { error: String(err) });
      }
      if (target['event.name'] === 'llm.request') requestAttached = n;
    }
    if (requestAttached > 0) {
      attachedLookupByRequestId.set(requestId, { paths: [] });
    } else if (synthesized) {
      entries.pop();
      if (response && carrier['gen_ai.turn.start'] === true) {
        response['gen_ai.turn.start'] = true;
      }
    }
  }
  return touchedEntries;
}

/**
 * Qoder can append chat_record shortly after the transcript event becomes visible.
 * Retry only absent request ids; a present `[]` is an authoritative empty result.
 */
async function readAttachedImagePathsWithRetry(
  requestIds: string[],
): Promise<Map<string, AttachedImageLookup>> {
  const result = new Map<string, AttachedImageLookup>();
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
        const lookup = fetched.get(id);
        if (lookup !== undefined) result.set(id, lookup);
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
  entry: AgentActivityEntry,
  pathToUri: PathToUriFn,
  stats: EnrichStats,
): Promise<number> {
  const raw = entry['gen_ai.tool.call.result'];
  if (typeof raw !== 'string' || !raw) return 0;
  const paths = extractToolImagePaths(raw);
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

async function enrichOutputMarkdownImages(
  entry: AgentActivityEntry,
  pathToUri: PathToUriFn,
  stats: EnrichStats,
): Promise<number> {
  const messages = entry['gen_ai.output.messages'];
  if (!Array.isArray(messages)) return 0;
  const timeMs = timeUnixNanoToMillis(entry.time_unix_nano);
  let n = 0;
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

    const uriParts = await convertPathsToUriParts(paths, pathToUri, timeMs, stats, logger);
    if (uriParts.length === 0) continue;
    record.parts.push(...uriParts);
    n += uriParts.length;
  }
  return n;
}

/** @returns number of uri parts appended */
function applyUriPartsToMessagesDelta(
  entry: AgentActivityEntry,
  uriParts: UriPart[],
): number {
  if (uriParts.length === 0) return 0;
  const messages = entry['gen_ai.input.messages_delta'];
  if (!Array.isArray(messages) || messages.length === 0) {
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
  parts.push(...uriParts);
  return uriParts.length;
}

export function extractToolImagePaths(text: string): string[] {
  return takeUniqueExtractedPaths([
    ...matchAll(IMAGE_FILE_RE, text),
    ...matchAll(IMAGE_GEN_PATH_RE, text),
  ]);
}

export function extractToolCallImagePaths(args: unknown, cwd?: string): string[] {
  const record = asRecord(args);
  const filePath = typeof record?.file_path === 'string' ? record.file_path.trim() : '';
  if (!filePath) return [];
  return takeUniqueExtractedPaths([filePath], cwd);
}

export function extractMarkdownImagePaths(text: string, cwd?: string): string[] {
  return takeUniqueExtractedPaths(
    matchAll(MARKDOWN_IMAGE_RE, text, m => m[1] ?? m[2]),
    cwd,
  );
}

export function deriveSyntheticIdeRequestEventId(responseEventId: string, requestId: string): string {
  return uuidV5(
    `qoder-ide-synthetic-llm.request\0${responseEventId}\0${requestId}`,
    AGENT_INPUT_EVENT_NAMESPACE,
  );
}

function synthesizeUriOnlyRequest(
  response: AgentActivityEntry,
  requestId: string,
  gmtCreateMs?: number,
): AgentActivityEntry {
  const carrier = { ...response } as AgentActivityEntry;
  carrier['event.id'] = deriveSyntheticIdeRequestEventId(String(response['event.id'] ?? ''), requestId);
  carrier['event.name'] = 'llm.request';
  const startNano = msToUnixNano(gmtCreateMs);
  if (startNano !== undefined && isStrictlyBefore(startNano, response.time_unix_nano)) {
    carrier.time_unix_nano = startNano;
  }
  for (const key of Object.keys(carrier)) {
    if (isResponseOnlyField(key)) delete carrier[key];
  }
  if (response['gen_ai.turn.start'] === true) {
    delete response['gen_ai.turn.start'];
  }
  return carrier;
}

function msToUnixNano(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  return String(BigInt(Math.trunc(ms)) * 1_000_000n);
}

function isStrictlyBefore(candidateNano: string, responseNano: unknown): boolean {
  if (typeof responseNano !== 'string' || !/^\d+$/.test(responseNano)) return true;
  try {
    return BigInt(candidateNano) < BigInt(responseNano);
  } catch {
    return true;
  }
}

function isResponseOnlyField(key: string): boolean {
  return key === 'gen_ai.turn.end'
    || key === 'agent.stop_reason'
    || key === 'agent.client_request_id'
    || key === 'agent.qoder.match_ts'
    || key.startsWith('gen_ai.output.')
    || key.startsWith('gen_ai.response.')
    || key.startsWith('gen_ai.usage.')
    || key.startsWith('error.');
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

import * as path from 'node:path';
import type { AgentActivityEntry, JsonValue, MultimodalUploadMode } from '../../types/index.js';
import {
  multimodalUploadIncludesInput,
  multimodalUploadIncludesTool,
} from '../../types/index.js';
import {
  attachMultimodalMetadataForEntry,
  isImageFilePath,
  MAX_MULTIMODAL_PARTS,
  type PathToUriFn,
  type UriPart,
} from '../../multimodal/index.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('QoderCliMultimodal');

const IMAGE_SOURCE_RE = /\[Image:\s*source:\s*([^\]]+)\]/gi;
const AT_IMAGE_RE = /@(\S+?\.(?:png|jpe?g|gif|webp|bmp|svg|ico|tif|tiff))\b/gi;
const READ_IMAGE_RE = /Read image:\s*([^\n\r]+)/gi;
const IMAGE_FILE_RE = /Image file:\s*([^\n\r]+)/gi;
const IMAGE_GEN_PATH_RE = /The absolute path of the image is:\s*([^\n\r]+)/gi;
const SIZE_SUFFIX_RE = /\s+\(\d+(?:\.\d+)?\s*[KMGT]?B\)\s*$/i;

interface EnrichStats {
  inputUri: number;
  toolUri: number;
  skipped: number;
}

export interface EnrichCliMultimodalOptions {
  uploadMode: MultimodalUploadMode;
  pathToUri: PathToUriFn;
}

/**
 * CLI-only multimodal enrichment. Mutates entries in place.
 * Input: union of `agent.qoder.attachments[].filename`, `[Image: source:]`, and
 * `@path`, then unique-resolve. Tool: Read/ImageGen.
 * No output surface (CLI assistant text does not embed images). Fail-open.
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

  const touched = new Set<AgentActivityEntry>();
  const stats: EnrichStats = { inputUri: 0, toolUri: 0, skipped: 0 };

  if (multimodalUploadIncludesInput(opts.uploadMode)) {
    await enrichInputImages(entries, opts.pathToUri, touched, stats);
  }
  if (multimodalUploadIncludesTool(opts.uploadMode)) {
    await enrichToolResultImages(entries, opts.pathToUri, touched, stats);
  }

  for (const entry of touched) {
    try {
      attachMultimodalMetadataForEntry(entry);
    } catch (err) {
      logger.debug('attach multimodal metadata failed', { error: String(err) });
    }
  }

  if (stats.inputUri > 0 || stats.toolUri > 0 || stats.skipped > 0) {
    logger.info('qoder cli multimodal enrich', {
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
    const cwd = cwdOf(entry);
    const paths = extractInputImagePaths(entry, cwd);
    if (paths.length === 0) continue;
    const n = await appendUriPartsToMessagesDelta(
      entry,
      paths,
      pathToUri,
      entryTimeMs(entry),
      stats,
    );
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
    if (typeof raw !== 'string' || !raw) continue;

    const cwd = cwdOf(entry);
    const paths = extractToolImagePaths(raw, cwd);
    if (paths.length === 0) continue;

    const uriParts = await convertPathsToUriParts(paths, pathToUri, entryTimeMs(entry), stats);
    if (uriParts.length === 0) continue;

    entry['gen_ai.tool.call.result'] = [
      { type: 'text', content: raw },
      ...uriParts,
    ] as unknown as JsonValue;
    stats.toolUri += uriParts.length;
    touched.add(entry);
  }
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
  for (const filePath of paths) {
    if (parts.length >= MAX_MULTIMODAL_PARTS) {
      stats.skipped += 1;
      logger.debug('qoder cli multimodal part cap reached', { skipped: filePath });
      continue;
    }
    const trimmed = filePath.trim();
    if (!trimmed) continue;
    let result;
    try {
      result = await pathToUri(trimmed, timeMs);
    } catch (err) {
      stats.skipped += 1;
      logger.warn('qoder cli multimodal pathToUri threw; skipping image', {
        error: String(err),
        path: trimmed,
      });
      continue;
    }
    if (!result) {
      stats.skipped += 1;
      logger.warn('qoder cli multimodal path skipped', { path: trimmed });
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

export function extractInputImagePaths(
  source: AgentActivityEntry | string,
  cwd?: string,
): string[] {
  const text = typeof source === 'string' ? source : collectMessageDeltaTexts(source);
  return resolveUniqueImagePaths([
    ...(typeof source === 'string' ? [] : attachmentImageFilenames(source)),
    ...matchAll(IMAGE_SOURCE_RE, text).map(stripImageSourcePath),
    ...matchAll(AT_IMAGE_RE, text),
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
  return resolveUniqueImagePaths([
    ...matchAll(READ_IMAGE_RE, text).map(stripSizeSuffix),
    ...matchAll(IMAGE_FILE_RE, text).map(stripSizeSuffix),
    ...matchAll(IMAGE_GEN_PATH_RE, text),
  ], cwd);
}

function matchAll(re: RegExp, text: string): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const p = match[1]?.trim();
    if (p) out.push(p);
  }
  return out;
}

function stripSizeSuffix(raw: string): string {
  return raw.replace(SIZE_SUFFIX_RE, '').trim();
}

function stripImageSourcePath(raw: string): string {
  return raw.replace(/,\s*original\b.*$/i, '').trim();
}

function resolveUniqueImagePaths(rawPaths: string[], cwd?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawPaths) {
    const resolved = resolveImagePath(raw, cwd);
    if (!resolved || seen.has(resolved) || !isImageFilePath(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export function resolveImagePath(raw: string, cwd?: string): string {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return '';

  if (process.platform === 'win32') {
    // Windows host: resolve with win32 semantics only (drive / UNC / relative).
    if (path.win32.isAbsolute(trimmed)) return path.win32.normalize(trimmed);
    if (cwd && cwd.trim()) return path.win32.resolve(cwd.trim(), trimmed);
    return path.win32.resolve(trimmed);
  }

  // Linux / macOS: original posix path behavior.
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  if (cwd && cwd.trim()) return path.resolve(cwd.trim(), trimmed);
  return path.resolve(trimmed);
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

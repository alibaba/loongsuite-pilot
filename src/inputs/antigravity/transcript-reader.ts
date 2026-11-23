import * as fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonValue } from '../../types/index.js';

export interface AntigravityTranscriptToolCall {
  id?: string;
  name: string;
  args?: JsonValue;
}

export interface AntigravityTranscriptMedia {
  mimeType?: string;
  uri: string;
}

export interface AntigravityTranscriptStep {
  stepIndex: number;
  source?: string;
  type: string;
  status?: string;
  createdAtMs?: number;
  content?: string;
  thinking?: string;
  model?: string;
  toolCalls: AntigravityTranscriptToolCall[];
  media: AntigravityTranscriptMedia[];
}

export interface AntigravityTranscript {
  /** Deduplicated (latest record per stepIndex) and sorted ascending by stepIndex. */
  steps: AntigravityTranscriptStep[];
  byStepIndex: Map<number, AntigravityTranscriptStep>;
  /** Byte offset after the last complete line, including a valid unterminated EOF line. */
  nextOffset: number;
  /** Latest rows changed by this append read, including a changed valid EOF line. */
  changedStepIndices?: readonly number[];
}

interface StepHistory {
  steps: AntigravityTranscriptStep[];
  byStepIndex: Map<number, AntigravityTranscriptStep>;
}

interface TranscriptCacheState {
  stamp: BigIntStats;
  committedOffset: number;
  witnesses: Buffer[];
  committed: StepHistory;
  result: AntigravityTranscript | null;
}

/** Process-local read cache for one conversation. Start with an empty object. */
export interface AntigravityTranscriptCache {
  state?: TranscriptCacheState;
}

export class AntigravityTranscriptChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AntigravityTranscriptChangedError';
  }
}

const READ_CHUNK_BYTES = 512 * 1024;
/** Guard against malformed newline-less lines causing unbounded carry growth. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const NEWLINE_BYTE = 0x0a;
const WITNESS_BYTES = 64;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function isJsonValue(v: unknown, depth = 0): v is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!isJsonValue(item, depth + 1)) return false;
    }
    return true;
  }
  if (t === 'object') {
    for (const val of Object.values(v as Record<string, unknown>)) {
      if (!isJsonValue(val, depth + 1)) return false;
    }
    return true;
  }
  return false;
}

function parseToolCalls(raw: unknown): AntigravityTranscriptToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: AntigravityTranscriptToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : undefined;
    if (!name) continue;
    const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : undefined;
    const rawArgs = rec.args ?? rec.arguments;
    const args = isJsonValue(rawArgs) ? rawArgs : undefined;
    out.push({ id, name, args });
  }
  return out;
}

function parseMedia(raw: unknown): AntigravityTranscriptMedia[] {
  if (!Array.isArray(raw)) return [];
  const out: AntigravityTranscriptMedia[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const uri = typeof rec.uri === 'string' && rec.uri.trim() ? rec.uri.trim() : undefined;
    if (!uri) continue;
    const mimeType =
      typeof rec.mime_type === 'string' && rec.mime_type.trim()
        ? rec.mime_type.trim()
        : undefined;
    out.push({ mimeType, uri });
  }
  return out;
}

function parseTranscriptLine(trimmed: string): AntigravityTranscriptStep | null {
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const stepIndex =
    typeof rec.step_index === 'number' && Number.isSafeInteger(rec.step_index) && rec.step_index >= 0
      ? rec.step_index
      : undefined;
  const type = typeof rec.type === 'string' && rec.type.length > 0 ? rec.type : undefined;
  if (stepIndex === undefined || !type) return null;

  return {
    stepIndex,
    source: typeof rec.source === 'string' ? rec.source : undefined,
    type,
    status: typeof rec.status === 'string' ? rec.status : undefined,
    createdAtMs: parseIsoMs(rec.created_at),
    content: typeof rec.content === 'string' && rec.content.length > 0 ? rec.content : undefined,
    thinking: typeof rec.thinking === 'string' && rec.thinking.length > 0 ? rec.thinking : undefined,
    model: typeof rec.model === 'string' && rec.model.length > 0 ? rec.model : undefined,
    toolCalls: parseToolCalls(rec.tool_calls),
    media: parseMedia(rec.media),
  };
}

function parseLineBytes(line: Buffer): AntigravityTranscriptStep | null {
  try {
    return parseTranscriptLine(utf8.decode(line).trim());
  } catch {
    return null;
  }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

function sameVersion(a: BigIntStats, b: BigIntStats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function readWitness(fh: fs.FileHandle, position: number, size: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await fh.read(buf, offset, size - offset, position + offset);
    if (bytesRead === 0) {
      throw new AntigravityTranscriptChangedError('Antigravity transcript shrank during read');
    }
    offset += bytesRead;
  }
  return buf;
}

async function readPrefixWitnesses(fh: fs.FileHandle, end: number): Promise<Buffer[]> {
  if (end === 0) return [];
  if (end <= 2 * WITNESS_BYTES) return [await readWitness(fh, 0, end)];
  return Promise.all([
    readWitness(fh, 0, WITNESS_BYTES),
    readWitness(fh, end - WITNESS_BYTES, WITNESS_BYTES),
  ]);
}

function applyStepUpdates(base: StepHistory, updates: Map<number, AntigravityTranscriptStep>): StepHistory {
  const changed = [...updates.values()].filter((step) =>
    !isDeepStrictEqual(base.byStepIndex.get(step.stepIndex), step),
  );
  if (changed.length === 0) return base;
  changed.sort((a, b) => a.stepIndex - b.stepIndex);
  const byStepIndex = new Map(base.byStepIndex);
  const steps: AntigravityTranscriptStep[] = [];
  let pos = 0;
  for (const step of changed) {
    while (pos < base.steps.length && base.steps[pos]!.stepIndex < step.stepIndex) {
      steps.push(base.steps[pos++]!);
    }
    if (base.steps[pos]?.stepIndex === step.stepIndex) pos++;
    steps.push(step);
    byStepIndex.set(step.stepIndex, step);
  }
  while (pos < base.steps.length) steps.push(base.steps[pos++]!);
  return { steps, byStepIndex };
}

/**
 * Read a fixed transcript version, resuming from the last newline for verified appends.
 * Byte offsets stay exact across UTF-8 chunk boundaries. A valid unterminated last
 * line is visible to callers but stays outside the reusable prefix.
 */
export async function readAntigravityTranscript(
  dataRoot: string,
  sessionId: string,
  isRunning?: () => boolean,
  { cache, forceFullRead = false, observedStat }: {
    cache?: AntigravityTranscriptCache;
    forceFullRead?: boolean;
    observedStat?: BigIntStats;
  } = {},
): Promise<AntigravityTranscript | null> {
  if (isRunning && !isRunning()) return null;
  if (!forceFullRead && cache?.state && observedStat && sameVersion(observedStat, cache.state.stamp)) {
    return cache.state.result;
  }
  const transcriptPath = path.join(
    dataRoot,
    'brain',
    sessionId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );

  let fh: fs.FileHandle | undefined;
  try {
    // Check the opened descriptor without blocking if the path points to a pipe.
    fh = await fs.open(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = await fh.stat({ bigint: true });
    if (isRunning && !isRunning()) return null;
    if (!stat.isFile() || stat.size === 0n) {
      if (cache) delete cache.state;
      return null;
    }
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Antigravity transcript is too large');

    let previous: TranscriptCacheState | undefined;
    if (!forceFullRead && cache?.state) {
      const candidate = cache.state;
      if (sameVersion(stat, candidate.stamp)) return candidate.result;
      if (sameFile(stat, candidate.stamp) && stat.size > candidate.stamp.size &&
          stat.mtimeNs >= candidate.stamp.mtimeNs && stat.ctimeNs >= candidate.stamp.ctimeNs) {
        const witnesses = await readPrefixWitnesses(fh, candidate.committedOffset);
        if (witnesses.every((witness, i) => witness.equals(candidate.witnesses[i]!))) {
          previous = candidate;
        }
      }
    }
    const size = Number(stat.size);
    const updates = new Map<number, AntigravityTranscriptStep>();
    let pos = previous?.committedOffset ?? 0;
    const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size - pos));
    let carryParts: Buffer[] = [];
    let carryBytes = 0;
    let skippingOversized = false;
    let committedOffset = pos;

    const flushLineBytes = (tailSlice: Buffer): void => {
      const total = carryBytes + tailSlice.length;
      if (!skippingOversized && total <= MAX_LINE_BYTES) {
        const line =
          carryParts.length === 0 ? tailSlice : Buffer.concat([...carryParts, tailSlice], total);
        const step = parseLineBytes(line);
        if (step) updates.set(step.stepIndex, step);
      }
      carryParts = [];
      carryBytes = 0;
      skippingOversized = false;
    };

    while (pos < size) {
      if (isRunning && !isRunning()) return null;
      const toRead = Math.min(buf.length, size - pos);
      const { bytesRead } = await fh.read(buf, 0, toRead, pos);
      if (isRunning && !isRunning()) return null;
      if (bytesRead === 0) {
        throw new AntigravityTranscriptChangedError('Antigravity transcript shrank during read');
      }
      const chunkStartOffset = pos;
      pos += bytesRead;
      const chunk = buf.subarray(0, bytesRead);

      let sliceStart = 0;
      while (sliceStart < bytesRead) {
        const nlIdx = chunk.indexOf(NEWLINE_BYTE, sliceStart);
        if (nlIdx === -1) {
          const remainder = chunk.subarray(sliceStart);
          if (!skippingOversized) {
            if (carryBytes + remainder.length > MAX_LINE_BYTES) {
              carryParts = [];
              carryBytes = 0;
              skippingOversized = true;
            } else {
              // Copy slice because `buf` is reused on the next read
              carryParts.push(Buffer.from(remainder));
              carryBytes += remainder.length;
            }
          }
          break;
        }
        flushLineBytes(chunk.subarray(sliceStart, nlIdx));
        committedOffset = chunkStartOffset + nlIdx + 1;
        sliceStart = nlIdx + 1;
      }
    }

    let trailingStep: AntigravityTranscriptStep | null = null;
    if (!skippingOversized && carryBytes > 0) {
      const tail = carryParts.length === 1 ? carryParts[0]! : Buffer.concat(carryParts, carryBytes);
      trailingStep = parseLineBytes(tail);
    }

    const witnesses = cache ? await readPrefixWitnesses(fh, committedOffset) : [];
    const finalStat = await fh.stat({ bigint: true });
    if (isRunning && !isRunning()) return null;
    if (!sameVersion(stat, finalStat)) {
      throw new AntigravityTranscriptChangedError('Antigravity transcript changed during read');
    }

    const committed = applyStepUpdates(previous?.committed ?? { steps: [], byStepIndex: new Map() }, updates);
    const visible = trailingStep
      ? applyStepUpdates(committed, new Map([[trailingStep.stepIndex, trailingStep]]))
      : committed;
    const result: AntigravityTranscript | null = visible.steps.length > 0
      ? { ...visible, nextOffset: trailingStep ? size : committedOffset }
      : null;
    if (cache) cache.state = { stamp: stat, committedOffset, witnesses, committed, result };
    if (!previous || !result) return result;

    const candidateIndices = new Set(updates.keys());
    if (trailingStep) candidateIndices.add(trailingStep.stepIndex);
    const changedStepIndices = [...candidateIndices]
      .filter((index) => !isDeepStrictEqual(previous.result?.byStepIndex.get(index), visible.byStepIndex.get(index)))
      .sort((a, b) => a - b);
    return changedStepIndices.length > 0 ? { ...result, changedStepIndices } : result;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (cache && (!isRunning || isRunning())) delete cache.state;
      return null;
    }
    throw err;
  } finally {
    try {
      await fh?.close();
    } catch {
      // Ignore close errors
    }
  }
}

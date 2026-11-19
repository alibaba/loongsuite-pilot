import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
  /** Byte offset after the last complete newline-terminated line read. */
  nextOffset: number;
}

const READ_CHUNK_BYTES = 512 * 1024;
const MAX_JSON_DEPTH = 64;

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
    typeof rec.step_index === 'number' && Number.isInteger(rec.step_index) && rec.step_index >= 0
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

/**
 * Streamed reader for `<dataRoot>/brain/<sessionId>/.system_generated/logs/transcript.jsonl`.
 * Reads in bounded chunks so transcripts of any size (>8 MiB) are supported without
 * loading the entire file into one string or truncating long conversations.
 * Deduplicates repeated `step_index` records (keeping latest) and sorts ascending.
 */
export async function readAntigravityTranscript(
  dataRoot: string,
  sessionId: string,
): Promise<AntigravityTranscript | null> {
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
    fh = await fs.open(transcriptPath, 'r');
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }

    const byStepIndex = new Map<number, AntigravityTranscriptStep>();
    const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, stat.size));
    let pos = 0;
    let carry = '';
    let nextOffset = 0;

    while (pos < stat.size) {
      const toRead = Math.min(buf.length, stat.size - pos);
      const { bytesRead } = await fh.read(buf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;

      const chunk = carry + buf.subarray(0, bytesRead).toString('utf-8');
      const lines = chunk.split('\n');
      // Last element may be incomplete if file didn't end with '\n' yet
      carry = lines.pop() ?? '';

      for (const line of lines) {
        const step = parseTranscriptLine(line.trim());
        if (step) {
          byStepIndex.set(step.stepIndex, step);
        }
      }
      nextOffset = pos - Buffer.byteLength(carry, 'utf-8');
    }

    // Parse final line if file had no trailing newline
    if (carry.trim().length > 0) {
      const step = parseTranscriptLine(carry.trim());
      if (step) {
        byStepIndex.set(step.stepIndex, step);
        nextOffset = pos;
      }
    }

    if (byStepIndex.size === 0) return null;

    const steps = [...byStepIndex.values()].sort((a, b) => a.stepIndex - b.stepIndex);
    return { steps, byStepIndex, nextOffset };
  } catch {
    return null;
  } finally {
    try {
      await fh?.close();
    } catch {
      // Ignore close errors
    }
  }
}

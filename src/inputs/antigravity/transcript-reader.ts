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
  steps: AntigravityTranscriptStep[];
  byStepIndex: Map<number, AntigravityTranscriptStep>;
}

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
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

function isJsonValue(v: unknown): v is JsonValue {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (Array.isArray(v)) return v.every(isJsonValue);
  if (t === 'object') {
    return Object.values(v as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

/**
 * Optional enrichment reader for `<dataRoot>/brain/<sessionId>/.system_generated/logs/transcript.jsonl`.
 * Returns null if the transcript file does not exist or cannot be read.
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

  let stat;
  try {
    stat = await fs.stat(transcriptPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TRANSCRIPT_BYTES) {
    return null;
  }

  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  const steps: AntigravityTranscriptStep[] = [];
  const byStepIndex = new Map<number, AntigravityTranscriptStep>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const rec = parsed as Record<string, unknown>;
    const stepIndex = typeof rec.step_index === 'number' && Number.isInteger(rec.step_index)
      ? rec.step_index
      : undefined;
    const type = typeof rec.type === 'string' ? rec.type : undefined;
    if (stepIndex === undefined || !type) continue;

    const step: AntigravityTranscriptStep = {
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
    steps.push(step);
    byStepIndex.set(stepIndex, step);
  }

  if (steps.length === 0) return null;
  return { steps, byStepIndex };
}

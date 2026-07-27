import * as path from 'node:path';
import { readJsonFile, writeJsonFile } from '../../utils/fs-utils.js';
import {
  type TokenUsageAgent,
  type TokenUsageDailyResult,
  type TokenUsageDeltas,
  type TokenUsageStateEntry,
  type TokenUsageStateFile,
  type TokenUsageStatusRow,
  type TokenUsageTotals,
} from './types.js';

// Version 2 changes total_tokens to exclude reasoning_output_tokens.
// Resetting v1 avoids comparing the new total with checkpoints written using the old formula.
const STATE_VERSION = 2;
const DEFAULT_RETENTION_DAYS = 3;

const DELTA_KEYS = [
  'calls',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'reasoning_tokens',
  'estimated_calls',
  'total_tokens',
] as const;

export class TokenUsageStateStore {
  private readonly statePath: string;
  private readonly retentionDays: number;

  constructor(dataDir: string, opts: { retentionDays?: number } = {}) {
    this.statePath = path.join(dataDir, 'logs', 'metric_alarm', 'token-usage-state.json');
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  get path(): string {
    return this.statePath;
  }

  async buildStatusRow(
    agent: TokenUsageAgent,
    userId: string,
    usage: TokenUsageDailyResult,
    now = new Date(),
  ): Promise<TokenUsageStatusRow> {
    const state = await this.readState();
    const key = stateKey(agent, usage.date);
    const previous = state.entries[key]?.totals ?? null;
    const current = toTotals(usage);
    const effectiveTotals = previous ? mergeMonotonicTotals(previous, current) : current;
    const deltas = computeDeltas(previous, effectiveTotals);

    state.entries[key] = {
      agent,
      date: usage.date,
      totals: effectiveTotals,
      updated_at: now.toISOString(),
    };
    pruneEntries(state, now, this.retentionDays);
    await writeJsonFile(this.statePath, state);

    return toStatusRow(agent, userId, { ...usage, ...effectiveTotals }, deltas, now);
  }

  private async readState(): Promise<TokenUsageStateFile> {
    const raw = await readJsonFile<Partial<TokenUsageStateFile>>(this.statePath);
    if (!raw || raw.version !== STATE_VERSION || !raw.entries || typeof raw.entries !== 'object') {
      return { version: STATE_VERSION, entries: {} };
    }

    const entries: Record<string, TokenUsageStateEntry> = {};
    for (const [key, value] of Object.entries(raw.entries)) {
      if (!isStateEntry(value)) continue;
      entries[key] = value;
    }
    return { version: STATE_VERSION, entries };
  }
}

function computeDeltas(previous: TokenUsageTotals | null, current: TokenUsageTotals): TokenUsageDeltas {
  const deltas = {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    estimated_calls: 0,
    total_tokens: 0,
  };
  if (!previous) return deltas;

  for (const key of DELTA_KEYS) {
    deltas[key] = Math.max(0, current[key] - previous[key]);
  }
  return deltas;
}

function mergeMonotonicTotals(previous: TokenUsageTotals, current: TokenUsageTotals): TokenUsageTotals {
  if (DELTA_KEYS.some((key) => current[key] < previous[key])) {
    return {
      ...previous,
      files_scanned: current.files_scanned,
      files_with_usage: current.files_with_usage,
    };
  }
  return current;
}

function toStatusRow(
  agent: TokenUsageAgent,
  userId: string,
  usage: TokenUsageDailyResult,
  deltas: TokenUsageDeltas,
  now: Date,
): TokenUsageStatusRow {
  return {
    category: 'token_usage',
    agent,
    user_id: userId,
    date: usage.date,
    calls_total: String(usage.calls),
    calls_delta: String(deltas.calls),
    input_tokens_total: String(usage.input_tokens),
    input_tokens_delta: String(deltas.input_tokens),
    output_tokens_total: String(usage.output_tokens),
    output_tokens_delta: String(deltas.output_tokens),
    cache_read_tokens_total: String(usage.cache_read_tokens),
    cache_read_tokens_delta: String(deltas.cache_read_tokens),
    reasoning_tokens_total: String(usage.reasoning_tokens),
    reasoning_tokens_delta: String(deltas.reasoning_tokens),
    total_tokens_total: String(usage.total_tokens),
    total_tokens_delta: String(deltas.total_tokens),
    estimated_calls_total: String(usage.estimated_calls),
    estimated_calls_delta: String(deltas.estimated_calls),
    files_scanned: String(usage.files_scanned),
    files_with_usage: String(usage.files_with_usage),
    __time__: Math.floor(now.getTime() / 1000),
  };
}

function toTotals(usage: TokenUsageDailyResult): TokenUsageTotals {
  return {
    calls: usage.calls,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    reasoning_tokens: usage.reasoning_tokens,
    estimated_calls: usage.estimated_calls,
    files_scanned: usage.files_scanned,
    files_with_usage: usage.files_with_usage,
    total_tokens: usage.total_tokens,
  };
}

function pruneEntries(state: TokenUsageStateFile, now: Date, retentionDays: number): void {
  const cutoff = localDateFromOffset(now, -(retentionDays - 1));
  for (const [key, entry] of Object.entries(state.entries)) {
    if (entry.date < cutoff) delete state.entries[key];
  }
}

function localDateFromOffset(now: Date, offsetDays: number): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function stateKey(agent: TokenUsageAgent, date: string): string {
  return `${agent}:${date}`;
}

function isStateEntry(value: unknown): value is TokenUsageStateEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<TokenUsageStateEntry>;
  return (
    entry.agent === 'codex' &&
    typeof entry.date === 'string' &&
    typeof entry.updated_at === 'string' &&
    isTotals(entry.totals)
  );
}

function isTotals(value: unknown): value is TokenUsageTotals {
  if (!value || typeof value !== 'object') return false;
  const totals = value as Partial<TokenUsageTotals>;
  return [
    totals.calls,
    totals.input_tokens,
    totals.output_tokens,
    totals.cache_read_tokens,
    totals.reasoning_tokens,
    totals.estimated_calls,
    totals.files_scanned,
    totals.files_with_usage,
    totals.total_tokens,
  ].every((v) => typeof v === 'number' && Number.isFinite(v));
}

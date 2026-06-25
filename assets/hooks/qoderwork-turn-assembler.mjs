/**
 * QoderWork persistent turn assembler.
 *
 * Why this module exists:
 *   QoderWork's Stop hook fires multiple times per user prompt — once per LLM
 *   wave, plus once after each tool_result. The previous "stateless splitTurn"
 *   implementation produced two failure modes:
 *     1. orphan llm.request when Stop fires between user and assistant rows
 *     2. random-uuid turn ids when an assistant batch lands without its prompt
 *   Both stem from the hook processor losing track of pending turns across
 *   invocations.
 *
 * What this module owns:
 *   - A pure state-machine for a single transcript-path's pending turn.
 *   - Persistence to a JSON file alongside .line_records.* so multiple Stop
 *     hooks share the same memory.
 *
 * What this module does NOT own:
 *   - Building the AgentActivityEntry records (hook processor's job).
 *   - Deciding wave boundaries beyond a stop_reason check (hook processor
 *     remains responsible for tool_result-driven boundaries).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  HOOKS_DIR,
  logDebug,
} from './shared/hook-processor-base.mjs';

const ASSEMBLER_VERSION = 1;
const DEFAULT_TTL_MS = 60 * 60 * 1000;        // 60 min
const STATE_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h, for evicting cold transcripts
const WAVE_END_REASONS = new Set(['end_turn', 'tool_use', 'stop_sequence', 'max_tokens']);

// ─── Pure state-machine helpers ────────────────────────────────────────────

export function openPending({ promptId, userText, userTimestampNano, nowMs }) {
  if (!promptId) throw new Error('openPending requires promptId');
  return {
    promptId,
    turnId: promptId,
    userText: userText ?? '',
    userTimestampNano: userTimestampNano ?? null,
    userTextEmitted: false,
    nextStepSeq: 1,
    pendingToolCalls: [],
    currentWaveRows: [],
    lastEmittedThroughLine: 0,
    createdAtMs: nowMs ?? Date.now(),
    updatedAtMs: nowMs ?? Date.now(),
  };
}

export function appendAssistant(turn, row, { nowMs } = {}) {
  if (!turn) throw new Error('appendAssistant requires turn');
  const next = {
    ...turn,
    currentWaveRows: [...(turn.currentWaveRows ?? []), row],
    updatedAtMs: nowMs ?? Date.now(),
  };
  return next;
}

export function clearWave(turn, { nowMs } = {}) {
  if (!turn) return turn;
  return {
    ...turn,
    currentWaveRows: [],
    updatedAtMs: nowMs ?? Date.now(),
  };
}

export function bumpStepSeq(turn, { nowMs } = {}) {
  if (!turn) return turn;
  return {
    ...turn,
    nextStepSeq: (turn.nextStepSeq ?? 1) + 1,
    updatedAtMs: nowMs ?? Date.now(),
  };
}

export function recordPendingToolCalls(turn, calls, { nowMs } = {}) {
  if (!turn) return turn;
  if (!Array.isArray(calls) || calls.length === 0) return turn;
  return {
    ...turn,
    pendingToolCalls: [...(turn.pendingToolCalls ?? []), ...calls],
    updatedAtMs: nowMs ?? Date.now(),
  };
}

export function dropResolvedToolCalls(turn, resolvedIds, { nowMs } = {}) {
  if (!turn) return turn;
  if (!resolvedIds || resolvedIds.size === 0) return turn;
  const remaining = (turn.pendingToolCalls ?? []).filter((c) => !resolvedIds.has(c.id));
  return {
    ...turn,
    pendingToolCalls: remaining,
    updatedAtMs: nowMs ?? Date.now(),
  };
}

export function markUserTextEmitted(turn, { nowMs } = {}) {
  if (!turn) return turn;
  return {
    ...turn,
    userTextEmitted: true,
    updatedAtMs: nowMs ?? Date.now(),
  };
}

export function closePending(turn, { reason, nowMs } = {}) {
  if (!turn) return null;
  return {
    promptId: turn.promptId,
    turnId: turn.turnId,
    reason: reason ?? 'unknown',
    closedAtMs: nowMs ?? Date.now(),
    nextStepSeq: turn.nextStepSeq,
    pendingToolCalls: turn.pendingToolCalls ?? [],
  };
}

export function waveEnded(row) {
  const stop = row?.message?.stop_reason;
  if (!stop) return false;
  return WAVE_END_REASONS.has(stop);
}

export function isPendingExpired(turn, { nowMs, ttlMs } = {}) {
  if (!turn) return false;
  const t = ttlMs ?? DEFAULT_TTL_MS;
  const now = nowMs ?? Date.now();
  return now - (turn.updatedAtMs ?? turn.createdAtMs ?? now) > t;
}

// ─── Persistence ───────────────────────────────────────────────────────────

export function assemblerStateFile(agentId) {
  return path.join(HOOKS_DIR, `.assembler_state.${agentId}.json`);
}

function freshState() {
  return {};
}

export function loadAssemblerState(agentId) {
  const file = assemblerStateFile(agentId);
  try {
    if (!fs.existsSync(file)) return freshState();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return freshState();
    // Drop entries whose schema version doesn't match (worst case: one
    // round of lost enrichment for that transcript).
    for (const key of Object.keys(parsed)) {
      const entry = parsed[key];
      if (!entry || typeof entry !== 'object' || entry._v !== ASSEMBLER_VERSION) {
        delete parsed[key];
      }
    }
    return parsed;
  } catch (e) {
    logDebug(agentId, `assembler state load failed: ${e.message || e}; reset`);
    return freshState();
  }
}

export function saveAssemblerState(agentId, state) {
  const file = assemblerStateFile(agentId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
    return true;
  } catch (e) {
    logDebug(agentId, `assembler state save failed: ${e.message || e}`);
    return false;
  }
}

/**
 * Read state for one transcript path. Returns the per-transcript subtree, or
 * a fresh empty object if missing. Caller mutates the returned subtree and
 * persists the full state via writeTranscriptState.
 */
export function getTranscriptState(state, transcriptPath) {
  const existing = state?.[transcriptPath];
  if (existing && typeof existing === 'object') {
    return {
      session_id: existing.session_id ?? null,
      consumed_line: typeof existing.consumed_line === 'number' ? existing.consumed_line : 0,
      pending_turn: existing.pending_turn ?? null,
      updated_at_ms: existing.updated_at_ms ?? Date.now(),
    };
  }
  return { session_id: null, consumed_line: 0, pending_turn: null, updated_at_ms: Date.now() };
}

export function writeTranscriptState(state, transcriptPath, sub, { nowMs } = {}) {
  state[transcriptPath] = { ...sub, updated_at_ms: nowMs ?? Date.now(), _v: ASSEMBLER_VERSION };
  return state;
}

export function evictColdTranscripts(state, { nowMs } = {}) {
  if (!state || typeof state !== 'object') return state;
  const now = nowMs ?? Date.now();
  for (const key of Object.keys(state)) {
    const entry = state[key];
    if (!entry || typeof entry !== 'object') {
      delete state[key];
      continue;
    }
    if (now - (entry.updated_at_ms ?? 0) > STATE_RETENTION_MS) {
      delete state[key];
    }
  }
  return state;
}

// Allow tests to inject a deterministic clock without monkey-patching Date.
export function resolveNowMs(envValue) {
  const raw = envValue ?? process.env.LOONGSUITE_PILOT_ASSEMBLER_NOW_MS;
  if (!raw) return Date.now();
  const n = Number(raw);
  return Number.isFinite(n) ? n : Date.now();
}

export const ASSEMBLER_DEFAULTS = Object.freeze({
  TTL_MS: DEFAULT_TTL_MS,
  STATE_RETENTION_MS,
  VERSION: ASSEMBLER_VERSION,
});

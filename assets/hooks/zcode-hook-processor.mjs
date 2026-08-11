#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * zcode-hook-processor.mjs — ZCode CLI hook dispatcher (V3 hybrid: envelope-only path).
 *
 * Invoked by zcode-loongsuite-pilot-hook.sh per registered hook event:
 *   $ node zcode-hook-processor.mjs <subcommand>
 *
 * V3 subcommand:
 *   stop  → read stdin (sessionId/turnId/traceId/timestamp), emit
 *           ENTRY + AGENT envelope records with gen_ai.response.finish_reasons
 *           (end_turn/interrupted). Per-LLM messages come from the independent
 *           ZCodeRolloutInput that tails ~/.zcode/cli/rollout/model-io-sess_*.jsonl.
 *
 * Per architect de8a29fe + spec.md §1.1-§1.2:
 *   - hook path = boundary span only (ENTRY/AGENT envelope)
 *   - rollout path = data source (LLM/STEP/TOOL + messages), independent input
 *   - cross-source stitching via trace_id (UUID→W3C) + gen_ai.session.id +
 *     gen_ai.turn.id; AGENT span_id and STEP parent_span_id derived from
 *     the SAME shared deriveSpanId() so they match deterministically.
 *
 * Cross-source correlation resilience:
 *   - ZCode Stop stdin guarantees session_id; turnId and traceId are
 *     best-effort. When turnId is absent, we derive a deterministic turn
 *     identifier from sessionId + timestamp to ensure AGENT envelope is
 *     still emitted (critical for rollout STEP parent_span_id matching).
 *   - When traceId is absent, we generate a W3C-compliant 32-hex trace_id
 *     (NOT a 16-hex span_id) so the flusher accepts it.
 *
 * Per spec.md §1.2 fallback: if Stop hook does NOT fire (zcode crash / kill /
 * session timeout), the OTLP flusher synthesizes ENTRY/AGENT envelopes via
 * turnIdleTimeoutMs. This hook-processor does not implement that fallback
 * directly — it lives in the pilot daemon's flusher config. The hook-processor
 * just emits envelopes when Stop DOES fire.
 *
 * Fail-open contract: any error → stdout "{}" + exit 0, never blocks zcode.
 */

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { readStdinJson } from './shared/stdin-reader.mjs';
import {
  toW3CTraceId,
  deriveSpanId,
  generateTraceId,
  writeJsonlRecords,
} from './shared/event-emitter.mjs';
import { logHookError } from './shared/error-logger.mjs';
import {
  sanitizeObject,
  loadHookRuntimeConfig,
  resolveUserId,
  applyHookContentPolicy,
} from './agent-event-normalizer.mjs';
import { loadState, saveState } from './zcode/state.mjs';

const AGENT_ID = 'zcode';

// ─── utilities ───

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID);
}

function tryReadStdin() {
  try { return readStdinJson(); }
  catch (err) {
    logHookError({
      agentId: AGENT_ID, stage: 'stdin_parse',
      errorType: 'parse_failed',
      errorMessage: err?.message || String(err),
    });
    return {};
  }
}

function getString(event, ...keys) {
  for (const k of keys) {
    const v = event?.[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function isoToUnixNanos(isoStr) {
  if (!isoStr) return '0';
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return '0';
  return String(ms) + '000000';
}

// ─── cmd handlers ───

async function cmdStop() {
  const event = tryReadStdin();
  const sessionId = getString(event, 'session_id', 'sessionId');
  if (!sessionId) {
    logHookError({
      agentId: AGENT_ID, stage: 'stop',
      errorType: 'missing_session_id',
      errorMessage: 'hook stdin lacks session_id; skipping',
    });
    return;
  }

  // turnId: ZCode Stop stdin guarantees session_id but turnId is best-effort.
  // When absent, derive a deterministic turn id from sessionId + timestamp
  // so the AGENT envelope is still emitted for cross-source stitching.
  const turnId = getString(event, 'turn_id', 'turnId')
    || deriveSpanId('turn-fallback', sessionId, new Date().toISOString());

  // traceId: generate a W3C-compliant 32-hex trace_id when absent (NOT 16-hex).
  const traceIdRaw = getString(event, 'trace_id', 'traceId');
  const traceId = traceIdRaw ? toW3CTraceId(traceIdRaw) : toW3CTraceId(generateTraceId());
  const timestamp = getString(event, 'timestamp') || new Date().toISOString();
  const cwd = getString(event, 'cwd');
  const stopReason = getString(event, 'stop_reason', 'stopReason') || 'end_turn';

  // Idempotency: if Stop fires twice for the same turn (zcode may do this on
  // retries), don't emit duplicate envelopes. State.last_exported_turn guard.
  const state = loadState(sessionId);
  if (turnId && state.last_exported_turn === turnId) {
    return;
  }
  state.last_exported_turn = turnId || state.last_exported_turn;
  state.cwd = cwd || state.cwd;
  state.stop_time = Date.now() / 1000;
  saveState(sessionId, state);

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);
  const records = buildEnvelopeRecords({
    sessionId, turnId, traceId, timestamp, userId, cwd, stopReason,
  });
  const cleaned = records.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);
}

// ─── envelope records (ENTRY + AGENT, no messages) ───

/**
 * Build ENTRY + AGENT envelope records for a Stop hook fire.
 *
 * ENTRY: marks the session boundary. span_id derived from sessionId (namespace 'entry').
 * AGENT: marks the turn boundary. span_id derived from sessionId+turnId (namespace 'agent').
 *        parent_span_id = ENTRY span_id.
 *
 * AGENT span_id uses the SAME deriveSpanId('agent', sessionId, turnId) formula
 * as the rollout STEP's parent_span_id (in ZCodeRolloutInput) — this guarantees
 * cross-source stitching without shared in-process state.
 *
 * NO gen_ai.input.messages / gen_ai.output.messages are emitted here — those
 * come from ZCodeRolloutInput reading the rollout JSONL. This satisfies the
 *坑 #2 trap spirit: hook path is envelope-only, messages from independent source.
 */
export function buildEnvelopeRecords({ sessionId, turnId, traceId, timestamp, userId, cwd, stopReason }) {
  const records = [];
  const ts = isoToUnixNanos(timestamp);
  // Use 32-hex W3C trace_id; fallback uses generateTraceId() (NOT generateSpanId)
  // to produce a valid 32-hex id. toW3CTraceId strips dashes from UUID form.
  const w3cTraceId = traceId || toW3CTraceId(generateTraceId());

  const entrySpanId = deriveSpanId('entry', sessionId);
  const agentSpanId = turnId
    ? deriveSpanId('agent', sessionId, turnId)
    : deriveSpanId('agent', sessionId);

  const baseFields = {
    trace_id: w3cTraceId,
    'gen_ai.session.id': sessionId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    'gen_ai.agent.name': 'ZCode',
    'user.id': userId || os.hostname(),
    ...(cwd ? { 'agent.zcode.cwd': cwd } : {}),
  };

  // ENTRY envelope — marks session start boundary.
  records.push({
    time_unix_nano: ts,
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...baseFields,
    'agent.source': 'zcode-hook',
    span_id: entrySpanId,
    'gen_ai.span.kind': 'entry',
    'gen_ai.response.finish_reasons': [stopReason || 'end_turn'],
  });

  // AGENT envelope — marks turn boundary inside the session.
  // Always emitted (turnId is now guaranteed by cmdStop's fallback derivation).
  // agent.source identifies the hook path so the flusher can distinguish
  // hook-originated envelopes from rollout-originated ones for dual-source
  // terminal suppression.
  records.push({
    time_unix_nano: ts,
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...baseFields,
    'gen_ai.turn.id': turnId,
    'agent.source': 'zcode-hook',
    span_id: agentSpanId,
    parent_span_id: entrySpanId,
    'gen_ai.span.kind': 'agent',
    'gen_ai.response.finish_reasons': [stopReason || 'end_turn'],
  });

  // Sort by time (ENTRY before AGENT — same timestamp, but stable order).
  records.sort((a, b) => {
    const ta = BigInt(a.time_unix_nano || '0');
    const tb = BigInt(b.time_unix_nano || '0');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  return records;
}

// ─── CLI dispatch ───

const SUBCOMMAND = process.argv[2];

async function main() {
  switch (SUBCOMMAND) {
    case 'stop':
      await cmdStop();
      break;
    default:
      // Unregistered subcommand — early return per fail-open contract.
      break;
  }
  // Hook output MUST be {} on success (zcode expects JSON; non-JSON would
  // mark the hook as failed in zcode's TRUSTED_HOOKS logs).
  process.stdout.write('{}\n');
}

if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('zcode-hook-processor.mjs')) {
  main().catch((err) => {
    try {
      logHookError({
        agentId: AGENT_ID, stage: 'main',
        errorType: 'unhandled',
        errorMessage: err?.message || String(err),
      });
    } catch {}
    process.stdout.write('{}\n');
    process.exit(0);
  });
}

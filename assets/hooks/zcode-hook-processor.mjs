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
 *   stop  → read stdin (sessionId guaranteed; turnId/traceId best-effort),
 *           emit ENTRY + AGENT envelope records (NO messages, NO terminal
 *           finish_reason). Per-LLM data and terminal state come from the
 *           independent ZCodeRolloutInput tailing
 *           ~/.zcode/cli/rollout/model-io-sess_*.jsonl (authoritative source).
 *
 * Per architect de8a29fe + spec.md §1.1-§1.2:
 *   - hook path = boundary span only (ENTRY/AGENT envelope)
 *   - rollout path = data source (LLM/STEP/TOOL + messages), independent input
 *   - cross-source stitching via trace_id (UUID→W3C) + gen_ai.session.id +
 *     gen_ai.turn.id; AGENT span_id and STEP parent_span_id derived from
 *     the SAME shared deriveSpanId() so they match deterministically.
 *
 * The documented Stop fields may lack native turn and trace identity. A full
 * native pair can stitch directly, and a supplied turn can be corroborated by
 * the exact session's rollout file. Otherwise emit a standalone observation.
 * The flusher settles both independent inputs after a quiet polling window.
 *
 * Fail-open contract: any error → stdout "{}" + exit 0, never blocks zcode.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
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

/**
 * Read the last complete `model_io` record from the session's rollout file.
 *
 * The rollout transcript (~/.zcode/cli/rollout/model-io-sess_<sid>.jsonl) is
 * the authoritative source for native turnId/traceId — ZCode's documented Stop
 * stdin payload may omit turnId, traceId, and timestamp. Only a row from
 * this exact session is eligible to corroborate an explicit native turn.
 *
 * Returns null when the file is missing or holds no complete line (fail-open).
 *
 */
export function readLastRolloutRecord(sessionId, homeDirOverride) {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
    const home = homeDirOverride || os.homedir();
    const rolloutDir = path.join(home, '.zcode', 'cli', 'rollout');
    const candidates = [`model-io-sess_${sessionId}.jsonl`];
    if (sessionId.startsWith('sess_')) candidates.push(`model-io-${sessionId}.jsonl`);
    const matches = candidates.map(name => path.join(rolloutDir, name)).filter(file => fs.existsSync(file));
    if (matches.length !== 1) return null;
    const [filePath] = matches;

    // Read the tail of the file (last 256KB is plenty for one record).
    const stat = fs.statSync(filePath);
    const readLen = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
      const text = buf.toString('utf-8');
      const lastNewline = text.lastIndexOf('\n');
      // Only consider complete lines (up to final '\n').
      const complete = lastNewline >= 0 ? text.slice(0, lastNewline) : '';
      const lines = complete.split('\n').filter((l) => l.trim().length > 0);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const rec = JSON.parse(lines[i]);
          if (rec?.type === 'model_io') {
            return getString(rec, 'sessionId', 'session_id') === sessionId ? rec : null;
          }
        } catch { /* skip invalid line */ }
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Resolve native turnId/traceId/timestamp for the Stop envelope.
 * Trust the observed full pair, or use the latest matching session/turn row
 * to fill in a missing trace. A Stop with no turn may belong to a previous
 * turn even when the same session already has a newer model observation.
 */
function resolveNativeIds(event, sessionId, stdinTimestamp) {
  const stdinTurnId = getString(event, 'turn_id', 'turnId');
  const rawTraceId = getString(event, 'trace_id', 'traceId');
  const stdinTraceId = toW3CTraceId(rawTraceId);
  const validTrace = id => /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id);

  if (stdinTurnId && validTrace(stdinTraceId)) {
    return {
      turnId: stdinTurnId,
      traceId: stdinTraceId,
      timestamp: stdinTimestamp,
      idsSource: 'stdin',
    };
  }

  const lastRecord = stdinTurnId && !rawTraceId ? readLastRolloutRecord(sessionId) : null;
  if (lastRecord) {
    const rolloutTurnId = getString(lastRecord, 'turnId', 'turn_id');
    const rolloutTraceId = toW3CTraceId(getString(lastRecord, 'traceId', 'trace_id'));
    const rolloutCompletedAt = getString(lastRecord, 'completedAt', 'completed_at');
    if (rolloutTurnId === stdinTurnId && validTrace(rolloutTraceId)) {
      return {
        turnId: rolloutTurnId,
        traceId: rolloutTraceId,
        // Prefer the rollout's completedAt: it is the native end-of-turn time
        // and stays stable across Stop re-fires (idempotency).
        timestamp: rolloutCompletedAt || stdinTimestamp,
        idsSource: 'rollout',
      };
    }
  }

  // Keep the Stop envelope available as independent observation. Do not
  // attach it to an unconfirmed native turn or reuse a partial native ID.
  return {
    turnId: deriveSpanId('turn-fallback', sessionId, stdinTimestamp, stdinTurnId),
    traceId: toW3CTraceId(generateTraceId()),
    timestamp: stdinTimestamp,
    idsSource: 'derived',
  };
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

  // timestamp from stdin for determinism (fallback: now).
  const stdinTimestamp = getString(event, 'timestamp') || new Date().toISOString();

  // Do not link an unverified Stop to a rollout turn.
  const { turnId, traceId, timestamp, idsSource } = resolveNativeIds(event, sessionId, stdinTimestamp);

  const cwd = getString(event, 'cwd');

  // Idempotency: if Stop fires twice for the same turn (zcode may do this on
  // retries), don't emit duplicate envelopes. State.last_exported_turn guard.
  const state = loadState(sessionId);
  if (state.last_exported_turn === turnId
      && (idsSource === 'derived' || !state.last_exported_trace || state.last_exported_trace === traceId)) {
    return;
  }

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);
  const records = buildEnvelopeRecords({
    sessionId, turnId, traceId, timestamp, userId, cwd,
  });
  const cleaned = records.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);

  // Persist the idempotency marker only AFTER the records hit disk (review
  // P2): if writeJsonlRecords throws (disk full / permissions) the fail-open
  // catch swallows it, and a pre-saved marker would silently dedup zcode's
  // Stop retry — the envelope would never be emitted.
  state.last_exported_turn = turnId || state.last_exported_turn;
  state.last_exported_trace = traceId;
  state.cwd = cwd || state.cwd;
  state.stop_time = Date.now() / 1000;
  saveState(sessionId, state);
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
 *
 * NO gen_ai.response.finish_reasons either — the rollout transcript is the
 * authoritative terminal source (review: hook-first arrival with a terminal
 * reason would flush the turn and drop later rollout records).
 */
export function buildEnvelopeRecords({ sessionId, turnId, traceId, timestamp, userId, cwd }) {
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
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    'gen_ai.agent.name': 'ZCode',
    'user.id': userId || os.hostname(),
    ...(cwd ? { 'agent.zcode.cwd': cwd } : {}),
  };

  // ENTRY envelope — marks session start boundary. Carries NO terminal
  // finish_reason because a Stop hook may still be vetoed or continued.
  records.push({
    time_unix_nano: ts,
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...baseFields,
    'agent.source': 'zcode-hook',
    span_id: entrySpanId,
    'gen_ai.span.kind': 'entry',
  });

  // AGENT envelope — marks turn boundary inside the session.
  // Always emitted (turnId is now guaranteed by cmdStop's native-ID
  // resolution). agent.source identifies the hook path so the flusher can
  // distinguish hook-originated envelopes from rollout-originated ones.
  records.push({
    time_unix_nano: ts,
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...baseFields,
    'agent.source': 'zcode-hook',
    span_id: agentSpanId,
    parent_span_id: entrySpanId,
    'gen_ai.span.kind': 'agent',
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

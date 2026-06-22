#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * qwen-code-cli-hook-processor.mjs — Qwen Code CLI hook dispatcher.
 *
 * Invoked by qwen-code-cli-loongsuite-pilot-hook.sh per registered hook event:
 *   $ node qwen-code-cli-hook-processor.mjs <subcommand>
 *
 * v1 subcommands handled:
 *   stop              → main export (parse transcript → write event_t records)
 *   subagent-start    → v1: accumulate into state.events (deferred to v2)
 *   subagent-stop     → v1: accumulate into state.events (deferred to v2)
 *
 * Architecture mirrors assets/hooks/claude-code-hook-processor.mjs v2:
 *   pure transcript-driven (timestamps from record.timestamp, not hook fire time).
 *
 * Field names align with loongsuite-pilot/docs/ai_event_schema.md and the
 * trace-conversion rules in docs/EVENT_LOG_TO_TRACE_SPEC.md. The C1-C11
 * constraints from the implementation plan map directly to the lines below
 * marked with `// [Cn] ...`.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { readStdinJson } from './shared/stdin-reader.mjs';
import {
  INITIAL_HASH,
  computeHash,
  generateTraceId,
  generateSpanId,
  writeJsonlRecords,
} from './shared/event-emitter.mjs';
import { logHookError } from './shared/error-logger.mjs';
import {
  sanitizeObject,
  loadHookRuntimeConfig,
  resolveUserId,
  applyHookContentPolicy,
} from './agent-event-normalizer.mjs';

import {
  loadState,
  saveState,
  readAndDeleteChildState,
} from './qwen-code-cli/state.mjs';
import { parseQwenTranscript } from './qwen-code-cli/transcript-parser.mjs';
import {
  buildOutputMessages,
  buildInputMessagesDelta,
  inferAssistantFinishReason,
} from './qwen-code-cli/message-converter.mjs';
import { inferProvider } from './qwen-code-cli/provider-inferrer.mjs';

const AGENT_ID = 'qwen-code-cli';

// ─── utilities ───

function nowSec() { return Date.now() / 1000; }

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

function requireSessionId(event, stage = 'cmd') {
  const sid = event && event.session_id;
  if (typeof sid === 'string' && sid.length > 0) return sid;
  logHookError({
    agentId: AGENT_ID, stage,
    errorType: 'missing_session_id',
    errorMessage: 'hook stdin lacks session_id; skipping',
  });
  return null;
}

/**
 * ISO 8601 → time_unix_nano string. [C10]
 *
 * Some records may have undefined/empty timestamps; we return '0' so downstream
 * BigInt parsing doesn't throw. The trace converter treats time=0 as a "no
 * timestamp" sentinel and warns; we prefer that to silently dropping the event.
 */
function isoToUnixNanos(isoStr) {
  if (!isoStr) return '0';
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return '0';
  return String(ms) + '000000';
}

// ─── cmd handlers ───

// v1: subagent_start / subagent_stop are INTENTIONALLY INERT.
//
// We register these hooks so the wiring is in place for v2, but in v1 we
// only persist the events into state.events for later consumption — we do
// NOT emit any event_t records here. The transcript parser explicitly
// filters out subagent (sidechain) records (`r.isSidechain === true || r.agentId`),
// so subagent activity is dropped end-to-end in v1.
//
// v2 will: read state.events at Stop time, fetch the child session's chats
// JSONL (via subagent_session_id), build a nested AGENT→STEP→LLM/TOOL
// subtree, and attach it under the parent TOOL span via
// `gen_ai.subagent.parent_tool_call.id`. See EVENT_LOG_TO_TRACE_SPEC §4.4.
//
// Until then, do not add record-emission logic here — leave the handlers
// minimal and side-effect-free (state accumulation only).
function cmdSubagentStart() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'subagent_start');
  if (!sessionId) return;
  const state = loadState(sessionId);
  state.events = state.events || [];
  state.events.push({
    type: 'subagent_start',
    timestamp: nowSec(),
    subagent_session_id: event.subagent_session_id || '',
    agent_id: event.agent_id || '',
    agent_type: event.agent_type || '',
  });
  saveState(sessionId, state);
}

function cmdSubagentStop() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'subagent_stop');
  if (!sessionId) return;
  const state = loadState(sessionId);
  const childSid = event.subagent_session_id || 'unknown';
  let childStateSnapshot = null;
  if (childSid && childSid !== 'unknown' && childSid !== sessionId) {
    childStateSnapshot = readAndDeleteChildState(childSid);
  }
  state.events = state.events || [];
  const ev = {
    type: 'subagent_stop',
    timestamp: nowSec(),
    subagent_session_id: childSid,
    stop_reason: event.stop_reason || 'end_turn',
  };
  if (childStateSnapshot) ev._child_state = childStateSnapshot;
  state.events.push(ev);
  saveState(sessionId, state);
}

async function cmdStop() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'stop');
  if (!sessionId) return;

  const state = loadState(sessionId);
  if (!state.transcript_path && event.transcript_path) {
    state.transcript_path = event.transcript_path;
  }
  if (event.cwd && typeof event.cwd === 'string') {
    state.cwd = event.cwd;
  }
  state.stop_time = nowSec();
  saveState(sessionId, state);

  try {
    await exportSession(state, event.stop_reason || 'end_turn');
    if (typeof state._next_transcript_offset === 'number') {
      state.transcript_offset = state._next_transcript_offset;
      delete state._next_transcript_offset;
    }
    state.events = [];
    state.stop_time = null;
    saveState(sessionId, state);
  } catch (err) {
    logHookError({
      agentId: AGENT_ID, stage: 'cmd_stop',
      errorType: 'export_failed',
      errorMessage: err?.message || String(err),
    });
  }
}

// ─── transcript stability wait ───

async function waitForTranscriptStable(transcriptPath, minSize = 0) {
  let prevSize = -1;
  let stableCount = 0;
  for (let i = 0; i < 10; i++) {
    let size = 0;
    try { size = fs.statSync(transcriptPath).size; } catch { break; }
    if (size <= minSize) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    if (size === prevSize) {
      stableCount++;
      if (stableCount >= 2) return;
    } else {
      stableCount = 0;
    }
    prevSize = size;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ─── Stop main export flow ───

async function exportSession(state, stopReason) {
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const sessionId = state.session_id || 'unknown';

  if (!state.transcript_path) {
    logHookError({
      agentId: AGENT_ID, stage: 'export',
      errorType: 'missing_transcript_path',
      errorMessage: 'no transcript_path in state; cannot export',
    });
    return;
  }

  const transcriptPath = state.transcript_path;
  const baseOffset = state.transcript_offset || 0;

  // If the transcript hasn't grown since the last export, there's nothing new
  // to do — return fast. This is the common case for repeated Stop hooks
  // (e.g. when a Stop hook fires for a session whose new turn data isn't yet
  // written, OR when the user re-invokes Stop without producing new output).
  let currentSize = 0;
  try { currentSize = fs.statSync(transcriptPath).size; } catch {}
  if (currentSize <= baseOffset) return;

  await waitForTranscriptStable(transcriptPath, baseOffset);

  let parseResult;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      parseResult = parseQwenTranscript(transcriptPath, baseOffset, sessionId);
      if (parseResult.turns.length > 0) break;
    } catch (err) {
      logHookError({
        agentId: AGENT_ID, stage: 'transcript_parse',
        errorType: 'parse_failed',
        errorMessage: err?.message || String(err),
      });
      break;
    }
    // No turns parsed: retry only if file is still growing. If size is stable
    // and we got 0 turns, it means new bytes exist but they don't form a
    // complete turn yet (rare) — give it 1 quick retry, then give up.
    await new Promise((r) => setTimeout(r, 200));
    let newSize = 0;
    try { newSize = fs.statSync(transcriptPath).size; } catch {}
    if (newSize === currentSize && attempt > 0) break;
    currentSize = newSize;
    await waitForTranscriptStable(transcriptPath, baseOffset);
  }

  if (!parseResult || parseResult.turns.length === 0) return;

  state._next_transcript_offset = parseResult.nextOffset;

  const userId = resolveUserId({}, runtimeConfig);
  const allRecords = [];
  let logHash = INITIAL_HASH;

  const baseTurnCount = state.turn_count || 0;

  // First-run guard: on fresh install/reinstall (no turn_count + offset=0), if
  // the transcript has historic turns from before pilot was deployed, only
  // export the last turn (= the just-completed conversation). This prevents
  // back-loading months of history on first deploy.
  const isFirstRun = !state.turn_count && baseOffset === 0;
  let turnsToExport = parseResult.turns;
  if (isFirstRun && parseResult.turns.length > 1) {
    turnsToExport = parseResult.turns.slice(-1);
  }

  const cwd = state.cwd || undefined;

  for (let i = 0; i < turnsToExport.length; i++) {
    const turn = turnsToExport[i];
    const isLast = i === turnsToExport.length - 1;
    const turnStopReason = isLast ? stopReason : 'end_turn';
    const { records, hash } = buildTurnRecords(
      turn, baseTurnCount + i, sessionId, logHash, userId, turnStopReason, cwd,
    );
    allRecords.push(...records);
    logHash = hash;

    // Surface positional-fallback usage so it is visible in operator
    // dashboards rather than silently producing potentially-mismatched
    // tool_call/tool_result links. The fallback is brittle (it uses a
    // global cursor that can mis-pair when a turn has multiple ID-less
    // tool calls with interleaved results) — but qwen-code's @google/genai
    // SDK almost always supplies functionCall.id, so this should rarely
    // fire. If it starts firing in production it's a signal that upstream
    // behavior changed (PR #37 review: A1 + B4).
    if (turn.positionalFallbacksUsed > 0) {
      logHookError({
        agentId: AGENT_ID,
        stage: 'pair_tool_results',
        errorType: 'tool_pair_ambiguous',
        errorMessage:
          `positional fallback used for ${turn.positionalFallbacksUsed} tool ` +
          `call(s) in turn ${baseTurnCount + i + 1} (session=${sessionId}); ` +
          `functionCall.id missing — pairings may be incorrect if multiple ID-less calls coexist`,
      });
    }
  }

  // turn_count includes ALL parsed turns (incl. ones skipped by first-run guard)
  // so the byte offset advances past them and they aren't re-processed.
  state.turn_count = baseTurnCount + parseResult.turns.length;

  const cleaned = allRecords.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);
}

// ─── buildTurnRecords — convert one parsed Turn into event_t records ───

/**
 * @param turn  Result of parseQwenTranscript().turns[i]
 * @param turnIndex 0-based turn index (used in turn.id suffix)
 * @param sessionId qwen session id (becomes gen_ai.session.id and turn.id prefix)
 * @param prevHash  Running input.messages_hash chain head (carried across turns)
 * @param userId    Resolved user.id
 * @param turnStopReason Stop reason for the last LLM call in this turn
 * @param cwd       Optional working dir for agent.qwen-code-cli.cwd
 * @returns {{records: object[], hash: string}}
 */
export function buildTurnRecords(turn, turnIndex, sessionId, prevHash, userId, turnStopReason, cwd) {
  const records = [];
  // [C2] turn.id = <sessionId>:t<N>
  const turnId = `${sessionId}:t${turnIndex + 1}`;
  let runningHash = prevHash;
  // [C1] trace_id: generate once per turn, reuse for every event in this turn
  const traceId = generateTraceId();

  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    'user.id': userId,
    ...(cwd ? { 'agent.qwen-code-cli.cwd': cwd } : {}),
    ...(turn.gitBranch ? { 'git.branch': turn.gitBranch } : {}),
  };

  // [C7] User input → event.name=other + messages_delta (做法 A).
  // We DON'T emit llm.request for the user prompt; the converter glues delta
  // into ENTRY/AGENT's input.messages.
  if (turn.prompt) {
    records.push({
      time_unix_nano: isoToUnixNanos(turn.promptTimestamp),
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...baseFields,
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: turn.prompt }] },
      ],
    });
  }

  // For each LLM call (= one assistant record), emit:
  //   - llm.request   (request side, with messages_delta and hash)
  //   - llm.response  (response side, with token + multi-part output messages)
  //   - tool.call + tool.result for each functionCall (paired by callId)
  // [C3] STEP is created per LLM call boundary → STEP count == LLM count
  const llmCalls = turn.llmCalls || [];
  let stepRound = 0;

  for (const llm of llmCalls) {
    stepRound++;
    // [C2] step.id = <turnId>:s<M>
    const stepId = `${turnId}:s${stepRound}`;
    const stepSpanId = generateSpanId();
    const llmSpanId = generateSpanId();
    // [C4] LLM pairing key: request + response share gen_ai.response.id
    const responseId =
      llm.apiResponse?.responseId || llm.assistantUuid || `${stepId}:r`;

    // [C8] Provider from model name with auth_type fallback (not hardcoded)
    const provider = inferProvider(llm.model, llm.apiResponse?.authType);

    // inputMessagesDeltaRecords holds the user/tool_result records produced
    // BETWEEN the previous step and this one, so the call.id we need for each
    // tool_call_response part lives on each record's own `toolCallResult.callId`.
    // buildInputMessagesDelta reads that directly — no per-call override map is
    // needed (PR #37 review: B1 dead-Map removed).
    const inputMsgsDelta = buildInputMessagesDelta(
      llm.inputMessagesDeltaRecords || [],
    );
    const inputMsgsHash = computeHash(runningHash, inputMsgsDelta);

    // ─── llm.request ───
    records.push({
      // [C11] request time MUST differ from response time — use upstream
      // requestStartTime (timestamp of last user/tool_result before assistant)
      time_unix_nano: isoToUnixNanos(llm.requestStartTime || llm.timestamp),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': llm.model || 'unknown',
      'gen_ai.input.messages_hash': inputMsgsHash,
      ...(inputMsgsDelta.length > 0 ? { 'gen_ai.input.messages_delta': inputMsgsDelta } : {}),
    });
    runningHash = inputMsgsHash;

    // ─── llm.response ───
    // Token priority: assistant.usageMetadata (model-side, always present)
    // → api_response telemetry (transport-side, may be missing if user disabled
    //    telemetry). Both should agree, but assistant.usageMetadata is canonical.
    const usage = llm.usageMetadata || {};
    const inputTokens = usage.promptTokenCount ?? llm.apiResponse?.inputTokenCount ?? 0;
    const outputTokens = usage.candidatesTokenCount ?? llm.apiResponse?.outputTokenCount ?? 0;
    const cacheRead = usage.cachedContentTokenCount ?? llm.apiResponse?.cachedContentTokenCount ?? 0;
    const totalTokens = usage.totalTokenCount ?? (inputTokens + outputTokens);

    // [C5] All parts (reasoning + text + tool_call) MUST be in the SAME
    // response, not split into multiple records.
    const outputMessages = buildOutputMessages(llm.assistantRecord);
    const finishReason = inferAssistantFinishReason(llm.assistantRecord);

    const respRecord = {
      time_unix_nano: isoToUnixNanos(llm.timestamp),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': llm.model || 'unknown',
      'gen_ai.response.model': llm.model || 'unknown',
      'gen_ai.response.finish_reasons': [finishReason],
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheRead,
      'gen_ai.usage.total_tokens': totalTokens,
      'gen_ai.output.messages': outputMessages,
    };
    // attach api_error info if telemetry recorded the call as failed
    if (llm.apiResponse?.eventName === 'qwen-code.api_error') {
      respRecord['error.type'] = llm.apiResponse.errorType || 'ApiError';
      respRecord['error.message'] = String(llm.apiResponse.errorMessage || '').slice(0, 500);
      if (typeof llm.apiResponse.statusCode === 'number') {
        respRecord['http.status_code'] = llm.apiResponse.statusCode;
      }
      respRecord['gen_ai.response.finish_reasons'] = ['error'];
    }
    records.push(respRecord);

    // ─── tool.call + tool.result for each declared tool ───
    for (const tool of llm.declaredTools) {
      const toolSpanId = generateSpanId();
      // [C6] tool.call and tool.result share gen_ai.tool.call.id
      const callIdForEvent = tool.callId || `${stepId}:t${tool.partIndex}`;

      // tool.call: tied to the assistant's emit time (response time). If the
      // model emitted multiple parallel tool_calls in one assistant record,
      // they all share that timestamp — acceptable since the actual execution
      // start isn't separately observable from the transcript.
      records.push({
        time_unix_nano: isoToUnixNanos(llm.timestamp),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: stepSpanId,
        'gen_ai.step.id': stepId,
        'gen_ai.tool.name': tool.name,
        'gen_ai.tool.call.id': callIdForEvent,
        ...(tool.args != null ? { 'gen_ai.tool.call.arguments': tool.args } : {}),
      });

      if (tool.result) {
        const resultRec = {
          time_unix_nano: isoToUnixNanos(tool.result.timestamp),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          ...baseFields,
          span_id: toolSpanId,
          parent_span_id: stepSpanId,
          'gen_ai.step.id': stepId,
          'gen_ai.tool.name': tool.name,
          'gen_ai.tool.call.id': callIdForEvent,
          ...(tool.result.response != null ? { 'gen_ai.tool.call.result': tool.result.response } : {}),
          'tool.result.status': tool.result.status,
        };
        if (tool.result.status === 'error') {
          resultRec['error.type'] = 'ToolError';
          resultRec['error.message'] =
            typeof tool.result.error === 'string'
              ? tool.result.error.slice(0, 500)
              : String(tool.result.error || 'tool execution failed').slice(0, 500);
        }
        records.push(resultRec);
      }
      // Orphan tool.call (no result) emitted without tool.result — the trace
      // converter will warn but won't crash; this preserves the LLM's intent
      // in the trace.
    }
  }

  // [Sort by time_unix_nano] so events flow in chronological order. The trace
  // converter's pairing logic doesn't strictly require ordering, but flushers
  // process records sequentially, and out-of-order events can confuse downstream.
  records.sort((a, b) => {
    const ta = BigInt(a.time_unix_nano || '0');
    const tb = BigInt(b.time_unix_nano || '0');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  // Apply the final turn's stop_reason to the LAST llm.response (overrides
  // 'stop' inferred from parts). For example, qwen finishing with content
  // filter would be reflected in the host hook stdin's stop_reason field.
  if (turnStopReason && turnStopReason !== 'end_turn') {
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i]['event.name'] === 'llm.response') {
        records[i]['gen_ai.response.finish_reasons'] = [turnStopReason];
        break;
      }
    }
  }

  return { records, hash: runningHash };
}

// ─── CLI dispatch ───

const SUBCOMMAND = process.argv[2];

async function main() {
  switch (SUBCOMMAND) {
    case 'stop':
      await cmdStop();
      break;
    case 'subagent-start':
      cmdSubagentStart();
      break;
    case 'subagent-stop':
      cmdSubagentStop();
      break;
    default:
      // Unregistered subcommand — early return per fail-open contract.
      break;
  }
  // Hook output MUST be {} on success (qwen-code expects JSON; non-JSON
  // would mark the hook as failed in qwen-code's TRUSTED_HOOKS logs).
  process.stdout.write('{}\n');
}

// Only run when invoked as the main script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('qwen-code-cli-hook-processor.mjs')) {
  main().catch((err) => {
    // Last-resort safety net: log and exit 0 to avoid blocking qwen-code.
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

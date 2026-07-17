// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * grok-build-hook-processor.mjs — Grok Build hook 主分发器。
 *
 * 由 grok-build-loongsuite-pilot-hook.sh 调用:
 *   $ node grok-build-hook-processor.mjs <subcommand>
 *
 * 只处理 3 个 subcommand: stop / subagent-start / subagent-stop
 * 纯 transcript 驱动: 时间戳优先从 chat_history.jsonl record.timestamp 获取;
 * grok 0.2.x fixture 的 record 不携带 timestamp,落入合成单调时间线(以 stop
 * envelope.timestamp 为锚点,每事件 +1ms),避免所有 span 塌缩成 0ms 时长。
 * tool→step 归属: 通过 tool_use_id 从声明方 LLM output_content 匹配到 step
 *
 * Grok Build 在 ~/.grok/sessions/<enc-cwd>/<sid>/chat_history.jsonl 持久化对话历史。
 * Stop 事件 envelope.transcriptPath 指向同目录下 updates.jsonl,processor 用同目录 chat_history.jsonl 作 transcript 源。
 *
 * 字段命名全部使用 ai_event_schema.md 标准 `gen_ai.*` 前缀。
 * finish_reasons 输出为 string[](规范要求 array)。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { readStdinJson } from './shared/stdin-reader.mjs';
import {
  INITIAL_HASH,
  computeHash,
  shouldLogFullMessages,
  generateTraceId,
  generateSpanId,
  writeJsonlRecords,
} from './shared/event-emitter.mjs';
import { logHookError } from './shared/error-logger.mjs';
import {
  sanitizeObject,
  toJsonValue,
  loadHookRuntimeConfig,
  resolveUserId,
  applyHookContentPolicy,
} from './agent-event-normalizer.mjs';
import {
  loadState,
  saveState,
  readAndDeleteChildState,
} from './grok-build/state.mjs';
import { parseGrokTranscript } from './grok-build/transcript-parser.mjs';
import {
  convertInputMessages,
  convertOutputMessages,
  mapStopReason,
} from './claude-code/message-converter.mjs';
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
} from './shared/resource-context.mjs';

const AGENT_ID = 'grok-build';
const PROVIDER_NAME = 'x_ai';
const FRAMEWORK_NAME = 'grok-build';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};

function nowSec() {
  return Date.now() / 1000;
}

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID);
}

// R2: unified.jsonl is shared across sessions and grows monotonically (observed
// 324KB / 21 sessions in researcher fixture). Tail-read at most MAX_UNIFIED_BYTES
// to bound memory; sessions whose events were rotated past the tail are simply
// not enriched (acceptable: usage is best-effort, falls back to transcript usage).
export const MAX_UNIFIED_BYTES = 50 * 1024 * 1024;

function resolveUnifiedLogPath() {
  if (process.env.GROK_UNIFIED_LOG_PATH) return process.env.GROK_UNIFIED_LOG_PATH;
  return path.join(os.homedir(), '.grok', 'logs', 'unified.jsonl');
}

// F1: read ~/.grok/logs/unified.jsonl, filter by sid + msg=='shell.turn.inference_done',
// drop retry rows where ctx.prompt_tokens == null (R1). Returns an array ordered by
// ts then loop_index, one entry per non-null inference_done. Caller pops sequentially
// to enrich each LLM call in the session.
function loadUsageBySession(sessionId) {
  if (!sessionId) return [];
  const logPath = resolveUnifiedLogPath();
  let fileSize;
  try {
    fileSize = fs.statSync(logPath).size;
  } catch {
    return [];
  }
  if (fileSize <= 0) return [];

  let content;
  try {
    if (fileSize > MAX_UNIFIED_BYTES) {
      const fd = fs.openSync(logPath, 'r');
      try {
        const tailOffset = fileSize - MAX_UNIFIED_BYTES;
        const buf = Buffer.alloc(MAX_UNIFIED_BYTES);
        fs.readSync(fd, buf, 0, MAX_UNIFIED_BYTES, tailOffset);
        content = buf.toString('utf-8');
        const firstNewline = content.indexOf('\n');
        if (firstNewline >= 0) content = content.slice(firstNewline + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(logPath, 'utf-8');
    }
  } catch {
    return [];
  }

  const out = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (rec.msg !== 'shell.turn.inference_done') continue;
    if (rec.sid !== sessionId) continue;
    const ctx = rec.ctx || {};
    // R1: retry/aborted inferences emit prompt_tokens=null. Skip so the next
    // non-null inference aligns with the next assistant record in chat_history.
    if (ctx.prompt_tokens == null) continue;
    out.push({
      ts: rec.ts || null,
      loop_index: typeof ctx.loop_index === 'number' ? ctx.loop_index : null,
      prompt_tokens: ctx.prompt_tokens || 0,
      cached_prompt_tokens: ctx.cached_prompt_tokens || 0,
      completion_tokens: ctx.completion_tokens || 0,
      reasoning_tokens: ctx.reasoning_tokens || 0,
    });
  }
  out.sort((a, b) => {
    if (a.ts && b.ts) {
      const c = a.ts.localeCompare(b.ts);
      if (c !== 0) return c;
    }
    if (a.loop_index != null && b.loop_index != null) {
      return a.loop_index - b.loop_index;
    }
    return 0;
  });
  return out;
}

function tryReadStdin() {
  try {
    return normalizeEnvelope(readStdinJson());
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'stdin_parse',
      errorType: 'parse_failed',
      errorMessage: err?.message || String(err),
    });
    return {};
  }
}

// grok hook stdin uses camelCase envelope keys (sessionId/transcriptPath/reason/...),
// but the agent def declares eventKeyCase: snake. Normalize once at the boundary
// so downstream code only reads snake_case. Also folds grok's stop-hook `reason`
// field into the standard `stop_reason`.
const CAMEL_TO_SNAKE_KEYS = {
  hookEventName: 'hook_event_name',
  sessionId: 'session_id',
  transcriptPath: 'transcript_path',
  workspaceRoot: 'workspace_root',
  promptId: 'prompt_id',
  subagentSessionId: 'subagent_session_id',
  stopReason: 'stop_reason',
  agentId: 'agent_id',
  agentType: 'agent_type',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
};

function normalizeEnvelope(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
  const out = { ...event };
  for (const [camel, snake] of Object.entries(CAMEL_TO_SNAKE_KEYS)) {
    if (out[camel] !== undefined) {
      if (out[snake] === undefined) out[snake] = out[camel];
      delete out[camel];
    }
  }
  if (out.hook_event_name === 'stop' && out.reason !== undefined && out.stop_reason === undefined) {
    out.stop_reason = out.reason;
  }
  return out;
}

// Fallback: grok stores chat history at ~/.grok/sessions/<encodeURIComponent(cwd)>/<sid>/chat_history.jsonl.
// Used when state.transcript_path is missing (e.g., stop hook fired without subagent_start capturing it).
function deriveChatHistoryPath(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const encCwd = encodeURIComponent(cwd);
  return path.join(os.homedir(), '.grok', 'sessions', encCwd, sessionId, 'chat_history.jsonl');
}

function requireSessionId(event, stage = 'cmd') {
  const sid = event && (event.session_id || event.sessionId);
  if (typeof sid === 'string' && sid.length > 0) return sid;
  logHookError({
    agentId: AGENT_ID,
    stage,
    errorType: 'missing_session_id',
    errorMessage: 'hook stdin lacks session_id; skipping',
  });
  return null;
}

function isoToUnixNanos(isoStr) {
  if (!isoStr) return '0';
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return '0';
  return String(ms) + '000000';
}

function isoToMs(isoStr) {
  if (!isoStr) return null;
  const ms = new Date(isoStr).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// grok 0.2.x chat_history.jsonl records carry no timestamp/created_at field, so all
// events in a turn collapse onto the same stop-envelope fallback ts → 0ms spans.
// When the turn has no real per-record timestamps we synthesize a monotonic timeline
// anchored at the stop envelope ts (+1ms per event). Real timestamps (when present)
// are always preferred. Synthetic times keep step ranges disjoint (tools emit right
// after their declaring LLM) so validate-trace time.no_step_overlap stays green.
function makeTimeResolver(hasRealTimestamps, fallbackTs) {
  const fallbackMs = isoToMs(fallbackTs);
  const anchorMs = fallbackMs != null ? fallbackMs : Date.now();
  let synthTick = 0;
  return function resolveTime(realTs) {
    if (hasRealTimestamps && realTs) return isoToUnixNanos(realTs);
    const ms = anchorMs + synthTick;
    synthTick += 1;
    return String(ms) + '000000';
  };
}

function resolveChatHistoryPath(transcriptPath) {
  if (!transcriptPath) return null;
  const dir = path.dirname(transcriptPath);
  return path.join(dir, 'chat_history.jsonl');
}

function cmdSubagentStart() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  const state = loadState(sessionId);
  if (!state.transcript_path && event.transcript_path) {
    state.transcript_path = event.transcript_path;
  }
  if (!state.cwd && event.cwd && typeof event.cwd === 'string') {
    state.cwd = event.cwd;
  }
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
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  const state = loadState(sessionId);
  if (!state.transcript_path && event.transcript_path) {
    state.transcript_path = event.transcript_path;
  }
  if (!state.cwd && event.cwd && typeof event.cwd === 'string') {
    state.cwd = event.cwd;
  }

  const childSid = event.subagent_session_id || 'unknown';
  let childStateSnapshot = null;
  if (childSid && childSid !== 'unknown' && childSid !== sessionId) {
    childStateSnapshot = readAndDeleteChildState(childSid);
  }

  state.events = state.events || [];
  const evData = {
    type: 'subagent_stop',
    timestamp: nowSec(),
    subagent_session_id: childSid,
    stop_reason: event.stop_reason || 'end_turn',
    input_tokens: event.usage?.input_tokens || event.input_tokens || 0,
    output_tokens: event.usage?.output_tokens || event.output_tokens || 0,
  };
  if (childStateSnapshot && Array.isArray(childStateSnapshot.events) && childStateSnapshot.events.length > 0) {
    evData._child_state = childStateSnapshot;
  }
  state.events.push(evData);
  saveState(sessionId, state);
}

async function cmdStop() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'cmd');
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
    const usageEvents = loadUsageBySession(sessionId);
    await exportSession(state, event.stop_reason || 'end_turn', event.timestamp, usageEvents);
    if (typeof state._next_transcript_offset === 'number') {
      state.transcript_offset = state._next_transcript_offset;
      delete state._next_transcript_offset;
    }
    state.events = [];
    state.stop_time = null;
    saveState(sessionId, state);
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'cmd_stop',
      errorType: 'export_failed',
      errorMessage: err?.message || String(err),
    });
  }
}

async function waitForTranscriptStable(transcriptPath, minSize = 0) {
  let prevSize = -1;
  let stableCount = 0;
  for (let i = 0; i < 10; i++) {
    let size = 0;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      break;
    }
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

async function exportSession(state, stopReason, fallbackTs, usageEvents = []) {
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const sessionId = state.session_id || 'unknown';

  const chatHistoryPathFromState = resolveChatHistoryPath(state.transcript_path);
  const chatHistoryPath = chatHistoryPathFromState
    || deriveChatHistoryPath(state.cwd, state.session_id);
  if (!chatHistoryPath) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'export',
      errorType: 'missing_transcript_path',
      errorMessage: 'no transcript_path in state; cannot export',
    });
    return;
  }
  if (!state.transcript_path) {
    state.transcript_path = path.join(path.dirname(chatHistoryPath), 'updates.jsonl');
  }

  const baseOffset = state.transcript_offset || 0;

  await waitForTranscriptStable(chatHistoryPath, baseOffset);

  let parseResult;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      parseResult = parseGrokTranscript(chatHistoryPath, baseOffset);
      if (parseResult.turns.length > 0) break;
    } catch (err) {
      logHookError({
        agentId: AGENT_ID,
        stage: 'transcript_parse',
        errorType: 'parse_failed',
        errorMessage: err?.message || String(err),
      });
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
    await waitForTranscriptStable(chatHistoryPath, baseOffset);
  }

  if (!parseResult) return;
  state._next_transcript_offset = parseResult.nextOffset;
  if (parseResult.turns.length === 0) return;

  const userId = resolveUserId({}, runtimeConfig);
  const allRecords = [];
  let logHash = INITIAL_HASH;

  const baseTurnCount = state.turn_count || 0;

  const isFirstRun = !state.turn_count && baseOffset === 0;
  let turnsToExport = parseResult.turns;
  if (isFirstRun && parseResult.turns.length > 1) {
    turnsToExport = parseResult.turns.slice(-1);
  }

  // F3a: system_prompt is captured at chat_history offset 0 (the `type:system` record).
  // On incremental parses (offset > 0) the system record is behind us, so persist
  // it in state and reuse for the first AGENT span of every cmdStop batch where
  // baseTurnCount === 0 (i.e. the first turn the session emits).
  if (parseResult.systemPrompt && typeof parseResult.systemPrompt === 'string') {
    state.system_prompt = parseResult.systemPrompt;
  }
  const systemPrompt = state.system_prompt || null;

  const cwd = state.cwd || undefined;

  // F1: session-level cursor over filtered inference_done events. Each LLM call
  // across the whole session (across cmdStop batches) pops the next event. Cursor
  // advances here are not persisted — if a cmdStop batch consumes N events and the
  // next batch arrives, we re-scan unified.jsonl (cheap, sid-filtered, tail-bounded)
  // and skip past the already-emitted N by indexing baseTurnCount's worth of LLM
  // calls. Simpler: just pop sequentially within this batch since usageEvents is
  // rebuilt fresh each cmdStop and aligns head-of-list with the next unenriched LLM
  // call only if previous batches also advanced. To stay correct across batches,
  // track a counter in state of how many inference_done events have been consumed.
  const consumedSoFar = state.usage_events_consumed || 0;
  const usageState = { events: usageEvents, idx: consumedSoFar };

  for (let i = 0; i < turnsToExport.length; i++) {
    const turn = turnsToExport[i];
    const isLast = i === turnsToExport.length - 1;
    const turnStopReason = isLast ? stopReason : 'end_turn';
    const isAgentSpanTurn = (baseTurnCount + i) === 0;
    const { records, hash } = buildTurnRecords(
      turn,
      baseTurnCount + i,
      sessionId,
      logHash,
      userId,
      turnStopReason,
      cwd,
      fallbackTs,
      systemPrompt,
      isAgentSpanTurn,
      usageState,
    );
    allRecords.push(...records);
    logHash = hash;
  }

  state.usage_events_consumed = usageState.idx;
  state.turn_count = baseTurnCount + parseResult.turns.length;

  const cleaned = allRecords.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);
}

function buildTurnRecords(turn, turnIndex, sessionId, prevHash, userId, turnStopReason, cwd, fallbackTs, systemPrompt, isAgentSpanTurn, usageState) {
  const records = [];
  const turnId = `${sessionId}:t${turnIndex + 1}`;
  let stepRound = 0;
  let runningHash = prevHash;
  let prevInputMsgs = [];

  const traceId = generateTraceId();
  const agentSpanId = generateSpanId();

  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    'gen_ai.framework': FRAMEWORK_NAME,
    ...RESOURCE_BASE_FIELD_PATCH,
    'user.id': userId,
    ...(cwd ? { 'agent.grok-build.cwd': cwd } : {}),
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };

  // F3a: emit gen_ai.system_instructions as a spec-compliant array of
  // {type:'text', content} blocks on the first AGENT span of the session only.
  // Sources: chat_history record 0 (type:system) — captured by parser and
  // persisted in state.system_prompt so incremental cmdStop batches still see it.
  if (isAgentSpanTurn && systemPrompt) {
    baseFields['gen_ai.system_instructions'] = [{ type: 'text', content: systemPrompt }];
  }

  const llmCalls = turn.llmCalls || [];

  // Real timestamps: any user prompt, assistant, tool result, or toolUse timestamp
  // present in the transcript. grok 0.2.x fixture has none → synthetic timeline kicks in.
  const hasRealTimestamps = !!turn.promptTimestamp
    || llmCalls.some((ev) => ev.timestamp || ev.request_start_time
      || (ev.toolDetails && [...ev.toolDetails.values()].some((t) => t.call || t.result)));
  const resolveTime = makeTimeResolver(hasRealTimestamps, fallbackTs);

  if (turn.prompt) {
    records.push({
      time_unix_nano: resolveTime(turn.promptTimestamp),
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...baseFields,
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: turn.prompt }] },
      ],
    });
  }

  const toolIdToStep = new Map();

  for (const ev of llmCalls) {
    stepRound++;
    const currentStepId = `${turnId}:s${stepRound}`;
    const currentStepSpanId = generateSpanId();
    const llmSpanId = generateSpanId();
    const responseId = ev.message_id || `${currentStepId}:r`;

    for (const toolId of (ev.declaredToolIds || [])) {
      toolIdToStep.set(toolId, { stepId: currentStepId, stepSpanId: currentStepSpanId });
    }

    const inputMsgs = convertInputMessages(ev.input_messages, ev.protocol || 'anthropic');
    let currentFullHash;
    let delta;
    let logFull;
    if (ev._input_is_delta) {
      delta = inputMsgs;
      currentFullHash = computeHash(runningHash, delta);
      logFull = false;
    } else {
      currentFullHash = computeHash(INITIAL_HASH, inputMsgs);
      delta = inputMsgs.slice(prevInputMsgs.length);
      logFull = shouldLogFullMessages(runningHash, delta, currentFullHash);
    }

    const reqRecord = {
      time_unix_nano: resolveTime(ev.request_start_time || ev.timestamp),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': ev.model || 'grok',
      'gen_ai.input.messages_hash': currentFullHash,
      'gen_ai.input.messages_delta': delta,
    };
    if (logFull) {
      reqRecord['gen_ai.input.messages'] = inputMsgs;
    }
    records.push(reqRecord);

    // F1: pop the next non-null inference_done event for this LLM call. Session
    // cursor (usageState.idx) advances across turns and across cmdStop batches
    // (state.usage_events_consumed persisted). When the unified log is empty or
    // the session has more LLM calls than recorded inferences, fall back to the
    // transcript's assistant.usage (typically 0 in grok 0.2.x → token=0 known gap).
    //
    // grok's `prompt_tokens` is OpenAI-style (total input, including cached);
    // `cached_prompt_tokens` is a subset, NOT additive. So when injected we set
    // input_tokens = prompt_tokens and cache_read = cached_prompt_tokens as a
    // separate breakdown (no double-count). When falling back to transcript
    // (anthropic-style usage) we keep the additive convention input + cache.
    let injectedUsage = null;
    if (usageState && usageState.events && usageState.idx < usageState.events.length) {
      injectedUsage = usageState.events[usageState.idx];
      usageState.idx += 1;
    }

    let apiInputTokens;
    let cacheRead;
    let cacheCreation;
    let outputTokens;
    if (injectedUsage) {
      apiInputTokens = injectedUsage.prompt_tokens || 0;
      cacheRead = injectedUsage.cached_prompt_tokens || 0;
      cacheCreation = 0;
      outputTokens = injectedUsage.completion_tokens || 0;
    } else {
      apiInputTokens = ev.input_tokens || 0;
      cacheRead = ev.cache_read_input_tokens || 0;
      cacheCreation = ev.cache_creation_input_tokens || 0;
      outputTokens = ev.output_tokens || 0;
    }
    const inputTokens = injectedUsage
      ? apiInputTokens
      : apiInputTokens + cacheRead + cacheCreation;
    // For injected usage, grok's prompt_tokens is the total input (OpenAI-style);
    // for the transcript fallback (Anthropic-style usage) we sum api + cache.
    const totalTokens = inputTokens + outputTokens;

    const finishReason = mapStopReason(ev.stop_reason || 'stop');

    const respRecord = {
      time_unix_nano: resolveTime(ev.timestamp),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': ev.model || 'grok',
      'gen_ai.response.model': ev.model || 'grok',
      'gen_ai.response.finish_reasons': [finishReason],
      'gen_ai.output.finish_reason': finishReason,
      'gen_ai.react.finish_reason': finishReason,
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheRead,
      'gen_ai.usage.cache_creation.input_tokens': cacheCreation,
      'gen_ai.usage.total_tokens': totalTokens,
      'gen_ai.output.messages': convertOutputMessages(ev.output_content, ev.stop_reason),
    };
    records.push(respRecord);

    runningHash = currentFullHash;
    prevInputMsgs = ev._input_is_delta ? [] : inputMsgs;

    // Emit tools for this LLM right after its response so synthetic-timeline step
    // ranges stay disjoint (no overlap with subsequent steps).
    for (const toolId of (ev.declaredToolIds || [])) {
      const timestamps = ev.toolDetails?.get(toolId);
      if (!timestamps) continue;

      const toolBlock = ev.output_content.find(
        (b) => b.type === 'tool_use' && b.id === toolId,
      );
      if (!toolBlock) continue;

      const toolName = toolBlock.name || 'unknown';
      const toolSpanId = generateSpanId();

      // Has any signal that the tool finished (explicit result ts or non-empty content)?
      // grok 0.2.x fixture lacks timestamps entirely; resultContent is the only finish signal.
      const hasResult = !!timestamps.result || (typeof timestamps.resultContent === 'string'
        ? timestamps.resultContent.length > 0
        : timestamps.resultContent != null);

      const toolArgs = toJsonValue(toolBlock.input) ?? {};

      records.push({
        time_unix_nano: resolveTime(timestamps.call || ev.timestamp),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: currentStepSpanId,
        'gen_ai.step.id': currentStepId,
        'gen_ai.tool.name': toolName,
        'gen_ai.tool.call.id': toolId,
        'gen_ai.tool.call.arguments': toolArgs,
      });

      // F2/F7: grok fixture may not record a tool_result for every tool_call
      // (e.g., todo_write often has no recorded result in multi-tool turns).
      // Emit a synthetic tool.result so the converter's pairTool logic doesn't
      // flag the tool.call as orphan, and the TOOL span gets a non-zero duration
      // in the synthetic timeline (resolveTime ticks forward per call).
      const resultTs = timestamps.result || timestamps.call || ev.timestamp;
      let resultPayload;
      let isSynthetic = false;
      if (hasResult) {
        resultPayload = timestamps.resultContent ?? '';
      } else {
        resultPayload = '[grok transcript: no tool_result recorded for this tool_call]';
        isSynthetic = true;
      }

      // F6: wrap result in spec message structure
      // [{role:"tool",parts:[{type:"tool_call_response",id,response}]}]
      const structuredResult = [{
        role: 'tool',
        parts: [{
          type: 'tool_call_response',
          id: toolId,
          name: toolName,
          response: resultPayload,
        }],
      }];

      const resultRecord = {
        time_unix_nano: resolveTime(resultTs),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.result',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: currentStepSpanId,
        'gen_ai.step.id': currentStepId,
        'gen_ai.tool.name': toolName,
        'gen_ai.tool.call.id': toolId,
        'gen_ai.tool.call.result': toJsonValue(structuredResult) ?? structuredResult,
        'tool.result.status': isSynthetic
          ? 'unknown'
          : (timestamps.isError ? 'error' : 'success'),
      };
      if (timestamps.isError) {
        resultRecord['error.type'] = 'ToolError';
        resultRecord['error.message'] = typeof timestamps.resultContent === 'string'
          ? timestamps.resultContent.slice(0, 500)
          : 'tool execution failed';
      }
      records.push(resultRecord);
    }
  }

  records.sort((a, b) => {
    const ta = BigInt(a.time_unix_nano || '0');
    const tb = BigInt(b.time_unix_nano || '0');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  return { records, hash: runningHash };
}

const DISPATCH = {
  'stop': cmdStop,
  'subagent-start': cmdSubagentStart,
  'subagent-stop': cmdSubagentStop,
};

const sub = process.argv[2] || 'unknown';
const fn = DISPATCH[sub];
if (fn) {
  Promise.resolve(fn()).catch((err) => {
    logHookError({
      agentId: AGENT_ID,
      stage: `dispatch_${sub}`,
      errorType: 'unhandled',
      errorMessage: err?.message || String(err),
    });
  }).finally(() => {
    process.stdout.write('{}\n');
  });
} else {
  process.stdout.write('{}\n');
}

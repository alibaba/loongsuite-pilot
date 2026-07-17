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
    await exportSession(state, event.stop_reason || 'end_turn', event.timestamp);
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

async function exportSession(state, stopReason, fallbackTs) {
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

  const cwd = state.cwd || undefined;

  for (let i = 0; i < turnsToExport.length; i++) {
    const turn = turnsToExport[i];
    const isLast = i === turnsToExport.length - 1;
    const turnStopReason = isLast ? stopReason : 'end_turn';
    const { records, hash } = buildTurnRecords(
      turn,
      baseTurnCount + i,
      sessionId,
      logHash,
      userId,
      turnStopReason,
      cwd,
      fallbackTs,
    );
    allRecords.push(...records);
    logHash = hash;
  }

  state.turn_count = baseTurnCount + parseResult.turns.length;

  const cleaned = allRecords.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);
}

function buildTurnRecords(turn, turnIndex, sessionId, prevHash, userId, turnStopReason, cwd, fallbackTs) {
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
    ...RESOURCE_BASE_FIELD_PATCH,
    'user.id': userId,
    ...(cwd ? { 'agent.grok-build.cwd': cwd } : {}),
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };

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

    const apiInputTokens = ev.input_tokens || 0;
    const cacheRead = ev.cache_read_input_tokens || 0;
    const cacheCreation = ev.cache_creation_input_tokens || 0;
    const inputTokens = apiInputTokens + cacheRead + cacheCreation;
    const outputTokens = ev.output_tokens || 0;
    const totalTokens = inputTokens + outputTokens;

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
      'gen_ai.response.finish_reasons': [mapStopReason(ev.stop_reason || 'stop')],
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
        'gen_ai.tool.call.arguments': toJsonValue(toolBlock.input || {}),
      });

      if (hasResult) {
        const resultRecord = {
          time_unix_nano: resolveTime(timestamps.result || timestamps.call || ev.timestamp),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          ...baseFields,
          span_id: toolSpanId,
          parent_span_id: currentStepSpanId,
          'gen_ai.step.id': currentStepId,
          'gen_ai.tool.name': toolName,
          'gen_ai.tool.call.id': toolId,
          'gen_ai.tool.call.result': toJsonValue(timestamps.resultContent || ''),
          'tool.result.status': timestamps.isError ? 'error' : 'success',
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

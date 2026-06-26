#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * claude-code-hook-processor.mjs — Claude Code hook 主分发器 (v2)。
 *
 * 由 claude-code-loongsuite-pilot-hook.sh 调用:
 *   $ node claude-code-hook-processor.mjs <subcommand>
 *
 * v2 重构:
 *   - 只处理 3 个 subcommand: stop / subagent-start / subagent-stop
 *   - 纯 transcript 驱动: 时间戳从 transcript record.timestamp 获取
 *   - tool→step 归属: 通过 tool_use_id 从 LLM output_content 匹配到声明方 step
 *   - 不再依赖 alignWithHookEvents / hook 事件累积
 *
 * 字段命名全部使用 ai_event_schema.md 标准 `gen_ai.*` 前缀。
 * finish_reasons 输出为 string[](规范要求 array)。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { readStdinJson, isCursorCaller } from './shared/stdin-reader.mjs';
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
} from './claude-code/state.mjs';
import {
  parseClaudeTranscript,
} from './claude-code/transcript-parser.mjs';
import {
  convertInputMessages,
  convertOutputMessages,
  mapStopReason,
} from './claude-code/message-converter.mjs';
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
} from './shared/resource-context.mjs';

const AGENT_ID = 'claude-code';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};

// ─── utilities ───

function nowSec() {
  return Date.now() / 1000;
}

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID);
}

// ─── intercept (BUN_OPTIONS preload) data integration ───

const INTERCEPT_STALE_MS = 60 * 60 * 1000; // 1 hour

function interceptSessionDir(sessionId) {
  return path.join(pilotDataDir(), 'intercept', AGENT_ID, sessionId);
}

/**
 * Read per-LLM-call intercept records dropped by claude-code-fetch-intercept.mjs.
 * Returns Map<response_id, { ttft_ns, system_instructions, _file }>.
 * Tracks `_file` so reapInterceptFiles can delete merged records after
 * buildTurnRecords consumes them.
 */
function loadInterceptForSession(sessionId) {
  const out = new Map();
  const dir = interceptSessionDir(sessionId);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_) {
      // Corrupt record (preload crashed mid-write): leave the file in place
      // so the stale reaper picks it up later, do not block merging.
      continue;
    }
    if (raw && typeof raw.response_id === 'string' && raw.response_id.length > 0) {
      out.set(raw.response_id, { ...raw, _file: filePath });
    }
  }
  return out;
}

/**
 * Delete intercept files corresponding to response_ids that buildTurnRecords
 * actually merged into emitted events. Files whose response_id was not in
 * the transcript stay on disk (they may belong to a future turn or be
 * stragglers that reapStaleIntercept will clean up).
 */
function reapInterceptFiles(intercept, mergedResponseIds) {
  for (const rid of mergedResponseIds) {
    const data = intercept.get(rid);
    if (!data?._file) continue;
    try { fs.unlinkSync(data._file); } catch (_) {}
  }
}

/**
 * Opportunistic cleanup: drop files in this session's intercept dir whose
 * mtime is older than STALE_MS (1h). Called once at the end of exportSession
 * — handles orphans from prior turns whose response_ids never showed up in
 * any subsequent transcript. Also rmdir if the dir is empty afterwards.
 */
function reapStaleIntercept(sessionId) {
  const dir = interceptSessionDir(sessionId);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of entries) {
    const f = path.join(dir, name);
    try {
      const st = fs.statSync(f);
      if (now - st.mtimeMs > INTERCEPT_STALE_MS) fs.unlinkSync(f);
    } catch (_) {}
  }
  try { fs.rmdirSync(dir); } catch (_) {}
}

function tryReadStdin() {
  try {
    return readStdinJson();
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

function requireSessionId(event, stage = 'cmd') {
  const sid = event && event.session_id;
  if (typeof sid === 'string' && sid.length > 0) return sid;
  logHookError({
    agentId: AGENT_ID,
    stage,
    errorType: 'missing_session_id',
    errorMessage: 'hook stdin lacks session_id; skipping',
  });
  return null;
}

/**
 * ISO8601 字符串转为 time_unix_nano 字符串。
 */
function isoToUnixNanos(isoStr) {
  if (!isoStr) return '0';
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return '0';
  return String(ms) + '000000';
}

// ─── cmd handlers ───

// TODO: subagent 事件累积到 state.events，当前 exportSession 未消费。
// 预留用于未来子 agent trace 合并（将子 agent 的 span 关联到主 trace）。
function cmdSubagentStart() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
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
  if (isCursorCaller(event)) return;
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
    cache_read_input_tokens: event.usage?.cache_read_input_tokens || event.cache_read_input_tokens || 0,
    cache_creation_input_tokens: event.usage?.cache_creation_input_tokens || event.cache_creation_input_tokens || 0,
  };
  if (childStateSnapshot && Array.isArray(childStateSnapshot.events) && childStateSnapshot.events.length > 0) {
    evData._child_state = childStateSnapshot;
  }
  state.events.push(evData);
  saveState(sessionId, state);
}

async function cmdStop() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
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
      agentId: AGENT_ID,
      stage: 'cmd_stop',
      errorType: 'export_failed',
      errorMessage: err?.message || String(err),
    });
  }
}

// ─── transcript 稳定性等待 ───

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

// ─── Stop 主导出流程 ───

async function exportSession(state, stopReason) {
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const sessionId = state.session_id || 'unknown';

  if (!state.transcript_path) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'export',
      errorType: 'missing_transcript_path',
      errorMessage: 'no transcript_path in state; cannot export',
    });
    return;
  }

  const transcriptPath = state.transcript_path;
  const baseOffset = state.transcript_offset || 0;

  // 等待 transcript 文件写入稳定
  await waitForTranscriptStable(transcriptPath, baseOffset);

  // 解析 transcript (纯 transcript 驱动,不需要 hook 事件)
  let parseResult;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      parseResult = parseClaudeTranscript(transcriptPath, baseOffset);
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
    await waitForTranscriptStable(transcriptPath, baseOffset);
  }

  if (!parseResult) return;
  state._next_transcript_offset = parseResult.nextOffset;
  if (parseResult.turns.length === 0) return;

  const userId = resolveUserId({}, runtimeConfig);
  const allRecords = [];
  let logHash = INITIAL_HASH;

  const baseTurnCount = state.turn_count || 0;

  // 首次运行防护: 新安装/重装后 state 被清空(offset=0, 无 turn_count),
  // 如果 transcript 包含大量历史 turn, 只上报最后一个(当前对话), 跳过历史。
  const isFirstRun = !state.turn_count && baseOffset === 0;
  let turnsToExport = parseResult.turns;
  if (isFirstRun && parseResult.turns.length > 1) {
    turnsToExport = parseResult.turns.slice(-1);
  }

  const cwd = state.cwd || undefined;

  // Load per-session intercept data once; buildTurnRecords looks up by
  // response_id (= Anthropic message_id). Empty Map when preload didn't
  // produce any files — merge logic safely no-ops in that case.
  const intercept = loadInterceptForSession(sessionId);
  const mergedResponseIds = new Set();

  for (let i = 0; i < turnsToExport.length; i++) {
    const turn = turnsToExport[i];
    const isLast = i === turnsToExport.length - 1;
    const turnStopReason = isLast ? stopReason : 'end_turn';
    const { records, hash, mergedResponseIds: turnMerged } = buildTurnRecords(
      turn,
      baseTurnCount + i,
      sessionId,
      logHash,
      userId,
      turnStopReason,
      cwd,
      intercept,
    );
    allRecords.push(...records);
    logHash = hash;
    if (turnMerged) {
      for (const rid of turnMerged) mergedResponseIds.add(rid);
    }
  }

  // turn_count 计入全部 turns(含跳过的历史), 确保 offset 正确推进不重复上报
  state.turn_count = baseTurnCount + parseResult.turns.length;

  const cleaned = allRecords.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);

  // Cleanup intercept files: delete what we merged + drop stragglers from
  // earlier turns. Failure is silent — host process must not be impacted.
  reapInterceptFiles(intercept, mergedResponseIds);
  reapStaleIntercept(sessionId);
}

// ─── buildTurnRecords — 单 turn 的 JSONL 记录构造 (v2: tool_use_id 归属) ───

function buildTurnRecords(turn, turnIndex, sessionId, prevHash, userId, turnStopReason, cwd, intercept) {
  const records = [];
  const turnId = `${sessionId}:t${turnIndex + 1}`;
  let stepRound = 0;
  let runningHash = prevHash;
  let prevInputMsgs = [];
  // response_ids whose intercept record we actually merged into emitted
  // events. exportSession uses this set to delete the corresponding
  // intercept files after JSONL is flushed.
  const mergedResponseIds = new Set();

  const traceId = generateTraceId();
  const entrySpanId = generateSpanId();
  const agentSpanId = generateSpanId();

  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    ...RESOURCE_BASE_FIELD_PATCH,
    'user.id': userId,
    ...(cwd ? { 'agent.claude-code.cwd': cwd } : {}),
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };

  // 用户输入: 做法 A (EVENT_LOG_TO_TRACE_SPEC §5.1, 0.1.0-beta.3+)
  // event.name="other" + messages_delta → 转换器归并到 ENTRY/AGENT 的 input.messages
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

  // Phase 1: 为每个 llm_call 创建 step + 生成 LLM 事件
  const toolIdToStep = new Map(); // tool_use_id → { stepId, stepSpanId }
  const llmCalls = turn.llmCalls || [];

  for (const ev of llmCalls) {
    stepRound++;
    const currentStepId = `${turnId}:s${stepRound}`;
    const currentStepSpanId = generateSpanId();
    const llmSpanId = generateSpanId();
    const responseId = ev.message_id || `${currentStepId}:r`;

    // 注册该 LLM 声明的所有 tool_use_id → 当前 step
    for (const toolId of (ev.declaredToolIds || [])) {
      toolIdToStep.set(toolId, { stepId: currentStepId, stepSpanId: currentStepSpanId });
    }

    // input messages delta/full hash
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

    // Look up preload-captured data once per LLM call. ev.message_id matches
    // the SSE message_start `message.id` the preload script extracted.
    const interceptData = intercept && ev.message_id
      ? intercept.get(ev.message_id)
      : undefined;
    if (interceptData) mergedResponseIds.add(ev.message_id);

    // llm.request
    const reqRecord = {
      time_unix_nano: isoToUnixNanos(ev.request_start_time),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': ev.model || 'unknown',
      'gen_ai.input.messages_hash': currentFullHash,
      'gen_ai.input.messages_delta': delta,
    };
    if (logFull) {
      reqRecord['gen_ai.input.messages'] = inputMsgs;
    }
    if (interceptData && Array.isArray(interceptData.system_instructions)
        && interceptData.system_instructions.length > 0) {
      reqRecord['gen_ai.system_instructions'] = interceptData.system_instructions;
    }
    records.push(reqRecord);

    // token 全量公式: input = api + cacheRead + cacheCreation
    const apiInputTokens = ev.input_tokens || 0;
    const cacheRead = ev.cache_read_input_tokens || 0;
    const cacheCreation = ev.cache_creation_input_tokens || 0;
    const inputTokens = apiInputTokens + cacheRead + cacheCreation;
    const outputTokens = ev.output_tokens || 0;
    const totalTokens = inputTokens + outputTokens;

    // llm.response
    const respRecord = {
      time_unix_nano: isoToUnixNanos(ev.timestamp),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': ev.model || 'unknown',
      'gen_ai.response.model': ev.model || 'unknown',
      'gen_ai.response.finish_reasons': [mapStopReason(ev.stop_reason || 'stop')],
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheRead,
      'gen_ai.usage.cache_creation.input_tokens': cacheCreation,
      'gen_ai.usage.total_tokens': totalTokens,
      'gen_ai.output.messages': convertOutputMessages(ev.output_content, ev.stop_reason),
    };
    if (interceptData && typeof interceptData.ttft_ns === 'number'
        && Number.isFinite(interceptData.ttft_ns) && interceptData.ttft_ns >= 0) {
      respRecord['gen_ai.response.time_to_first_token'] = interceptData.ttft_ns;
    }
    records.push(respRecord);

    runningHash = currentFullHash;
    prevInputMsgs = ev._input_is_delta ? [] : inputMsgs;
  }

  // Phase 2: 为每个 tool 生成 tool.call + tool.result，归属到声明方 LLM 的 step
  for (const ev of llmCalls) {
    for (const toolId of (ev.declaredToolIds || [])) {
      const owner = toolIdToStep.get(toolId);
      if (!owner) continue;

      const timestamps = ev.toolDetails?.get(toolId);
      if (!timestamps) continue;

      // 从 output_content 找到该 tool_use block 的 name + input
      const toolBlock = ev.output_content.find(
        (b) => b.type === 'tool_use' && b.id === toolId,
      );
      if (!toolBlock) continue;

      const toolName = toolBlock.name || 'unknown';
      if (toolName === 'Agent' || toolName === 'agent') continue;

      const toolSpanId = generateSpanId();

      // tool.call
      records.push({
        time_unix_nano: isoToUnixNanos(timestamps.call),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: owner.stepSpanId,
        'gen_ai.step.id': owner.stepId,
        'gen_ai.tool.name': toolName,
        'gen_ai.tool.call.id': toolId,
        'gen_ai.tool.call.arguments': toJsonValue(toolBlock.input || {}),
      });

      // tool.result (only if we have a result timestamp)
      if (timestamps.result) {
        const resultRecord = {
          time_unix_nano: isoToUnixNanos(timestamps.result),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          ...baseFields,
          span_id: toolSpanId,
          parent_span_id: owner.stepSpanId,
          'gen_ai.step.id': owner.stepId,
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

  // 按 time_unix_nano 排序，确保 tool 事件交错在 LLM 事件之间。
  // OTLP flusher 在收到 finish_reasons=stop 时立即 flush turn buffer，
  // 如果 tool 事件全部堆在末尾（在 stop 之后），会被丢弃。
  records.sort((a, b) => {
    const ta = BigInt(a.time_unix_nano || '0');
    const tb = BigInt(b.time_unix_nano || '0');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  return { records, hash: runningHash, mergedResponseIds };
}

// ─── dispatcher ───

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

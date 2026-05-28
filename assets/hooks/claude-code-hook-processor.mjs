#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * claude-code-hook-processor.mjs — Claude Code hook 主分发器。
 *
 * 由 claude-code-loongsuite-pilot-hook.sh 调用,每个 hook 事件触发一次:
 *   $ node claude-code-hook-processor.mjs <subcommand>
 *
 * Subcommand ↔ Claude hook event:
 *   user-prompt-submit / pre-tool-use / post-tool-use / stop
 *   pre-compact / subagent-start / subagent-stop / notification
 *
 * 整体职责:
 *   - UserPromptSubmit / PreToolUse / PostToolUse / PreCompact / SubagentStart /
 *     SubagentStop / Notification: 累积 event 到 state.events,持久化
 *   - Stop: 触发 transcript 增量解析 + 切 turn + 写 JSONL,持久化 transcript_offset
 *
 * 关键移植 + 修复:
 *   - isCursorCaller 早返回 (cursor IDE 调用 Claude 时避免双重采集)
 *   - 7.5 byteOffset 增量读 (跨 turn 跳过已消费字节)
 *   - 7.7 input_tokens 全量公式 (input = apiInput + cacheRead + cacheCreation)
 *   - 7.9 logOnly 模式 trace_id / span_id 自生成 (无 OTel SDK)
 *   - 30% PostToolUse drop 修复 (孤儿 PreToolUse 输出 tool.call,无对应 result)
 *   - SubagentStop 子 state 合并 (readAndDeleteChildState)
 *   - cmdStop transcript 解析空时 retry 50ms × 3 (R9: 防止 transcript flush 慢)
 *
 * 字段命名全部使用 ai_event_schema.md 标准 `gen_ai.*` 前缀。
 * finish_reasons 输出为 string[](规范要求 array)。
 */

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
  timestampToUnixNanos,
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
  alignWithHookEvents,
} from './claude-code/transcript-parser.mjs';
import {
  convertInputMessages,
  convertOutputMessages,
  mapStopReason,
} from './claude-code/message-converter.mjs';
import {
  extractToolResult,
  extractToolError,
} from './claude-code/tool-utils.mjs';

const AGENT_ID = 'claude-code';

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

function maybeSaveTranscriptPath(state, event) {
  if (!state.transcript_path && event.transcript_path) {
    state.transcript_path = event.transcript_path;
  }
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

/**
 * 没拿到合法 session_id 时跳过 state 写入,避免污染 sessions/ 目录。
 * Claude / Cursor / Codex 的 hook stdin 都会带 session_id;若缺失说明 stdin 解析有问题
 * 或调用方异常,直接早返回(已 logHookError 记录,fail-open)。
 */
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

// ─── 8 cmd handlers — 累积 event 到 state ───

function cmdUserPromptSubmit() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;
  const prompt = event.prompt || '';

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.start_time = state.start_time || nowSec();
  if (!state.prompt) state.prompt = prompt;
  state.metrics = state.metrics || {};
  state.metrics.turns = (state.metrics.turns || 0) + 1;
  if (event.model) state.model = event.model;

  state.events.push({
    type: 'user_prompt_submit',
    timestamp: nowSec(),
    prompt,
  });
  saveState(sessionId, state);
}

function cmdPreToolUse() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;
  const toolName = event.tool_name || 'unknown';
  const toolInput = event.tool_input || {};
  // 缺 tool_use_id 时不 fallback uuid — 让 cmdPostToolUse 配不上,孤儿 → 30% drop 修复路径处理
  const toolUseId = event.tool_use_id || null;

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.metrics = state.metrics || {};
  state.metrics.tools_used = (state.metrics.tools_used || 0) + 1;
  state.tools_used = state.tools_used || [];
  if (!state.tools_used.includes(toolName)) state.tools_used.push(toolName);

  state.events.push({
    type: 'pre_tool_use',
    timestamp: nowSec(),
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  });
  saveState(sessionId, state);
}

function cmdPostToolUse() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.events.push({
    type: 'post_tool_use',
    timestamp: nowSec(),
    tool_name: event.tool_name || 'unknown',
    tool_response: event.tool_response,
    tool_use_id: event.tool_use_id || null,
  });
  saveState(sessionId, state);
}

function cmdPreCompact() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.events.push({
    type: 'pre_compact',
    timestamp: nowSec(),
    trigger: event.trigger || 'unknown',
    has_custom_instructions:
      event.custom_instructions !== null && event.custom_instructions !== undefined,
  });
  saveState(sessionId, state);
}

function cmdSubagentStart() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
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
  const stopReason = event.stop_reason || 'end_turn';

  const usage = event.usage || {};
  const inputTokens = usage.input_tokens || event.input_tokens || 0;
  const outputTokens = usage.output_tokens || event.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || event.cache_read_input_tokens || 0;
  const cacheCreate =
    usage.cache_creation_input_tokens || event.cache_creation_input_tokens || 0;

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);

  const childSid = event.subagent_session_id || 'unknown';
  let childStateSnapshot = null;
  if (childSid && childSid !== 'unknown' && childSid !== sessionId) {
    childStateSnapshot = readAndDeleteChildState(childSid);
  }

  const evData = {
    type: 'subagent_stop',
    timestamp: nowSec(),
    subagent_session_id: childSid,
    stop_reason: stopReason,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
  if (childStateSnapshot && Array.isArray(childStateSnapshot.events) && childStateSnapshot.events.length > 0) {
    evData._child_state = childStateSnapshot;
  }

  state.events.push(evData);
  saveState(sessionId, state);
}

function cmdNotification() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.events.push({
    type: 'notification',
    timestamp: nowSec(),
    message: event.message || '',
    title: event.title || '',
    level: event.level || 'info',
  });
  saveState(sessionId, state);
}

async function cmdStop() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;
  const stopReason = event.stop_reason || 'end_turn';

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.stop_time = nowSec();
  saveState(sessionId, state);

  try {
    await exportSession(state, stopReason);
    // 固化下次 transcript 增量起点 + 清空 events
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

// ─── Stop 主流程 ───

function splitEventsByTurn(events) {
  const turns = [];
  let current = null;

  for (const ev of events) {
    if (ev.type === 'user_prompt_submit') {
      if (current) current.endTime = ev.timestamp || current.startTime;
      current = {
        prompt: ev.prompt || '',
        startTime: ev.timestamp || nowSec(),
        endTime: null,
        events: [],
      };
      turns.push(current);
    } else if (current) {
      current.events.push(ev);
    }
  }
  return turns;
}

/**
 * Stop 主导出流程:
 *   1. 增量读 transcript(retry 50ms × 3 防止 flush 慢)
 *   2. alignWithHookEvents 校准时间戳
 *   3. 合并到 events,按时间排序
 *   4. splitEventsByTurn
 *   5. 每 turn 调 buildTurnRecords + write JSONL
 */
async function exportSession(state, stopReason) {
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const sessionId = state.session_id || 'unknown';
  const startTime = typeof state.start_time === 'number' ? state.start_time : nowSec();
  const stopTime = typeof state.stop_time === 'number' ? state.stop_time : nowSec();

  let allEvents = Array.isArray(state.events) ? [...state.events] : [];
  let llmEvents = [];

  // R9: transcript 增量读取,空时 retry 50ms × 3 防 flush 慢
  if (state.transcript_path) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        llmEvents = parseClaudeTranscript(
          state.transcript_path,
          startTime,
          stopTime,
          state.transcript_offset || 0,
        );
        if (typeof llmEvents.nextOffset === 'number') {
          state._next_transcript_offset = llmEvents.nextOffset;
        }
        if (llmEvents.length > 0) {
          alignWithHookEvents(llmEvents, allEvents, stopTime);
          break;
        }
      } catch (err) {
        logHookError({
          agentId: AGENT_ID,
          stage: 'transcript_parse',
          errorType: 'parse_failed',
          errorMessage: err?.message || String(err),
        });
        break;
      }
      // 空读 → 等 50ms 再试(transcript 可能还没 flush)
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (llmEvents.length > 0) {
    const valid = llmEvents.filter((e) => !e._discarded);
    if (valid.length > 0) {
      const sortKey = (e) => {
        if (e.type === 'llm_call' && e.request_start_time) return e.request_start_time;
        return e.timestamp || 0;
      };
      allEvents = [...allEvents, ...valid].sort((a, b) => sortKey(a) - sortKey(b));
    }
  }

  const turns = splitEventsByTurn(allEvents);
  if (turns.length === 0) return;
  turns[turns.length - 1].endTime = stopTime;

  const userId = resolveUserId({}, runtimeConfig);
  const allRecords = [];
  let logHash = INITIAL_HASH;

  // turn_count 跨 Stop 持久化,确保多 turn session 中 turn_id 递增(不重复 :t1)
  const baseTurnCount = state.turn_count || 0;

  for (let i = 0; i < turns.length; i++) {
    const isLast = i === turns.length - 1;
    const turnStopReason = isLast ? stopReason : 'end_turn';
    const { records, hash } = buildTurnRecords(
      turns[i],
      baseTurnCount + i,
      sessionId,
      state.model || 'unknown',
      logHash,
      userId,
      turnStopReason,
    );
    allRecords.push(...records);
    logHash = hash;
  }

  // 持久化 turn_count
  state.turn_count = baseTurnCount + turns.length;

  // 应用 content policy(可选 redact)
  const cleaned = allRecords.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);
}

// ─── buildTurnRecords — 单 turn 的 JSONL 记录构造 ───

function buildTurnRecords(turn, turnIndex, sessionId, fallbackModel, prevHash, userId, turnStopReason) {
  const records = [];
  const turnId = `${sessionId}:t${turnIndex + 1}`;
  let stepRound = 0;
  let runningHash = prevHash;
  let prevInputMsgs = [];

  // 每 turn 一个 trace_id;ENTRY 是 turn 根 span(parent=null)
  // AGENT 在 ENTRY 下;每 step 一个 STEP span;LLM/TOOL 在 STEP 下
  const traceId = generateTraceId();
  const entrySpanId = generateSpanId();
  const agentSpanId = generateSpanId();

  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    'user.id': userId,
  };

  // turn-level llm.request(代表 user prompt)— 挂在 AGENT span 下
  if (turn.prompt) {
    records.push({
      time_unix_nano: timestampToUnixNanos(turn.startTime * 1000),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      span_id: agentSpanId,
      parent_span_id: entrySpanId,
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: turn.prompt }] },
      ],
    });
  }

  // 索引 PreToolUse(用于 30% drop 修复 + tool.result 时取参数)
  const preToolUseMap = {};
  for (const ev of turn.events) {
    if (ev.type === 'pre_tool_use' && ev.tool_use_id) {
      preToolUseMap[ev.tool_use_id] = ev;
    }
  }

  let currentStepId = null;
  let currentStepSpanId = null;

  for (const ev of turn.events) {
    const evTs = ev.timestamp || turn.endTime;

    if (ev.type === 'llm_call') {
      stepRound++;
      currentStepId = `${turnId}:s${stepRound}`;
      currentStepSpanId = generateSpanId();
      const llmSpanId = generateSpanId();
      const responseId = ev.message_id || `${currentStepId}:r`;
      const protocol = ev.protocol || 'anthropic';

      const inputMsgs = convertInputMessages(ev.input_messages, protocol);
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

      // llm.request
      const reqRecord = {
        time_unix_nano: timestampToUnixNanos((ev.request_start_time || evTs) * 1000),
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.request',
        ...baseFields,
        span_id: llmSpanId,
        parent_span_id: currentStepSpanId,
        'gen_ai.step.id': currentStepId,
        'gen_ai.response.id': responseId,
        'gen_ai.provider.name': 'anthropic',
        'gen_ai.request.model': ev.model || fallbackModel,
        'gen_ai.input.messages_hash': currentFullHash,
        'gen_ai.input.messages_delta': delta,
      };
      if (logFull) {
        reqRecord['gen_ai.input.messages'] = inputMsgs;
      }
      records.push(reqRecord);

      // 7.7 token 全量公式: input = api + cacheRead + cacheCreation
      const apiInputTokens = ev.input_tokens || 0;
      const cacheRead = ev.cache_read_input_tokens || 0;
      const cacheCreation = ev.cache_creation_input_tokens || 0;
      const inputTokens = apiInputTokens + cacheRead + cacheCreation;
      const outputTokens = ev.output_tokens || 0;
      const totalTokens = inputTokens + outputTokens;

      const respRecord = {
        time_unix_nano: timestampToUnixNanos(evTs * 1000),
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.response',
        ...baseFields,
        span_id: llmSpanId,
        parent_span_id: currentStepSpanId,
        'gen_ai.step.id': currentStepId,
        'gen_ai.response.id': responseId,
        'gen_ai.provider.name': 'anthropic',
        'gen_ai.request.model': ev.model || fallbackModel,
        'gen_ai.response.model': ev.model || fallbackModel,
        'gen_ai.response.finish_reasons': [mapStopReason(ev.stop_reason || 'stop')],
        'gen_ai.usage.input_tokens': inputTokens,
        'gen_ai.usage.output_tokens': outputTokens,
        'gen_ai.usage.cache_read.input_tokens': cacheRead,
        'gen_ai.usage.cache_creation.input_tokens': cacheCreation,
        'gen_ai.usage.total_tokens': totalTokens,
        'gen_ai.output.messages': convertOutputMessages(ev.output_content, ev.stop_reason),
      };

      if (ev.is_error) {
        respRecord['error.type'] = 'LLMError';
        respRecord['error.message'] = ev.error_message || 'unknown error';
      }

      records.push(respRecord);
      runningHash = currentFullHash;
      prevInputMsgs = ev._input_is_delta ? [] : inputMsgs;
    } else if (ev.type === 'post_tool_use') {
      const toolName = ev.tool_name || 'unknown';
      if (toolName === 'Agent' || toolName === 'agent') continue;

      const preEv = preToolUseMap[ev.tool_use_id] || {};
      const effectiveName = preEv.tool_name || toolName;
      const effectiveInput = preEv.tool_input || {};
      const toolSpanId = generateSpanId();
      const parentStepSpan = currentStepSpanId || agentSpanId;
      const stepIdForTool = currentStepId || turnId;

      records.push({
        time_unix_nano: timestampToUnixNanos((preEv.timestamp || evTs) * 1000),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: parentStepSpan,
        'gen_ai.step.id': stepIdForTool,
        'gen_ai.tool.name': effectiveName,
        'gen_ai.tool.call.id': ev.tool_use_id || '',
        'gen_ai.tool.call.arguments': toJsonValue(effectiveInput),
      });

      const toolErr = extractToolError(ev.tool_response);
      const durationMs = preEv.timestamp ? (evTs - preEv.timestamp) * 1000 : undefined;

      const resultRecord = {
        time_unix_nano: timestampToUnixNanos(evTs * 1000),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.result',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: parentStepSpan,
        'gen_ai.step.id': stepIdForTool,
        'gen_ai.tool.name': effectiveName,
        'gen_ai.tool.call.id': ev.tool_use_id || '',
        'gen_ai.tool.call.result': toJsonValue(extractToolResult(ev.tool_response)),
        'tool.result.status': toolErr ? 'error' : 'success',
      };
      if (durationMs !== undefined) resultRecord['gen_ai.tool.call.duration'] = durationMs;
      if (toolErr) {
        resultRecord['error.type'] = toolErr.type || 'ToolError';
        resultRecord['error.message'] = toolErr.message || 'unknown error';
      }
      records.push(resultRecord);
    }
  }

  // 30% PostToolUse drop 修复:
  // 末尾扫剩余的 PreToolUse(没配上 PostToolUse 的孤儿)输出 tool.call,无对应 result。
  const consumedIds = new Set(
    turn.events
      .filter((e) => e.type === 'post_tool_use' && e.tool_use_id)
      .map((e) => e.tool_use_id),
  );
  for (const [toolUseId, preEv] of Object.entries(preToolUseMap)) {
    if (consumedIds.has(toolUseId)) continue;
    const toolName = preEv.tool_name || 'unknown';
    if (toolName === 'Agent' || toolName === 'agent') continue;
    const orphanSpanId = generateSpanId();
    const parentStepSpan = currentStepSpanId || agentSpanId;
    records.push({
      time_unix_nano: timestampToUnixNanos((preEv.timestamp || turn.endTime) * 1000),
      'event.id': crypto.randomUUID(),
      'event.name': 'tool.call',
      ...baseFields,
      span_id: orphanSpanId,
      parent_span_id: parentStepSpan,
      'gen_ai.step.id': currentStepId || turnId,
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': toolUseId,
      'gen_ai.tool.call.arguments': toJsonValue(preEv.tool_input || {}),
      'tool.result.status': 'orphaned',
    });
  }

  // turn-level llm.response(代表 final assistant message,可选)
  // 老插件这里没单独写,我们也保持一致 — final message 已经在最末 llm_call 的 llm.response 里
  // 为了合规 turn 闭环,可选添加一条以 turn finish_reason 标记 turn 结束。
  // 这里保持精简:不补 turn 结束 record。

  return { records, hash: runningHash };
}

// ─── dispatcher ───

const DISPATCH = {
  'user-prompt-submit': cmdUserPromptSubmit,
  'pre-tool-use': cmdPreToolUse,
  'post-tool-use': cmdPostToolUse,
  'stop': cmdStop,
  'pre-compact': cmdPreCompact,
  'subagent-start': cmdSubagentStart,
  'subagent-stop': cmdSubagentStop,
  'notification': cmdNotification,
};

async function main() {
  const subcmd = (process.argv[2] || '').trim();
  const fn = DISPATCH[subcmd];
  if (!fn) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'dispatch',
      errorType: 'unknown_subcommand',
      errorMessage: `subcommand=${subcmd}`,
    });
    process.stdout.write('{}\n');
    return;
  }
  try {
    await fn();
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: subcmd,
      errorType: 'handler_failed',
      errorMessage: err?.message || String(err),
    });
  }
  process.stdout.write('{}\n');
}

main().catch((err) => {
  logHookError({
    agentId: AGENT_ID,
    stage: 'main',
    errorType: 'unhandled',
    errorMessage: err?.message || String(err),
  });
  process.stdout.write('{}\n');
});

#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * minimax-code-hook-processor.mjs — MiniMax Code hook 主分发器。
 *
 * 由 minimax-code-loongsuite-pilot-hook.sh 调用:
 *   $ node minimax-code-hook-processor.mjs <subcommand>
 *
 * Subcommand (kebab-case,对应 MiniMax Code hook event):
 *   session-start / user-prompt-submit / pre-tool-use / post-tool-use / stop
 *
 * 设计与 zcode-hook-processor.mjs 类似,但事件来源为 MiniMax Code:
 *   - MiniMax Code 的 hook payload 字段 (待 MiniMax Code 团队最终确认命名):
 *     * session_id | sessionId
 *     * turn_id | turnId
 *     * timestamp | ts
 *     * trace_id | traceId
 *     * tool_name | toolName
 *     * tool_input | toolInput
 *     * tool_use_id | toolCallId
 *     * isError | is_error
 *     * toolResult | toolResultPreview
 *   - 字段命名兼容 camelCase 和 snake_case(与 MiniMax Code SDK 当前规范一致)。
 *   - per-LLM 的 llm.request/llm.response 不在 hook 里发 —— MiniMax Code hook
 *     只在 Stop 给最终响应,无法支撑 per-LLM 配对。这部分由 minimax-code-rollout
 *     input 从 ~/.minimax-code/rollout/ 补全(每条 record 含完整 request body +
 *     response text/toolCalls/usage + startedAt/completedAt)。
 *   - Stop 事件发 "other" 标记 turn 元数据(agent.event.name=stop, tool.call.count),
 *     并携带 gen_ai.response.finish_reasons=['end_turn'|'interrupted'|'cancelled']
 *     触发 Signal A 立即 flush(只有当 hook payload 显式提供 interrupted/cancelled
 *     信号时才 emit 终止 finish_reason; 没信号默认 'end_turn')。turnFlushDebounceMs(35s)
 *     给 minimax-code-log input (5s poll) 和 minimax-code-rollout input (30s poll)
 *     留出 dispatch 时间。真正的 per-LLM llm.response (含 finish_reason) 由 rollout
 *     input 从 ~/.minimax-code/rollout/*.jsonl 补全。
 *
 * 字段命名全部使用 ARMS GenAI 约定的 gen_ai.* 前缀。
 * finish_reasons 输出为 string[](规范要求 array)。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { readStdinJson } from './shared/stdin-reader.mjs';
import {
  generateSpanId,
  generateTraceId,
  writeJsonlRecords,
} from './shared/event-emitter.mjs';
import { logHookError } from './shared/error-logger.mjs';
import {
  sanitizeObject,
  loadHookRuntimeConfig,
  resolveUserId,
  applyHookContentPolicy,
  toJsonValue,
} from './agent-event-normalizer.mjs';
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
} from './shared/resource-context.mjs';

const AGENT_ID = 'minimax-code';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};

// ─── utilities ───

// W3C trace_id 必须是 32-hex 不带连字符。MiniMax Code 用 UUID (带连字符)，
// 直接传给 OTLP 转换器会被拒并重新分配 traceId,导致事件归并错位。
function normalizeTraceId(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex.length === 32 ? hex : undefined;
}

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID);
}

function isoToUnixNanos(isoStr) {
  if (!isoStr) return '0';
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return '0';
  return String(ms) + '000000';
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

function generateEventId() {
  return crypto.randomBytes(16).toString('hex');
}

function baseFields(event, userId, runtimeConfig) {
  const traceId = normalizeTraceId(event.traceId || event.trace_id) || generateTraceId();
  const sessionId = event.session_id || event.sessionId || '';
  const turnId = event.turn_id || event.turnId || '';
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : undefined;
  return {
    trace_id: traceId,
    span_id: generateSpanId(),
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    'gen_ai.agent.name': 'MiniMax Code',
    'gen_ai.agent.description': 'MiniMax Code CLI coding agent probe (hook + rollout inputs)',
    'user.id': userId,
    ...(cwd ? { 'agent.minimax-code.cwd': cwd } : {}),
    ...RESOURCE_BASE_FIELD_PATCH,
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };
}

// ─── subcommand handlers ───

function cmdSessionStart() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'session-start');
  if (!sessionId) return;

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);

  const record = {
    ...baseFields(event, userId, runtimeConfig),
    time_unix_nano: isoToUnixNanos(event.timestamp || event.ts),
    'event.id': generateEventId(),
    'event.name': 'other',
    'gen_ai.agent.event.name': 'session.start',
    'gen_ai.agent.event.source': event.source || 'startup',
  };
  const cleaned = applyHookContentPolicy(sanitizeObject(record) || record, runtimeConfig);
  writeJsonlRecords(defaultLogDir(), AGENT_ID, [cleaned]);
}

function cmdUserPromptSubmit() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'user-prompt-submit');
  if (!sessionId) return;

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);

  const prompt = event.prompt || event.user_prompt || '';
  const record = {
    ...baseFields(event, userId, runtimeConfig),
    time_unix_nano: isoToUnixNanos(event.timestamp || event.ts),
    'event.id': generateEventId(),
    'event.name': 'other',
    'gen_ai.agent.event.name': 'user_prompt.submit',
    'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: prompt }] }],
  };
  const cleaned = applyHookContentPolicy(sanitizeObject(record) || record, runtimeConfig);
  writeJsonlRecords(defaultLogDir(), AGENT_ID, [cleaned]);
}

function cmdPreToolUse() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'pre-tool-use');
  if (!sessionId) return;

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);

  const toolName = event.tool_name || event.toolName || '';
  const toolInput = event.tool_input || event.toolInput || {};
  const toolCallId = event.tool_use_id || event.toolCallId || '';

  const record = {
    ...baseFields(event, userId, runtimeConfig),
    time_unix_nano: isoToUnixNanos(event.timestamp || event.ts),
    'event.id': generateEventId(),
    'event.name': 'tool.call',
    'gen_ai.tool.name': toolName,
    'gen_ai.tool.call.id': toolCallId,
    'gen_ai.tool.call.arguments': toJsonValue(toolInput),
  };
  const cleaned = applyHookContentPolicy(sanitizeObject(record) || record, runtimeConfig);
  writeJsonlRecords(defaultLogDir(), AGENT_ID, [cleaned]);
}

function cmdPostToolUse() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'post-tool-use');
  if (!sessionId) return;

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);

  const toolName = event.tool_name || event.toolName || '';
  const toolInput = event.tool_input || event.toolInput || {};
  const toolCallId = event.tool_use_id || event.toolCallId || '';
  const isError = event.isError === true || event.is_error === true;

  let toolResult = event.toolResult || event.tool_result || event.toolResultPreview || '';
  if (typeof toolResult === 'string' && toolResult.length > 0) {
    try { toolResult = JSON.parse(toolResult); } catch { /* keep raw string */ }
  }

  let status;
  if (isError) {
    status = 'error';
  } else if (toolResult && typeof toolResult === 'object') {
    // Round 8 fix (PR #233, addressing fangxiu-wf review): previously a
    // non-empty object without `status` AND without `exitCode` (e.g.
    // {content: "ok"} from a MiniMax Code tool result) fell through to
    // 'error' because `undefined || (undefined === 0 ? 'success' : 'error')`
    // is 'error'. Honor status/exitCode when present, otherwise assume
    // success (the !isError path is itself a positive signal that the
    // tool call returned without an error).
    if (typeof toolResult.status === 'string' && toolResult.status.length > 0) {
      status = toolResult.status;
    } else if (typeof toolResult.exitCode === 'number') {
      status = toolResult.exitCode === 0 ? 'success' : 'error';
    } else {
      status = 'success';
    }
  } else {
    status = 'success';
  }

  // 错误路径: 把 error 文本透传到 gen_ai.tool.call.result,避免被 pilot
  // orphan synthesis 兜底为 "orphaned" 占位。
  let resultPayload = toolResult;
  if (isError && toolResult && typeof toolResult !== 'object') {
    resultPayload = { status: 'error', error: String(toolResult) };
  }

  const record = {
    ...baseFields(event, userId, runtimeConfig),
    time_unix_nano: isoToUnixNanos(event.timestamp || event.ts),
    'event.id': generateEventId(),
    'event.name': 'tool.result',
    'gen_ai.tool.name': toolName,
    'gen_ai.tool.call.id': toolCallId,
    'gen_ai.tool.call.arguments': toJsonValue(toolInput),
    'gen_ai.tool.call.result': toJsonValue(resultPayload),
    'gen_ai.tool.call.status': status,
    'tool.result.status': status,
  };
  if (isError) {
    record['error.type'] = 'tool_execution_error';
    const errMsg = (resultPayload && typeof resultPayload === 'object' && typeof resultPayload.error === 'string')
      ? resultPayload.error
      : (typeof resultPayload === 'string' ? resultPayload : 'tool execution failed');
    record['error.message'] = errMsg;
  }
  const cleaned = applyHookContentPolicy(sanitizeObject(record) || record, runtimeConfig);
  writeJsonlRecords(defaultLogDir(), AGENT_ID, [cleaned]);
}

function cmdStop() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'stop');
  if (!sessionId) return;

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);

  // Stop 事件不再发 llm.response —— per-LLM 的 llm.request/llm.response 由
  // minimax-code-rollout input 从 ~/.minimax-code/rollout/*.jsonl 补全,这里
  // 再发 llm.response 会与 rollout 的 per-LLM response 争抢 pairing,造成
  // orphan llm.request(duration=0ms + messages 缺失)。
  //
  // Stop 事件携带 tool.call.count 元数据 + ['end_turn'|'interrupted'|'cancelled']
  // finish_reason, 触发 Signal A 立即 flush。turnFlushDebounceMs(35s) 给
  // minimax-code-log input 和 minimax-code-rollout input 留出 dispatch 时间。
  //
  // interrupted / cancelled 推断 (Round 6): 读取 hook payload 的显式信号
  // (event.interrupted | event.isInterrupted | event.is_interrupted) →
  // 'interrupted'; (event.cancelled | event.isCancelled | event.is_cancelled) →
  // 'cancelled'; 都没显式信号就默认 'end_turn'。
  //
  // 早期 (Round 1-5) 用 toolCallCount === 0 作为中断 heuristic, 这会把
  // 纯聊天 session (zero tool calls, 正常 end_turn) 误判为 interrupted。
  // 在 Round 5 把 'interrupted' 加进 TERMINAL_FINISH_REASONS 后会触发
  // 不必要的 immediate flush (每个 chat-only turn 都立刻 flush), 所以
  // Round 6 改成读显式信号。
  //
  // interrupted 优先于 cancelled (如果同时给两个,按 interrupted 处理)。
  // 字段命名兼容 camelCase + snake_case 两种形态, MiniMax Code SDK
  // 最终字段名待官方确认。
  const toolCallCount = typeof event.toolCallCount === 'number' ? event.toolCallCount : 0;
  const interruptedSignal = event.interrupted
    ?? event.isInterrupted
    ?? event.is_interrupted;
  const cancelledSignal = event.cancelled
    ?? event.isCancelled
    ?? event.is_cancelled;
  const isInterrupted = interruptedSignal === true;
  const isCancelled = !isInterrupted && cancelledSignal === true;
  const finishReason = isInterrupted ? 'interrupted' : (isCancelled ? 'cancelled' : 'end_turn');
  const record = {
    ...baseFields(event, userId, runtimeConfig),
    time_unix_nano: isoToUnixNanos(event.timestamp || event.ts),
    'event.id': generateEventId(),
    'event.name': 'other',
    'gen_ai.agent.event.name': 'stop',
    'gen_ai.agent.event.source': event.source || 'stop',
    'gen_ai.tool.call.count': toolCallCount,
    'gen_ai.response.finish_reasons': [finishReason],
  };
  const cleaned = applyHookContentPolicy(sanitizeObject(record) || record, runtimeConfig);
  writeJsonlRecords(defaultLogDir(), AGENT_ID, [cleaned]);
}

// ─── dispatch ───

// Hook host invokes this script synchronously over stdin/stdout and reads
// the JSON response from stdout to apply hook-policy decisions. Even when
// the hook is fail-open (no JSON response needed), the host expects stdout
// to be a valid JSON document (commonly `{}`) before it proceeds. We always
// emit `{}\n` from a finally block so subcommand handlers can short-circuit
// (e.g. missing sessionId, unknown subcommand) without leaving stdout empty
// and blocking the host. Mirrors assets/hooks/claude-code-hook-processor.mjs.

const DISPATCH = {
  'session-start':       cmdSessionStart,
  'user-prompt-submit':  cmdUserPromptSubmit,
  'pre-tool-use':        cmdPreToolUse,
  'post-tool-use':       cmdPostToolUse,
  'stop':                cmdStop,
};

const subcommand = process.argv[2] || '';
const handler = DISPATCH[subcommand];
if (handler) {
  try {
    handler();
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: `dispatch_${subcommand}`,
      errorType: 'unhandled',
      errorMessage: err?.message || String(err),
    });
  } finally {
    process.stdout.write('{}\n');
  }
} else {
  // Unknown subcommand: fail-open, emit empty JSON so the host can proceed.
  process.stdout.write('{}\n');
}

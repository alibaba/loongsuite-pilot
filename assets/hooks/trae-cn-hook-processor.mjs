#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * trae-cn-hook-processor.mjs — TRAE-CN hook 主分发器 (v1).
 *
 * 由 trae-cn-loongsuite-pilot-hook.sh|.ps1 调用:
 *   $ node trae-cn-hook-processor.mjs <subcommand>
 *
 * subcommand 与 TRAE-CN hook event 一一对应:
 *   session-start       → SessionStart
 *   user-prompt-submit  → UserPromptSubmit
 *   pre-tool-use        → PreToolUse
 *   post-tool-use       → PostToolUse
 *   stop                → Stop
 *   notification        → Notification
 *
 * 设计来源: 用户 spec v2 §2.7 / §2.9 / §8.2 / §8.3 / §8.4 / §8.6.
 *
 * 关键约束:
 *   - TRAE-CN hook payload 不携带 trace / turn / message / task id (官方文档),
 *     处理器自维护每 session 的轮次状态.
 *   - 一轮对话 = 一个 trace_id = 一个 STEP = 一个 LLM (UserPromptSubmit+Stop 配对).
 *     多 ReAct 迭代边界只从日志 [commit_toolcall_result] 取, hook 无权切分,
 *     本处理器不尝试 (§8.2 / §8.5 已推翻启发式).
 *   - Stop 不清状态: loop_count 可能递增触发多次 Stop (§2.9), 改由 Notification
 *     notification_type=idle_prompt 真正收尾.
 *   - 工具状态: exit_code (tool_response 内) > is_error > success > error 字段 (§8.3).
 *   - provider / model 字段在 hook payload 中无, 恒为 'unknown' (§8.3).
 *   - finish_reasons 恒为 ['stop'], 白名单兼容 (§2.9).
 *   - fail-open: 任何错误都 exit 0 + stdout '{}', 不阻塞 TRAE-CN 工具执行.
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
import { recordUpstreamContextOnce } from './shared/upstream-context.mjs';
import {
  sanitizeObject,
  toJsonValue,
  loadHookRuntimeConfig,
  resolveUserId,
  applyHookContentPolicy,
} from './agent-event-normalizer.mjs';
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
  parseSpanAttributesFromEnv,
} from './shared/resource-context.mjs';

const AGENT_ID = 'trae-cn';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};
const SPAN_ATTRIBUTES = parseSpanAttributesFromEnv(process.env, { agentId: AGENT_ID });

const TURN_STATE_TTL_MS = 12 * 60 * 60 * 1000; // 12h, §2.9
const SESSION_TIMEOUT_CLEANUP_MS = 60 * 60 * 1000; // 1h
let emittedHookResponse = false;

// ─── utilities ───

function nowSec() { return Date.now() / 1000; }

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID, 'history');
}

function stateDir() {
  return path.join(pilotDataDir(), 'state', AGENT_ID, 'turns');
}

function sessionStatePath(sessionId) {
  const safe = String(sessionId || 'unknown')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  const hash = crypto.createHash('sha256').update(safe).digest('hex');
  return path.join(stateDir(), `${hash}.json`);
}

function ensureStateDir() {
  try { fs.mkdirSync(stateDir(), { recursive: true }); } catch { /* best-effort */ }
}

function loadSessionState(sessionId) {
  ensureStateDir();
  const file = sessionStatePath(sessionId);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    // TTL check (§2.9): expire stale turn state
    const ts = Number(raw.last_activity_at_sec || 0);
    if (ts && nowSec() - ts > TURN_STATE_TTL_MS / 1000) {
      try { fs.unlinkSync(file); } catch {}
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function saveSessionState(sessionId, state) {
  ensureStateDir();
  const file = sessionStatePath(sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    state.last_activity_at_sec = nowSec();
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

function clearSessionState(sessionId) {
  try { fs.unlinkSync(sessionStatePath(sessionId)); } catch { /* best-effort */ }
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

function isoToUnixNanos(isoStr) {
  if (!isoStr) return '0';
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return '0';
  return String(ms) + '000000';
}

function nowUnixNanos() {
  return String(Date.now()) + '000000';
}

function safeText(value, max = 32_000) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) + '…[truncated]' : value;
}

// ─── model / provider resolution ───

function resolveModel(_event, state) {
  // TRAE-CN hook payload 不携带 model_info (§8.3), 静态记录于 state 以便回看;
  // 真实模型从 ai-agent 日志的 token_count 行或 setCustomModel 行才能取到.
  return state?.model || 'unknown';
}

function resolveProvider(_event, state) {
  return state?.provider || 'unknown';
}

// ─── turn state machine ───

function newTurnState(sessionId, cwd, runtimeConfig) {
  const turnIndex = (runtimeConfig?._lastTurnIndex || 0) + 1; // session-level counter
  const traceId = generateTraceId();
  const turnId = `${sessionId}:t${turnIndex}`;
  const stepId = `${turnId}:s1`;
  const entrySpanId = generateSpanId();
  const agentSpanId = generateSpanId();
  const stepSpanId = generateSpanId();
  const llmSpanId = generateSpanId();
  const startedAt = nowUnixNanos();
  return {
    session_id: sessionId,
    cwd: cwd || '',
    trace_id: traceId,
    turn_id: turnId,
    step_id: stepId,
    turn_index: turnIndex,
    entry_span_id: entrySpanId,
    agent_span_id: agentSpanId,
    step_span_id: stepSpanId,
    llm_span_id: llmSpanId,
    llm_request_emitted: false,
    llm_response_emitted: false,
    prompt: '',
    prompt_timestamp: null,
    last_assistant_message: '',
    stop_timestamp: null,
    stop_count: 0,
    turn_started_at: startedAt,
    turn_synthesized: false,
    tool_seq: 0,
    pending_tool_calls: {}, // tool_use_id → { name, arguments, call_time, span_id }
    messages_hash: INITIAL_HASH,
  };
}

function getOrCreateTurn(sessionId, event, state, runtimeConfig) {
  // §2.9: UserPromptSubmit 总是强制开新轮, 不依赖旧状态; 中途启动 (无
  // UserPromptSubmit 就先 PreToolUse) 惰性补一个轮次, 标 turn_synthesized.
  if (state && !state.llm_response_emitted) return state;
  const fresh = newTurnState(sessionId, event.cwd, runtimeConfig);
  if (state) {
    fresh.turn_index = (state.turn_index || 0) + 1;
    fresh.turn_id = `${sessionId}:t${fresh.turn_index}`;
    fresh.step_id = `${fresh.turn_id}:s1`;
  } else {
    fresh.turn_synthesized = true;
  }
  return fresh;
}

// ─── record builder ───

function baseFields(state, runtimeConfig) {
  const userId = resolveUserId({}, runtimeConfig);
  const cwd = state.cwd || undefined;
  return {
    trace_id: state.trace_id,
    'gen_ai.session.id': state.session_id,
    'gen_ai.conversation.id': state.session_id,
    'gen_ai.turn.id': state.turn_id,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': state.session_id,
    'gen_ai.agent.name': AGENT_ID,
    'gen_ai.system': AGENT_ID,
    ...RESOURCE_BASE_FIELD_PATCH,
    'user.id': userId,
    ...(cwd ? { 'agent.trae-cn.cwd': cwd } : {}),
    ...SPAN_ATTRIBUTES,
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };
}

function entryRecord(state, baseFields, timestamp) {
  return {
    time_unix_nano: timestamp,
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...baseFields,
    span_id: state.entry_span_id,
    parent_span_id: '',
    'gen_ai.span.kind': 'ENTRY',
    'gen_ai.operation.name': 'enter',
    'gen_ai.request.model': resolveModel(null, state),
    'agent.trae.session_start': true,
    'agent.trae.turn_synthesized': Boolean(state.turn_synthesized),
  };
}

function agentRecord(state, baseFields, timestamp) {
  return {
    time_unix_nano: timestamp,
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...baseFields,
    span_id: state.agent_span_id,
    parent_span_id: state.entry_span_id,
    'gen_ai.span.kind': 'AGENT',
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': AGENT_ID,
    'gen_ai.request.model': resolveModel(null, state),
  };
}

function stepRecord(state, baseFields, timestamp) {
  return {
    time_unix_nano: timestamp,
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...baseFields,
    span_id: state.step_span_id,
    parent_span_id: state.agent_span_id,
    'gen_ai.span.kind': 'STEP',
    'gen_ai.operation.name': 'react',
    'gen_ai.step.id': state.step_id,
  };
}

function llmRequestRecord(state, baseFields, runtimeConfig, timestamp, prompt) {
  const inputMessages = [
    { role: 'user', parts: [{ type: 'text', content: safeText(prompt) }] },
  ];
  const fullHash = computeHash(INITIAL_HASH, inputMessages);
  const delta = inputMessages;
  const logFull = true;
  const record = {
    time_unix_nano: timestamp,
    'event.id': crypto.randomUUID(),
    'event.name': 'llm.request',
    ...baseFields,
    span_id: state.llm_span_id,
    parent_span_id: state.step_span_id,
    'gen_ai.span.kind': 'LLM',
    'gen_ai.operation.name': 'chat',
    'gen_ai.step.id': state.step_id,
    'gen_ai.response.id': `${state.step_id}:r`,
    'gen_ai.provider.name': resolveProvider(null, state),
    'gen_ai.request.model': resolveModel(null, state),
    'gen_ai.input.messages_hash': fullHash,
    'gen_ai.input.messages_delta': delta,
  };
  if (logFull) record['gen_ai.input.messages'] = inputMessages;
  return record;
}

function llmResponseRecord(state, baseFields, timestamp, lastAssistantMessage) {
  const outputMessages = [
    {
      role: 'assistant',
      parts: [{ type: 'text', content: safeText(lastAssistantMessage) }],
    },
  ];
  return {
    time_unix_nano: timestamp,
    'event.id': crypto.randomUUID(),
    'event.name': 'llm.response',
    ...baseFields,
    span_id: state.llm_span_id,
    parent_span_id: state.step_span_id,
    'gen_ai.span.kind': 'LLM',
    'gen_ai.operation.name': 'chat',
    'gen_ai.step.id': state.step_id,
    'gen_ai.response.id': `${state.step_id}:r`,
    'gen_ai.provider.name': resolveProvider(null, state),
    'gen_ai.request.model': resolveModel(null, state),
    'gen_ai.response.model': resolveModel(null, state),
    'gen_ai.response.finish_reasons': ['stop'],
    'gen_ai.output.messages': outputMessages,
    'agent.trae.stop_count': Number(state.stop_count || 0),
    'agent.trae.finish_reason_raw': 'stop',
  };
}

function toolCallRecord(state, baseFields, timestamp, toolUseId, toolName, toolInput) {
  const toolSpanId = generateSpanId();
  state.pending_tool_calls[toolUseId] = {
    span_id: toolSpanId,
    name: toolName,
    call_time: timestamp,
  };
  state.tool_seq = (state.tool_seq || 0) + 1;
  return {
    time_unix_nano: timestamp,
    'event.id': crypto.randomUUID(),
    'event.name': 'tool.call',
    ...baseFields,
    span_id: toolSpanId,
    parent_span_id: state.step_span_id,
    'gen_ai.span.kind': 'TOOL',
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.step.id': state.step_id,
    'gen_ai.tool.name': toolName || 'unknown',
    'gen_ai.tool.call.id': toolUseId,
    'gen_ai.tool.call.arguments': toJsonValue(toolInput || {}),
    'agent.trae.tool_seq': state.tool_seq,
    'agent.trae.llm_tool_name': '',
  };
}

function inferToolStatus(toolResponse) {
  // §8.3: 结构化信号优先 (exit_code > is_error > success > error 字段).
  // 字符串结果只看开头错误抬头, 不对全文跑 \berror\b 正则.
  if (!toolResponse || typeof toolResponse !== 'object') {
    return { status: 'success', source: 'default' };
  }
  if (typeof toolResponse.exit_code === 'number') {
    return { status: toolResponse.exit_code === 0 ? 'success' : 'error', source: 'exit_code' };
  }
  if (typeof toolResponse.exitCode === 'number') {
    return { status: toolResponse.exitCode === 0 ? 'success' : 'error', source: 'exitCode' };
  }
  if (typeof toolResponse.is_error === 'boolean') {
    return { status: toolResponse.is_error ? 'error' : 'success', source: 'is_error' };
  }
  if (typeof toolResponse.success === 'boolean') {
    return { status: toolResponse.success ? 'success' : 'error', source: 'success' };
  }
  if (toolResponse.error) {
    return { status: 'error', source: 'error_field' };
  }
  if (typeof toolResponse === 'object' && typeof toolResponse.stdout === 'string'
      && /^(error|fatal|traceback|exception)/i.test(toolResponse.stdout.slice(0, 200))) {
    return { status: 'error', source: 'stdout_prefix' };
  }
  return { status: 'success', source: 'default' };
}

function toolResultRecord(state, baseFields, timestamp, toolUseId, toolName, toolResponse) {
  const pending = state.pending_tool_calls[toolUseId];
  const toolSpanId = pending?.span_id || generateSpanId();
  const inferred = inferToolStatus(toolResponse);
  const record = {
    time_unix_nano: timestamp,
    'event.id': crypto.randomUUID(),
    'event.name': 'tool.result',
    ...baseFields,
    span_id: toolSpanId,
    parent_span_id: state.step_span_id,
    'gen_ai.span.kind': 'TOOL',
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.step.id': state.step_id,
    'gen_ai.tool.name': toolName || 'unknown',
    'gen_ai.tool.call.id': toolUseId,
    'gen_ai.tool.call.result': toJsonValue(toolResponse ?? {}),
    'tool.result.status': inferred.status,
    'agent.trae.status_source': inferred.source,
  };
  if (inferred.status === 'error') {
    record['error.type'] = 'ToolError';
    const msg = typeof toolResponse === 'string'
      ? toolResponse.slice(0, 500)
      : (typeof toolResponse?.error === 'string' ? toolResponse.error.slice(0, 500) : 'tool execution failed');
    record['error.message'] = msg;
  }
  if (toolResponse && typeof toolResponse === 'object'
      && typeof toolResponse.exit_code === 'number') {
    record['agent.trae.command.exit_code'] = toolResponse.exit_code;
  }
  return record;
}

// ─── record emission helpers ───

function emitRecords(state, records, runtimeConfig) {
  if (!records || records.length === 0) return;
  records.sort((a, b) => {
    const ta = BigInt(a.time_unix_nano || '0');
    const tb = BigInt(b.time_unix_nano || '0');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
  const cleaned = records.map((r) =>
    applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);
}

function emitEntryIfMissing(state, runtimeConfig, records, timestamp) {
  if (state.entry_emitted) return;
  const base = baseFields(state, runtimeConfig);
  records.push(entryRecord(state, base, timestamp));
  records.push(agentRecord(state, base, timestamp));
  records.push(stepRecord(state, base, timestamp));
  state.entry_emitted = true;
}

// ─── cmd handlers ───

function cmdSessionStart() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'session-start');
  if (!sessionId) return;
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  recordUpstreamContextOnce({ agentId: AGENT_ID, sessionId, dataDir: pilotDataDir() });
  // SessionStart is a no-op marker — no turn opened (§2.9).
  // Touch session state so the next UserPromptSubmit can chain turn_index.
  let state = loadSessionState(sessionId);
  if (!state) {
    state = { session_id: sessionId, cwd: event.cwd || '', turn_index: 0 };
    saveSessionState(sessionId, state);
  } else if (event.cwd && state.cwd !== event.cwd) {
    state.cwd = event.cwd;
    saveSessionState(sessionId, state);
  }
}

function cmdUserPromptSubmit() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'user-prompt-submit');
  if (!sessionId) return;
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  recordUpstreamContextOnce({ agentId: AGENT_ID, sessionId, dataDir: pilotDataDir() });

  const prevState = loadSessionState(sessionId);
  // §2.9: UserPromptSubmit 总是强制开新轮. 中途启动 (PreToolUse 在前) 时上一
  // 轮若未 Stop, 强制收尾再开新轮, 防止同轮被拆成两条 trace.
  let state = prevState;
  if (state && state.llm_request_emitted && !state.llm_response_emitted) {
    // synthesize a final llm.response with empty assistant message to close prev turn
    const base = baseFields(state, runtimeConfig);
    const ts = nowUnixNanos();
    const records = [];
    emitEntryIfMissing(state, runtimeConfig, records, ts);
    records.push(llmResponseRecord(state, base, ts, ''));
    state.llm_response_emitted = true;
    emitRecords(state, records, runtimeConfig);
    saveSessionState(sessionId, state);
  }
  const nextTurnIndex = (prevState?.turn_index || 0) + 1;
  state = newTurnState(sessionId, event.cwd, runtimeConfig);
  state.turn_index = nextTurnIndex;
  state.turn_id = `${sessionId}:t${nextTurnIndex}`;
  state.step_id = `${state.turn_id}:s1`;
  state.turn_synthesized = false;

  const ts = event.timestamp ? isoToUnixNanos(event.timestamp) : nowUnixNanos();
  const base = baseFields(state, runtimeConfig);
  const records = [];
  emitEntryIfMissing(state, runtimeConfig, records, ts);
  state.prompt = safeText(event.prompt || '');
  state.prompt_timestamp = ts;
  records.push(llmRequestRecord(state, base, runtimeConfig, ts, state.prompt));
  state.llm_request_emitted = true;
  state.messages_hash = computeHash(INITIAL_HASH, [
    { role: 'user', parts: [{ type: 'text', content: state.prompt }] },
  ]);

  emitRecords(state, records, runtimeConfig);
  saveSessionState(sessionId, state);
}

function cmdPreToolUse() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'pre-tool-use');
  if (!sessionId) return;
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  let state = loadSessionState(sessionId);
  if (!state || !state.llm_request_emitted) {
    // §2.9: 中途启动 — 惰性补一个轮次, 标 turn_synthesized.
    state = newTurnState(sessionId, event.cwd, runtimeConfig);
    state.turn_synthesized = true;
    const base = baseFields(state, runtimeConfig);
    const ts = event.timestamp ? isoToUnixNanos(event.timestamp) : nowUnixNanos();
    const records = [];
    emitEntryIfMissing(state, runtimeConfig, records, ts);
    records.push(llmRequestRecord(state, base, runtimeConfig, ts, ''));
    state.llm_request_emitted = true;
    state.prompt = '';
    state.prompt_timestamp = ts;
    emitRecords(state, records, runtimeConfig);
  }

  const toolUseId = typeof event.tool_use_id === 'string' ? event.tool_use_id : '';
  if (!toolUseId) {
    logHookError({
      agentId: AGENT_ID, stage: 'pre_tool_use',
      errorType: 'missing_tool_use_id',
      errorMessage: 'PreToolUse lacks tool_use_id; skipping',
    });
    return;
  }
  const toolName = event.tool_name || event.llm_tool_name || 'unknown';
  const ts = event.timestamp ? isoToUnixNanos(event.timestamp) : nowUnixNanos();
  const base = baseFields(state, runtimeConfig);
  const records = [];
  emitEntryIfMissing(state, runtimeConfig, records, ts);
  records.push(toolCallRecord(state, base, ts, toolUseId, toolName, event.tool_input));
  if (event.llm_tool_name && event.llm_tool_name !== toolName) {
    const pending = state.pending_tool_calls[toolUseId];
    if (pending) pending.llm_tool_name = event.llm_tool_name;
  }
  emitRecords(state, records, runtimeConfig);
  saveSessionState(sessionId, state);
}

function cmdPostToolUse() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'post-tool-use');
  if (!sessionId) return;
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const state = loadSessionState(sessionId);
  if (!state) {
    logHookError({
      agentId: AGENT_ID, stage: 'post_tool_use',
      errorType: 'no_active_turn',
      errorMessage: 'PostToolUse without preceding PreToolUse/UserPromptSubmit; skipping',
    });
    return;
  }
  const toolUseId = typeof event.tool_use_id === 'string' ? event.tool_use_id : '';
  if (!toolUseId) return;
  const toolName = event.tool_name || event.llm_tool_name
    || state.pending_tool_calls[toolUseId]?.name
    || 'unknown';
  const ts = event.timestamp ? isoToUnixNanos(event.timestamp) : nowUnixNanos();
  const base = baseFields(state, runtimeConfig);
  const records = [];
  emitEntryIfMissing(state, runtimeConfig, records, ts);
  records.push(toolResultRecord(state, base, ts, toolUseId, toolName, event.tool_response));
  delete state.pending_tool_calls[toolUseId];
  emitRecords(state, records, runtimeConfig);
  saveSessionState(sessionId, state);
}

function cmdStop() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'stop');
  if (!sessionId) return;
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  recordUpstreamContextOnce({ agentId: AGENT_ID, sessionId, dataDir: pilotDataDir() });
  let state = loadSessionState(sessionId);
  if (!state || !state.llm_request_emitted) {
    // Stop without a UserPromptSubmit — synthesize an empty turn to keep the
    // structure valid (§2.9). This is rare; Notification idle_prompt will clean up.
    state = newTurnState(sessionId, event.cwd, runtimeConfig);
    state.turn_synthesized = true;
    const base = baseFields(state, runtimeConfig);
    const ts = event.timestamp ? isoToUnixNanos(event.timestamp) : nowUnixNanos();
    const records = [];
    emitEntryIfMissing(state, runtimeConfig, records, ts);
    records.push(llmRequestRecord(state, base, runtimeConfig, ts, ''));
    state.llm_request_emitted = true;
    emitRecords(state, records, runtimeConfig);
  }
  state.stop_count = (state.stop_count || 0) + 1;
  state.last_assistant_message = safeText(event.last_assistant_message || '');
  state.stop_timestamp = event.timestamp ? isoToUnixNanos(event.timestamp) : nowUnixNanos();
  // §2.9: do NOT clear state here — Stop may fire multiple times (loop_count).
  // Mark llm_response_emitted so a subsequent UserPromptSubmit knows the turn closed.
  if (!state.llm_response_emitted) {
    const base = baseFields(state, runtimeConfig);
    const records = [];
    emitEntryIfMissing(state, runtimeConfig, records, state.stop_timestamp);
    records.push(llmResponseRecord(state, base, state.stop_timestamp, state.last_assistant_message));
    state.llm_response_emitted = true;
    emitRecords(state, records, runtimeConfig);
  }
  saveSessionState(sessionId, state);
}

function cmdNotification() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'notification');
  if (!sessionId) return;
  // §2.9: idle_prompt is the real turn-end signal — clear state so the next
  // UserPromptSubmit opens a fresh turn/trace.
  if (event.notification_type === 'idle_prompt') {
    clearSessionState(sessionId);
  }
}

// ─── dispatcher ───

const DISPATCH = {
  'session-start': cmdSessionStart,
  'user-prompt-submit': cmdUserPromptSubmit,
  'pre-tool-use': cmdPreToolUse,
  'post-tool-use': cmdPostToolUse,
  'stop': cmdStop,
  'notification': cmdNotification,
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
    if (!emittedHookResponse) process.stdout.write('{}\n');
  });
} else {
  process.stdout.write('{}\n');
}

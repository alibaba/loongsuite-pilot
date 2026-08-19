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
import { decodeProbeLine } from './trae-cn/transcript-parser.mjs';

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

// ─── model / provider / usage resolution ───
//
// TRAE-CN hook payload (per round 3 §8.3 + agent-hooks.log inspection) does
// NOT carry model_info / provider / usage fields. Round 5 fix:
//   1. Forward-compatible extraction from stdin payload (event.model_info,
//      event.usage) — if TRAE-CN hook payload gains these fields later,
//      the processor picks them up automatically.
//   2. Static fallback to TRAE-CN's user-configured model catalog stored in
//      ~/.trae-cn/User/globalStorage/state.vscdb (key
//      "<userId>_AI.agent.model.model_list_map"). Per-agent_type default
//      model is selected, matching the user's TRAE-CN UI configuration.
//   3. Provider inferred from model name (qwen→qwen, doubao→doubao, etc.)
//      via inferProviderName.
//
// Token usage extraction (round 5 #2): Stop hook payload may carry an
// `event.usage` object in OpenAI/Qwen standard format
//   { prompt_tokens, completion_tokens, total_tokens }
// or in the alternate
//   { input_tokens, output_tokens, total_tokens }
// form. We normalize both to gen_ai.usage.{input,output,total}_tokens.

import { createRequire } from 'node:module';
const cjsRequire = createRequire(import.meta.url);

function readTraeVscdbModelCatalogSync() {
  if (readTraeVscdbModelCatalogSync._cache !== undefined) {
    return readTraeVscdbModelCatalogSync._cache;
  }
  let result = null;
  const home = os.homedir();
  const vscdbPath = path.join(home, '.trae-cn', 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(vscdbPath)) {
    readTraeVscdbModelCatalogSync._cache = null;
    return null;
  }
  try {
    const childProcess = cjsRequire('child_process');
    const raw = childProcess.execSync(
      `sqlite3 "${vscdbPath}" "SELECT value FROM ItemTable WHERE key LIKE '%AI.agent.model.model_list_map'"`,
      { encoding: 'utf-8', timeout: 2000 },
    );
    result = JSON.parse(raw);
  } catch {
    result = null;
  }
  readTraeVscdbModelCatalogSync._cache = result;
  return result;
}

function pickDefaultModelForAgentType(agentType) {
  const catalog = readTraeVscdbModelCatalogSync();
  if (!catalog || typeof catalog !== 'object') return null;
  const list = catalog[agentType];
  if (!Array.isArray(list) || list.length === 0) return null;
  const def = list.find((m) => m && m.is_default === true)
    || list.find((m) => m && m.is_preset === true)
    || list[0];
  if (!def || typeof def !== 'object') return null;
  return {
    name: def.name || def.display_name || null,
    provider: def.provider || null,
    display_name: def.display_name || def.name || null,
  };
}

function resolveModel(event, state) {
  // Forward-compat: extract from stdin payload if TRAE-CN hook ever carries it.
  // Per trae-session-trace-path.md §4.2: model_info.model_name is the field
  // observed in TRAE internal LLM request/response objects.
  const eventModel =
    event?.model_info?.model_name ||
    event?.model_info?.model ||
    event?.model ||
    event?.request?.model ||
    event?.display_model_name ||
    null;
  if (eventModel && typeof eventModel === 'string') return eventModel;
  if (state?.model && state.model !== 'unknown') return state.model;
  const agentType = event?.agent_type || state?.agent_type;
  if (agentType) {
    const pick = pickDefaultModelForAgentType(agentType);
    if (pick?.name) return pick.name;
  }
  return state?.model || 'unknown';
}

function resolveProvider(event, state) {
  const eventProvider =
    event?.model_info?.provider ||
    event?.provider ||
    event?.provider_name ||
    null;
  if (eventProvider && typeof eventProvider === 'string') return eventProvider;
  if (state?.provider && state.provider !== 'unknown') return state.provider;
  const agentType = event?.agent_type || state?.agent_type;
  if (agentType) {
    const pick = pickDefaultModelForAgentType(agentType);
    if (pick?.provider) return pick.provider;
  }
  const model = resolveModel(event, state).toLowerCase();
  if (/qwen|tongyi/.test(model)) return 'qwen';
  if (/doubao/.test(model)) return 'doubao';
  if (/deepseek/.test(model)) return 'deepseek';
  if (/gpt|openai|codex/.test(model)) return 'openai';
  return state?.provider || 'unknown';
}

function resolveDisplayModel(event, state) {
  const eventDisplay = event?.display_model_name || event?.model_info?.display_name || null;
  if (eventDisplay && typeof eventDisplay === 'string') return eventDisplay;
  if (state?.display_model && state.display_model !== 'unknown') return state.display_model;
  const agentType = event?.agent_type || state?.agent_type;
  if (agentType) {
    const pick = pickDefaultModelForAgentType(agentType);
    if (pick?.display_name) return pick.display_name;
  }
  return resolveModel(event, state);
}

function extractUsage(event, state) {
  // OpenAI/Qwen standard format: { prompt_tokens, completion_tokens, total_tokens }
  // Alternate: { input_tokens, output_tokens, total_tokens }
  const u = event?.usage || event?.token_usage || null;
  if (u && typeof u === 'object') {
    const inputTokens = Number(u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? undefined);
    const outputTokens = Number(u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? undefined);
    const totalTokens = Number(u.total_tokens ?? u.totalTokens ?? undefined);
    const out = {};
    if (Number.isInteger(inputTokens) && inputTokens >= 0) out.input_tokens = inputTokens;
    if (Number.isInteger(outputTokens) && outputTokens >= 0) out.output_tokens = outputTokens;
    if (Number.isInteger(totalTokens) && totalTokens >= 0) out.total_tokens = totalTokens;
    if (Object.keys(out).length > 0) return out;
  }
  // Per trae-session-trace-path.md §4.2: token_count=Some(N) attribution
  // unclear between prompt/completion. We emit as total_tokens only —
  // input/output remain MISSING rather than fabricate values.
  if (typeof event?.token_count === 'number' && event.token_count > 0) {
    return { total_tokens: event.token_count };
  }
  if (state?.usage) return state.usage;
  return {};
}

// Round 6 #1: scan every plausible payload location for an LLM usage object.
// tester round 5 confirmed the production TRAE-CN Stop payload does NOT carry
// usage, so this is forward-compat: when TRAE-CN starts emitting usage (via
// Notification streaming chunks, PreToolUse tool_input, or PostToolUse
// tool_response), the processor captures and accumulates it into state.usage.
// At Stop, extractUsage picks up the accumulated values.
function scanEventForUsage(event) {
  if (!event || typeof event !== 'object') return null;
  const candidates = [
    event.usage, event.token_usage, event.tokenUsage,
    event?.data?.usage, event?.data?.token_usage,
    event?.chunk?.usage, event?.chunk?.object?.usage,
    event?.delta?.usage, event?.stream_chunk?.usage,
    event?.response?.usage, event?.llm_response?.usage,
    event?.tool_input?.usage, event?.tool_response?.usage,
    event?.tool_input?.llm_response?.usage,
    event?.message && typeof event.message === 'object' ? event.message.usage : null,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      const u = extractUsage({ usage: c });
      if (u && Object.keys(u).length > 0) return u;
    }
  }
  if (typeof event.message === 'string' && event.message.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(event.message);
      const u = scanEventForUsage(parsed);
      if (u && Object.keys(u).length > 0) return u;
    } catch { /* not JSON, ignore */ }
  }
  if (typeof event.token_count === 'number' && event.token_count > 0) {
    return { total_tokens: event.token_count };
  }
  return null;
}

function mergeUsageIntoState(state, event) {
  const u = scanEventForUsage(event);
  if (!u || Object.keys(u).length === 0) return false;
  const prev = state.usage || {};
  const merged = { ...prev };
  for (const [k, v] of Object.entries(u)) {
    if (Number.isInteger(v) && v > 0) merged[k] = v;
  }
  if (Object.keys(merged).length > 0) {
    state.usage = merged;
    return true;
  }
  return false;
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
    last_event_at: startedAt,
    turn_synthesized: false,
    tool_seq: 0,
    pending_tool_calls: {}, // tool_use_id → { name, arguments, call_time, span_id, result_time }
    messages_hash: INITIAL_HASH,
    model: 'unknown',
    provider: 'unknown',
    display_model: 'unknown',
    usage: {},
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
    // Round 5 #1: carry over model/provider/usage snapshot from prev turn so
    // subsequent turns resolve consistently without re-reading vscdb.
    if (state.model) fresh.model = state.model;
    if (state.provider) fresh.provider = state.provider;
    if (state.display_model) fresh.display_model = state.display_model;
    if (state.agent_type) fresh.agent_type = state.agent_type;
  } else {
    fresh.turn_synthesized = true;
  }
  // Round 5 #1: capture agent_type from event for vscdb catalog lookup.
  if (event?.agent_type) fresh.agent_type = event.agent_type;
  return fresh;
}

// ─── record builder ───

// Round 5 #3: every emitted span carries startTimeUnixNano + endTimeUnixNano
// in OTel semconv string form so validate-trace can compute duration and
// parent-containment without a separate OTLP pass. time_unix_nano remains
// the event-log single-point timestamp for backwards compat.
function spanBounds(state, kind, timestamp, toolUseId) {
  const ts = BigInt(timestamp || '0');
  if (kind === 'LLM') {
    const start = BigInt(state.prompt_timestamp || timestamp || '0') || ts;
    const end = BigInt(state.stop_timestamp || timestamp || '0') || ts;
    return {
      startTimeUnixNano: String(start),
      endTimeUnixNano: end > start ? String(end) : String(start + 1n),
    };
  }
  if (kind === 'TOOL') {
    const pending = toolUseId ? state.pending_tool_calls[toolUseId] : null;
    const callTime = pending?.call_time ? BigInt(pending.call_time) : ts;
    const resultTime = pending?.result_time ? BigInt(pending.result_time) : ts;
    const start = callTime;
    const end = resultTime >= callTime ? resultTime : callTime + 1n;
    return {
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(end > start ? end : start + 1n),
    };
  }
  // ENTRY / AGENT / STEP: start = turn start, end = latest event in turn.
  const start = BigInt(state.turn_started_at || timestamp || '0') || ts;
  const end = BigInt(state.last_event_at || timestamp || '0') || ts;
  return {
    startTimeUnixNano: String(start),
    endTimeUnixNano: end > start ? String(end) : String(start + 1n),
  };
}

function baseFields(state, runtimeConfig) {
  const userId = resolveUserId({}, runtimeConfig);
  const cwd = state.cwd || undefined;
  // Round 6 #3: validate-trace commonAttributes.must requires gen_ai.user.id
  // (not just user.id). Emit both — gen_ai.user.id for the validator, user.id
  // retained for downstream consumers that haven't migrated yet.
  return {
    trace_id: state.trace_id,
    'gen_ai.session.id': state.session_id,
    'gen_ai.conversation.id': state.session_id,
    'gen_ai.turn.id': state.turn_id,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': state.session_id,
    'gen_ai.agent.name': AGENT_ID,
    'gen_ai.system': AGENT_ID,
    'gen_ai.framework': 'trae',
    ...RESOURCE_BASE_FIELD_PATCH,
    'user.id': userId,
    'gen_ai.user.id': userId,
    ...(cwd ? { 'agent.trae-cn.cwd': cwd } : {}),
    ...SPAN_ATTRIBUTES,
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };
}

function entryRecord(state, base, timestamp) {
  const bounds = spanBounds(state, 'ENTRY', timestamp);
  return {
    time_unix_nano: timestamp,
    startTimeUnixNano: bounds.startTimeUnixNano,
    endTimeUnixNano: bounds.endTimeUnixNano,
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...base,
    span_id: state.entry_span_id,
    parent_span_id: '',
    'gen_ai.span.kind': 'ENTRY',
    'gen_ai.operation.name': 'enter',
    'gen_ai.request.model': resolveModel(null, state),
    'agent.trae.session_start': true,
    'agent.trae.turn_synthesized': Boolean(state.turn_synthesized),
  };
}

function agentRecord(state, base, timestamp) {
  const bounds = spanBounds(state, 'AGENT', timestamp);
  return {
    time_unix_nano: timestamp,
    startTimeUnixNano: bounds.startTimeUnixNano,
    endTimeUnixNano: bounds.endTimeUnixNano,
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...base,
    span_id: state.agent_span_id,
    parent_span_id: state.entry_span_id,
    'gen_ai.span.kind': 'AGENT',
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': AGENT_ID,
    'gen_ai.request.model': resolveModel(null, state),
    'gen_ai.provider.name': resolveProvider(null, state),
  };
}

function stepRecord(state, base, timestamp) {
  const bounds = spanBounds(state, 'STEP', timestamp);
  return {
    time_unix_nano: timestamp,
    startTimeUnixNano: bounds.startTimeUnixNano,
    endTimeUnixNano: bounds.endTimeUnixNano,
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...base,
    span_id: state.step_span_id,
    parent_span_id: state.agent_span_id,
    'gen_ai.span.kind': 'STEP',
    'gen_ai.operation.name': 'react',
    'gen_ai.step.id': state.step_id,
  };
}

function llmRequestRecord(state, base, runtimeConfig, timestamp, prompt) {
  const inputMessages = [
    { role: 'user', parts: [{ type: 'text', content: safeText(prompt) }] },
  ];
  const fullHash = computeHash(INITIAL_HASH, inputMessages);
  const delta = inputMessages;
  const logFull = true;
  const bounds = spanBounds(state, 'LLM', timestamp);
  const record = {
    time_unix_nano: timestamp,
    startTimeUnixNano: bounds.startTimeUnixNano,
    endTimeUnixNano: bounds.endTimeUnixNano,
    'event.id': crypto.randomUUID(),
    'event.name': 'llm.request',
    ...base,
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

function llmResponseRecord(state, base, timestamp, lastAssistantMessage) {
  const parts = [{ type: 'text', content: safeText(lastAssistantMessage) }];
  // Round 7: synthesize tool_call parts from state.pending_tool_calls so
  // validate-trace `semantic.tool_matches_llm_output` can match each TOOL
  // span against an LLM-declared tool_call. Production TRAE-CN Stop event
  // only carries text content (no tool_calls part), so we reconstruct from
  // PreToolUse-captured data. Fields `id` + `name` are what the validator
  // reads (part.id / part.name); `tool_name` + `arguments` are the OTel
  // GenAI spec fields the architect prescribed.
  const pendingCalls = state.pending_tool_calls || {};
  for (const [toolUseId, pending] of Object.entries(pendingCalls)) {
    if (!pending || !pending.name) continue;
    parts.push({
      type: 'tool_call',
      id: toolUseId,
      name: pending.name,
      tool_name: pending.name,
      arguments: pending.arguments !== undefined ? pending.arguments : {},
    });
  }
  const outputMessages = [
    {
      role: 'assistant',
      parts,
    },
  ];
  const bounds = spanBounds(state, 'LLM', timestamp);
  // Round 5 #2: usage tokens emitted on llm.response (LLM span carries usage).
  const usage = state.usage || {};
  // Round 6 #5: dual-record merge — the LLM request record was emitted at
  // UserPromptSubmit time with input.messages only. validate-trace uses
  // `spanMap.set(spanId, s)` last-write-wins, so we also emit input.messages
  // here (rebuilt from state.prompt) so the final LLM span has BOTH input
  // and output.messages. Without this, validate-trace would see only
  // output.messages on the response (the last write) and fail
  // `semantic.llm_has_input_output`.
  const inputMessages = state.prompt
    ? [{ role: 'user', parts: [{ type: 'text', content: safeText(state.prompt) }] }]
    : null;
  const record = {
    time_unix_nano: timestamp,
    startTimeUnixNano: bounds.startTimeUnixNano,
    endTimeUnixNano: bounds.endTimeUnixNano,
    'event.id': crypto.randomUUID(),
    'event.name': 'llm.response',
    ...base,
    span_id: state.llm_span_id,
    parent_span_id: state.step_span_id,
    'gen_ai.span.kind': 'LLM',
    'gen_ai.operation.name': 'chat',
    'gen_ai.step.id': state.step_id,
    'gen_ai.response.id': `${state.step_id}:r`,
    'gen_ai.provider.name': resolveProvider(null, state),
    'gen_ai.request.model': resolveModel(null, state),
    'gen_ai.response.model': resolveDisplayModel(null, state),
    'gen_ai.response.finish_reasons': ['stop'],
    'gen_ai.output.messages': outputMessages,
    'agent.trae.stop_count': Number(state.stop_count || 0),
    'agent.trae.finish_reason_raw': 'stop',
  };
  if (inputMessages) {
    record['gen_ai.input.messages'] = inputMessages;
    record['gen_ai.input.messages_hash'] = computeHash(INITIAL_HASH, inputMessages);
  }
  if (Number.isInteger(usage.input_tokens)) {
    record['gen_ai.usage.input_tokens'] = usage.input_tokens;
  }
  if (Number.isInteger(usage.output_tokens)) {
    record['gen_ai.usage.output_tokens'] = usage.output_tokens;
  }
  if (Number.isInteger(usage.total_tokens)) {
    record['gen_ai.usage.total_tokens'] = usage.total_tokens;
  }
  return record;
}

function toolCallRecord(state, base, timestamp, toolUseId, toolName, toolInput) {
  const toolSpanId = generateSpanId();
  state.pending_tool_calls[toolUseId] = {
    span_id: toolSpanId,
    name: toolName,
    call_time: timestamp,
    result_time: null,
    arguments: toJsonValue(toolInput || {}),
  };
  state.tool_seq = (state.tool_seq || 0) + 1;
  const bounds = spanBounds(state, 'TOOL', timestamp, toolUseId);
  return {
    time_unix_nano: timestamp,
    startTimeUnixNano: bounds.startTimeUnixNano,
    endTimeUnixNano: bounds.endTimeUnixNano,
    'event.id': crypto.randomUUID(),
    'event.name': 'tool.call',
    ...base,
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

function toolResultRecord(state, base, timestamp, toolUseId, toolName, toolResponse) {
  const pending = state.pending_tool_calls[toolUseId];
  // Record result_time so the next TOOL record for the same span_id has a
  // real end timestamp.
  if (pending) pending.result_time = timestamp;
  const toolSpanId = pending?.span_id || generateSpanId();
  const inferred = inferToolStatus(toolResponse);
  const bounds = spanBounds(state, 'TOOL', timestamp, toolUseId);
  // Round 6 #5: dual-record merge — the TOOL call record was emitted at
  // PreToolUse time with gen_ai.tool.call.arguments only. validate-trace
  // uses last-write-wins, so we ALSO emit arguments here (from pending_tool_calls)
  // so the final TOOL span has BOTH arguments and result. Without this,
  // validate-trace would see only result on the result record and fail
  // `semantic.tool_has_arguments`.
  const argumentsValue = pending?.arguments !== undefined
    ? pending.arguments
    : toJsonValue({});
  // Round 8 #2: ensure gen_ai.tool.call.result is ALWAYS present on the merged
  // TOOL span — toJsonValue(null/undefined/{}) returns undefined which drops
  // the key entirely; sanitizeObject also drops empty objects/strings.
  // Resulting missing field triggered validate-trace `attr.TOOL.should.result`
  // 1× WARN in tester r8 t9 (Read nonexistent.txt). When toolResponse is
  // falsy/empty, emit a non-empty placeholder string so the field survives
  // sanitizeObject + OTLP merge and validate-trace's empty-value check.
  const resultRaw = toJsonValue(toolResponse ?? {});
  let resultValue;
  if (resultRaw === undefined || resultRaw === null || resultRaw === ''
      || (typeof resultRaw === 'object' && Object.keys(resultRaw).length === 0)) {
    resultValue = 'no_response_captured';
  } else {
    resultValue = resultRaw;
  }
  const record = {
    time_unix_nano: timestamp,
    startTimeUnixNano: bounds.startTimeUnixNano,
    endTimeUnixNano: bounds.endTimeUnixNano,
    'event.id': crypto.randomUUID(),
    'event.name': 'tool.result',
    ...base,
    span_id: toolSpanId,
    parent_span_id: state.step_span_id,
    'gen_ai.span.kind': 'TOOL',
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.step.id': state.step_id,
    'gen_ai.tool.name': toolName || 'unknown',
    'gen_ai.tool.call.id': toolUseId,
    'gen_ai.tool.call.arguments': argumentsValue,
    'gen_ai.tool.call.result': resultValue,
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
  // Round 5 #4: also emit OTLP JSONL to otlp-debug so validate-trace --latest
  // can consume without the pilot-service flusher running.
  if (otlpDebugEnabled()) {
    try { writeOtlpDebugRecords(cleaned); } catch { /* best-effort */ }
  }
}

function otlpDebugEnabled() {
  // Triggered by env var OR by config.json `otlpTrace.debug`/`cms.debug`.
  if (process.env.LOONGSUITE_PILOT_OTLP_DEBUG === '1'
      || process.env.LOONGSUITE_PILOT_OTLP_DEBUG === 'true') {
    return true;
  }
  const cfg = loadRuntimeConfigRaw();
  return Boolean(cfg?.otlpTrace?.debug ?? cfg?.cms?.debug);
}

function loadRuntimeConfigRaw() {
  const cfgPath = path.join(pilotDataDir(), 'config.json');
  try {
    if (!fs.existsSync(cfgPath)) return {};
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function otlpDebugDir() {
  return path.join(pilotDataDir(), 'logs', 'otlp-debug');
}

// Round 6 #4 + #5: produce OTLP spans suitable for validate-trace.
//   - #4: each span carries `resource: { attributes: { service.name } }`
//     so the validator's `attr.resource.must.service.name` rule passes.
//   - #5: dual-record merge — the event-log spec emits two records per
//     span_id (llm.request + llm.response; tool.call + tool.result). The
//     validator's `spanMap.set(spanId, s)` last-write-wins behaviour drops
//     the first record, losing input.messages / tool.call.arguments. We
//     group by spanId here, merge attributes, and emit ONE span per
//     spanId with startTime=min, endTime=max, attributes=union.
function buildOtlpSpansFromRecords(records) {
  if (!records || records.length === 0) return [];
  // Resource attributes are attached to every span. validate-trace reads
  // `span.resource[attrDef.key]` FLAT (not nested under .attributes), so
  // we put service.name flat AND under .attributes for OTLP-spec consumers.
  const resource = {
    'service.name': AGENT_ID,
    attributes: {
      'service.name': AGENT_ID,
      ...(RESOURCE_ATTRIBUTES && Object.keys(RESOURCE_ATTRIBUTES).length > 0
        ? RESOURCE_ATTRIBUTES : {}),
    },
  };
  const grouped = new Map();
  for (const r of records) {
    const sid = r.span_id;
    if (!sid) continue;
    if (!grouped.has(sid)) grouped.set(sid, []);
    grouped.get(sid).push(r);
  }
  const spans = [];
  for (const [spanId, group] of grouped) {
    const first = group[0];
    // Merge attributes from all records in the group. Later records
    // override scalars, but complementary fields (input.messages vs
    // output.messages, tool.call.arguments vs tool.call.result) co-exist
    // because they have distinct keys.
    const attributes = {};
    let startMin = null;
    let endMax = null;
    let statusCode = 0;
    for (const r of group) {
      for (const [k, v] of Object.entries(r)) {
        if (k === 'time_unix_nano' || k === 'startTimeUnixNano' || k === 'endTimeUnixNano'
            || k === 'event' || k === 'span_id' || k === 'parent_span_id' || k === 'trace_id'
            || k === 'event.id' || k === 'event.name') {
          continue;
        }
        if (v === undefined || v === null || v === '') continue;
        // Don't let a later record's undefined clobber an earlier record's value.
        if (attributes[k] !== undefined && (v === undefined || v === null)) continue;
        attributes[k] = v;
      }
      const s = r.startTimeUnixNano || r.time_unix_nano || '0';
      const e = r.endTimeUnixNano
        || String(BigInt(r.time_unix_nano || '0') + 1n);
      const sBig = BigInt(s);
      const eBig = BigInt(e);
      if (startMin === null || sBig < startMin) startMin = sBig;
      if (endMax === null || eBig > endMax) endMax = eBig;
      if (r['error.type']) statusCode = 2;
    }
    // Round 8 #1: build span name per ARMS GenAI semconv expected pattern
    // (arms_docs/trace/gen-ai.md). `gen_ai.operation.name` stays as the
    // short form ('enter'/'invoke_agent'/'react'/'chat'/'execute_tool')
    // because validate-trace `operation_kind_mapping` maps that to span.kind.
    // The OTLP span `name` field follows the ARMS name template instead:
    //   ENTRY  → 'enter_ai_application_system' (literal)
    //   AGENT  → '{operation.name} {agent.name}'    e.g. 'invoke_agent trae-cn'
    //   STEP   → 'react step' (literal)
    //   LLM    → '{operation.name} {request.model}' e.g. 'chat Doubao-Seed-Code'
    //   TOOL   → '{operation.name} {tool.name}'     e.g. 'execute_tool Read'
    const opName = attributes['gen_ai.operation.name'];
    const spanKind = attributes['gen_ai.span.kind'];
    let name = opName || 'span';
    if (spanKind === 'ENTRY') {
      name = 'enter_ai_application_system';
    } else if (spanKind === 'STEP') {
      name = 'react step';
    } else if (spanKind === 'AGENT') {
      const agentName = attributes['gen_ai.agent.name'];
      name = agentName ? `${opName} ${agentName}` : opName;
    } else if (spanKind === 'LLM') {
      const model = attributes['gen_ai.request.model'];
      name = model ? `${opName} ${model}` : opName;
    } else if (spanKind === 'TOOL') {
      const toolName = attributes['gen_ai.tool.name'];
      name = toolName ? `${opName} ${toolName}` : opName;
    }
    spans.push({
      traceId: first.trace_id,
      spanId,
      parentSpanId: first.parent_span_id || '',
      name,
      kind: 0,
      startTimeUnixNano: String(startMin ?? BigInt(first.time_unix_nano || '0')),
      endTimeUnixNano: String(endMax ?? (startMin ?? 0n) + 1n),
      attributes,
      status: { code: statusCode },
      resource,
    });
  }
  return spans;
}

// Kept for backward compatibility with any caller that wants a single span.
function buildOtlpSpanFromRecord(record) {
  return buildOtlpSpansFromRecords([record])[0] || null;
}

// Round 6 #5: dual-record merge across emit calls. Each hook event triggers
// a separate writeOtlpDebugRecords call (user-prompt-submit writes LLM req,
// stop writes LLM resp). validate-trace reads the .jsonl file and uses
// `spanMap.set(spanId, s)` last-write-wins — without cross-call merge, the
// last write for the LLM spanId would be the response (output.messages
// only), losing input.messages. We read the existing file, group ALL spans
// by spanId, merge attributes (union, later wins for scalar conflicts), and
// overwrite the file with one span per spanId. The .jsonl is bounded to a
// daily file so the rewrite cost is negligible.
function writeOtlpDebugRecords(records) {
  if (!records || records.length === 0) return;
  const dir = otlpDebugDir();
  fs.mkdirSync(dir, { recursive: true });
  const today = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  })();
  const filename = `${AGENT_ID}-${today}.jsonl`;
  const filepath = path.join(dir, filename);
  // Read existing spans so we can merge across emit calls.
  let existingRecords = [];
  if (fs.existsSync(filepath)) {
    try {
      const text = fs.readFileSync(filepath, 'utf-8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          // Reuse buildOtlpSpansFromRecords which expects event-log
          // records — the file already contains OTLP spans, so we
          // unwrap attributes + metadata back into record form for merge.
          if (obj && obj.spanId && obj.traceId) {
            existingRecords.push(otlpSpanToRecord(obj));
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* ignore */ }
  }
  const allRecords = existingRecords.concat(records);
  const spans = buildOtlpSpansFromRecords(allRecords);
  const lines = spans.map((s) => JSON.stringify(s));
  fs.writeFileSync(filepath, lines.join('\n') + '\n', 'utf-8');
}

// Inverse of buildOtlpSpansFromRecords — flatten an OTLP span back into the
// event-log record shape so it can be re-merged. Only fields needed for
// dedup + attribute union are preserved.
function otlpSpanToRecord(span) {
  const record = {
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId || '',
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    'event.name': span.name,
    ...((span.attributes && typeof span.attributes === 'object')
      ? span.attributes : {}),
  };
  if (span.status && Number(span.status.code) === 2) {
    record['error.type'] = record['error.type'] || 'Error';
  }
  return record;
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
  // Round 5 #5: turn_index persists across idle_prompt so multi-turn
  // conversations produce unique t1/t2/t3 ids. prevState (even after
  // idle_prompt) retains turn_index.
  const nextTurnIndex = (prevState?.turn_index || 0) + 1;
  state = newTurnState(sessionId, event.cwd, runtimeConfig);
  state.turn_index = nextTurnIndex;
  state.turn_id = `${sessionId}:t${nextTurnIndex}`;
  state.step_id = `${state.turn_id}:s1`;
  state.turn_synthesized = false;
  // Round 5 #1: capture model/provider/agent_type from event + vscdb fallback.
  if (event?.agent_type) state.agent_type = event.agent_type;
  state.model = resolveModel(event, state);
  state.provider = resolveProvider(event, state);
  state.display_model = resolveDisplayModel(event, state);
  // Round 6 #1: forward-compat usage capture (won't yield values in
  // production TRAE-CN — payload lacks usage — but picks it up when present).
  mergeUsageIntoState(state, event);

  const ts = event.timestamp ? isoToUnixNanos(event.timestamp) : nowUnixNanos();
  // Round 9: keep state.turn_started_at in EVENT-TIME (not wall-clock) so
  // spanBounds ENTRY/AGENT/STEP computes start/end consistently.
  // newTurnState() initially sets turn_started_at=nowUnixNanos() (wall-clock)
  // which desyncs from state.last_event_at (event-time parsed from
  // event.timestamp) when the event ts is in the past (historical replay)
  // or trae-cn assigns event ts slightly behind wall-clock. The desync made
  // spanBounds clip end=start+1n at cmdStop rewrite time, dropping the
  // corrected endTimeUnixNano on ENTRY/AGENT/STEP and leaving parent end
  // earlier than child LLM end → parent_contains_children ERROR.
  if (ts && ts !== '0') state.turn_started_at = ts;
  state.last_event_at = ts;
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
    if (event?.agent_type) state.agent_type = event.agent_type;
    state.model = resolveModel(event, state);
    state.provider = resolveProvider(event, state);
    state.display_model = resolveDisplayModel(event, state);
    const base = baseFields(state, runtimeConfig);
    const ts = event.timestamp ? isoToUnixNanos(event.timestamp) : nowUnixNanos();
    // Round 9: keep state.turn_started_at in EVENT-TIME (see cmdUserPromptSubmit).
    if (ts && ts !== '0') state.turn_started_at = ts;
    state.last_event_at = ts;
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
  state.last_event_at = ts;
  // Round 6 #1: forward-compat usage capture from PreToolUse payload.
  mergeUsageIntoState(state, event);
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
  state.last_event_at = ts;
  // Round 6 #1: forward-compat usage capture from PostToolUse payload.
  mergeUsageIntoState(state, event);
  const base = baseFields(state, runtimeConfig);
  const records = [];
  emitEntryIfMissing(state, runtimeConfig, records, ts);
  records.push(toolResultRecord(state, base, ts, toolUseId, toolName, event.tool_response));
  // Round 7: do NOT delete pending_tool_calls[toolUseId] here. We need the
  // tool_name + arguments at cmdStop time to synthesize tool_call parts on
  // the LLM response. Cleared in cmdStop after llmResponseRecord emission.
  if (state.pending_tool_calls[toolUseId]) {
    state.pending_tool_calls[toolUseId].completed = true;
  }
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
    if (event?.agent_type) state.agent_type = event.agent_type;
    state.model = resolveModel(event, state);
    state.provider = resolveProvider(event, state);
    state.display_model = resolveDisplayModel(event, state);
    const base = baseFields(state, runtimeConfig);
    const ts = event.timestamp ? isoToUnixNanos(event.timestamp) : nowUnixNanos();
    // Round 9: keep state.turn_started_at in EVENT-TIME (see cmdUserPromptSubmit).
    if (ts && ts !== '0') state.turn_started_at = ts;
    state.last_event_at = ts;
    const records = [];
    emitEntryIfMissing(state, runtimeConfig, records, ts);
    records.push(llmRequestRecord(state, base, runtimeConfig, ts, ''));
    state.llm_request_emitted = true;
    emitRecords(state, records, runtimeConfig);
  }
  state.stop_count = (state.stop_count || 0) + 1;
  state.last_assistant_message = safeText(event.last_assistant_message || '');
  state.stop_timestamp = event.timestamp ? isoToUnixNanos(event.timestamp) : nowUnixNanos();
  state.last_event_at = state.stop_timestamp;
  // Round 5 #2 + Round 6 #1: extract usage tokens from Stop hook payload
  // (forward-compat — production TRAE-CN doesn't carry usage here) and merge
  // any values accumulated from earlier PreToolUse/PostToolUse/Notification.
  mergeUsageIntoState(state, event);
  // §2.9: do NOT clear state here — Stop may fire multiple times (loop_count).
  // Mark llm_response_emitted so a subsequent UserPromptSubmit knows the turn closed.
  if (!state.llm_response_emitted) {
    const base = baseFields(state, runtimeConfig);
    const records = [];
    emitEntryIfMissing(state, runtimeConfig, records, state.stop_timestamp);
    records.push(llmResponseRecord(state, base, state.stop_timestamp, state.last_assistant_message));
    state.llm_response_emitted = true;
    // Round 7: clear pending_tool_calls now that llmResponseRecord has
    // synthesized tool_call parts from them. Prevents the next turn's
    // LLM response from re-declaring the previous turn's tool calls.
    state.pending_tool_calls = {};
    emitRecords(state, records, runtimeConfig);
  }
  // Round 6 #2: re-emit ENTRY/AGENT/STEP with corrected endTimeUnixNano so
  // the parent containment rule (parent.end >= child.end) passes — the
  // original ENTRY/AGENT/STEP was written at UserPromptSubmit time with
  // end=prompt_timestamp, which is earlier than the child LLM/TOOL ends.
  // We bypass the history JSONL (already has these span_ids from earlier
  // emit) and write only to OTLP debug so the OTLP merge (round 6 #5) keeps
  // the latest end. This preserves round 3 + round 5 unit-test invariants.
  if (otlpDebugEnabled()) {
    const base = baseFields(state, runtimeConfig);
    const corrected = [
      entryRecord(state, base, state.stop_timestamp),
      agentRecord(state, base, state.stop_timestamp),
      stepRecord(state, base, state.stop_timestamp),
    ];
    try { writeOtlpDebugRecords(corrected); } catch { /* best-effort */ }
  }
  saveSessionState(sessionId, state);
}

function cmdNotification() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'notification');
  if (!sessionId) return;
  // Round 6 #1: forward-compat — if TRAE-CN ever starts emitting LLM streaming
  // chunks (notification_type != idle_prompt) carrying usage data, accumulate
  // it into state.usage so the next Stop extracts real token counts. tester
  // round 5 confirmed current production emits only idle_prompt, so this is a
  // no-op until TRAE-CN exposes usage; documented as known limitation.
  if (event.notification_type !== 'idle_prompt') {
    const state = loadSessionState(sessionId);
    if (state) {
      const changed = mergeUsageIntoState(state, event);
      if (changed) saveSessionState(sessionId, state);
    }
    return;
  }
  // §2.9 + round 5 #5: idle_prompt is the real turn-end signal. We previously
  // fully cleared state here, but that wiped turn_index — so the next turn
  // always restarted at t1, breaking 3+ unique step.id across multi-turn.
  // Preserve turn_index (and model/provider snapshot) in a minimal stub so
  // UserPromptSubmit can increment to t2/t3/...; llm_response_emitted=true
  // marks the current turn as closed.
  const prev = loadSessionState(sessionId);
  if (prev) {
    const stub = {
      session_id: sessionId,
      cwd: prev.cwd || '',
      turn_index: prev.turn_index || 0,
      agent_type: prev.agent_type || undefined,
      model: prev.model || 'unknown',
      provider: prev.provider || 'unknown',
      display_model: prev.display_model || 'unknown',
      // Round 6 #1: preserve usage across turn boundary in case the next
      // turn's Stop doesn't carry usage (so AGG spans still surface tokens).
      usage: prev.usage || {},
      llm_response_emitted: true,
    };
    Object.keys(stub).forEach((k) => {
      if (stub[k] === undefined) delete stub[k];
    });
    saveSessionState(sessionId, stub);
  } else {
    clearSessionState(sessionId);
  }
}

// disabled: frida-enrich subcommand, see Frida path (not in current PR scope).
// User selected hook path as primary collection mode (option B, comment c5f0f238),
// Frida probe + frida-enrich are intentionally out-of-scope for this PR and kept
// uninvoked — the dispatcher entry is preserved for future enablement only.
//
// ─── frida enrichment (round 3 production path, architect `58295276`) ───
//
// Reads the frida-probe.jsonl produced by frida-trae-cn-probe.js (Plan B
// TLSWrap::DoWrite + Plan D sendmsg/sscronet hex capture), decodes Mojom
// payloads via transcript-parser.mjs, and emits supplementary llm.request /
// llm.response spans carrying the captured plaintext. Round 4 will verify
// field-hit count ≥ 4 after user OAuth enables a real LLM trigger.
//
// Subcommand: `node trae-cn-hook-processor.mjs frida-enrich`
// Reads JSONL from $LOONGSUITE_PILOT_DATA_DIR/logs/trae-cn/frida-probe.jsonl
// Writes supplementary spans into the same history dir as the hook path so
// the OTLP flusher merges them with the hook-derived 5-layer tree.
//
// Boundary: observational only — does not mutate turn state on disk; spans
// emitted here are tagged `agent.trae-cn.source=frida_probe` so round 4
// validation can distinguish them from hook-derived spans.

function fridaProbePath() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID, 'frida-probe.jsonl');
}

function readFridaProbeLines() {
  const probePath = fridaProbePath();
  if (!fs.existsSync(probePath)) return [];
  try {
    const raw = fs.readFileSync(probePath, 'utf-8');
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}

function emitFridaEnrichmentSpans(probeLines) {
  if (!probeLines || probeLines.length === 0) return;
  const ts = nowUnixNanos();
  const traceId = generateTraceId();
  const entrySpan = generateSpanId();
  const agentSpan = generateSpanId();
  const stepSpan = generateSpanId();
  const llmSpan = generateSpanId();
  const base = {
    trace_id: traceId,
    'gen_ai.session.id': 'frida-enrichment',
    'gen_ai.conversation.id': 'frida-enrichment',
    'gen_ai.turn.id': 'frida-enrichment',
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': 'frida-enrichment',
    'gen_ai.agent.name': AGENT_ID,
    'gen_ai.system': AGENT_ID,
    ...RESOURCE_BASE_FIELD_PATCH,
    ...SPAN_ATTRIBUTES,
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };
  const records = [
    {
      time_unix_nano: ts,
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...base,
      span_id: entrySpan,
      parent_span_id: '',
      'gen_ai.span.kind': 'ENTRY',
      'gen_ai.operation.name': 'frida_enrichment',
      'agent.trae-cn.source': 'frida_probe',
    },
    {
      time_unix_nano: ts,
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...base,
      span_id: agentSpan,
      parent_span_id: entrySpan,
      'gen_ai.span.kind': 'AGENT',
      'gen_ai.operation.name': 'invoke_agent',
      'agent.trae-cn.source': 'frida_probe',
    },
    {
      time_unix_nano: ts,
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...base,
      span_id: stepSpan,
      parent_span_id: agentSpan,
      'gen_ai.span.kind': 'STEP',
      'gen_ai.operation.name': 'react',
      'gen_ai.step.id': 'frida-enrichment-step',
      'agent.trae-cn.source': 'frida_probe',
    },
  ];
  let reqText = '';
  let resText = '';
  for (const line of probeLines) {
    const decoded = decodeProbeLine(line);
    if (!decoded || !decoded.parsed_ok) continue;
    const text = decoded.llm_text || '';
    if (!text) continue;
    if (decoded.kind === 'request' && !reqText) reqText = text;
    else if (decoded.kind === 'response' && !resText) resText = text;
  }
  const inputMessages = reqText
    ? [{ role: 'user', parts: [{ type: 'text', content: safeText(reqText) }] }]
    : [];
  if (inputMessages.length > 0) {
    records.push({
      time_unix_nano: ts,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...base,
      span_id: llmSpan,
      parent_span_id: stepSpan,
      'gen_ai.span.kind': 'LLM',
      'gen_ai.operation.name': 'chat',
      'gen_ai.step.id': 'frida-enrichment-step',
      'gen_ai.response.id': 'frida-enrichment-step:r',
      'gen_ai.provider.name': resolveProvider(null, { provider: 'frida_probe' }),
      'gen_ai.request.model': resolveModel(null, { model: 'frida_probe' }),
      'gen_ai.input.messages_hash': computeHash(INITIAL_HASH, inputMessages),
      'gen_ai.input.messages_delta': inputMessages,
      'gen_ai.input.messages': inputMessages,
      'agent.trae-cn.source': 'frida_probe',
    });
  }
  const outputMessages = resText
    ? [{ role: 'assistant', parts: [{ type: 'text', content: safeText(resText) }] }]
    : [];
  if (outputMessages.length > 0) {
    records.push({
      time_unix_nano: ts,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...base,
      span_id: llmSpan,
      parent_span_id: stepSpan,
      'gen_ai.span.kind': 'LLM',
      'gen_ai.operation.name': 'chat',
      'gen_ai.step.id': 'frida-enrichment-step',
      'gen_ai.response.id': 'frida-enrichment-step:r',
      'gen_ai.provider.name': resolveProvider(null, { provider: 'frida_probe' }),
      'gen_ai.request.model': resolveModel(null, { model: 'frida_probe' }),
      'gen_ai.output.messages': outputMessages,
      'gen_ai.response.finish_reasons': ['stop'],
      'agent.trae-cn.source': 'frida_probe',
    });
  }
  emitRecords({ trace_id: traceId }, records, loadHookRuntimeConfig(pilotDataDir()));
}

function cmdFridaEnrich() {
  // Reads the frida-probe.jsonl written by frida-trae-cn-probe.js and emits
  // supplementary LLM spans. Idempotent — re-running just appends more spans
  // (caller's responsibility to deduplicate via trace_id). Round 3 production
  // path; live LLM trace capture blocked until user OAuth (CT3 gate).
  const probeLines = readFridaProbeLines();
  if (probeLines.length === 0) {
    logHookError({
      agentId: AGENT_ID, stage: 'frida_enrich',
      errorType: 'no_probe_data',
      errorMessage: 'frida-probe.jsonl missing or empty; trigger LLM first',
    });
    return;
  }
  emitFridaEnrichmentSpans(probeLines);
}

// ─── dispatcher ───

const DISPATCH = {
  'session-start': cmdSessionStart,
  'user-prompt-submit': cmdUserPromptSubmit,
  'pre-tool-use': cmdPreToolUse,
  'post-tool-use': cmdPostToolUse,
  'stop': cmdStop,
  'notification': cmdNotification,
  'frida-enrich': cmdFridaEnrich,
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

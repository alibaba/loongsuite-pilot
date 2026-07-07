#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * zcode-hook-processor.mjs — ZCode hook 主分发器。
 *
 * 由 zcode-loongsuite-pilot-hook.sh 调用:
 *   $ node zcode-hook-processor.mjs <subcommand>
 *
 * Subcommand (kebab-case,对应 ZCode hook event):
 *   session-start / user-prompt-submit / pre-tool-use / post-tool-use / stop
 *
 * 设计与 claude-code-hook-processor.mjs 的差异:
 *   - ZCode 的 hook payload 自带丰富字段(prompt/tool_input/toolResultPreview 等),
 *     直接从 payload 出事件即可,不需要解析完整 transcript。
 *   - ZCode 的 Stop transcript_path 仅含最终 assistant message(单条 JSONL),
 *     处理器同步拷贝到 pilot data dir(architect 硬约束:
 *     /tmp/zcode-claude-hook-XXX 临时目录会被宿主清理)。
 *   - per-LLM 的 llm.request/llm.response 不在 hook 里发 —— ZCode hook 只在
 *     Stop 给最终响应,无法支撑 per-LLM 配对。这部分由 zcode-rollout input
 *     从 ~/.zcode/cli/rollout/model-io-sess_*.jsonl 补全(每条记录含完整
 *     request body + response text/toolCalls/usage + startedAt/completedAt)。
 *     Stop 事件只发 "other" 标记 turn 元数据(agent.event.name=stop,
 *     tool.call.count),不带 terminal finish_reason —— terminal signal 由
 *     rollout input 的最后一条 llm.response(finish_reason=stop)提供,
 *     turnIdleTimeoutMs 作为兜底。
 *   - traceId/turnId 来自 ZCode hook payload(字段 traceId/turnId),需去连字符
 *     转 32-hex(W3C);非 32-hex 会被 OTLP 转换器拒并重新分配 traceId。
 *   - spanId 自生成 16-hex(architect 约束:ZCode spanId 是 8-4-2 截断 UUID,非 W3C 16-hex)。
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
  generateSpanId,
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

const AGENT_ID = 'zcode';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};

// ─── utilities ───

// W3C trace_id 必须是 32-hex 不带连字符。ZCode 用 UUID (带连字符)，
// 直接传给 OTLP 转换器会被拒并重新分配 traceId，导致事件归并错位。
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

/**
 * 拷贝 Stop 事件指向的 transcript 临时文件到 pilot data dir。
 * ZCode 把 transcript 写到 /tmp/zcode-claude-hook-XXX/ 临时目录,会被宿主清理。
 * 同步拷贝保留 ground truth(architect 硬约束)。
 */
function persistTranscript(transcriptPath, sessionId) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const dir = path.join(pilotDataDir(), 'transcripts', AGENT_ID, sessionId || 'unknown');
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, `${Date.now()}-${path.basename(transcriptPath)}`);
    fs.copyFileSync(transcriptPath, dst);
    return dst;
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'transcript_persist',
      errorType: 'copy_failed',
      errorMessage: err?.message || String(err),
    });
    return null;
  }
}

function baseFields(event, userId, runtimeConfig) {
  const traceId = normalizeTraceId(event.traceId || event.trace_id) || generateSpanId();
  const spanId = generateSpanId();
  const sessionId = event.session_id || event.sessionId || '';
  const turnId = event.turnId || event.turn_id || '';
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : undefined;
  return {
    trace_id: traceId,
    span_id: spanId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    'gen_ai.agent.name': 'ZCode',
    'gen_ai.agent.description': 'ZCode CLI coding agent probe (hook + rollout inputs)',
    'user.id': userId,
    ...(cwd ? { 'agent.zcode.cwd': cwd } : {}),
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
  const spanId = generateSpanId();
  const traceId = normalizeTraceId(event.traceId || event.trace_id) || generateSpanId();

  const record = {
    ...baseFields(event, userId, runtimeConfig),
    span_id: spanId,
    trace_id: traceId,
    time_unix_nano: isoToUnixNanos(event.timestamp),
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

  const prompt = event.prompt || '';
  const record = {
    ...baseFields(event, userId, runtimeConfig),
    time_unix_nano: isoToUnixNanos(event.timestamp),
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
    time_unix_nano: isoToUnixNanos(event.timestamp),
    'event.id': generateEventId(),
    'event.name': 'tool.call',
    'gen_ai.tool.name': toolName,
    'gen_ai.tool.call.id': toolCallId,
    'gen_ai.tool.call.arguments': toJsonValue(toolInput),
    'gen_ai.tool.risk.level': event.riskLevel || '',
    'gen_ai.tool.side_effect_scope': event.sideEffectScope || '',
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
  const toolResultPreview = event.toolResultPreview || '';

  let parsedResult = toolResultPreview;
  if (typeof toolResultPreview === 'string' && toolResultPreview.length > 0) {
    try { parsedResult = JSON.parse(toolResultPreview); } catch { /* keep raw string */ }
  }

  const record = {
    ...baseFields(event, userId, runtimeConfig),
    time_unix_nano: isoToUnixNanos(event.timestamp),
    'event.id': generateEventId(),
    'event.name': 'tool.result',
    'gen_ai.tool.name': toolName,
    'gen_ai.tool.call.id': toolCallId,
    'gen_ai.tool.call.arguments': toJsonValue(toolInput),
    'gen_ai.tool.call.result': toJsonValue(parsedResult),
    'tool.result.status': typeof parsedResult === 'object' && parsedResult
      ? (parsedResult.status || (parsedResult.exitCode === 0 ? 'success' : 'error'))
      : 'success',
  };
  const cleaned = applyHookContentPolicy(sanitizeObject(record) || record, runtimeConfig);
  writeJsonlRecords(defaultLogDir(), AGENT_ID, [cleaned]);
}

function cmdStop() {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event, 'stop');
  if (!sessionId) return;

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);

  // 同步拷贝 transcript 临时文件(architect 硬约束)
  const transcriptPath = event.transcript_path || event.transcriptPath;
  persistTranscript(transcriptPath, sessionId);

  // Stop 事件不再发 llm.response —— per-LLM 的 llm.request/llm.response 由
  // zcode-rollout input 从 ~/.zcode/cli/rollout/model-io-sess_*.jsonl 补全，
  // 这里再发 llm.response 会与 rollout 的 per-LLM response 争抢 pairing，造成
  // orphan llm.request（duration=0ms + messages 缺失）。
  //
  // P0 race condition fix: Stop emits terminal finish_reason to trigger Signal A
  // flush. The rollout input's terminal llm.response (finish_reason=stop) is
  // suppressed in the flusher (see otlp-trace-flusher.ts send()) to avoid
  // starting the debounce window before hook tool events have been polled.
  // Stop fires after all hook events (tool.call/tool.result) are in the hook
  // JSONL, so Stop's Signal A + turnFlushDebounceMs (35s) gives zcode-log input
  // (5s poll) and zcode-rollout input (30s poll) time to dispatch all events
  // before the debounce window closes.
  //
  // - toolCallCount > 0 (normal case): emit ['end_turn'] — the LLM finished its
  //   turn and all tool results are in hook JSONL.
  // - toolCallCount === 0 (interrupted): emit ['interrupted'] — ZCode was
  //   killed before the model produced any tool_call; flush immediately so
  //   ENTRY+AGENT skeleton spans appear without waiting 120s idle timeout.
  //
  // If ZCode is SIGKILL'd and Stop never fires, the turn is flushed by
  // turnIdleTimeoutMs (120s) as the ultimate fallback.
  const toolCallCount = event.toolCallCount ?? 0;
  const isInterrupted = toolCallCount === 0;
  const record = {
    ...baseFields(event, userId, runtimeConfig),
    time_unix_nano: isoToUnixNanos(event.timestamp),
    'event.id': generateEventId(),
    'event.name': 'other',
    'gen_ai.agent.event.name': 'stop',
    'gen_ai.agent.event.source': event.source || 'stop',
    'gen_ai.tool.call.count': toolCallCount,
    'gen_ai.response.finish_reasons': [isInterrupted ? 'interrupted' : 'end_turn'],
  };
  const cleaned = applyHookContentPolicy(sanitizeObject(record) || record, runtimeConfig);
  writeJsonlRecords(defaultLogDir(), AGENT_ID, [cleaned]);
}

// ─── dispatch ───

const subcommand = process.argv[2] || '';
switch (subcommand) {
  case 'session-start':       cmdSessionStart(); break;
  case 'user-prompt-submit':  cmdUserPromptSubmit(); break;
  case 'pre-tool-use':        cmdPreToolUse(); break;
  case 'post-tool-use':       cmdPostToolUse(); break;
  case 'stop':                cmdStop(); break;
  default:
    // Unknown subcommand: fail-open, emit nothing.
    break;
}

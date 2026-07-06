#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * kimi-cli-hook-processor.mjs — Kimi CLI hook 主分发器。
 *
 * 由 kimi-cli-loongsuite-pilot-hook.sh 调用（无 subcommand 参数）：
 *   $ node kimi-cli-hook-processor.mjs
 *
 * Kimi 的 hook 协议：stdin 携带 JSON payload（含 hook_event_name 字段），
 * exit 0=allow / exit 2=block。本 processor 读取 stdin 后按 hook_event_name
 * 分派：
 *   - Stop: 正常 turn 结束。读 wire.jsonl（末行应为 TurnEnd），按 step 发射
 *     llm.request/llm.response + tool.call/tool.result 记录。
 *   - StopFailure: 异常 turn 结束。读 wire.jsonl（末行应为 StepInterrupted），
 *     发射正常记录 + 在最后一个 StepInterrupted 对应的 step span 上附加
 *     ERROR 状态 + exception 事件（error_type / error_message 从 hook payload 提取）。
 *
 * 路径模板：~/.kimi/sessions/<md5(cwd)>/<session_id>/{wire,context}.jsonl
 *   - 对齐 claude-code-hook-processor.mjs:87 interceptSessionDir 的下沉范式
 *   - md5(cwd) 由 kimi-cli session.py 的 work_dir_meta 计算
 *
 * wire.jsonl race condition：异步 queue + recorder 落盘，Stop hook 触发时末尾
 * 几行可能未 flush。waitForWireStable（size 稳定 100ms + maxWait 2000ms）+ 末行
 * 校验 TurnEnd/StepInterrupted + best-effort 回退（partial=true + 末行 timestamp
 * 兜底 end_timestamp）。
 *
 * Fail-open：任何异常都输出 "{}" 并 exit 0，不阻塞宿主 agent。
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
  collectResourceAttributesFromEnv,
  agentBaseFieldPatch,
} from './shared/resource-context.mjs';
import {
  parseKimiTranscript,
  peekLastWireEventType,
  _internal,
} from './kimi-cli/transcript-parser.mjs';
import {
  convertInputMessages,
  convertOutputMessages,
  mapStopReason,
} from './kimi-cli/message-converter.mjs';

const AGENT_ID = 'kimi';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};

const { unixFloatToNanos } = _internal;

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID);
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
 * 计算 kimi-cli session 目录路径。
 *   ~/.kimi/sessions/<md5(cwd)>/<session_id>/
 *
 * md5(cwd) 与 kimi-cli session.py 的 work_dir_meta.sessions_dir 命名规则一致。
 */
function resolveSessionDir(cwd, sessionId) {
  const home = os.homedir();
  const sessionsRoot = path.join(home, '.kimi', 'sessions');
  const cwdHash = crypto.createHash('md5').update(cwd || '/').digest('hex');
  return path.join(sessionsRoot, cwdHash, sessionId);
}

/**
 * 等待 wire.jsonl 文件 size 稳定（recorder queue drain）。
 *   - 每 20ms 轮询一次 stat.size
 *   - size 连续 stableMs 毫秒不变 → 返回当前 size
 *   - 超过 maxWaitMs → 抛 timeout（调用方走 best-effort）
 */
async function waitForWireStable(wirePath, { maxWaitMs = 2000, stableMs = 100 } = {}) {
  let lastSize = -1;
  let stableSince = null;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    let size = -1;
    try {
      size = fs.statSync(wirePath).size;
    } catch {
      // 文件不存在 → 等待并重试
      await sleep(20);
      continue;
    }
    if (size === lastSize) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return size;
    } else {
      lastSize = size;
      stableSince = null;
    }
    await sleep(20);
  }
  throw new Error(`wire.jsonl not stable after ${maxWaitMs}ms`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── cmd handlers ───

async function cmdStop(event) {
  const sessionId = requireSessionId(event, 'cmd_stop');
  if (!sessionId) return;
  await exportSession(event, sessionId, /* isStopFailure */ false);
}

async function cmdStopFailure(event) {
  const sessionId = requireSessionId(event, 'cmd_stop_failure');
  if (!sessionId) return;
  await exportSession(event, sessionId, /* isStopFailure */ true);
}

/**
 * 主导出流程：解析 wire.jsonl + context.jsonl，发射 JSONL records。
 *
 * Stop 路径：末行预期 TurnEnd
 * StopFailure 路径：末行预期 StepInterrupted + 从 payload 提取 error_type/error_message
 */
async function exportSession(event, sessionId, isStopFailure) {
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const cwd = typeof event.cwd === 'string' ? event.cwd : '/';
  const sessionDir = resolveSessionDir(cwd, sessionId);
  const wirePath = path.join(sessionDir, 'wire.jsonl');
  const contextPath = path.join(sessionDir, 'context.jsonl');

  // waitForWireStable + 末行校验
  let partial = false;
  let expectedLastType = isStopFailure ? 'StepInterrupted' : 'TurnEnd';
  try {
    await waitForWireStable(wirePath);
    const lastType = peekLastWireEventType(wirePath);
    if (lastType && lastType !== expectedLastType && lastType !== 'metadata') {
      // 末行不匹配 — best-effort：仍尝试解析，标 partial=true
      partial = true;
    }
  } catch (err) {
    // waitForWireStable 超时 — best-effort
    partial = true;
    logHookError({
      agentId: AGENT_ID,
      stage: 'wire_stable_timeout',
      errorType: 'stable_timeout',
      errorMessage: err?.message || String(err),
    });
  }

  // 增量 offset：每个 session 独立维护 wire.jsonl 的已上报字节偏移
  const statePath = path.join(pilotDataDir(), 'state', AGENT_ID, `${sessionId}.json`);
  let state = { wire_offset: 0, turn_count: 0 };
  try {
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'state_load',
      errorType: 'state_load_failed',
      errorMessage: err?.message || String(err),
    });
  }

  let parseResult;
  try {
    parseResult = parseKimiTranscript(wirePath, contextPath, state.wire_offset || 0);
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'transcript_parse',
      errorType: 'parse_failed',
      errorMessage: err?.message || String(err),
    });
    return;
  }

  if (parseResult.turns.length === 0) {
    // 无新 turn — 仅推进 offset
    state.wire_offset = parseResult.nextOffset;
    saveState(statePath, state);
    return;
  }

  // 首次运行防护：state.turn_count === 0 且 wire_offset === 0 → 只上报最后一个 turn
  const isFirstRun = !state.turn_count && (state.wire_offset || 0) === 0;
  let turnsToExport = parseResult.turns;
  if (isFirstRun && parseResult.turns.length > 1) {
    turnsToExport = parseResult.turns.slice(-1);
  }

  const userId = resolveUserId({}, runtimeConfig);
  const systemPrompt = parseResult.systemPrompt;
  const contextMessages = parseResult.contextMessages || [];
  const defaultModel = parseResult.defaultModel || 'unknown';
  const systemInstructions = systemPrompt
    ? [{ type: 'text', content: systemPrompt }]
    : [];

  // 收集本 turn 内被调用的所有 tool name（去重），作为 gen_ai.tool_definitions。
  // kimi wire.jsonl 不携带 tool schema，仅能从实际 ToolCall 事件提取 tool name。
  const toolDefinitions = [];
  const seenToolNames = new Set();
  for (const t of turnsToExport) {
    for (const s of t.steps) {
      for (const tc of s.toolCalls) {
        const name = tc.name;
        if (name && !seenToolNames.has(name)) {
          seenToolNames.add(name);
          toolDefinitions.push({ type: 'function', name });
        }
      }
    }
  }

  const baseTurnCount = state.turn_count || 0;
  const allRecords = [];
  let logHash = INITIAL_HASH;

  // StopFailure payload
  const errorType = typeof event.error_type === 'string' ? event.error_type : '';
  const errorMessage = typeof event.error_message === 'string' ? event.error_message : '';

  for (let i = 0; i < turnsToExport.length; i++) {
    const turn = turnsToExport[i];
    const isLast = i === turnsToExport.length - 1;
    const turnStopReason = isLast && isStopFailure ? 'error' : (isLast ? 'end_turn' : 'end_turn');
    const turnErrorContext = isLast && isStopFailure ? { errorType, errorMessage } : null;
    const { records, hash } = buildTurnRecords(
      turn,
      baseTurnCount + i,
      sessionId,
      cwd,
      logHash,
      userId,
      systemPrompt,
      contextMessages,
      turnStopReason,
      turnErrorContext,
      partial && isLast,
      defaultModel,
      systemInstructions,
      toolDefinitions,
    );
    allRecords.push(...records);
    logHash = hash;
  }

  state.turn_count = baseTurnCount + turnsToExport.length;
  state.wire_offset = parseResult.nextOffset;
  saveState(statePath, state);

  const cleaned = allRecords.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);
}

function saveState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    fs.renameSync(tmp, statePath);
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'state_save',
      errorType: 'state_save_failed',
      errorMessage: err?.message || String(err),
    });
  }
}

// ─── buildTurnRecords — 单 turn 的 JSONL 记录构造 ───

function buildTurnRecords(turn, turnIndex, sessionId, cwd, prevHash, userId, systemPrompt, contextMessages, stopReason, errorContext, partial, defaultModel, systemInstructions, toolDefinitions) {
  const records = [];
  const turnId = `${sessionId}:t${turnIndex + 1}`;
  const stepRound = { n: 0 };
  let runningHash = prevHash;
  let prevInputMsgs = [];

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
    ...(cwd ? { 'agent.kimi.cwd': cwd } : {}),
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };

  // ENTRY span (root)
  records.push({
    time_unix_nano: unixFloatToNanos(turn.promptTs),
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...baseFields,
    span_id: entrySpanId,
    parent_span_id: '',
    'gen_ai.step.id': turnId,
    'gen_ai.span.type': 'ENTRY',
    'gen_ai.input.messages_delta': [
      { role: 'user', parts: [{ type: 'text', content: turn.prompt }] },
    ],
  });

  // AGENT span (parent of all steps)
  records.push({
    time_unix_nano: unixFloatToNanos(turn.promptTs),
    'event.id': crypto.randomUUID(),
    'event.name': 'other',
    ...baseFields,
    span_id: agentSpanId,
    parent_span_id: entrySpanId,
    'gen_ai.step.id': turnId,
    'gen_ai.span.type': 'AGENT',
  });

  // 构造本 turn 起始的 conversation history（system + 之前所有 context messages + 本 turn prompt）
  // 简化：每个 step 的 input.messages = system_prompt + context_messages_so_far + 本 turn 的累积 assistant/tool 消息
  const conversationHistory = [];
  if (systemPrompt) {
    conversationHistory.push({ role: 'system', content: [{ type: 'text', text: systemPrompt }] });
  }
  for (const msg of contextMessages) {
    conversationHistory.push({ role: msg.role, content: msg.content });
  }
  conversationHistory.push({ role: 'user', content: [{ type: 'text', text: turn.prompt }] });

  // 收集本 turn 的 tool_results，按 tool_call_id 索引
  const toolResultMap = new Map();
  for (const tr of turn.toolResults) {
    if (tr.toolCallId) toolResultMap.set(tr.toolCallId, tr);
  }

  // 已发射的 tool_call_id（用于判断哪些 tool.result 还需要发射）
  const emittedToolCallIds = [];

  for (const step of turn.steps) {
    stepRound.n++;
    const currentStepId = `${turnId}:s${stepRound.n}`;
    const currentStepSpanId = generateSpanId();
    const llmSpanId = generateSpanId();
    const responseId = step.messageId || `${currentStepId}:r`;

    // STEP span (parent of LLM + TOOL spans)
    records.push({
      time_unix_nano: unixFloatToNanos(step.stepBeginTs),
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...baseFields,
      span_id: currentStepSpanId,
      parent_span_id: agentSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.span.type': 'STEP',
    });

    // 构造 output_content（OpenAI 风格 parts）
    const outputContent = [];
    for (const tp of step.thinkParts) {
      outputContent.push({ type: 'thinking', thinking: tp.thinking });
    }
    for (const tp of step.textParts) {
      outputContent.push({ type: 'text', text: tp.text });
    }
    for (const tc of step.toolCalls) {
      let input;
      try {
        input = typeof tc.arguments === 'string' && tc.arguments ? JSON.parse(tc.arguments) : {};
      } catch {
        input = { _raw: tc.arguments };
      }
      outputContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }

    // input messages：到本 step 之前的全部 history
    const inputMsgs = conversationHistory.slice();
    let currentFullHash;
    let delta;
    let logFull;
    // 本 step 的 input 视为 full（kimi wire 不提供 delta 信号）
    currentFullHash = computeHash(INITIAL_HASH, inputMsgs);
    delta = inputMsgs.slice(prevInputMsgs.length);
    logFull = shouldLogFullMessages(INITIAL_HASH, delta, currentFullHash) || prevInputMsgs.length === 0;

    // llm.request
    const requestModel = step.model || defaultModel || 'unknown';
    const reqRecord = {
      time_unix_nano: unixFloatToNanos(step.stepBeginTs),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': 'kimi',
      'gen_ai.request.model': requestModel,
      'gen_ai.input.messages_hash': currentFullHash,
      'gen_ai.input.messages_delta': convertInputMessages(delta),
    };
    if (logFull) {
      reqRecord['gen_ai.input.messages'] = convertInputMessages(inputMsgs);
    }
    if (systemInstructions && systemInstructions.length > 0) {
      reqRecord['gen_ai.system_instructions'] = systemInstructions;
    }
    if (toolDefinitions && toolDefinitions.length > 0) {
      reqRecord['gen_ai.tool.definitions'] = toolDefinitions;
    }
    records.push(reqRecord);

    // token usage（kimi 的 TokenUsage: input_other / output / input_cache_read / input_cache_creation）
    const tu = step.tokenUsage || {};
    const apiInputTokens = typeof tu.input_other === 'number' ? tu.input_other : 0;
    const cacheRead = typeof tu.input_cache_read === 'number' ? tu.input_cache_read : 0;
    const cacheCreation = typeof tu.input_cache_creation === 'number' ? tu.input_cache_creation : 0;
    const inputTokens = apiInputTokens + cacheRead + cacheCreation;
    const outputTokens = typeof tu.output === 'number' ? tu.output : 0;
    const totalTokens = inputTokens + outputTokens;

    // llm.response
    // 时间戳优先用 statusUpdateTs（LLM 响应到达时刻），避免末位 step 0ms duration。
    const responseTs = step.statusUpdateTs || step.stepEndTs || step.stepBeginTs;
    const finishReason = step.interrupted
      ? 'error'
      : (step.toolCalls.length > 0 ? 'tool_use' : 'stop');
    const respRecord = {
      time_unix_nano: unixFloatToNanos(responseTs),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': 'kimi',
      'gen_ai.request.model': requestModel,
      'gen_ai.response.model': requestModel,
      'gen_ai.response.finish_reasons': [mapStopReason(finishReason)],
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheRead,
      'gen_ai.usage.cache_creation.input_tokens': cacheCreation,
      'gen_ai.usage.total_tokens': totalTokens,
      'gen_ai.output.messages': convertOutputMessages(outputContent, finishReason),
    };
    if (partial) {
      respRecord['gen_ai.response.partial'] = true;
    }
    records.push(respRecord);

    // 把本 step 的 assistant 输出加入 conversationHistory（供下一 step 的 input）
    conversationHistory.push({ role: 'assistant', content: outputContent });

    // Phase 2: tool.call + tool.result（归属到当前 step）
    for (const tc of step.toolCalls) {
      const toolSpanId = generateSpanId();
      const toolCallId = tc.id || `${currentStepId}:tc`;
      emittedToolCallIds.push({ id: toolCallId, spanId: toolSpanId, stepSpanId: currentStepSpanId, stepId: currentStepId, name: tc.name });

      let toolInput;
      try {
        toolInput = typeof tc.arguments === 'string' && tc.arguments ? JSON.parse(tc.arguments) : {};
      } catch {
        toolInput = { _raw: tc.arguments };
      }
      // toJsonValue({}) 返回 undefined 会被 sanitizeObject 抹掉，导致空参数工具
      // （如 TaskList）丢失 gen_ai.tool.call.arguments 字段。回退为字符串 "{}" 保字段存在。
      const toolArgumentsField = toJsonValue(toolInput) ?? '{}';

      records.push({
        time_unix_nano: unixFloatToNanos(tc.timestamp || step.stepBeginTs),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: currentStepSpanId,
        'gen_ai.step.id': currentStepId,
        'gen_ai.tool.name': tc.name || 'unknown',
        'gen_ai.tool.call.id': toolCallId,
        'gen_ai.tool.call.arguments': toolArgumentsField,
      });

      const tr = toolResultMap.get(toolCallId);
      if (tr) {
        const rv = tr.returnValue || {};
        const resultRecord = {
          time_unix_nano: unixFloatToNanos(tr.timestamp),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          ...baseFields,
          span_id: toolSpanId,
          parent_span_id: currentStepSpanId,
          'gen_ai.step.id': currentStepId,
          'gen_ai.tool.name': tc.name || 'unknown',
          'gen_ai.tool.call.id': toolCallId,
          'gen_ai.tool.call.result': toJsonValue(rv),
          'tool.result.status': tr.isError ? 'error' : 'success',
        };
        if (tr.isError) {
          resultRecord['error.type'] = 'ToolError';
          resultRecord['error.message'] = (tr.message || tr.output || 'tool execution failed').slice(0, 500);
        }
        records.push(resultRecord);
        toolResultMap.delete(toolCallId);

        // 把 tool_result 加入 conversationHistory（供下一 step 的 input）
        conversationHistory.push({
          role: 'tool',
          content: [{ type: 'tool_result', tool_use_id: toolCallId, content: tr.output || tr.message || '' }],
        });
      }
    }

    runningHash = currentFullHash;
    prevInputMsgs = inputMsgs;
  }

  // StopFailure：附加 exception 事件到最后一个 step 的 STEP span
  if (errorContext && errorContext.errorType) {
    const lastStep = turn.steps[turn.steps.length - 1];
    if (lastStep) {
      const lastStepId = `${turnId}:s${turn.steps.length}`;
      // 找到最后一个 STEP span 的 span_id（按发射顺序倒序找）
      let lastStepSpanId = null;
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        if (r['gen_ai.span.type'] === 'STEP' && r['gen_ai.step.id'] === lastStepId) {
          lastStepSpanId = r.span_id;
          break;
        }
      }
      if (lastStepSpanId) {
        records.push({
          time_unix_nano: unixFloatToNanos(lastStep.stepEndTs || lastStep.stepBeginTs),
          'event.id': crypto.randomUUID(),
          'event.name': 'other',
          ...baseFields,
          span_id: generateSpanId(),
          parent_span_id: lastStepSpanId,
          'gen_ai.step.id': lastStepId,
          'gen_ai.span.type': 'EXCEPTION',
          'error.type': errorContext.errorType,
          'error.message': errorContext.errorMessage,
          'exception.escaped': true,
        });
      }
    }
  }

  // 按时间排序：tool 事件交错在 LLM 事件之间
  records.sort((a, b) => {
    const ta = BigInt(a.time_unix_nano || '0');
    const tb = BigInt(b.time_unix_nano || '0');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  return { records, hash: runningHash };
}

// ─── dispatcher ───

const DISPATCH = {
  'Stop': cmdStop,
  'StopFailure': cmdStopFailure,
};

async function main() {
  const event = tryReadStdin();
  const eventName = event && event.hook_event_name;
  const fn = DISPATCH[eventName];
  if (!fn) return;
  try {
    await fn(event);
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: `dispatch_${eventName || 'unknown'}`,
      errorType: 'unhandled',
      errorMessage: err?.message || String(err),
    });
  }
}

main().finally(() => {
  process.stdout.write('{}\n');
});

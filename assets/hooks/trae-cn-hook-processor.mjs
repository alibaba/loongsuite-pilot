#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * TRAE CN hook processor for loongsuite-pilot.
 *
 * TRAE 通过 stdin 传入 JSON payload 调用本处理器，事件名由 argv 传入：
 *   trae-cn-hook-processor.mjs <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|Notification>
 *
 * 字段与语义均以官方文档为准（docs/zh-CN/trae-session-trace-path.md §2.7）：
 *   https://docs.trae.ai/ide/hook-configuration-reference?_lang=zh
 *
 * 埋点时机 → GenAI event.name 映射：
 *   SessionStart     → other        （会话起点，不开轮次）
 *   UserPromptSubmit → llm.request  （prompt → gen_ai.input.messages）
 *   PreToolUse       → tool.call    （tool_input → gen_ai.tool.call.arguments）
 *   PostToolUse      → tool.result  （tool_response → gen_ai.tool.call.result / tool.result.status）
 *   Stop             → llm.response （last_assistant_message → gen_ai.output.messages）
 *   Notification     → other        （idle_prompt 兼作轮次终止信号）
 *
 * ⚠️ Stop 的官方 payload 只有 stop_hook_active / loop_count / last_assistant_message：
 * 没有 usage、没有 reasoning 思考过程、没有 finish_reason。相关候选探测保留仅为后续版本兼容。
 *
 * 输出：~/.loongsuite-pilot/logs/trae-cn/history/trae-cn-YYYY-MM-DD.jsonl
 * 由 src/inputs/trae-cn/ 的 BaseHookInput 实现消费。
 *
 * 轮次串联：官方 payload **不携带任何 trace / turn / message id**，因此这里维护
 * 每 session 的轮次状态（state/trae-cn/turns/<session>.json）：
 * UserPromptSubmit 开新 turn 并生成 traceId，PreToolUse/PostToolUse/Stop 复用，
 * Notification(idle_prompt) 才收尾——不用 Stop 收尾是因为一轮可能触发多次 Stop
 *（其他 hook 返回 block 后智能体会继续执行并再次 Stop，loop_count 递增）。
 *
 * Fail-open：任何异常都写错误日志并输出 {} + exit 0，从不阻断 TRAE。
 * 官方退出码语义：只有 exit 2 是阻断性的（PreToolUse 等价于 deny）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyHookContentPolicy,
  getNumberValue,
  getStringValue,
  hashJson,
  inferProviderName,
  loadHookRuntimeConfig,
  parseMaybeJson,
  resolveUserId,
  sanitizeObject,
  timestampToUnixNanos,
  toJsonValue,
} from './agent-event-normalizer.mjs';
import { generateSpanId, generateTraceId } from './shared/event-emitter.mjs';
import {
  LOONGSUITE_PILOT_DATA_DIR,
  appendRowsToHistory,
  logDebug,
  readStdin,
} from './shared/hook-processor-base.mjs';
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
  parseSpanAttributesFromEnv,
} from './shared/resource-context.mjs';
import { recordUpstreamContextOnce } from './shared/upstream-context.mjs';
import { logHookError } from './shared/error-logger.mjs';

const AGENT_ID = 'trae-cn';
const AGENT_TYPE = 'trae-cn';
const LOG_PREFIX = 'trae-cn';
const SOURCE_NS = 'trae';

const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv();
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const SPAN_ATTRIBUTES = parseSpanAttributesFromEnv();

/** 埋点时机 → GenAI 事件名 */
const EVENT_NAME_MAP = {
  sessionstart: 'other',
  userpromptsubmit: 'llm.request',
  pretooluse: 'tool.call',
  posttooluse: 'tool.result',
  stop: 'llm.response',
  notification: 'other',
};

/**
 * 字段候选表：**官方字段名优先**（§2.7 已根据官方文档逐一核对），
 * camelCase 与早期从 dylib 字符串推断的名字仅作向后兼容。
 * 命中不到时字段留空，原始 payload 仍会以 agent.trae.* 全量保留，不丢数据。
 *
 * 注意：`message` 刻意不入候选表——它是 Notification 的通知正文，
 * 一旦进了候选表就会被归入 MAPPED_KEYS 而从 agent.trae.* 里静默消失。
 */
const CANDIDATES = {
  sessionId: ['session_id', 'sessionId', 'conversation_id', 'conversationId'],
  // 官方 payload 无 turn/message id，保留探测仅为兼容（实际靠自维护的轮次状态）
  turnId: ['turn_id', 'turnId', 'message_id', 'messageId'],
  taskId: ['task_id', 'taskId'],
  toolName: ['tool_name', 'toolName', 'name'],
  toolCallId: ['tool_use_id', 'toolUseId', 'tool_call_id', 'toolCallId', 'toolcall_id'],
  toolInput: ['tool_input', 'toolInput', 'input', 'arguments', 'params', 'parameters'],
  toolResult: ['tool_response', 'toolResponse', 'tool_result', 'toolResult', 'result', 'output'],
  prompt: ['prompt', 'user_prompt', 'userPrompt', 'text', 'content'],
  cwd: ['cwd', 'workspace', 'workingDirectory', 'working_dir'],
  model: ['model', 'model_name', 'modelName'],
  agentType: ['agent_type', 'agentType'],
  durationMs: ['duration_ms', 'durationMs', 'cost', 'cost_ms', 'elapsed_ms'],
  status: ['status', 'tool_status', 'result_status'],
  exitCode: ['exit_code', 'exitCode'],
  errorMessage: ['error', 'error_message', 'errorMessage'],
  // 助手回复正文：Stop 事件的 last_assistant_message 是官方唯一来源
  response: [
    'last_assistant_message', 'lastAssistantMessage',
    'output_messages', 'response', 'assistant_message', 'assistantMessage', 'completion',
  ],
  // 思考过程：官方 payload 不提供，保留映射仅为后续版本兼容
  reasoning: ['reasoning_content', 'reasoningContent', 'reasoning', 'thinking', 'thinking_content', 'thought'],
  // 同上：官方 Stop 无 finish_reason
  finishReason: ['stop_reason', 'stopReason', 'finish_reason', 'finishReason'],
  // Notification 的通知类型，idle_prompt 用作轮次终止信号
  notificationType: ['notification_type', 'notificationType'],
};

/** 按候选键取第一个非空值 */
function firstString(payload, keys) {
  for (const k of keys) {
    const v = getStringValue(payload, k);
    if (v) return v;
  }
  return undefined;
}

function firstNumber(payload, keys) {
  for (const k of keys) {
    const v = getNumberValue(payload, k);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function firstRaw(payload, keys) {
  for (const k of keys) {
    const v = payload?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** 已映射到标准字段的源键，避免在 agent.trae.* 里重复 */
function mappedSourceKeys() {
  const set = new Set(['hook_event_name', 'hookEventName']);
  for (const list of Object.values(CANDIDATES)) for (const k of list) set.add(k);
  return set;
}
const MAPPED_KEYS = mappedSourceKeys();

/** 未映射的源字段挂到 agent.trae.* 命名空间下，保证原始信息不丢 */
function addSourceAttributes(record, payload) {
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (MAPPED_KEYS.has(key)) continue;
    const json = toJsonValue(value);
    if (json !== undefined) record[`agent.${SOURCE_NS}.${key}`] = json;
  }
}

// ─── 轮次状态：把同一轮的 hook 事件串成一条 trace ───

/** 轮次状态过期阈值：防止漏收尾的旧状态把新事件吸进一个已死的 trace */
const TURN_STATE_TTL_MS = 12 * 60 * 60 * 1000;

function turnStateFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^\w.-]/g, '_');
  return path.join(LOONGSUITE_PILOT_DATA_DIR, 'state', AGENT_ID, 'turns', `${safe}.json`);
}

function loadTurnState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(turnStateFile(sessionId), 'utf-8'));
  } catch {
    return null;
  }
}

function saveTurnState(sessionId, state) {
  try {
    const file = turnStateFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf-8');
  } catch (e) {
    logDebug(AGENT_ID, `save turn state failed: ${e.message}`);
  }
}

function clearTurnState(sessionId) {
  try {
    fs.rmSync(turnStateFile(sessionId), { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * 取当前轮次上下文。
 * - UserPromptSubmit：开新轮
 * - 其他事件且无状态：说明 pilot 在会话中途启动，惰性补一个轮次而不是丢事件
 *
 * step 划分：gen_ai.step.id 的语义是「一次 ReAct 迭代」，下游按它把
 * llm.request/response 与 tool.call/result 组成 STEP{ LLM, TOOL... }，且每个 STEP 恰好 1 个 LLM
 *（scripts/validate-trace.mjs 强制）。TRAE 的 hook 只在轮次首尾给出模型信号
 * （UserPromptSubmit / Stop），中间每次推理未暴露，所以一轮 = 一个 step：
 * 首尾两条配成唯一的 LLM span，工具作为其兄弟 TOOL span。
 *
 * 按事件自增 step 是错的：会把同一次调用的 tool.call 与 tool.result 拆到两个 step，
 * 把 llm.request 和 llm.response 拆到首尾两个 step，结果是一堆没有 LLM 的破碎 STEP。
 *
 * ⚠️ ReAct 迭代边界无法从 hook 事件流推出。曾用「PreToolUse 出现在 PostToolUse 之后
 * 就算新一批」的启发式，实测是错的：TRAE 边流式接收 tool call 边执行，一次 LLM 响应里的
 * 三个工具到达顺序是 Pre(LS) → Post(LS) → Pre(Read) → Pre(RunCommand) → Post…，
 * 该启发式会把同一批拆成两批。真边界只在 ai-agent 日志的 `[commit_toolcall_result]`
 * 那一行，hook 侧看不到。所以这里只记诚实的东西：工具在本轮内的调用序号
 * （agent.trae.tool_seq），Pre / Post 靠 tool_call_id 共享同一序号。
 */
function resolveTurnContext(sessionId, sourceEvent, payloadTurnId, eventName, toolCallId) {
  const source = sourceEvent.toLowerCase();

  // SessionStart 在第一个 prompt 之前触发，不属于任何轮次。
  // 若走下面「无状态就补一个轮次」的分支，会先落一份轮次状态并多出一条
  // 只含 SessionStart 的空 trace，所以给它一个不落盘的临时上下文。
  if (source === 'sessionstart') {
    const turnId = payloadTurnId || crypto.randomUUID();
    return {
      turnId,
      traceId: generateTraceId(),
      stepId: `${turnId}:s1`,
      eventSeq: 1,
      toolSeq: undefined,
      synthesized: false,
    };
  }

  const isTurnStart = source === 'userpromptsubmit';
  let state = isTurnStart ? null : loadTurnState(sessionId);

  // 漏收的旧状态（比如 idle_prompt 通知未送达）不能无限期生效
  if (state && Date.now() - (state.startedAt || 0) > TURN_STATE_TTL_MS) state = null;

  if (!state) {
    const turnId = payloadTurnId || crypto.randomUUID();
    state = {
      turnId,
      traceId: generateTraceId(),
      startedAt: Date.now(),
      stepId: `${turnId}:s1`,
      eventSeq: 0,
      toolCount: 0,
      toolSeqById: {},
      synthesized: !isTurnStart,
    };
  }
  state.eventSeq = (state.eventSeq || 0) + 1;
  state.stepId = state.stepId || `${state.turnId}:s1`;
  state.toolSeqById = state.toolSeqById || {};

  // 工具调用序号在 PreToolUse 时分配，PostToolUse 靠 tool_call_id 复用同一个号
  let toolSeq;
  if (eventName === 'tool.call' || eventName === 'tool.result') {
    if (toolCallId && state.toolSeqById[toolCallId]) {
      toolSeq = state.toolSeqById[toolCallId];
    } else {
      toolSeq = (state.toolCount || 0) + 1;
      state.toolCount = toolSeq;
      if (toolCallId) state.toolSeqById[toolCallId] = toolSeq;
    }
  }

  saveTurnState(sessionId, state);
  return { ...state, toolSeq };
}

// ─── 记录构建 ───

/** 结果体里可能承载正文的键，出现即说明工具正常返回了内容 */
const RESULT_CONTENT_KEYS = ['content', 'files', 'result', 'output', 'stdout', 'text', 'data'];

/**
 * 判定工具结果状态。
 *
 * ⚠️ 这里**绝不能**把整个结果正文拿去正则嗅探 `error`：读一个正文里出现过 "error"
 * 字样的普通文件，就会被误判成工具失败（已实测踩中）。仓库其他 Agent 的做法
 * （agent-event-normalizer.mjs 的 inferToolStatus / inferQoderToolResultStatus）统一是
 * 只认结构化错误标志，判不出就交回 undefined，这里对齐。
 *
 * 返回 { status, source }，source 记录判定依据，写入 agent.trae.status_source 便于回溯。
 */
function normalizeStatus(rawStatus, exitCode, toolResult) {
  if (typeof exitCode === 'number') {
    return { status: exitCode === 0 ? 'success' : 'error', source: 'exit_code' };
  }

  const s = String(rawStatus || '').toLowerCase();
  if (s) {
    if (s === 'success' || s === 'ok' || s === 'succeeded' || s === 'exited') {
      return { status: 'success', source: 'status_field' };
    }
    if (s === 'failed' || s === 'failure' || s === 'error') {
      return { status: 'error', source: 'status_field' };
    }
    // TRAE 的 RunCommand 常以 Running 返回（异步下发已返回，非最终态）
    if (s === 'running' || s === 'pending') return { status: 'running', source: 'status_field' };
    return { status: s, source: 'status_field' };
  }

  if (toolResult && typeof toolResult === 'object' && !Array.isArray(toolResult)) {
    // exit_code 常嵌在 tool_response 里而不在顶层，必须先看它：否则失败的 RunCommand
    // 会因为带了 stdout 字段而撞上 content_present 被当成成功（已实测踩中）。
    const innerExit = toolResult.exit_code ?? toolResult.exitCode;
    if (typeof innerExit === 'number') {
      return { status: innerExit === 0 ? 'success' : 'error', source: 'result_exit_code' };
    }
    if (toolResult.is_error === true || toolResult.isError === true) {
      return { status: 'error', source: 'is_error_flag' };
    }
    if (toolResult.is_error === false || toolResult.isError === false) {
      return { status: 'success', source: 'is_error_flag' };
    }
    if (toolResult.success === false) return { status: 'error', source: 'success_flag' };
    if (toolResult.success === true) return { status: 'success', source: 'success_flag' };
    for (const key of ['error', 'error_message', 'errorMessage']) {
      const v = toolResult[key];
      if (typeof v === 'string' && v.trim()) return { status: 'error', source: 'error_field' };
      if (v && typeof v === 'object') return { status: 'error', source: 'error_field' };
    }
    if (RESULT_CONTENT_KEYS.some(k => toolResult[k] !== undefined && toolResult[k] !== null)) {
      return { status: 'success', source: 'content_present' };
    }
  }

  // 纯字符串结果：只看开头是否是错误抬头，不扫全文
  if (typeof toolResult === 'string' && /^\s*(error|failed|failure|exception)\b|^\s*Error:/i.test(toolResult)) {
    return { status: 'error', source: 'error_prefix' };
  }

  // 判不出：PostToolUse 已经代表工具执行完并返回了响应，按成功计，但标注依据是兜底
  return { status: 'success', source: 'default' };
}

/**
 * finish_reason 白名单。
 * 以 scripts/validate-trace.mjs 的 VALID_FINISH_REASONS 为准——那是接入验收实际强制的集合，
 * 越界会直接报 error。注意它不含 docs 里提到的 `cancelled`，因此中断类信号归一到
 * `stop`（轮次正常结束，非错误），原始值另存 agent.trae.finish_reason_raw 不丢信息。
 */
const FINISH_REASONS = new Set([
  'stop', 'length', 'content_filter', 'tool_call', 'tool_calls', 'error', 'end_turn', 'max_tokens',
]);

function normalizeFinishReason(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'stop';
  if (s === 'max_tokens' || s === 'max_length') return 'length';
  if (s === 'tool_use' || s === 'tool_call') return 'tool_calls';
  if (s === 'aborted' || s === 'interrupted' || s === 'canceled' || s === 'cancelled') return 'stop';
  return FINISH_REASONS.has(s) ? s : 'stop';
}

/**
 * 构造 llm.response 的 output messages。
 * 思考过程走 reasoning part，正文走 text part，与仓库既有 Agent（Qoder / Claude Code）一致。
 */
function buildOutputMessages(payload, finishReason) {
  const parts = [];

  const reasoning = firstString(payload, CANDIDATES.reasoning);
  if (reasoning) parts.push({ type: 'reasoning', content: reasoning });

  const raw = firstRaw(payload, CANDIDATES.response);
  // 宿主已给出完整 messages 数组时直接沿用，不二次包装
  const parsed = parseMaybeJson(raw);
  if (Array.isArray(parsed) && parsed.some(m => m && typeof m === 'object' && 'role' in m)) {
    return parsed;
  }
  const text = typeof parsed === 'string' ? parsed : firstString(payload, CANDIDATES.response);
  if (text) parts.push({ type: 'text', content: text });

  if (parts.length === 0) return undefined;
  return [{ role: 'assistant', parts, finish_reason: finishReason }];
}

function buildRecord(payload, sourceEvent, runtimeConfig, now) {
  const eventName = EVENT_NAME_MAP[sourceEvent.toLowerCase()] || 'other';

  const sessionId = firstString(payload, CANDIDATES.sessionId) || '';
  const payloadTurnId = firstString(payload, CANDIDATES.turnId);
  const toolCallId = firstString(payload, CANDIDATES.toolCallId);
  const turn = resolveTurnContext(sessionId, sourceEvent, payloadTurnId, eventName, toolCallId);

  const model = firstString(payload, CANDIDATES.model);
  const toolName = firstString(payload, CANDIDATES.toolName);
  const toolInput = parseMaybeJson(firstRaw(payload, CANDIDATES.toolInput));
  const toolResult = parseMaybeJson(firstRaw(payload, CANDIDATES.toolResult));
  const prompt = firstString(payload, CANDIDATES.prompt);
  const exitCode = firstNumber(payload, CANDIDATES.exitCode);
  const cwd = firstString(payload, CANDIDATES.cwd);
  const notificationType = firstString(payload, CANDIDATES.notificationType);

  const isToolCall = eventName === 'tool.call';
  const isToolResult = eventName === 'tool.result';
  const isLlmRequest = eventName === 'llm.request';
  const isLlmResponse = eventName === 'llm.response';

  const toolStatus = isToolResult
    ? normalizeStatus(firstString(payload, CANDIDATES.status), exitCode, toolResult)
    : undefined;

  const finishReason = isLlmResponse
    ? normalizeFinishReason(firstString(payload, CANDIDATES.finishReason))
    : undefined;
  const rawFinishReason = isLlmResponse ? firstString(payload, CANDIDATES.finishReason) : undefined;
  const outputMessages = isLlmResponse ? buildOutputMessages(payload, finishReason) : undefined;
  const hasReasoning = Boolean(outputMessages?.some(message =>
    Array.isArray(message?.parts) && message.parts.some(part => part?.type === 'reasoning' && part?.content),
  ));

  // prompt 统一包成 OTel GenAI 的 messages 结构
  const inputMessages = isLlmRequest && prompt
    ? [{ role: 'user', parts: [{ type: 'text', content: prompt }] }]
    : undefined;

  const record = {
    'event.id': crypto.randomUUID(),
    'event.name': eventName,
    'user.id': resolveUserId(payload, runtimeConfig),

    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turn.turnId,
    // 一轮 = 一个 ReAct step（理由见 resolveTurnContext），同轮所有事件共享
    'gen_ai.step.id': turn.stepId,
    'gen_ai.agent.type': AGENT_TYPE,
    'gen_ai.agent.name': firstString(payload, CANDIDATES.agentType),
    'gen_ai.provider.name': inferProviderName({
      ...payload,
      'gen_ai.request.model': model,
      'gen_ai.agent.type': AGENT_TYPE,
    }),
    'gen_ai.request.model': model,
    'gen_ai.response.model': model,

    'gen_ai.input.messages': inputMessages ? toJsonValue(inputMessages) : undefined,
    'gen_ai.input.messages_hash': inputMessages ? hashJson(inputMessages) : undefined,
    'gen_ai.output.messages': outputMessages ? toJsonValue(outputMessages) : undefined,
    'gen_ai.response.finish_reasons': finishReason ? [finishReason] : undefined,

    'gen_ai.tool.name': toolName,
    'gen_ai.tool.call.id': toolCallId,
    'gen_ai.tool.call.exec.id': toolCallId,
    'gen_ai.tool.call.arguments': isToolCall ? toJsonValue(toolInput) : undefined,
    'gen_ai.tool.call.result': isToolResult ? toJsonValue(toolResult) : undefined,
    'gen_ai.tool.call.duration': firstNumber(payload, CANDIDATES.durationMs),
    'tool.result.status': toolStatus?.status,

    'gen_ai.usage.input_tokens': getNumberValue(payload, 'input_tokens'),
    'gen_ai.usage.output_tokens': getNumberValue(payload, 'output_tokens'),
    'gen_ai.usage.total_tokens': getNumberValue(payload, 'total_tokens'),

    // 可观测缺口：TRAE CN 官方 hook 当前不提供 token usage / reasoning / system prompt。
    // 不伪造 0，也不把缺失误报成关闭；本地前端/服务可根据这些字段标红。
    'gen_ai.observability.missing.usage_tokens': isLlmResponse && (
      getNumberValue(payload, 'input_tokens') === undefined
      && getNumberValue(payload, 'output_tokens') === undefined
      && getNumberValue(payload, 'total_tokens') === undefined
    ) ? true : undefined,
    'gen_ai.observability.missing.usage_tokens.reason': isLlmResponse ? 'trae_cn_hook_payload_has_no_usage' : undefined,
    'gen_ai.observability.missing.reasoning': isLlmResponse && !hasReasoning ? true : undefined,
    'gen_ai.observability.missing.reasoning.reason': isLlmResponse && !hasReasoning ? 'trae_cn_hook_payload_has_no_reasoning' : undefined,
    'gen_ai.observability.missing.system_prompt': isLlmRequest ? true : undefined,
    'gen_ai.observability.missing.system_prompt.reason': isLlmRequest ? 'trae_cn_hook_payload_has_user_prompt_only' : undefined,

    'workspace.path': cwd,

    // 源特定上下文
    [`agent.${SOURCE_NS}.hook_event_name`]: sourceEvent,
    // git 上下文强化（src/normalization/enrich-git-context.ts）只认 agent.<ns>.cwd
    // 与 agent.<ns>.workspace_roots，不认 workspace.path，所以 cwd 必须再挂一份
    [`agent.${SOURCE_NS}.cwd`]: cwd,
    // notification_type 已进候选表（=已映射），需显式保留原值
    [`agent.${SOURCE_NS}.notification_type`]: notificationType,
    [`agent.${SOURCE_NS}.task_id`]: firstString(payload, CANDIDATES.taskId),
    [`agent.${SOURCE_NS}.turn_synthesized`]: turn.synthesized ? true : undefined,
    [`agent.${SOURCE_NS}.exit_code`]: exitCode,
    // 工具状态的判定依据（exit_code / is_error_flag / content_present / default …），
    // default 意味着 TRAE 没给任何错误信号、按成功兜底，排查时需区分对待
    [`agent.${SOURCE_NS}.status_source`]: toolStatus?.source,
    // 本轮内第几个工具调用（Pre / Post 共享同一序号）。
    // 注意这不是 ReAct 迭代号——迭代边界 hook 侧不可得，见 resolveTurnContext 的说明
    [`agent.${SOURCE_NS}.tool_seq`]: turn.toolSeq,
    // 轮内事件序号，仅用于排查事件到达顺序，不参与 span 层级
    [`agent.${SOURCE_NS}.event_seq`]: turn.eventSeq,
    // 归一后与原值不一致时保留原值，便于回溯 TRAE 真实结束原因
    [`agent.${SOURCE_NS}.finish_reason_raw`]: rawFinishReason && rawFinishReason !== finishReason
      ? rawFinishReason
      : undefined,

    // trace 串联：同轮共享 traceId，每条记录独立 spanId
    trace_id: turn.traceId,
    span_id: generateSpanId(),

    observed_time_unix_nano: timestampToUnixNanos(now),
    time_unix_nano: timestampToUnixNanos(payload?.timestamp ?? now),
  };

  if (isToolResult) {
    const status = record['tool.result.status'];
    if (status === 'error') {
      record['error.type'] = 'tool_error';
      record['error.message'] = firstString(payload, CANDIDATES.errorMessage);
    }
  }

  addSourceAttributes(record, payload);
  Object.assign(record, RESOURCE_BASE_FIELD_PATCH, SPAN_ATTRIBUTES);
  if (Object.keys(RESOURCE_ATTRIBUTES).length > 0) record.resourceAttributes = RESOURCE_ATTRIBUTES;

  // 轮次终点不是 Stop：官方的 loop_count / stop_hook_active / loop_limit（默认 5）说明
  // 一轮可能触发多次 Stop——其他 hook 返回 block 就会让智能体继续执行并再 Stop 一次。
  // 在第一次 Stop 就清状态会把同一轮对话拆成两条 trace，所以改用官方语义上
  // 真正的终止信号：Notification 的 idle_prompt（智能体完成当前任务）。
  if (String(notificationType || '').toLowerCase() === 'idle_prompt') clearTurnState(sessionId);

  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || {};
}

// ─── 主流程 ───

async function main() {
  const sourceEvent = process.argv[2] || 'unknown';
  // readStdin() 已内部完成 decodePayload（去 BOM + 修复双重编码），返回的是字符串，
  // 不能再过一次 decodePayload，否则得到 null。
  const raw = await readStdin();
  if (!raw || !raw.trim()) {
    logDebug(AGENT_ID, `empty stdin for event=${sourceEvent}`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    logDebug(AGENT_ID, `unparsable stdin JSON for event=${sourceEvent}: ${e.message}`);
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    logDebug(AGENT_ID, `unexpected payload shape for event=${sourceEvent}`);
    return;
  }

  const runtimeConfig = loadHookRuntimeConfig(LOONGSUITE_PILOT_DATA_DIR) || {};
  const record = buildRecord(payload, sourceEvent, runtimeConfig, new Date());

  const sessionId = getStringValue(record, 'gen_ai.session.id');
  if (sessionId) {
    try {
      recordUpstreamContextOnce({
        agentId: AGENT_ID,
        sessionId,
        dataDir: LOONGSUITE_PILOT_DATA_DIR,
      });
    } catch (e) {
      logDebug(AGENT_ID, `upstream context failed: ${e.message}`);
    }
  }

  appendRowsToHistory(AGENT_ID, LOG_PREFIX, [JSON.stringify(record)]);
  logDebug(AGENT_ID, `event=${sourceEvent} -> ${record['event.name']} turn=${record['gen_ai.turn.id']}`);
}

main()
  .catch(err => {
    try {
      logHookError({
        agentId: AGENT_ID,
        stage: 'processor',
        errorType: err?.name || 'Error',
        errorMessage: err?.message || String(err),
      });
    } catch {
      /* 错误日志也失败时静默，不能影响宿主 */
    }
  })
  .finally(() => {
    // 空对象 = 无决策 = 放行。PreToolUse 若返回非零或阻断决策会卡住 TRAE 的工具执行。
    try {
      process.stdout.write('{}\n');
    } catch {
      /* ignore */
    }
    process.exit(0);
  });

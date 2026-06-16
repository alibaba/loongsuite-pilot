#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * codex-hook-processor.mjs — Codex hook 主分发器。
 *
 * 由 codex-loongsuite-pilot-hook.sh 调用,每个 hook 事件触发一次:
 *   $ node codex-hook-processor.mjs <subcommand>
 *
 * Subcommand ↔ Codex hook event:
 *   session-start / user-prompt-submit / pre-tool-use / post-tool-use / stop
 *
 * 整体职责:
 *   - SessionStart / UserPromptSubmit / PreToolUse / PostToolUse: 累积 event 到 state.events
 *   - Stop: 触发 transcript 增量解析(byteOffset + 心跳去重) → 切 turn → buildReactSteps
 *           → 生成 JSONL records → 写出。**不 clearState**(R9.9):仅 events=[] + 持久化
 *           transcript_offset / lastEmittedUsage,因为 codex transcript 是 session 级累加的。
 *
 * 关键移植 + 修复(对照 plan §1.5 Bug Fix Checklist):
 *   - 9.6 system_instructions / tool.definitions 提取
 *   - 9.9 byteOffset 增量 + tokenEventsByTurn(主路径) + 心跳去重
 *   - 9.9 state 不 clearState,改为 events=[] + 持久化 offset
 *   - 9.9 total_tokens 优先用源值,回退 input+output
 *   - 9.9 reasoning_output_tokens 字段
 *   - cmdStop transcript 解析空时 retry 50ms × 3
 *
 * 字段命名全部 ai_event_schema.md 标准 `gen_ai.*`;finish_reasons 输出 string[]。
 */

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
  timestampToUnixNanos,
  toJsonValue,
  loadHookRuntimeConfig,
  resolveUserId,
  applyHookContentPolicy,
} from './agent-event-normalizer.mjs';

import { loadState, saveState, splitIntoTurns } from './codex/state.mjs';
import { parseTranscript } from './codex/transcript-parser.mjs';
import { buildReactSteps } from './codex/react-step-builder.mjs';
import {
  mergeCodexToolArguments,
  normalizeCodexToolArguments,
} from './codex/tool-arguments.mjs';

const AGENT_ID = 'codex';

function nowSec() { return Date.now() / 1000; }

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID);
}

function maybeSaveTranscriptPath(state, input) {
  if (!state.transcript_path) {
    const tp = input.transcript_path;
    if (typeof tp === 'string' && tp) state.transcript_path = tp;
  }
  if (!state.cwd && input.cwd && typeof input.cwd === 'string') {
    state.cwd = input.cwd;
  }
}

function tryReadStdin() {
  try { return readStdinJson(); }
  catch (err) {
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

// ─── transcript tool event injection ───

function appendMissingTranscriptToolEvents(state, transcriptToolEvents) {
  if (!Array.isArray(transcriptToolEvents) || transcriptToolEvents.length === 0) return;
  if (!Array.isArray(state.events)) state.events = [];
  const seen = new Map();
  for (const event of state.events) {
    if (event.type === 'pre_tool_use' || event.type === 'post_tool_use') {
      seen.set(`${event.type}:${event.tool_use_id || ''}`, event);
    }
  }
  for (const event of transcriptToolEvents) {
    const key = `${event.type}:${event.tool_use_id || ''}`;
    const existing = seen.get(key);
    if (existing) {
      mergeTranscriptToolEvent(existing, event);
    } else {
      if (event.type === 'pre_tool_use') {
        event.tool_input = normalizeCodexToolArguments(event.tool_name, event.tool_input);
      }
      state.events.push(event);
      seen.set(key, event);
    }
  }
}

function mergeTranscriptToolEvent(target, transcriptEvent) {
  if (!target || !transcriptEvent) return;
  if (target.type === 'pre_tool_use' && transcriptEvent.type === 'pre_tool_use') {
    target.tool_input = mergeCodexToolArguments(target.tool_name, target.tool_input, transcriptEvent.tool_name, transcriptEvent.tool_input);
    if ((!target.tool_name || target.tool_name === 'unknown') && transcriptEvent.tool_name) {
      target.tool_name = transcriptEvent.tool_name;
    }
  } else if (target.type === 'post_tool_use' && transcriptEvent.type === 'post_tool_use') {
    if (target.tool_response === undefined || target.tool_response === null || target.tool_response === '') {
      target.tool_response = transcriptEvent.tool_response;
    }
    if ((!target.tool_name || target.tool_name === 'unknown') && transcriptEvent.tool_name) {
      target.tool_name = transcriptEvent.tool_name;
    }
  }
}

// ─── 5 cmd handlers — 累积 event 到 state ───

function cmdSessionStart() {
  const input = tryReadStdin();
  const sessionId = requireSessionId(input, 'session_start');
  if (!sessionId) return;
  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, input);
  state.model = String(input.model || state.model || 'unknown');
  state.start_time = state.start_time || nowSec();
  state.events.push({
    type: 'session_start',
    timestamp: nowSec(),
    source: String(input.source || 'startup'),
    model: state.model,
  });
  saveState(sessionId, state);
}

function cmdUserPromptSubmit() {
  const input = tryReadStdin();
  const sessionId = requireSessionId(input, 'user_prompt_submit');
  if (!sessionId) return;
  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, input);
  const model = String(input.model || state.model || 'unknown');
  if (model !== 'unknown') state.model = model;
  state.events.push({
    type: 'user_prompt_submit',
    timestamp: nowSec(),
    prompt: String(input.prompt || ''),
    turn_id: String(input.turn_id || ''),
    model,
  });
  saveState(sessionId, state);
}

function cmdPreToolUse() {
  const input = tryReadStdin();
  const sessionId = requireSessionId(input, 'pre_tool_use');
  if (!sessionId) return;
  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, input);
  state.events.push({
    type: 'pre_tool_use',
    timestamp: nowSec(),
    turn_id: String(input.turn_id || ''),
    tool_name: String(input.tool_name || 'unknown'),
    tool_input: input.tool_input ?? null,
    tool_use_id: String(input.tool_use_id || ''),
  });
  saveState(sessionId, state);
}

function cmdPostToolUse() {
  const input = tryReadStdin();
  const sessionId = requireSessionId(input, 'post_tool_use');
  if (!sessionId) return;
  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, input);
  state.events.push({
    type: 'post_tool_use',
    timestamp: nowSec(),
    turn_id: String(input.turn_id || ''),
    tool_name: String(input.tool_name || 'unknown'),
    tool_response: input.tool_response ?? null,
    tool_use_id: String(input.tool_use_id || ''),
  });
  saveState(sessionId, state);
}

async function cmdStop() {
  const input = tryReadStdin();
  const sessionId = requireSessionId(input, 'stop');
  if (!sessionId) return;
  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, input);
  if (input.cwd && typeof input.cwd === 'string') {
    state.cwd = input.cwd;
  }
  const model = String(input.model || state.model || 'unknown');
  if (model !== 'unknown') state.model = model;

  state.events.push({
    type: 'stop',
    timestamp: nowSec(),
    turn_id: String(input.turn_id || ''),
    last_assistant_message:
      input.last_assistant_message != null ? String(input.last_assistant_message) : undefined,
    model,
  });
  saveState(sessionId, state);

  // R9: transcript 增量读 + retry 50ms × 3
  let transcriptData = null;
  if (state.transcript_path) {
    const startOffset = state.transcript_offset || 0;
    const startLastUsage = state.transcript_last_token_usage ?? null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        transcriptData = parseTranscript(state.transcript_path, startOffset, startLastUsage);
      } catch (err) {
        logHookError({
          agentId: AGENT_ID,
          stage: 'transcript_parse',
          errorType: 'parse_failed',
          errorMessage: err?.message || String(err),
        });
        break;
      }
      // null 或本次没有任何新业务内容 → retry 让 transcript 再 flush 一会
      if (transcriptData && (transcriptData.tokenEvents.length > 0 || transcriptData.systemInstruction || transcriptData.toolDefinitions || transcriptData.toolEvents?.length > 0)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (transcriptData) {
    if (state.model === 'unknown' && transcriptData.model && transcriptData.model !== 'unknown') {
      state.model = transcriptData.model;
    }
  }

  // 从 transcript 提取的工具调用事件，补充 state.events 中缺失的 pre/post_tool_use
  // exec 模式下 user_prompt_submit 必定存在（已验证 250/250 sessions），
  // splitIntoTurns 按事件顺序分配，不依赖 turn_id 字段匹配
  if (transcriptData?.toolEvents?.length > 0) {
    appendMissingTranscriptToolEvents(state, transcriptData.toolEvents);
  }

  // 切 turn + 写 JSONL
  try {
    await writeSessionJsonl(state, transcriptData);
    // 写成功后才推进 offset 和清空 events，避免 write 失败导致数据永久丢失
    if (transcriptData) {
      state.transcript_offset = transcriptData.nextOffset;
      if (transcriptData.lastEmittedUsage) {
        state.transcript_last_token_usage = transcriptData.lastEmittedUsage;
      }
    }
    state.events = [];
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'write_jsonl',
      errorType: 'write_failed',
      errorMessage: err?.message || String(err),
    });
  }
  saveState(sessionId, state);
}

// ─── Stop 主流程: 把 turn events 转成 JSONL records ───

async function writeSessionJsonl(state, transcriptData) {
  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);
  const sessionId = state.session_id || 'unknown';

  // 优先用 transcript 的 turnBoundaries 驱动 turn 切分（覆盖所有用户交互），
  // fallback 到 state.events 的 user_prompt_submit（hook 可能漏报）。
  const turns = resolveTurns(state, transcriptData);
  if (turns.length === 0) return;

  const provider = transcriptData?.modelProvider || 'openai';
  const allRecords = [];
  let logHash = INITIAL_HASH;

  // turn_count 跨 Stop 持久化,确保多 turn session 中 turn_id 递增(不重复 :t1)
  const baseTurnCount = state.turn_count || 0;

  for (let turnIdx = 0; turnIdx < turns.length; turnIdx++) {
    const turn = turns[turnIdx];
    // 主路径:按 turn_id 取本 turn 的 token 事件;fallback 从扁平队列尾部
    let turnTokens = transcriptData?.tokenEventsByTurn?.get(turn.turn_id);
    if (!turnTokens || turnTokens.length === 0) {
      const stepCount = buildReactSteps(turn).length;
      const flat = transcriptData?.tokenEvents ? [...transcriptData.tokenEvents] : [];
      turnTokens = flat.splice(-stepCount, stepCount);
    }

    const { records, hash } = buildTurnRecords({
      turn,
      turnIndex: baseTurnCount + turnIdx,
      sessionId,
      fallbackModel: state.model || 'unknown',
      provider,
      userId,
      turnTokens,
      systemInstruction: transcriptData?.systemInstruction,
      toolDefinitions: transcriptData?.toolDefinitions,
      prevHash: logHash,
      cwd: state.cwd,
    });
    allRecords.push(...records);
    logHash = hash;
  }

  // 持久化 turn_count(跨 Stop 递增)
  state.turn_count = baseTurnCount + turns.length;

  const cleaned = allRecords.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);
}

// ─── Turn 切分：transcript 驱动 + state.events fallback ───

function resolveTurns(state, transcriptData) {
  const boundaries = transcriptData?.turnBoundaries;

  // 无 transcript 数据时回退到原有的 splitIntoTurns（按 user_prompt_submit 切分）
  if (!boundaries || boundaries.length === 0) {
    return splitIntoTurns(state);
  }

  // 用 transcript turnBoundaries 作为权威 turn 边界。
  // 每个 boundary 代表一次真实用户交互（turn_context 事件），
  // 子 agent 的 turn_context 在子 transcript 中，不会出现在父 transcript 里。
  const allEvents = state.events.filter(
    (e) => e.type !== 'session_start',
  );
  const stopEvent = allEvents.find((e) => e.type === 'stop');

  // 父 agent 工具调用的 call_id 白名单。state.events 中 tool_use_id 不在此集合中的
  // pre/post_tool_use 是子 agent 进程混入的事件（子 agent hook 使用父 session_id），
  // 应当过滤掉，避免干扰父 turn 的 step 构建和时间线。
  const parentCallIds = transcriptData?.parentToolCallIds;

  const turns = [];
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const nextBoundary = boundaries[i + 1];
    const startTime = boundary.timestamp;
    const endTime = nextBoundary ? nextBoundary.timestamp : (stopEvent?.timestamp ?? startTime);

    // 找到 state.events 中对应这个 turn 时间范围内的事件。
    // 1. 过滤掉子 agent 混入的 pre/post_tool_use（tool_use_id 不在父白名单中）
    // 2. 对同一 tool_use_id 去重（hook 事件 + appendMissingTranscriptToolEvents
    //    可能各产生一条，优先保留有 tool_input 的那条）
    const seenToolIds = new Map();  // tool_use_id:type → event
    const turnEvents = [];
    for (const e of allEvents) {
      if (e.type === 'stop' || e.type === 'user_prompt_submit') continue;
      const ts = e.timestamp;
      if (ts < startTime || (nextBoundary && ts >= nextBoundary.timestamp)) continue;

      if (e.type === 'pre_tool_use' || e.type === 'post_tool_use') {
        // 白名单过滤：不在父 transcript 中的 tool_use_id 是子 agent 事件
        if (parentCallIds && e.tool_use_id && !parentCallIds.has(e.tool_use_id)) continue;
        // 去重：同一 tool_use_id + type 只保留第一条（hook 事件在前，有 tool_input）
        const dedup = `${e.type}:${e.tool_use_id || ''}`;
        if (seenToolIds.has(dedup)) continue;
        seenToolIds.set(dedup, true);
      }

      turnEvents.push(e);
    }

    // prompt 优先从 transcript 的 user_message 获取（覆盖所有交互），
    // fallback 到 state.events 的 user_prompt_submit（hook 可能漏报）
    const promptEvent = allEvents.find(
      (e) => e.type === 'user_prompt_submit' && e.timestamp >= startTime
        && (!nextBoundary || e.timestamp < nextBoundary.timestamp),
    );

    turns.push({
      turn_id: boundary.turn_id,
      prompt: boundary.prompt || promptEvent?.prompt || '',
      inputMessages: boundary.inputMessages,
      model: promptEvent?.model || state.model || 'unknown',
      start_time: startTime,
      end_time: stopEvent && i === boundaries.length - 1
        ? stopEvent.timestamp
        : endTime,
      events: turnEvents,
      last_assistant_message: i === boundaries.length - 1
        ? stopEvent?.last_assistant_message
        : undefined,
      agentMessages: (transcriptData?.agentMessages || []).filter((am) => {
        if (am.turn_id && boundary.turn_id && am.turn_id !== boundary.turn_id) return false;
        return am.timestamp >= startTime && (!nextBoundary || am.timestamp < nextBoundary.timestamp);
      }),
    });
  }

  return turns;
}

// ─── buildTurnRecords — 单 turn 的 JSONL records 构造 ───

function buildTurnRecords({
  turn,
  turnIndex,
  sessionId,
  fallbackModel,
  provider,
  userId,
  turnTokens,
  systemInstruction,
  toolDefinitions,
  prevHash,
  cwd,
}) {
  const records = [];
  const turnId = `${sessionId}:t${turnIndex + 1}`;
  let runningHash = prevHash;

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
    'gen_ai.provider.name': provider,
    ...(cwd ? { 'agent.codex.cwd': cwd } : {}),
  };

  // turn-level llm.request(代表 user prompt)
  if (turn.prompt) {
    records.push({
      time_unix_nano: timestampToUnixNanos(turn.start_time * 1000),
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...baseFields,
      span_id: agentSpanId,
      parent_span_id: entrySpanId,
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: turn.prompt }] },
      ],
    });
  }

  const steps = buildReactSteps(turn);
  const tokenQueue = Array.isArray(turnTokens) ? [...turnTokens] : [];
  const model = turn.model && turn.model !== 'unknown' ? turn.model : fallbackModel;

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    const tokenEvent = tokenQueue.shift() ?? null;
    const isLastStep = si === steps.length - 1;
    const stepId = `${turnId}:s${si + 1}`;
    const stepSpanId = generateSpanId();
    const llmSpanId = generateSpanId();

    const inputMsgs = step.llm_input_messages;
    const fullInputMsgs = Array.isArray(step.llm_full_input_messages) && step.llm_full_input_messages.length > 0
      ? step.llm_full_input_messages
      : inputMsgs;
    const currentFullHash = computeHash(INITIAL_HASH, fullInputMsgs);
    const logFull = shouldLogFullMessages(runningHash, inputMsgs, currentFullHash);

    // llm.request
    const reqRecord = {
      time_unix_nano: timestampToUnixNanos(step.llm_start_time * 1000),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.request.model': model,
      'gen_ai.input.messages_hash': currentFullHash,
      'gen_ai.input.messages_delta': inputMsgs,
    };
    if (logFull) reqRecord['gen_ai.input.messages'] = fullInputMsgs;
    // Codex 专属:system_instructions / tool.definitions(每条 LLM record 都贴,符合 ARMS 规范)
    if (systemInstruction) reqRecord['gen_ai.system_instructions'] = systemInstruction;
    if (toolDefinitions) reqRecord['gen_ai.tool.definitions'] = toolDefinitions;
    records.push(reqRecord);

    // finish_reasons(array)
    const finishReasons =
      step.tools.length > 0
        ? ['tool_call']
        : isLastStep && turn.last_assistant_message
          ? ['stop']
          : [];

    const inputTokens = tokenEvent?.inputTokens ?? 0;
    const outputTokens = tokenEvent?.outputTokens ?? 0;
    // 9.9 total_tokens 优先用源值,缺失/为 0 时回退到 input+output
    const totalTokens =
      tokenEvent?.totalTokens && tokenEvent.totalTokens > 0
        ? tokenEvent.totalTokens
        : inputTokens + outputTokens;

    const respRecord = {
      time_unix_nano: timestampToUnixNanos(step.llm_end_time * 1000),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.response.finish_reasons': finishReasons.length > 0 ? finishReasons : undefined,
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': tokenEvent?.cachedInputTokens ?? 0,
      'gen_ai.usage.total_tokens': totalTokens,
      'gen_ai.output.messages': step.llm_output_messages,
    };
    if (tokenEvent?.reasoningOutputTokens != null) {
      respRecord['gen_ai.usage.reasoning_output_tokens'] = tokenEvent.reasoningOutputTokens;
    }
    if (systemInstruction) respRecord['gen_ai.system_instructions'] = systemInstruction;
    if (toolDefinitions) respRecord['gen_ai.tool.definitions'] = toolDefinitions;
    records.push(respRecord);

    runningHash = currentFullHash;

    // tool.call / tool.result
    for (const tool of step.tools) {
      const toolSpanId = generateSpanId();
      records.push({
        time_unix_nano: timestampToUnixNanos(tool.start_time * 1000),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: stepSpanId,
        'gen_ai.step.id': stepId,
        'gen_ai.tool.name': tool.tool_name,
        'gen_ai.tool.call.id': tool.tool_use_id,
        'gen_ai.tool.call.arguments': toJsonValue(tool.tool_input),
      });

      const durationMs = (tool.end_time - tool.start_time) * 1000;
      records.push({
        time_unix_nano: timestampToUnixNanos(tool.end_time * 1000),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.result',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: stepSpanId,
        'gen_ai.step.id': stepId,
        'gen_ai.tool.name': tool.tool_name,
        'gen_ai.tool.call.id': tool.tool_use_id,
        'gen_ai.tool.call.result': toJsonValue(tool.tool_response),
        'tool.result.status': 'success',
        'gen_ai.tool.call.duration': durationMs > 0 ? durationMs : undefined,
      });
    }
  }

  return { records, hash: runningHash };
}

// ─── dispatcher ───

const DISPATCH = {
  'session-start': cmdSessionStart,
  'user-prompt-submit': cmdUserPromptSubmit,
  'pre-tool-use': cmdPreToolUse,
  'post-tool-use': cmdPostToolUse,
  'stop': cmdStop,
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

#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * kiro-cli-hook-processor.mjs — Kiro CLI hook 主分发器。
 *
 * 由 kiro-cli-loongsuite-pilot-hook.sh 调用:
 *   $ node kiro-cli-hook-processor.mjs <subcommand>
 *
 * subcommand（camelCase，由 hook.sh 把 PascalCase 事件转过来）:
 *   userPromptSubmit / preToolUse / postToolUse / stop
 *
 * 双源关联（round3 APPROVED）:
 *   - transcript 主干（sqlite conversations_v2.value.history[]）→ STEP/LLM span
 *   - hook PostToolUse 仅补 tool_response（transcript 拿不到的唯一产出）
 *
 * 时间戳:
 *   - STEP/LLM span: transcript ms 级 request_start/end_timestamp_ms（真实时刻）
 *   - TOOL span: hook processor 接收时刻兜底（precision 1s，标注 time_source）
 *
 * token: 恒 null（AWS 后端只回吐 credit）；credit 仅作自定义 attribute。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

import { readTranscriptForCwd, parseConversationValue } from './kiro-cli/transcript-parser.mjs';
import { readSessionJsonl } from './kiro-cli/session-parser.mjs';
import {
  appendToolEvent, drainToolEvents,
  appendPreToolEvent, drainPreToolEvents,
  loadOffset, saveOffset,
  loadSessionOffset, saveSessionOffset,
  loadEmittedSteps, saveEmittedSteps,
} from './kiro-cli/state.mjs';
import { resolveDbPath } from './kiro-cli/db-path.mjs';

const AGENT_ID = 'kiro-cli';
const PROVIDER_NAME = 'amazon'; // Kiro CLI = Amazon Q CodeWhisperer 再分发

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

function nowIso() {
  return new Date().toISOString();
}

function msToUnixNanos(ms) {
  if (!ms || !Number.isFinite(ms)) return '0';
  return String(Math.floor(ms)) + '000000';
}

function isoToUnixNanos(iso) {
  if (!iso) return '0';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '0';
  return String(ms) + '000000';
}

// ─── cmd handlers ───

/**
 * postToolUse: 把 tool_response 缓冲到 per-cwd 文件，stop 时再 join。
 * 不发任何 JSONL（避免无 step 上下文的孤立 tool 事件）。
 */
function cmdPostToolUse() {
  const event = tryReadStdin();
  const cwd = event && event.cwd;
  if (!cwd) return;
  const toolName = event.tool_name || 'unknown';
  const toolInput = event.tool_input ?? {};
  const toolResponse = event.tool_response ?? null;
  appendToolEvent(cwd, {
    toolName,
    toolInput,
    toolResponse,
    captureTs: nowIso(),
  });
}

/**
 * preToolUse: 缓冲 {toolName, toolInput, startTs} 到 per-cwd 独立文件。
 * stop 时与 transcript tool_use join，为 tool.call 提供真实起点时间。
 */
function cmdPreToolUse() {
  const event = tryReadStdin();
  const cwd = event && event.cwd;
  if (!cwd) return;
  const toolName = event.tool_name || 'unknown';
  const toolInput = event.tool_input ?? {};
  appendPreToolEvent(cwd, {
    toolName,
    toolInput,
    startTs: nowIso(),
  });
}

/**
 * userPromptSubmit: 不单独发 JSONL。
 * transcript 主干已覆盖 prompt。
 */
function cmdNoop() {
  // intentionally empty
}

/**
 * stop: 主导出。
 *  1. drain per-cwd PostToolUse 缓冲（tool_response）
 *  2. 读 transcript（sqlite），按 history[] 切 STEP
 *  3. SQLite miss → fallback 到 session JSONL（~/.kiro/sessions/cli/*.jsonl）
 *  4. join tool_response 到 step（按 tool_name + args 匹配）
 *  5. 发 llm.request / llm.response / tool.call / tool.result
 *  6. 若 history[] 缺最终 Response 步，用 stop.assistant_response 合成（兜底）
 *  7. 推进 per-cwd updated_at offset
 */
async function cmdStop() {
  const event = tryReadStdin();
  const cwd = event && event.cwd;
  if (!cwd) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'cmd_stop',
      errorType: 'missing_cwd',
      errorMessage: 'stop hook stdin lacks cwd; skipping',
    });
    return;
  }

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);

  const toolEvents = drainToolEvents(cwd);
  const preToolEvents = drainPreToolEvents(cwd);
  const sinceMs = loadOffset(cwd);

  let transcript;
  let source = 'sqlite';

  // 优先 SQLite transcript
  const dbPath = resolveDbPath();
  if (fs.existsSync(dbPath)) {
    // transcript 落盘略滞后于 stop hook，轮询等待稳定。
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        transcript = await readTranscriptForCwd(cwd, { dbPath, sinceUpdatedMs: sinceMs });
        if (transcript && transcript.steps.length > 0) break;
      } catch (err) {
        logHookError({
          agentId: AGENT_ID,
          stage: 'transcript_read',
          errorType: 'read_failed',
          errorMessage: err?.message || String(err),
        });
        break;
      }
      await new Promise((r) => setTimeout(r, 200 * (1 << attempt)));
    }
  }

  // SQLite miss → session JSONL fallback
  if (!transcript || transcript.steps.length === 0) {
    transcript = await trySessionJsonl(cwd);
    if (transcript) {
      source = 'session_jsonl';
    }
  }

  if (!transcript || transcript.steps.length === 0) {
    return;
  }

  // step-level idempotent dedup：交互式模式下 stop 可能多次触发，
  // 若 SQLite updated_at 在两次 stop 之间变化，offset 机制无法阻止
  // 全量重读。按 (conversationId + stepId) 过滤已发射的 step。
  const currentConvId = transcript.conversationId || transcript.continuationId || 'unknown';
  const emitted = loadEmittedSteps(cwd);
  const seenIds = emitted.conversationId === currentConvId ? emitted.stepIds : new Set();

  const originalHasFinalResponse = transcript.steps.some(
    (s) => s.kind === 'NotToolUse' && s.assistantText,
  );

  const newSteps = transcript.steps.filter((s) => {
    const sid = s.stepId || '';
    if (!sid) return true;
    return !seenIds.has(sid);
  });

  if (newSteps.length === 0) return;

  const dedupedTranscript = { ...transcript, steps: newSteps };

  const records = buildRecords(
    dedupedTranscript, toolEvents, preToolEvents, cwd, userId, event,
    { originalHasFinalResponse },
  );
  if (records.length === 0) return;

  const cleaned = records.map((r) => applyHookContentPolicy(sanitizeObject(r) || r, runtimeConfig));

  let writeOk = false;
  try {
    writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);
    writeOk = true;
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'jsonl_write',
      errorType: 'write_failed',
      errorMessage: err?.message || String(err),
    });
  }

  if (!writeOk) return;

  const allEmittedIds = new Set(seenIds);
  for (const s of newSteps) {
    if (s.stepId) allEmittedIds.add(s.stepId);
  }
  saveEmittedSteps(cwd, currentConvId, allEmittedIds);

  if (source === 'session_jsonl') {
    if (transcript.updatedMs) {
      saveSessionOffset(cwd, transcript.updatedMs);
    }
  } else {
    if (transcript.updatedMs) {
      saveOffset(cwd, transcript.updatedMs);
    }
  }
}

/**
 * session JSONL fallback：扫描 ~/.kiro/sessions/cli/ 找 cwd 匹配的最新 session。
 * @returns {Promise<import('./kiro-cli/transcript-parser.mjs').TranscriptData|null>}
 */
async function trySessionJsonl(cwd) {
  const sessionSinceMs = loadSessionOffset(cwd);
  try {
    const session = await readSessionJsonl(cwd, {
      sinceUpdatedMs: sessionSinceMs,
    });
    return session;
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'session_jsonl_read',
      errorType: 'read_failed',
      errorMessage: err?.message || String(err),
    });
    return null;
  }
}

// ─── buildRecords — 整会话的 trace 记录构造 ───

function buildRecords(transcript, toolEvents, preToolEvents, cwd, userId, stopEvent, opts = {}) {
  const records = [];
  const sessionId = transcript.conversationId || transcript.continuationId || 'unknown';
  const traceId = generateTraceId();
  const entrySpanId = generateSpanId();
  const agentSpanId = generateSpanId();
  const turnId = `${sessionId}:t1`; // 单次 stop 导出 = 一个 turn

  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    'gen_ai.conversation.id': transcript.conversationId || sessionId,
    'user.id': userId,
    ...(cwd ? { 'agent.kiro-cli.cwd': cwd } : {}),
    ...(transcript.source === 'session_jsonl'
      ? {
          'kiro.id_source': 'session_jsonl',
          'kiro.time_precision': 'turn_estimate',
        }
      : {}),
  };

  let runningHash = INITIAL_HASH;
  let prevInputMsgs = [];
  let stepRound = 0;

  const steps = transcript.steps;
  const hasFinalResponse = opts.originalHasFinalResponse
    ?? steps.some((s) => s.kind === 'NotToolUse' && s.assistantText);

  for (const step of steps) {
    stepRound++;
    const currentStepId = step.stepId || `${turnId}:s${stepRound}`;
    const currentStepSpanId = generateSpanId();
    const llmSpanId = generateSpanId();
    const responseId = step.responseId || `${currentStepId}:r`;
    const modelId = step.modelId || transcript.modelId || 'auto';

    const finishReason = step.kind === 'NotToolUse' ? 'stop' : 'tool_call';

    // input messages: 首步带首轮用户原始 prompt（transcript history[0].user.content.Prompt.prompt），
    // 后续步从 ToolUseResults 构建 role: "tool" 消息（transcript history[i].user.content.ToolUseResults.tool_use_results[].content[].Text）。
    const inputMsgs = [];
    if (stepRound === 1) {
      const prompt = step.userPrompt || '';
      inputMsgs.push({ role: 'user', parts: [{ type: 'text', content: prompt }] });
    } else if (Array.isArray(step.toolUseResults) && step.toolUseResults.length > 0) {
      for (const resultText of step.toolUseResults) {
        inputMsgs.push({ role: 'tool', parts: [{ type: 'text', content: resultText }] });
      }
    }

    let currentFullHash;
    let delta;
    let logFull;
    if (stepRound === 1) {
      currentFullHash = computeHash(INITIAL_HASH, inputMsgs);
      delta = inputMsgs;
      logFull = shouldLogFullMessages(INITIAL_HASH, delta, currentFullHash);
    } else {
      currentFullHash = computeHash(runningHash, inputMsgs);
      delta = inputMsgs;
      logFull = inputMsgs.length > 0;
    }

    // llm.request
    const reqRecord = {
      time_unix_nano: msToUnixNanos(step.startTimeMs),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': modelId,
      'gen_ai.input.messages_hash': currentFullHash,
      'gen_ai.input.messages_delta': delta,
    };
    if (logFull) {
      reqRecord['gen_ai.input.messages'] = inputMsgs;
    }
    records.push(reqRecord);

    // output messages:
    //   - NotToolUse 终步: 真 Response.content
    //   - ToolUse 步: 由 transcript tool_uses[] 合成 tool_call parts（derived=true，
    //     表示模型本轮产出即工具调用，无自然语言文本）。
    const outMessages = [];
    if (step.kind === 'NotToolUse' && step.assistantText) {
      outMessages.push({
        role: 'assistant',
        parts: [{ type: 'text', content: step.assistantText }],
        finish_reason: 'stop',
      });
    } else {
      const toolCallParts = step.tools.map((t) => ({
        type: 'tool_call',
        id: t.id || null,
        name: t.name,
        arguments: t.args ?? null,
      }));
      outMessages.push({
        role: 'assistant',
        parts: toolCallParts,
        finish_reason: 'tool_call',
        derived: true,
      });
    }

    // credit 对齐到 step（usage_info 与 history 等长；round3 实证对齐）
    const credit = step.creditIndex >= 0 ? transcript.credits[step.creditIndex] : undefined;

    const respRecord = {
      time_unix_nano: msToUnixNanos(step.endTimeMs || step.startTimeMs),
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: currentStepSpanId,
      'gen_ai.step.id': currentStepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': modelId,
      'gen_ai.response.model': modelId,
      'gen_ai.response.finish_reasons': [finishReason],
      'gen_ai.output.messages': outMessages,
      // token 恒 null（AWS 后端不回吐）；不臆造 0
      'kiro.token_source': 'unavailable',
      ...(credit !== undefined ? { 'kiro.credit_cost': credit } : {}),
    };
    records.push(respRecord);

    runningHash = currentFullHash;
    prevInputMsgs = inputMsgs;

    // tool.call + tool.result: preToolUse 提供 tool.call 真实起点，postToolUse 补 tool_response
    const isSessionJsonl = transcript.source === 'session_jsonl';
    for (const tool of step.tools) {
      const toolSpanId = generateSpanId();
      const preMatch = matchToolEvent(preToolEvents, tool, 'toolName', 'toolInput');
      const matched = matchToolEvent(toolEvents, tool, 'toolName', 'toolInput');
      const toolResult = matched ? matched.toolResponse : null;
      const toolTimeNs = matched ? isoToUnixNanos(matched.captureTs) : msToUnixNanos(step.endTimeMs || step.startTimeMs);

      // tool.call time: preToolUse startTs > step.endTimeMs（LLM 流结束）; 禁用 step.startTimeMs（LLM 请求起点）
      const toolCallTimeNs = preMatch
        ? isoToUnixNanos(preMatch.startTs)
        : msToUnixNanos(step.endTimeMs || step.startTimeMs);

      records.push({
        time_unix_nano: toolCallTimeNs,
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: currentStepSpanId,
        'gen_ai.step.id': currentStepId,
        'gen_ai.tool.name': tool.name,
        'gen_ai.tool.call.id': tool.id,
        'gen_ai.tool.call.arguments': toJsonValue(stripMetaKeys(tool.args ?? {})),
        'kiro.time_source': preMatch ? 'processor_receive' : 'transcript_estimate',
        'kiro.time_precision': preMatch ? 'ms' : (isSessionJsonl ? 'turn_estimate' : 'ms'),
      });

      if (toolResult !== null && toolResult !== undefined) {
        const toolErr = detectToolError(matched?.toolResponse);
        const resultRecord = {
          time_unix_nano: toolTimeNs,
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          ...baseFields,
          span_id: toolSpanId,
          parent_span_id: currentStepSpanId,
          'gen_ai.step.id': currentStepId,
          'gen_ai.tool.name': tool.name,
          'gen_ai.tool.call.id': tool.id,
          'gen_ai.tool.call.result': toJsonValue(extractToolResultText(toolResult)),
          'tool.result.status': toolErr ? 'error' : 'success',
          'kiro.time_source': matched ? 'processor_receive' : 'transcript_estimate',
          'kiro.time_precision': matched ? 'ms' : (isSessionJsonl ? 'turn_estimate' : 'ms'),
        };
        if (toolErr) {
          resultRecord['error.type'] = 'ToolError';
          resultRecord['error.message'] = toolErr.message;
        }
        records.push(resultRecord);
      } else {
        // 无对应 hook 事件（transcript-only）：发一条 derived 的 tool.result 兜底，
        // 用 transcript 的 ToolUseResults（history 下一 entry 的 user.content）。
        // 结果文本仅纯文本，无 success/exit_status 等失败语义字段，
        // 无法据此判定成功/失败（kiro 工具级失败如 fs_read 权限拒绝会在 harness 层崩溃、
        // 不回吐 postToolUse，整个 session 无 pilot 数据，此分支不可达），故恒记 success。
        const derivedResult = deriveToolResultText(step, transcript, tool);
        // 无 postToolUse hook 时 tool.call.time == step.endTimeMs（无真实起点），
        // 若 result 也取同一时刻 → 0ms TOOL span（validate-trace time.non_zero_duration ERROR）。
        // 与已合成的 NotToolUse step 一致：result 时刻至少 +1ms 偏移，保证非零时长。
        records.push({
          time_unix_nano: msToUnixNanos((step.endTimeMs || step.startTimeMs) + 1),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          ...baseFields,
          span_id: toolSpanId,
          parent_span_id: currentStepSpanId,
          'gen_ai.step.id': currentStepId,
          'gen_ai.tool.name': tool.name,
          'gen_ai.tool.call.id': tool.id,
          'gen_ai.tool.call.result': toJsonValue(derivedResult),
          'tool.result.status': 'success',
          'kiro.time_source': 'transcript_derived',
        });
      }
    }
  }

  // 兜底：history[] 缺最终 Response 步 → 用 stop.assistant_response 合成一条 NotToolUse step。
  if (!hasFinalResponse && stopEvent && stopEvent.assistant_response) {
    stepRound++;
    const synthStepId = `${turnId}:s${stepRound}`;
    const synthStepSpanId = generateSpanId();
    const synthLlmSpanId = generateSpanId();
    const synthResponseId = crypto.randomUUID();

    // 合成 request/response 加 +1ms 偏移，避免 validate-trace 报 time.non_zero_duration ERROR
    const synthTimeMs = Date.now();
    const synthReqNano = msToUnixNanos(synthTimeMs);
    const synthRespNano = msToUnixNanos(synthTimeMs + 1);

    const inputMsgs = [];
    const currentFullHash = computeHash(runningHash, inputMsgs);

    records.push({
      time_unix_nano: synthReqNano,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      span_id: synthLlmSpanId,
      parent_span_id: synthStepSpanId,
      'gen_ai.step.id': synthStepId,
      'gen_ai.response.id': synthResponseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': transcript.modelId || 'auto',
      'gen_ai.input.messages_hash': currentFullHash,
      'gen_ai.input.messages_delta': [],
    });

    records.push({
      time_unix_nano: synthRespNano,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      span_id: synthLlmSpanId,
      parent_span_id: synthStepSpanId,
      'gen_ai.step.id': synthStepId,
      'gen_ai.response.id': synthResponseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': transcript.modelId || 'auto',
      'gen_ai.response.model': transcript.modelId || 'auto',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.output.messages': [
        {
          role: 'assistant',
          parts: [{ type: 'text', content: stopEvent.assistant_response }],
          finish_reason: 'stop',
          derived: true,
        },
      ],
      'kiro.token_source': 'unavailable',
      'kiro.synthesized': true,
      'kiro.id_source': 'synthesized',
      'kiro.time_source': 'processor_receive',
      'kiro.time_precision': '1s',
    });
  }

  // 按时间排序，tool 事件交错在 LLM 事件之间，避免 OTLP finish=stop 提前 flush 丢弃。
  records.sort((a, b) => {
    const ta = BigInt(a.time_unix_nano || '0');
    const tb = BigInt(b.time_unix_nano || '0');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  return records;
}

/**
 * 通用 hook 事件 → tool_use 匹配（consume-on-match）。
 * 同名 + 同 args 确定性匹配；命中即 splice，解决同名同 args 并行工具串台。
 */
function matchToolEvent(toolEvents, tool, nameKey = 'toolName', inputKey = 'toolInput') {
  const idx = toolEvents.findIndex(
    (e) => e[nameKey] === tool.name && argsEqual(e[inputKey], tool.args),
  );
  if (idx === -1) return null;
  return toolEvents.splice(idx, 1)[0];
}

function argsEqual(a, b) {
  try {
    return JSON.stringify(stripMetaKeys(a ?? {})) === JSON.stringify(stripMetaKeys(b ?? {}));
  } catch {
    return false;
  }
}

function stripMetaKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripMetaKeys);
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('__')) continue;
    clean[k] = stripMetaKeys(v);
  }
  return clean;
}

/**
 * hook tool_response 结构: { success: bool, result: string[] } → 取 result 文本。
 */
function extractToolResultText(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return toolResponse;
  if (Array.isArray(toolResponse.result)) {
    return toolResponse.result.join('\n');
  }
  if (typeof toolResponse.result === 'string') return toolResponse.result;
  return toolResponse;
}

/**
 * 从 postToolUse tool_response 判定工具是否失败（kiro-cli v2.8.0 pilot-probe 实证语义）。
 *
 * 实测（pilot-probe 抓 kiro 原始 postToolUse payload）：
 *   - execute_bash 命令失败: success=true，退出码在 result[].exit_status（!= "0"）
 *     例: cat /nonexistent → {"success":true,"result":[{"exit_status":"1",...}]}
 *   - success===false 的 postToolUse 在 v2.8.0 下未被观测到（保留判定以兼容未来版本）
 *   - 工具级失败（如 fs_read 权限拒绝）→ kiro 在 harness 层崩溃、不回吐 postToolUse，
 *     整个 session 无 pilot 数据，故该路径无 postToolUse 可检，不在此构造死代码。
 *
 * @returns {{ message: string } | null} 失败时携带真实错误信息（退出码 / 错误文本）
 */
function detectToolError(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return null;
  if (toolResponse.success === false) {
    return { message: extractToolErrorMessage(toolResponse) };
  }
  const items = Array.isArray(toolResponse.result) ? toolResponse.result : [];
  for (const item of items) {
    if (item && typeof item === 'object' &&
      item.exit_status !== undefined && item.exit_status !== null &&
      String(item.exit_status) !== '0') {
      const detail = [item.stderr, item.error, item.output, item.stdout]
        .find((v) => typeof v === 'string' && v.trim());
      return {
        message: detail
          ? `exit_status ${item.exit_status}: ${detail.trim()}`
          : `exit_status ${item.exit_status}`,
      };
    }
  }
  return null;
}

function extractToolErrorMessage(toolResponse) {
  const m = toolResponse.error || toolResponse.message;
  if (typeof m === 'string' && m.trim()) return m.trim();
  try {
    return JSON.stringify(toolResponse).slice(0, 200);
  } catch {
    return 'tool execution reported failure';
  }
}

/**
 * 从 transcript history 的下一个 entry 的 user.content.ToolUseResults 取 tool 结果文本。
 * round3 实证：history[i+1].user.content.ToolUseResults.tool_use_results[].content[].Text
 *
 * session JSONL: 从 toolResultMap（toolUseId → resultText）取。
 */
function deriveToolResultText(step, transcript, tool) {
  if (transcript?.toolResultMap && tool?.id) {
    const result = transcript.toolResultMap.get(tool.id);
    if (result !== undefined) return result;
  }
  return '';
}

// ─── dispatcher ───

const DISPATCH = {
  'stop': cmdStop,
  'postToolUse': cmdPostToolUse,
  'preToolUse': cmdPreToolUse,
  'userPromptSubmit': cmdNoop,
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

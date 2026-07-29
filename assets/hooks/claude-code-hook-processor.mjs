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
import { recordUpstreamContextOnce } from './shared/upstream-context.mjs';
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
  parseSpanAttributesFromEnv,
} from './shared/resource-context.mjs';

const AGENT_ID = 'claude-code';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};
// Caller-supplied span attributes (e.g. multica.*) stamped as top-level record
// fields so the trace flusher can pass matching keys through to span attributes.
const SPAN_ATTRIBUTES = parseSpanAttributesFromEnv(process.env, { agentId: AGENT_ID });

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

// ─── /skill 根 SKILL.md 去重合成辅助 ───

/**
 * 纯词法归一化 skill 根路径 / Read file_path,用于按精确相等比较去重。
 * runtime 为 Linux(大小写敏感 FS):禁 toLowerCase(会误配仅大小写不同的文件)、
 * 禁 realpathSync(命中 FS、路径不存在会抛、与 transcript 字符串不确定一致 → 非幂等)。
 * 只做 path.resolve(cwd,p) + normalize + 去尾斜杠。
 */
function normalizeSkillPath(cwd, p) {
  if (!p || typeof p !== 'string') return null;
  const resolved = cwd ? path.resolve(cwd, p) : path.resolve(p);
  return path.normalize(resolved).replace(/\/+$/, '');
}

/**
 * 兜底合成 Read 的确定性 call id: hash(client+turnId+normalizedRootPath)。
 * 同一次 build 内幂等,tool.call/tool.result 复用同一 id → OTLP 一个 execute_tool Read span。
 */
function deterministicSkillReadId(client, turnId, normalizedRootPath) {
  const h = crypto
    .createHash('sha1')
    .update(`${client}|${turnId}|${normalizedRootPath}`)
    .digest('hex')
    .slice(0, 24);
  return `toolu_skillread_${h}`;
}

/**
 * 把一个合成的 tool_call part 注入到指定 step 的 llm.response 记录的
 * gen_ai.output.messages(assistant 消息)里。参照 cursor PR #193 的做法,
 * 保证合成的 tool span 在 LLM 输出侧有对应 tool_call(ARMS 语义校验要求)。
 */
function injectSynthesizedToolCall(records, stepId, toolCall) {
  const llmResp = records.find(
    (r) => r['event.name'] === 'llm.response' && r['gen_ai.step.id'] === stepId,
  );
  if (!llmResp) return;
  const msgs = Array.isArray(llmResp['gen_ai.output.messages'])
    ? llmResp['gen_ai.output.messages']
    : [];
  let assistantMsg = msgs.find((m) => m && m.role === 'assistant');
  if (!assistantMsg) {
    assistantMsg = { role: 'assistant', parts: [] };
    msgs.push(assistantMsg);
  }
  if (!Array.isArray(assistantMsg.parts)) assistantMsg.parts = [];
  assistantMsg.parts.push({ type: 'tool_call', ...toolCall });
  llmResp['gen_ai.output.messages'] = msgs;
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

  // 方案1(env):首个 turn 读 TRACEPARENT 写 session 级关联记录(fail-open, 每 session 一次)
  recordUpstreamContextOnce({ agentId: AGENT_ID, sessionId, dataDir: pilotDataDir() });

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
    // SPAN_ATTRIBUTES first so structural/pipeline fields (e.g. resourceAttributes)
    // win over caller-supplied attributes; aligns with qoder's Object.assign order.
    ...SPAN_ATTRIBUTES,
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
  // user-typed /skill 合成挂 owner step = turn 首个 LLM step;result ts 取首个 LLM response。
  let firstStepId = null;
  let firstStepSpanId = null;
  let firstLlmResponseTs = null;

  for (const ev of llmCalls) {
    stepRound++;
    const currentStepId = `${turnId}:s${stepRound}`;
    const currentStepSpanId = generateSpanId();
    if (firstStepId === null) {
      firstStepId = currentStepId;
      firstStepSpanId = currentStepSpanId;
      firstLlmResponseTs = ev.timestamp || null;
    }
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

  // /skill 兜底合成前置数据: 本 turn 所有真实 Read 的归一化 file_path(事件优先级
  // transcript/Hook 真实 Read > 兜底合成),以及已合成过的根路径(同 turn 幂等去重)。
  // 只用于「根 SKILL.md 是否已有真实 Read」判定,普通文件 Read 全程不触碰、不做全局去重。
  const skillRootByToolId = turn.skillRootByToolId;
  const userTypedSkillRoots = turn.userTypedSkillRoots;
  const hasUserTypedRoots = !!(userTypedSkillRoots && userTypedSkillRoots.size > 0);
  const realReadPaths = new Set();
  if ((skillRootByToolId && skillRootByToolId.size > 0) || hasUserTypedRoots) {
    for (const ev of llmCalls) {
      for (const block of (ev.output_content || [])) {
        if (block && block.type === 'tool_use' && block.name === 'Read') {
          const norm = normalizeSkillPath(cwd, block.input?.file_path);
          if (norm) realReadPaths.add(norm);
        }
      }
    }
  }
  const synthesizedSkillRoots = new Set();

  // user-typed /skill 兜底合成 (turn 级入口):
  // CC UI 直接以 isMeta + sourceToolUseID 缺席注入 SKILL.md 内容时,本 turn 无 Skill
  // tool_use 可挂(参见下方 :702 no-op),故在此合成根 Read span,挂 owner step = turn 首个 LLM step。
  // 去重键 = client + turnId + 归一化根路径,复用 deterministicSkillReadId / synthesizedSkillRoots。
  if (hasUserTypedRoots && firstStepId) {
    // P0 时间戳: call/result 必须不同,防 validate-trace time.non_zero_duration ERROR。
    // call ts = 用户敲 /skill 时刻 (promptTimestamp);
    // result ts = 本 turn 首个 LLM response (读完成于模型开始回应前),取不到 → promptTs + 1ns 兜底。
    const callNs = isoToUnixNanos(turn.promptTimestamp);
    const firstRespNs = isoToUnixNanos(firstLlmResponseTs);
    let resultNs = (!firstRespNs || firstRespNs === '0' || firstRespNs === callNs)
      ? (() => { try { return String(BigInt(callNs) + 1n); } catch { return callNs; } })()
      : firstRespNs;
    for (const rootRaw of userTypedSkillRoots) {
      const normRoot = normalizeSkillPath(cwd, rootRaw);
      if (!normRoot) continue;
      if (realReadPaths.has(normRoot) || synthesizedSkillRoots.has(normRoot)) continue;
      synthesizedSkillRoots.add(normRoot);
      const readCallId = deterministicSkillReadId(AGENT_ID, turnId, normRoot);
      const readSpanId = generateSpanId();
      records.push({
        time_unix_nano: callNs,
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        span_id: readSpanId,
        parent_span_id: firstStepSpanId,
        'gen_ai.step.id': firstStepId,
        'gen_ai.tool.name': 'Read',
        'gen_ai.tool.call.id': readCallId,
        'gen_ai.tool.call.arguments': toJsonValue({ file_path: normRoot }),
      });
      records.push({
        time_unix_nano: resultNs,
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.result',
        ...baseFields,
        span_id: readSpanId,
        parent_span_id: firstStepSpanId,
        'gen_ai.step.id': firstStepId,
        'gen_ai.tool.name': 'Read',
        'gen_ai.tool.call.id': readCallId,
        'gen_ai.tool.call.result': toJsonValue(''),
        'tool.result.status': 'success',
      });
      // 参照 cursor PR #193: owner step 的 LLM span output.messages 挂同 id/name=Read 的 tool_call,
      // 使合成 Read span 满足 ARMS semantic.tool_matches_llm_output。
      injectSynthesizedToolCall(records, firstStepId, {
        id: readCallId,
        name: 'Read',
        arguments: toJsonValue({ file_path: normRoot }),
      });
    }
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

      // model-auto Skill 不再合成根 Read (用户边界: 仅 user-typed slash /skill 合成)。
      // user-typed 合成在上方 turn 级入口 (hasUserTypedRoots 分支),此处 model-auto 路径 no-op。
      // 未来若需 model-auto 合成可从 git 历史恢复本块。
      if (toolName === 'Skill' && skillRootByToolId) { /* no-op */ }
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

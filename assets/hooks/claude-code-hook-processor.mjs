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
 *   - 只处理 4 个 subcommand: pre-tool-use / stop / subagent-start / subagent-stop
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
  withStateLock,
} from './claude-code/state.mjs';
import {
  buildBashUpdatedInput,
  consumeToolContext,
  markToolPropagationConsumed,
  reserveToolContext,
} from './claude-code/tool-context.mjs';
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

// P0 cross-Agent guard: when running inside TRAE-CN (env TRAE_PROJECT_DIR set
// by TRAE's hook executor), skip processing entirely. Without this, a user who
// enables TRAE's "import CLAUDE hooks" switch would have pilot's Claude Code
// hook fire inside TRAE, producing gen_ai.agent.type=claude-code records for
// TRAE sessions — duplicate collection plus wrong Agent attribution
// (see user spec v2 §2.7 / §8.10). fail-open: emit {} and exit so the host
// (TRAE) treats the hook as a no-op pass-through.
if (process.env.TRAE_PROJECT_DIR) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const AGENT_ID = 'claude-code';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};
// Caller-supplied span attributes (e.g. multica.*) stamped as top-level record
// fields so the trace flusher can pass matching keys through to span attributes.
const SPAN_ATTRIBUTES = parseSpanAttributesFromEnv(process.env, { agentId: AGENT_ID });
// Retain recent completion tombstones to ignore delayed duplicate SubagentStop
// events while keeping the persisted session state bounded.
const FINALIZED_SUBAGENT_LIMIT = 128;
let emittedHookResponse = false;

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

function isAgentTool(toolName) {
  return toolName === 'Agent' || toolName === 'agent';
}

/**
 * Resolve a direct subagent transcript at:
 * <parent-directory>/<parent-session>/subagents/agent-<agent-id>.jsonl
 *
 * Returns null when the agent ID cannot be resolved safely inside that directory.
 */
function resolveSubagentTranscriptPath(parentTranscriptPath, agentId) {
  const rawAgentId = String(agentId || '').trim();
  if (
    !rawAgentId
    || rawAgentId.includes('/')
    || rawAgentId.includes('\\')
    || rawAgentId.includes('\0')
  ) return null;

  const safeAgentId = path.basename(rawAgentId).replace(/\.jsonl$/, '');
  if (!safeAgentId || safeAgentId === '.' || safeAgentId === '..') return null;

  const parentSessionId = path.basename(parentTranscriptPath, path.extname(parentTranscriptPath));
  const filename = safeAgentId.startsWith('agent-')
    ? `${safeAgentId}.jsonl`
    : `agent-${safeAgentId}.jsonl`;
  const subagentDir = path.resolve(
    path.dirname(parentTranscriptPath),
    parentSessionId,
    'subagents',
  );
  const transcriptPath = path.resolve(subagentDir, filename);
  const relativePath = path.relative(subagentDir, transcriptPath);
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) return null;
  return transcriptPath;
}

function collectSubagentLinks(turn) {
  const links = [];
  for (const llmCall of (turn.llmCalls || [])) {
    for (const block of (llmCall.output_content || [])) {
      if (!block?.id || !isAgentTool(block.name)) continue;
      const detail = llmCall.toolDetails?.get(block.id);
      if (!detail?.agentId) continue;
      links.push({
        agentId: detail.agentId,
        agentName: detail.agentType || block.input?.subagent_type || 'Subagent',
        parentToolCallId: block.id,
        isBackground: block.input?.run_in_background === true
          || detail.status === 'async_launched'
          || detail.isAsync === true,
      });
    }
  }
  return links;
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

// ─── runtime Skill load 辅助 ───

/**
 * 显式 /skill 没有模型生成的 tool_use id。使用 transcript 中稳定字段生成 call id,
 * 使同一条 meta 注入在重放时仍映射为同一个 TOOL span。
 */
function deterministicSkillLoadId(sessionId, promptId, metaUuid, rootPath) {
  const h = crypto
    .createHash('sha256')
    .update([
      sessionId || '',
      promptId || '',
      metaUuid || '',
      rootPath || '',
    ].join('\0'))
    .digest('hex')
    .slice(0, 24);
  return `toolu_skillload_${h}`;
}

function toolPropagationEnabled(runtimeConfig) {
  return runtimeConfig?.upstreamLink?.enabled === true
    && runtimeConfig?.upstreamLink?.propagateToTools === true;
}

function cmdPreToolUse() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'pre_tool_use');
  if (!sessionId) return;

  // v1 policy: only propagate from the main agent's Bash calls.
  if (event.agent_id || event.agent_type) return;
  if (event.tool_name !== 'Bash') return;
  const toolUseId = typeof event.tool_use_id === 'string' ? event.tool_use_id : '';
  if (!toolUseId) return;

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  if (!toolPropagationEnabled(runtimeConfig)) return;

  const context = reserveToolContext({
    dataDir: pilotDataDir(),
    sessionId,
    toolUseId,
    traceparent: process.env.TRACEPARENT,
    tracestate: process.env.TRACESTATE,
  });
  const updatedInput = buildBashUpdatedInput(event.tool_input, context);
  if (!updatedInput) return;

  emittedHookResponse = true;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput,
    },
  })}\n`);
}

function skillAttributes(skillLoad, fallbackName) {
  const name = skillLoad?.name
    || (typeof fallbackName === 'string' ? fallbackName.trim().replace(/^\/+/, '') : null);
  const id = skillLoad?.id || name;
  return {
    ...(name ? { 'gen_ai.skill.name': name } : {}),
    ...(id ? { 'gen_ai.skill.id': id } : {}),
  };
}

function positiveSkillLoadTimes(skillLoad, fallbackTimestamp) {
  const minDurationNanos = 1_000_000n; // converter uses millisecond start/end times
  let call = BigInt(isoToUnixNanos(
    skillLoad?.commandTimestamp || skillLoad?.metaTimestamp || fallbackTimestamp,
  ));
  let result = BigInt(isoToUnixNanos(
    skillLoad?.metaTimestamp || fallbackTimestamp || skillLoad?.commandTimestamp,
  ));

  if (call === 0n && result > minDurationNanos) call = result - minDurationNanos;
  if (call === 0n) call = BigInt(Date.now()) * 1_000_000n;
  if (result <= call) result = call + minDurationNanos;

  return { call: String(call), result: String(result) };
}

// ─── cmd handlers ───

async function cmdSubagentStart() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  await withStateLock(sessionId, async () => {
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
  });
}

async function cmdSubagentStop() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  await withStateLock(sessionId, async () => {
    const state = loadState(sessionId);
    if (!state.transcript_path && event.transcript_path) {
      state.transcript_path = event.transcript_path;
    }
    if (!state.cwd && event.cwd && typeof event.cwd === 'string') {
      state.cwd = event.cwd;
    }

    const agentId = event.agent_id || event.subagent_session_id || '';
    const childSid = event.subagent_session_id || 'unknown';
    let childStateSnapshot = null;
    if (childSid && childSid !== 'unknown' && childSid !== sessionId) {
      childStateSnapshot = readAndDeleteChildState(childSid);
    }

    state.completed_subagents = state.completed_subagents || {};
    const finalizedSubagents = new Set(state.finalized_subagent_ids || []);
    if (agentId && !finalizedSubagents.has(agentId)) {
      state.completed_subagents[agentId] = true;
    }

    state.events = state.events || [];
    const evData = {
      type: 'subagent_stop',
      timestamp: nowSec(),
      subagent_session_id: childSid,
      agent_id: agentId,
      agent_type: event.agent_type || '',
      agent_transcript_path: event.agent_transcript_path || '',
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

    await finalizePendingSubagentTurns(state);
    saveState(sessionId, state);
  });
}

async function cmdStop() {
  const event = tryReadStdin();
  if (isCursorCaller(event)) return;
  const sessionId = requireSessionId(event, 'cmd');
  if (!sessionId) return;

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());

  // 方案1(env):首个 turn 读 TRACEPARENT 写 session 级关联记录(fail-open, 每 session 一次)
  recordUpstreamContextOnce({ agentId: AGENT_ID, sessionId, dataDir: pilotDataDir() });
  if (toolPropagationEnabled(runtimeConfig)) {
    markToolPropagationConsumed(pilotDataDir(), sessionId);
  }

  await withStateLock(sessionId, async () => {
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
  });
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

function sortRecordsByTimestamp(records) {
  records.sort((a, b) => {
    const ta = BigInt(a.time_unix_nano || '0');
    const tb = BigInt(b.time_unix_nano || '0');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
  return records;
}

function cleanRecords(records, runtimeConfig) {
  return records.map((record) =>
    applyHookContentPolicy(sanitizeObject(record) || record, runtimeConfig));
}

function extendBackgroundAgentResult(records, link, childRecords) {
  let childEnd = 0n;
  for (const record of childRecords) {
    const timestamp = BigInt(record.time_unix_nano || '0');
    if (timestamp > childEnd) childEnd = timestamp;
  }
  if (childEnd === 0n) return;

  const parentResult = records.find((record) =>
    record['event.name'] === 'tool.result'
    && record['gen_ai.tool.call.id'] === link.parentToolCallId);
  if (!parentResult) return;
  if (BigInt(parentResult.time_unix_nano || '0') < childEnd) {
    parentResult.time_unix_nano = String(childEnd);
  }
}

function buildSubagentRecords({
  parentTranscriptPath,
  parentSessionId,
  parentTraceId,
  parentTurnId,
  link,
  userId,
  cwd,
  intercept,
}) {
  const childTranscriptPath = resolveSubagentTranscriptPath(parentTranscriptPath, link.agentId);
  if (!childTranscriptPath || !fs.existsSync(childTranscriptPath)) {
    return { records: [], mergedResponseIds: new Set() };
  }

  let childParseResult;
  try {
    childParseResult = parseClaudeTranscript(childTranscriptPath, 0);
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'subagent_transcript_parse',
      errorType: 'parse_failed',
      errorMessage: err?.message || String(err),
    });
    return { records: [], mergedResponseIds: new Set() };
  }

  const childRecords = [];
  const mergedResponseIds = new Set();
  let childHash = INITIAL_HASH;
  for (let childTurnIndex = 0; childTurnIndex < childParseResult.turns.length; childTurnIndex++) {
    const childBuild = buildTurnRecords(
      childParseResult.turns[childTurnIndex],
      childTurnIndex,
      link.agentId,
      childHash,
      userId,
      'end_turn',
      cwd,
      intercept,
    );
    childHash = childBuild.hash;
    for (const rid of childBuild.mergedResponseIds) mergedResponseIds.add(rid);

    for (const childRecord of childBuild.records) {
      // The child prompt is already present in the first llm.request delta.
      // Keeping its `other` record would incorrectly feed the parent ENTRY.
      if (childRecord['event.name'] === 'other') continue;
      childRecords.push({
        ...childRecord,
        trace_id: parentTraceId,
        'gen_ai.session.id': parentSessionId,
        'gen_ai.turn.id': parentTurnId,
        'gen_ai.agent.scope': 'subagent',
        'gen_ai.agent.depth': 1,
        'gen_ai.agent.id': link.agentId,
        'gen_ai.agent.name': link.agentName,
        'gen_ai.agent.parent.id': parentSessionId,
        'gen_ai.subagent.parent_tool_call.id': link.parentToolCallId,
      });
    }
  }

  return { records: childRecords, mergedResponseIds };
}

async function finalizePendingSubagentTurns(state) {
  const pendingTurns = Array.isArray(state.pending_subagent_turns)
    ? state.pending_subagent_turns
    : [];
  if (pendingTurns.length === 0) return;

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const sessionId = state.session_id || 'unknown';
  const userId = resolveUserId({}, runtimeConfig);
  const cwd = state.cwd || undefined;
  const intercept = loadInterceptForSession(sessionId);
  const mergedResponseIds = new Set();
  const completedSubagents = state.completed_subagents || {};
  const remainingTurns = [];

  for (const pending of pendingTurns) {
    const records = Array.isArray(pending.records) ? [...pending.records] : [];
    const backgroundLinks = Array.isArray(pending.background_links)
      ? pending.background_links
      : [];

    for (const link of backgroundLinks) {
      if (link.completed) {
        delete completedSubagents[link.agentId];
        continue;
      }
      if (!completedSubagents[link.agentId]) continue;
      const childTranscriptPath = resolveSubagentTranscriptPath(
        state.transcript_path,
        link.agentId,
      );
      if (childTranscriptPath) {
        await waitForTranscriptStable(childTranscriptPath, 0);
      }
      const childBuild = buildSubagentRecords({
        parentTranscriptPath: state.transcript_path,
        parentSessionId: sessionId,
        parentTraceId: pending.trace_id,
        parentTurnId: pending.turn_id,
        link,
        userId,
        cwd,
        intercept,
      });
      extendBackgroundAgentResult(records, link, childBuild.records);
      records.push(...cleanRecords(childBuild.records, runtimeConfig));
      for (const rid of childBuild.mergedResponseIds) mergedResponseIds.add(rid);
      link.completed = true;
      delete completedSubagents[link.agentId];
    }

    if (backgroundLinks.every((link) => link.completed)) {
      writeJsonlRecords(
        defaultLogDir(),
        AGENT_ID,
        sortRecordsByTimestamp(records),
      );
      state.finalized_subagent_ids = [
        ...(state.finalized_subagent_ids || []),
        ...backgroundLinks.map((link) => link.agentId),
      ].slice(-FINALIZED_SUBAGENT_LIMIT);
    } else {
      remainingTurns.push({
        ...pending,
        records,
        background_links: backgroundLinks,
      });
    }
  }

  state.pending_subagent_turns = remainingTurns;
  state.completed_subagents = completedSubagents;
  reapInterceptFiles(intercept, mergedResponseIds);
  reapStaleIntercept(sessionId);
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
    logHash = hash;
    if (turnMerged) {
      for (const rid of turnMerged) mergedResponseIds.add(rid);
    }

    const turnRecords = [...records];
    const backgroundLinks = [];
    const parentRecord = records[0];
    if (parentRecord) {
      // 只展开主会话的直接子 Agent。子 transcript 内再次调用 Agent 时，
      // buildTurnRecords 会保留 TOOL span，但不会递归读取孙级 transcript。
      for (const link of collectSubagentLinks(turn)) {
        const completion = state.completed_subagents?.[link.agentId];
        if (link.isBackground && !completion) {
          backgroundLinks.push({ ...link, completed: false });
          continue;
        }
        const childBuild = buildSubagentRecords({
          parentTranscriptPath: transcriptPath,
          parentSessionId: sessionId,
          parentTraceId: parentRecord.trace_id,
          parentTurnId: parentRecord['gen_ai.turn.id'],
          link,
          userId,
          cwd,
          intercept,
        });
        if (link.isBackground) {
          extendBackgroundAgentResult(turnRecords, link, childBuild.records);
        }
        turnRecords.push(...childBuild.records);
        for (const rid of childBuild.mergedResponseIds) mergedResponseIds.add(rid);
        if (completion) delete state.completed_subagents[link.agentId];
      }
    }

    sortRecordsByTimestamp(turnRecords);
    if (backgroundLinks.length > 0 && parentRecord) {
      state.pending_subagent_turns = state.pending_subagent_turns || [];
      state.pending_subagent_turns.push({
        created_at: nowSec(),
        trace_id: parentRecord.trace_id,
        turn_id: parentRecord['gen_ai.turn.id'],
        records: cleanRecords(turnRecords, runtimeConfig),
        background_links: backgroundLinks,
      });
    } else {
      allRecords.push(...turnRecords);
    }
  }

  // turn_count 计入全部 turns(含跳过的历史), 确保 offset 正确推进不重复上报
  state.turn_count = baseTurnCount + parseResult.turns.length;

  const cleaned = cleanRecords(allRecords, runtimeConfig);
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
  let firstStepOwner = null;

  for (const ev of llmCalls) {
    stepRound++;
    const currentStepId = `${turnId}:s${stepRound}`;
    const currentStepSpanId = generateSpanId();
    const llmSpanId = generateSpanId();
    const responseId = ev.message_id || `${currentStepId}:r`;
    if (!firstStepOwner) {
      firstStepOwner = { stepId: currentStepId, stepSpanId: currentStepSpanId };
    }

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

  const skillLoads = Array.isArray(turn.skillLoads) ? turn.skillLoads : [];
  const skillLoadsByToolId = new Map(
    skillLoads
      .filter((load) => load.sourceToolUseId)
      .map((load) => [load.sourceToolUseId, load]),
  );
  const consumedSkillLoads = new Set();

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

      const reservedContext = consumeToolContext(pilotDataDir(), sessionId, toolId);
      const toolSpanId = reservedContext?.spanId || generateSpanId();
      const skillLoad = toolName === 'Skill' ? skillLoadsByToolId.get(toolId) : null;
      const skillFields = toolName === 'Skill'
        ? skillAttributes(skillLoad, toolBlock.input?.skill || toolBlock.input?.name)
        : {};
      if (skillLoad) consumedSkillLoads.add(skillLoad);

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
        ...skillFields,
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
          ...skillFields,
        };
        if (timestamps.isError) {
          resultRecord['error.type'] = 'ToolError';
          resultRecord['error.message'] = typeof timestamps.resultContent === 'string'
            ? timestamps.resultContent.slice(0, 500)
            : 'tool execution failed';
        }
        records.push(resultRecord);
      }

    }
  }

  // /skill 和其他 runtime meta 注入没有 LLM tool_use。将加载事实建模成
  // extension TOOL span,但不篡改 LLM output.messages。
  if (firstStepOwner) {
    const synthesizedCallIds = new Set();
    for (const skillLoad of skillLoads) {
      if (consumedSkillLoads.has(skillLoad)) continue;
      const callId = deterministicSkillLoadId(
        sessionId,
        skillLoad.promptId || turn.promptId,
        skillLoad.metaUuid || skillLoad.metaTimestamp,
        skillLoad.rootPath,
      );
      if (synthesizedCallIds.has(callId)) continue;
      synthesizedCallIds.add(callId);

      const toolSpanId = generateSpanId();
      const skillFields = skillAttributes(skillLoad);
      const times = positiveSkillLoadTimes(
        skillLoad,
        llmCalls[0]?.request_start_time || llmCalls[0]?.timestamp,
      );
      records.push({
        time_unix_nano: times.call,
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: firstStepOwner.stepSpanId,
        'gen_ai.step.id': firstStepOwner.stepId,
        'gen_ai.tool.name': 'load_skill',
        'gen_ai.tool.type': 'extension',
        'gen_ai.tool.call.id': callId,
        'gen_ai.tool.call.arguments': toJsonValue({
          skill: skillLoad.name || skillLoad.id || 'unknown',
        }),
        ...skillFields,
      });
      records.push({
        time_unix_nano: times.result,
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.result',
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: firstStepOwner.stepSpanId,
        'gen_ai.step.id': firstStepOwner.stepId,
        'gen_ai.tool.name': 'load_skill',
        'gen_ai.tool.type': 'extension',
        'gen_ai.tool.call.id': callId,
        'gen_ai.tool.call.result': toJsonValue({ success: true }),
        'tool.result.status': 'success',
        ...skillFields,
      });
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
  'pre-tool-use': cmdPreToolUse,
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
    if (!emittedHookResponse) process.stdout.write('{}\n');
  });
} else {
  process.stdout.write('{}\n');
}

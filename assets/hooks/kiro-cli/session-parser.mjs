// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * session-parser.mjs — Kiro CLI interactive session (JSONL) parser.
 *
 * 数据源：~/.kiro/sessions/cli/
 *   - <session_id>.jsonl    v2 session store，交互式对话的完整事件流
 *   - <session_id>.json     sidecar 元数据（cwd / updated_at / turn 统计）
 *
 * 交互式对话（TUI 模式）只落 session JSONL，不进 SQLite conversations_v2。
 * 非交互式（hook subprocess 模式）只落 SQLite。双源互斥，session 级不双计。
 *
 * JSONL 每行格式: { version: "v1", kind, data }
 *   kind ∈ { Prompt, AssistantMessage, ToolResults }
 *
 * 工具名归一化（parser 边界做，不让 processor 改）:
 *   read    → fs_read
 *   shell   → execute_bash
 *   write   → fs_write
 *   未知工具 → pass-through + logHookError 告警
 *
 * 时间精度：JSONL 无 per-request ms 时间戳，使用 sidecar 的
 *   turn_duration + end_timestamp 在 turn 内均分各 request，
 *   标注 kiro.time_precision = 'turn_estimate'。
 *
 * ID 策略：session JSONL 无 request_id，step.id 使用 AssistantMessage.message_id，
 *   标注 kiro.id_source = 'session_jsonl'。
 *
 * 增量游标：sidecar .json 的 updated_at（ISO ms 精度）作 offset，
 *   与 SQLite offset 同语义但独立文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { logHookError } from '../shared/error-logger.mjs';

// ─── 工具名映射（数据驱动，const map）───

const TOOL_NAME_MAP = Object.freeze({
  read: 'fs_read',
  shell: 'execute_bash',
  write: 'fs_write',
});

function mapToolName(rawName) {
  if (!rawName || typeof rawName !== 'string') return 'unknown';
  const mapped = TOOL_NAME_MAP[rawName];
  if (mapped) return mapped;
  if (TOOL_NAME_MAP.hasOwnProperty(rawName)) return mapped;
  // 未知工具：pass-through + 告警
  logHookError({
    agentId: 'kiro-cli',
    stage: 'session_parser',
    errorType: 'unknown_tool_name',
    errorMessage: `unknown Kiro CLI tool name: ${rawName} (pass-through)`,
  });
  return rawName;
}

// ─── 辅助函数 ───

function isoToMs(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function turnDurationToMs(td) {
  if (!td || typeof td !== 'object') return 0;
  const secs = typeof td.secs === 'number' ? td.secs : 0;
  const nanos = typeof td.nanos === 'number' ? td.nanos : 0;
  return secs * 1000 + Math.floor(nanos / 1_000_000);
}

function resolveSessionDir() {
  if (process.env.KIRO_SESSIONS_DIR) {
    return process.env.KIRO_SESSIONS_DIR;
  }
  return path.join(os.homedir(), '.kiro', 'sessions', 'cli');
}

// ─── JSONL 条目解析 ───

function extractPromptText(content) {
  if (!Array.isArray(content)) return '';
  const textItem = content.find((c) => c && c.kind === 'text');
  return textItem && typeof textItem.data === 'string' ? textItem.data : '';
}

function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c && c.kind === 'toolUse' && c.data)
    .map((c) => ({
      toolUseId: typeof c.data.toolUseId === 'string' ? c.data.toolUseId : '',
      rawName: typeof c.data.name === 'string' ? c.data.name : 'unknown',
      name: mapToolName(typeof c.data.name === 'string' ? c.data.name : ''),
      input: c.data.input ?? {},
    }))
    .filter((t) => t.toolUseId);
}

function extractAssistantText(content) {
  if (!Array.isArray(content)) return '';
  const textItem = content.find((c) => c && c.kind === 'text' && c.data);
  return typeof textItem?.data === 'string' ? textItem.data : '';
}

/**
 * 从 ToolResults.content[] 提取工具结果文本。
 */
function extractToolResultContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || item.kind !== 'toolResult' || !item.data) continue;
    const inner = item.data.content;
    if (!Array.isArray(inner)) continue;
    for (const c of inner) {
      if (!c) continue;
      if (c.kind === 'text' && typeof c.data === 'string') {
        parts.push(c.data);
      } else if (c.kind === 'json' && c.data && typeof c.data === 'object') {
        parts.push(JSON.stringify(c.data));
      }
    }
  }
  return parts.join('\n');
}

// ─── Turn 构建 ───

/**
 * 将 flat JSONL entries 按 Prompt 边界切分成 turns。
 * 每个 turn 对应 sidecar 中一个 user_turn_metadatas 条目。
 *
 * @param {Array} entries JSONL 条目数组
 * @param {Array} sidecarTurns sidecar.user_turn_metadatas
 * @returns {Array} turns
 */
function buildTurnData(entries, sidecarTurns) {
  const turns = [];
  let currentTurn = null;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { kind, data } = entry;
    if (!data || typeof data !== 'object') continue;

    if (kind === 'Prompt') {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = {
        promptMessageId: typeof data.message_id === 'string' ? data.message_id : '',
        promptText: extractPromptText(data.content),
        promptTimestampMs:
          typeof data.meta?.timestamp === 'number' ? data.meta.timestamp * 1000 : 0,
        assistantMessages: [],
        toolResults: new Map(),
        sidecar: null,
      };
    } else if (kind === 'AssistantMessage' && currentTurn) {
      currentTurn.assistantMessages.push({
        messageId: typeof data.message_id === 'string' ? data.message_id : '',
        toolUses: extractToolUses(data.content),
        text: extractAssistantText(data.content),
      });
    } else if (kind === 'ToolResults' && currentTurn) {
      const results = Array.isArray(data.content) ? data.content : [];
      for (const item of results) {
        if (!item || item.kind !== 'toolResult' || !item.data) continue;
        currentTurn.toolResults.set(item.data.toolUseId, {
          content: item.data.content,
          status: typeof item.data.status === 'string' ? item.data.status : 'success',
          resultText: extractToolResultContent([item]),
        });
      }
    }
  }

  if (currentTurn) turns.push(currentTurn);

  // 对齐 sidecar turn metadata
  for (let i = 0; i < turns.length; i++) {
    turns[i].sidecar = sidecarTurns && i < sidecarTurns.length ? sidecarTurns[i] : null;
  }

  return turns;
}

/**
 * 在一个 turn 内，将 request_start/end 按 total_request_count 均分。
 * 保证各 request 的 start/end 互不相同（无 0ms span）。
 *
 * @param {number} turnStartMs turn 起始时间（ms）
 * @param {number} turnEndMs   turn 结束时间（ms）
 * @param {number} n           request 数量
 * @returns {Array<{startMs: number, endMs: number}>}
 */
function distributeRequestTimes(turnStartMs, turnEndMs, n) {
  if (n <= 0) return [];
  if (n === 1) return [{ startMs: turnStartMs, endMs: turnEndMs }];

  const totalMs = Math.max(1, turnEndMs - turnStartMs);
  const spanMs = Math.max(1, Math.floor(totalMs / n));

  return Array.from({ length: n }, (_, i) => ({
    startMs: turnStartMs + i * spanMs,
    endMs: Math.min(turnStartMs + (i + 1) * spanMs, turnEndMs),
  }));
}

/**
 * 将 turns 转成 StepInfo[]（与 transcript-parser.mjs 同构）。
 * 每个 AssistantMessage = 一个 STEP = 一个 LLM 调用。
 */
function buildStepsFromTurns(turns) {
  const steps = [];
  let globalIndex = 0;

  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti];
    const sc = turn.sidecar;

    const turnStartMs = turn.promptTimestampMs;
    const turnEndMs = sc?.end_timestamp ? isoToMs(sc.end_timestamp) : turnStartMs;
    const requestCount =
      sc?.total_request_count && sc.total_request_count > 0
        ? sc.total_request_count
        : turn.assistantMessages.length;
    const times = distributeRequestTimes(turnStartMs, turnEndMs, requestCount);

    // 第一条 assistant 消息带 turn 的 userPrompt
    let firstInTurn = true;

    for (let ai = 0; ai < turn.assistantMessages.length; ai++) {
      const am = turn.assistantMessages[ai];
      if (!am.messageId) continue;

      const hasTools = am.toolUses.length > 0;
      const timeInfo = times[Math.min(ai, times.length - 1)] || {
        startMs: turnStartMs,
        endMs: turnEndMs,
      };

      const toolResultsMap = new Map();
      if (hasTools) {
        for (const tu of am.toolUses) {
          const tr = turn.toolResults.get(tu.toolUseId);
          if (tr) toolResultsMap.set(tu.toolUseId, tr);
        }
      }

      steps.push({
        index: globalIndex++,
        stepId: am.messageId,
        responseId: am.messageId,
        kind: hasTools ? 'ToolUse' : 'NotToolUse',
        modelId: 'auto',
        startTimeMs: timeInfo.startMs,
        endTimeMs: timeInfo.endMs,
        tools: hasTools
          ? am.toolUses.map((tu) => ({
              id: tu.toolUseId,
              name: tu.name,
              args: tu.input,
              rawName: tu.rawName,
            }))
          : [],
        assistantText: hasTools ? '' : am.text,
        userPrompt: firstInTurn ? turn.promptText : '',
        creditIndex: ti,
        turnIndex: ti,
        timePrecision: 'turn_estimate',
        idSource: 'session_jsonl',
        toolResultsMap,
      });

      firstInTurn = false;
    }
  }

  steps.sort((a, b) => a.startTimeMs - b.startTimeMs);
  return steps;
}

// ─── 导出（纯解析，供测试）───

/** @visibleForTesting 解析 JSONL 文本为条目数组 */
export function parseSessionEntries(jsonlContent) {
  const entries = [];
  const lines = String(jsonlContent || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/** @visibleForTesting 从条目 + sidecar turns 构建 StepInfo[] */
export function buildStepsFromEntries(entries, sidecarTurns) {
  const turns = buildTurnData(entries, sidecarTurns);
  return buildStepsFromTurns(turns);
}

// ─── 主入口 ───

/**
 * 读取指定 cwd 的最新交互式 session（JSONL）。
 *
 * @param {string} cwd  hook cwd（对应 sidecar 的 cwd 字段）
 * @param {object} [opts]
 * @param {string} [opts.sessionDir]     显式 session 目录（默认 ~/.kiro/sessions/cli/）
 * @param {number} [opts.sinceUpdatedMs] 仅取 updated_at > 此值的 sidecar；默认 0
 * @returns {TranscriptData|null}
 */
export function readSessionForCwd(cwd, opts = {}) {
  if (!cwd) return null;
  const sessionDir = opts.sessionDir || resolveSessionDir();
  const sinceMs = typeof opts.sinceUpdatedMs === 'number' ? opts.sinceUpdatedMs : 0;

  if (!fs.existsSync(sessionDir)) return null;

  let sidecarFiles;
  try {
    sidecarFiles = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }

  let bestSidecar = null;
  let bestUpdatedMs = 0;
  let bestSessionId = '';

  for (const file of sidecarFiles) {
    let sc;
    try {
      sc = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf-8'));
    } catch {
      continue;
    }
    if (!sc || typeof sc !== 'object') continue;
    if (!sc.session_id || !sc.cwd) continue;

    const updatedMs = sc.updated_at ? isoToMs(sc.updated_at) : 0;
    if (updatedMs <= sinceMs) continue;
    if (sc.cwd !== cwd) continue;
    if (updatedMs <= bestUpdatedMs) continue;

    bestSidecar = sc;
    bestUpdatedMs = updatedMs;
    bestSessionId = sc.session_id;
  }

  if (!bestSidecar) return null;

  const jsonlPath = path.join(sessionDir, `${bestSessionId}.jsonl`);
  let entries;
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    entries = parseSessionEntries(content);
  } catch {
    return null;
  }

  if (entries.length === 0) return null;

  const utm = bestSidecar.session_state?.conversation_metadata?.user_turn_metadatas || [];
  const turns = buildTurnData(entries, utm);
  if (turns.length === 0) return null;

  const steps = buildStepsFromTurns(turns);
  if (steps.length === 0) return null;

  const credits = [];
  for (const turn of turns) {
    const mu = turn.sidecar?.metering_usage;
    if (Array.isArray(mu) && mu.length > 0 && typeof mu[0]?.value === 'number') {
      credits.push(mu[0].value);
    } else {
      credits.push(undefined);
    }
  }

  const modelId =
    bestSidecar.session_state?.rts_model_state?.model_info?.model_id || 'auto';

  return {
    conversationId: bestSessionId,
    continuationId: '',
    modelId,
    steps,
    credits,
    updatedMs: bestUpdatedMs,
    source: 'session_jsonl',
  };
}

/**
 * 解析 Kiro CLI sessions 目录。
 * @returns {string}
 */
export { resolveSessionDir };

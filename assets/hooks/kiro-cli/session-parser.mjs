// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * session-parser.mjs — Kiro CLI session JSONL 解析。
 *
 * 数据源：~/.kiro/sessions/cli/<session_id>.jsonl + <session_id>.json（sidecar）
 *
 * 当 SQLite transcript 不可用时（交互式 session），从 session JSONL 解析 steps。
 *
 * JSONL 行格式（version: v1）：
 *   kind: "Prompt"           → 用户原始输入
 *   kind: "AssistantMessage" → LLM 输出（text / toolUse）
 *   kind: "ToolResults"      → 工具执行结果
 *
 * Sidecar 格式：
 *   session_id, cwd, session_state.conversation_metadata.user_turn_metadatas[]
 *   session_state.rts_model_state.model_info.model_id
 *
 * fixture 来源: researcher 调研报告中的真实 session JSONL (kiro-cli v2.8.0)
 */

import fs from 'node:fs';
import path from 'node:path';

const TOOL_NAME_MAP = {
  read: 'fs_read',
  write: 'fs_write',
  shell: 'execute_bash',
  execute_bash: 'execute_bash',
  fs_read: 'fs_read',
  fs_write: 'fs_write',
};

function mapToolName(name) {
  if (!name) return 'unknown';
  return TOOL_NAME_MAP[name] || name;
}

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value, fallback = '') {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * 从 session JSONL 行数组中提取 steps。
 *
 * 每个 AssistantMessage 对应一个 step：
 *   - 包含 toolUse → ToolUse step
 *   - 仅 text → NotToolUse step（最终回答）
 *
 * @param {Array<object>} lines  解析后的 JSONL 行
 * @param {object} sidecar       sidecar JSON 解析后的对象
 * @returns {{ steps: import('./transcript-parser.mjs').StepInfo[], conversationId: string, continuationId: string, modelId: string, credits: number[] }}
 */
/**
 * 从 ToolResults 行的 content 中提取 toolUseId → resultText 映射。
 */
function extractToolResultMap(toolResultsLine) {
  const map = new Map();
  if (!toolResultsLine || typeof toolResultsLine !== 'object') return map;
  const contentArr = Array.isArray(toolResultsLine.data?.content) ? toolResultsLine.data.content : [];
  for (const entry of contentArr) {
    if (entry?.kind !== 'toolResult' || !entry.data) continue;
    const toolUseId = entry.data.toolUseId;
    if (!toolUseId) continue;
    const innerContent = Array.isArray(entry.data.content) ? entry.data.content : [];
    const texts = [];
    for (const c of innerContent) {
      if (c?.kind === 'text' && typeof c.data === 'string') {
        texts.push(c.data);
      } else if (c?.kind === 'json' && c.data) {
        texts.push(typeof c.data === 'string' ? c.data : JSON.stringify(c.data));
      }
    }
    map.set(toolUseId, texts.join('\n'));
  }
  return map;
}

export function parseSessionLines(lines, sidecar) {
  const sessionId = str(sidecar?.session_id);
  const modelState = sidecar?.session_state?.rts_model_state || {};
  const conversationId = str(modelState?.conversation_id, sessionId);
  const modelId = str(modelState?.model_info?.model_id, 'auto');
  const continuationId = conversationId;

  const turnMetadatas =
    sidecar?.session_state?.conversation_metadata?.user_turn_metadatas || [];

  const credits = [];
  const turnDurations = [];
  const turnEndTimestamps = [];
  for (const tm of turnMetadatas) {
    const usage = Array.isArray(tm?.metering_usage) ? tm.metering_usage : [];
    for (const u of usage) {
      if (u?.unit === 'credit' || u?.unitPlural === 'credits') {
        credits.push(num(u?.value));
      }
    }
    const dur = tm?.turn_duration;
    turnDurations.push({
      secs: num(dur?.secs),
      nanos: num(dur?.nanos),
    });
    const endTs = tm?.end_timestamp;
    if (typeof endTs === 'string') {
      turnEndTimestamps.push(Date.parse(endTs));
    } else {
      turnEndTimestamps.push(0);
    }
  }

  const steps = [];
  let currentPrompt = '';
  let assistantIndex = 0;
  let toolResultIndex = 0;
  const toolResultMap = new Map();

  const totalDurationMs = turnDurations.reduce(
    (sum, d) => sum + d.secs * 1000 + d.nanos / 1e6,
    0,
  );
  const totalRequests = lines.filter(
    (l) => l?.kind === 'AssistantMessage',
  ).length;

  let baseTimeMs = 0;
  if (turnEndTimestamps.length > 0 && turnEndTimestamps[0] > 0 && totalDurationMs > 0) {
    baseTimeMs = turnEndTimestamps[0] - totalDurationMs;
  }

  const timePerRequest = totalRequests > 0 ? totalDurationMs / totalRequests : 0;

  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const kind = line.kind;
    const data = line.data || {};

    if (kind === 'Prompt') {
      const contentArr = Array.isArray(data.content) ? data.content : [];
      for (const c of contentArr) {
        if (c?.kind === 'text' && typeof c.data === 'string') {
          currentPrompt = c.data;
        }
      }
      continue;
    }

    if (kind === 'AssistantMessage') {
      const messageId = str(data.message_id);
      const contentArr = Array.isArray(data.content) ? data.content : [];

      const toolUses = [];
      let textContent = '';

      for (const c of contentArr) {
        if (c?.kind === 'toolUse' && c.data) {
          const td = c.data;
          toolUses.push({
            id: str(td.toolUseId),
            name: mapToolName(str(td.name)),
            args: td.input ?? {},
          });
        } else if (c?.kind === 'text' && typeof c.data === 'string') {
          textContent += c.data;
        }
      }

      const isToolUse = toolUses.length > 0;
      const startTimeMs = baseTimeMs + assistantIndex * timePerRequest;
      const endTimeMs = startTimeMs + timePerRequest;

      steps.push({
        index: assistantIndex,
        stepId: messageId,
        responseId: messageId,
        kind: isToolUse ? 'ToolUse' : 'NotToolUse',
        modelId,
        startTimeMs,
        endTimeMs,
        tools: isToolUse
          ? toolUses.filter((t) => t.id)
          : [],
        assistantText: isToolUse ? '' : textContent,
        userPrompt: assistantIndex === 0 ? currentPrompt : '',
        toolUseResults: [],
        creditIndex: assistantIndex < credits.length ? assistantIndex : -1,
      });

      assistantIndex++;
      continue;
    }

    if (kind === 'ToolResults') {
      const resultMap = extractToolResultMap(line);
      for (const [toolUseId, resultText] of resultMap) {
        toolResultMap.set(toolUseId, resultText);
      }
      toolResultIndex++;
    }
  }

  // Map tool results onto subsequent steps as toolUseResults.
  // For step N (N > 0), the tool results from step N-1's tools form the
  // input messages (role: "tool") for step N — matching the transcript-parser
  // behavior where each history entry's user.content.ToolUseResults provides
  // the prior step's tool outputs.
  for (let i = 1; i < steps.length; i++) {
    const prevStep = steps[i - 1];
    if (!prevStep.tools || prevStep.tools.length === 0) continue;
    const results = [];
    for (const tool of prevStep.tools) {
      if (!tool.id) continue;
      const result = toolResultMap.get(tool.id);
      if (result !== undefined) {
        results.push(result);
      }
    }
    steps[i].toolUseResults = results;
  }

  return { steps, conversationId, continuationId, modelId, credits, toolResultMap };
}

/**
 * 根据 cwd 在 ~/.kiro/sessions/cli/ 中找到匹配的 session 文件并解析。
 *
 * 匹配策略：
 *   1. 扫描 *.json sidecar，找 cwd 匹配的最新 session
 *   2. 读对应 *.jsonl 解析 steps
 *
 * @param {string} cwd           hook cwd
 * @param {object} [opts]
 * @param {string} [opts.sessionDir]  显式 session 目录（默认 ~/.kiro/sessions/cli）
 * @param {number} [opts.sinceUpdatedMs]  仅取 updated_at > 此值
 * @returns {Promise<import('./transcript-parser.mjs').TranscriptData|null>}
 */
export async function readSessionJsonl(cwd, opts = {}) {
  if (!cwd) return null;

  const sessionDir =
    opts.sessionDir || path.join(process.env.HOME || '~', '.kiro', 'sessions', 'cli');

  if (!fs.existsSync(sessionDir)) return null;

  let sidecarFiles;
  try {
    sidecarFiles = fs
      .readdirSync(sessionDir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.history'))
      .map((f) => path.join(sessionDir, f));
  } catch {
    return null;
  }

  const candidates = [];
  for (const sidecarPath of sidecarFiles) {
    let sidecar;
    try {
      sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    } catch {
      continue;
    }
    if (sidecar.cwd !== cwd) continue;
    const sid = sidecar.session_id;
    if (!sid) continue;

    const updatedAt = sidecar.updated_at ? Date.parse(sidecar.updated_at) : 0;

    candidates.push({ sidecar, sid, updatedAt, sidecarPath });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  const best = candidates[0];

  const jsonlPath = path.join(sessionDir, `${best.sid}.jsonl`);
  if (!fs.existsSync(jsonlPath)) return null;

  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }

  if (lines.length === 0) return null;

  const parsed = parseSessionLines(lines, best.sidecar);
  if (parsed.steps.length === 0) return null;

  return {
    conversationId: parsed.conversationId,
    continuationId: parsed.continuationId,
    modelId: parsed.modelId,
    steps: parsed.steps,
    credits: parsed.credits,
    updatedMs: best.updatedAt,
    sessionId: best.sid,
    source: 'session_jsonl',
    toolResultMap: parsed.toolResultMap || new Map(),
  };
}

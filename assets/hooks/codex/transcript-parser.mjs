// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-parser.mjs — Codex rollout transcript JSONL 解析。
 *
 * 移植自 codex-plugin .../src/transcript.ts,改 ESM + JSDoc 类型。
 *
 * Codex 在 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 持久化全 session 事件,跨 turn 累加。
 * Stop hook 触发时:
 *   - parseTranscript(path, byteOffset, lastEmittedUsage) 增量读取
 *   - 按 task_started / turn_context 中的 turn_id 把 token_count 事件分桶到 tokenEventsByTurn
 *   - 跨 turn 心跳去重(codex 在 turn 间会重发同一份 last_token_usage)
 *
 * 关键 bug fix(均已保留):
 *   9.6 system_instructions / tool.definitions 提取
 *   9.9 byteOffset 增量 + turn_id 关联 + 心跳去重 + total_tokens 用源值
 */

import fs from 'node:fs';

/**
 * @typedef {object} TokenUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cachedInputTokens
 * @property {number} reasoningOutputTokens
 * @property {number} totalTokens
 */

/**
 * @typedef {object} TranscriptData
 * @property {string} model
 * @property {string} modelProvider
 * @property {TokenUsage[]} tokenEvents 扁平视图(按 transcript 顺序),fallback 用
 * @property {Map<string, TokenUsage[]>} tokenEventsByTurn 按 turn_id 分组(主消费路径)
 * @property {TokenUsage|null} totalUsage
 * @property {Array<{type:string, content:string}>=} systemInstruction
 * @property {Array<{type:string, name:string, description:string|null, parameters:any}>=} toolDefinitions
 * @property {number} nextOffset 增量读取的下一个字节偏移
 * @property {TokenUsage|null} lastEmittedUsage 跨调用心跳去重锚点
 */

function mapDynamicTool(t) {
  const rawName = typeof t.name === 'string' ? t.name : '';
  if (!rawName) return null;
  const ns = typeof t.namespace === 'string' ? t.namespace : '';
  return {
    type: 'function',
    name: ns ? `${ns}/${rawName}` : rawName,
    description: typeof t.description === 'string' ? t.description : null,
    parameters: t.inputSchema ?? {},
  };
}

function parseTokenUsage(raw) {
  return {
    inputTokens: Number(raw['input_tokens'] || 0),
    outputTokens: Number(raw['output_tokens'] || 0),
    cachedInputTokens: Number(raw['cached_input_tokens'] || 0),
    reasoningOutputTokens: Number(raw['reasoning_output_tokens'] || 0),
    totalTokens: Number(raw['total_tokens'] || 0),
  };
}

/**
 * 跨 turn 心跳去重:codex 在 turn 间隙会重发与上一次相同的 last_token_usage 事件,
 * 只看四个数值字段就能识别。
 */
function tokenUsageEqual(a, b) {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.reasoningOutputTokens === b.reasoningOutputTokens &&
    a.totalTokens === b.totalTokens
  );
}

/**
 * 解析 codex transcript(rollout-*.jsonl)。
 *
 * @param {string} transcriptPath transcript 文件绝对路径
 * @param {number} [byteOffset=0] 起始字节偏移(>0 时增量读)
 * @param {TokenUsage|null} [initialLastUsage=null] 上次已采纳的 last_token_usage(跨调用去重锚点)
 * @returns {TranscriptData|null}
 */
export function parseTranscript(transcriptPath, byteOffset = 0, initialLastUsage = null) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  let content;
  let fileSize;
  try {
    const stat = fs.statSync(transcriptPath);
    fileSize = stat.size;

    if (byteOffset >= fileSize) {
      return {
        model: 'unknown',
        modelProvider: 'openai',
        tokenEvents: [],
        tokenEventsByTurn: new Map(),
        totalUsage: null,
        nextOffset: byteOffset,
        lastEmittedUsage: initialLastUsage,
      };
    }

    const readFrom = Math.max(byteOffset, 0);
    if (readFrom > 0) {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const readLen = fileSize - readFrom;
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, readFrom);
        content = buf.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(transcriptPath, 'utf-8');
    }
  } catch {
    return null;
  }

  let model = 'unknown';
  let modelProvider = 'openai';
  /** @type {TokenUsage[]} */
  const tokenEvents = [];
  /** @type {Map<string, TokenUsage[]>} */
  const tokenEventsByTurn = new Map();
  /** @type {TokenUsage|null} */
  let lastTotalUsage = null;
  let baseInstructionsText = '';
  let lastDeveloperInstructions = '';
  /** @type {Array<ReturnType<typeof mapDynamicTool>>} */
  const toolDefs = [];

  // 当前正在处理的 turn_id;由 task_started / turn_context 设置
  let currentTurnId = null;

  // 跨 turn 心跳去重锚点;由调用方从 state.transcript_last_token_usage 传入
  let lastEmittedUsage = initialLastUsage;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const entryType = entry.type;
    const payload = entry.payload;
    if (!payload || typeof payload !== 'object') continue;

    if (entryType === 'session_meta') {
      if (typeof payload.model_provider === 'string' && payload.model_provider) {
        modelProvider = payload.model_provider;
      }

      const bi = payload.base_instructions;
      if (bi && typeof bi === 'object') {
        if (typeof bi.text === 'string' && bi.text) baseInstructionsText = bi.text;
      } else if (typeof bi === 'string' && bi) {
        baseInstructionsText = bi;
      }

      if (Array.isArray(payload.dynamic_tools)) {
        for (const t of payload.dynamic_tools) {
          if (!t || typeof t !== 'object') continue;
          const mapped = mapDynamicTool(t);
          if (mapped) toolDefs.push(mapped);
        }
      }
    } else if (entryType === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) model = payload.model;
      if (typeof payload.developer_instructions === 'string' && payload.developer_instructions) {
        lastDeveloperInstructions = payload.developer_instructions;
      }
      if (typeof payload.turn_id === 'string' && payload.turn_id) {
        currentTurnId = payload.turn_id;
      }
    } else if (entryType === 'event_msg') {
      const payloadType = payload.type;

      if (payloadType === 'task_started') {
        if (typeof payload.turn_id === 'string' && payload.turn_id) {
          currentTurnId = payload.turn_id;
        }
        continue;
      }

      if (payloadType === 'token_count') {
        const info = payload.info;
        if (!info || typeof info !== 'object') continue;

        if (info.last_token_usage && typeof info.last_token_usage === 'object') {
          const usage = parseTokenUsage(info.last_token_usage);
          // 跨 turn 全局去重:与上一次已采纳值相同 → 心跳事件,跳过
          if (lastEmittedUsage && tokenUsageEqual(lastEmittedUsage, usage)) {
            // skip heartbeat
          } else {
            const tid = currentTurnId ?? '';
            tokenEvents.push(usage);
            const list = tokenEventsByTurn.get(tid);
            if (list) {
              list.push(usage);
            } else {
              tokenEventsByTurn.set(tid, [usage]);
            }
            lastEmittedUsage = usage;
          }
        }

        if (info.total_token_usage && typeof info.total_token_usage === 'object') {
          lastTotalUsage = parseTokenUsage(info.total_token_usage);
        }
      }
    }
  }

  /** @type {Array<{type:string, content:string}>} */
  const systemInstruction = [];
  if (baseInstructionsText) {
    systemInstruction.push({ type: 'text', content: baseInstructionsText });
  }
  if (lastDeveloperInstructions) {
    systemInstruction.push({ type: 'text', content: lastDeveloperInstructions });
  }

  const hasContent =
    tokenEvents.length > 0 ||
    !!lastTotalUsage ||
    systemInstruction.length > 0 ||
    toolDefs.length > 0;

  if (!hasContent) {
    return {
      model,
      modelProvider,
      tokenEvents: [],
      tokenEventsByTurn: new Map(),
      totalUsage: null,
      nextOffset: fileSize,
      lastEmittedUsage,
    };
  }

  return {
    model,
    modelProvider,
    tokenEvents,
    tokenEventsByTurn,
    totalUsage: lastTotalUsage,
    systemInstruction: systemInstruction.length > 0 ? systemInstruction : undefined,
    toolDefinitions: toolDefs.length > 0 ? toolDefs : undefined,
    nextOffset: fileSize,
    lastEmittedUsage,
  };
}

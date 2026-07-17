// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-parser.mjs — Grok Build chat_history.jsonl 解析。
 *
 * Grok Build 在 ~/.grok/sessions/<enc-cwd>/<sid>/chat_history.jsonl 持久化对话历史。
 * 记录格式支持两种形态:
 *   - Anthropic-style(早期 grok 版本): assistant.content 为 content block 数组,含 {type:"tool_use",id,name,input};
 *     tool_result 作为 user.content 内 block {type:"tool_result",tool_use_id,...}。
 *   - OpenAI-style(grok 0.2.x 真实 fixture): assistant.content 为字符串(可能为空)+ 顶层字段 tool_calls:[{id,name,arguments}];
 *     tool_result 为顶层 record {type:"tool_result",tool_call_id,content},id 常为空串。
 *     arguments 为 JSON 字符串。reasoning record {type:"reasoning",id,summary:[...]} 跳过。
 *
 * 设计:
 *   - 时间戳: grok chat_history 记录本身不携带 timestamp(不在 record.timestamp 字段);
 *     用 hook envelope.timestamp(由 cmdStop 传入)作 fallback。若 record 自带 timestamp(新版本)优先使用。
 *   - turn 切分: 用 user record 的 prompt_index 字段(类比 Claude 的 promptId);
 *     无 prompt_index 的 user record 视为系统注入(synthetic_reason != null 或 user_info/system-reminder)。
 *   - LLM 调用分组: grok chat_history 不携带 message.id;每条 assistant record 视为一次 LLM 调用。
 *   - tool_use_id 归属: 通过 tool_use.id 从声明方 assistant record 匹配到 step。
 *   - 空 id 兜底: grok 0.2.x 真实 fixture 中 tool_call.id 与 tool_result.tool_call_id 均为空串,
 *     生成合成 id (`name_<assistantSeq>_<idxInAssistant>`),通过 FIFO 队列把空 id 的 tool_result
 *     按到达顺序回填到下一个未匹配的合成 id。
 *
 * 增量约定:
 *   parseGrokTranscript(path, byteOffset) 返回 { turns, nextOffset }
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
const MISSING_PROMPT_INDEX = '__missing_prompt_index__';

function parseTimestampMs(ts) {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function laterTimestamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const aMs = parseTimestampMs(a);
  const bMs = parseTimestampMs(b);
  if (aMs === null) return b;
  if (bMs === null) return a;
  return bMs > aMs ? b : a;
}

function normalizeRequestStart(candidate, responseTs) {
  if (!candidate) return responseTs || null;
  const candidateMs = parseTimestampMs(candidate);
  const responseMs = parseTimestampMs(responseTs);
  if (candidateMs !== null && responseMs !== null && candidateMs > responseMs) {
    return responseTs;
  }
  return candidate;
}

function isSyntheticUserRecord(record) {
  return record?.synthetic_reason != null;
}

function isToolResultContent(content) {
  return Array.isArray(content) &&
    content.every((p) => p && p.type === 'tool_result');
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') parts.push(block);
    else if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

function extractUserPromptText(content) {
  const text = extractTextContent(content);
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return m ? m[1].trim() : text;
}

function shouldSkipUserRecord(record) {
  if (isSyntheticUserRecord(record)) return true;
  if (Array.isArray(record.content) && record.content.some((p) => p && p.type === 'tool_result')) {
    return false;
  }
  const text = extractTextContent(record.content);
  if (!text) return true;
  return text.startsWith('<user_info>') || text.startsWith('<system-reminder>');
}

/**
 * @param {string} transcriptPath chat_history.jsonl 路径
 * @param {number} byteOffset 增量读取起点(字节偏移)
 * @returns {{ turns: Array, nextOffset: number }}
 */
export function parseGrokTranscript(transcriptPath, byteOffset = 0) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { turns: [], nextOffset: byteOffset };
  }

  let content;
  let fileSize;
  try {
    const stat = fs.statSync(transcriptPath);
    fileSize = stat.size;
    if (byteOffset >= fileSize) {
      return { turns: [], nextOffset: byteOffset };
    }

    const readFrom = Math.max(byteOffset, 0);
    const readLen = fileSize - readFrom;

    if (readLen > MAX_TRANSCRIPT_BYTES) {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const tailOffset = fileSize - MAX_TRANSCRIPT_BYTES;
        const actualOffset = Math.max(tailOffset, readFrom);
        const actualLen = fileSize - actualOffset;
        const buf = Buffer.alloc(actualLen);
        fs.readSync(fd, buf, 0, actualLen, actualOffset);
        content = buf.toString('utf-8');
        if (actualOffset > readFrom) {
          const firstNewline = content.indexOf('\n');
          if (firstNewline >= 0) content = content.slice(firstNewline + 1);
        }
      } finally {
        fs.closeSync(fd);
      }
    } else if (readFrom > 0) {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
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
    return { turns: [], nextOffset: byteOffset };
  }

  const conversationRecords = [];
  const toolResultTimestamps = new Map();
  const toolResultContents = new Map();
  const toolResultErrors = new Map();
  const pendingEmptyToolCallIds = [];
  let currentPromptIndex = null;
  let assistantSeq = 0;

  let assistantSeen = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const recordType = record.type;
    if (!recordType) continue;

    if (recordType === 'system') {
      conversationRecords.push({
        type: 'system',
        content: typeof record.content === 'string' ? record.content : extractTextContent(record.content),
        timestamp: record.timestamp || null,
      });
      continue;
    }

    if (recordType === 'user') {
      const recordTs = record.timestamp || null;
      const promptIndex = record.prompt_index != null ? String(record.prompt_index) : null;
      if (promptIndex) currentPromptIndex = promptIndex;

      const userContent = record.content;
      if (Array.isArray(userContent)) {
        for (const part of userContent) {
          if (part && part.type === 'tool_result' && part.tool_use_id) {
            if (recordTs) toolResultTimestamps.set(part.tool_use_id, recordTs);
            const resultContent = part.content ?? part.output ?? part.result ?? '';
            toolResultContents.set(part.tool_use_id, resultContent);
            if (part.is_error) toolResultErrors.set(part.tool_use_id, true);
          }
        }
      }

      conversationRecords.push({
        type: 'user',
        content: userContent,
        timestamp: recordTs,
        promptIndex: currentPromptIndex,
        synthetic: isSyntheticUserRecord(record),
        skipFromHistory: shouldSkipUserRecord(record),
      });
      continue;
    }

    if (recordType === 'assistant') {
      assistantSeen = true;
      assistantSeq++;
      const msgId = record.message_id || record.id || `_syn_${crypto.randomUUID()}`;
      const recordTs = record.timestamp || null;
      const contentBlocks = buildAssistantContentBlocks(record, assistantSeq, pendingEmptyToolCallIds);

      conversationRecords.push({
        type: 'assistant',
        msgId,
        content: contentBlocks,
        timestamp: recordTs,
        model: record.model_id || record.model || null,
        usage: record.usage || null,
        stop_reason: record.stop_reason || 'end_turn',
        promptIndex: currentPromptIndex,
        toolUseTimestamps: extractToolUseTimestamps(contentBlocks, recordTs),
      });
      continue;
    }

    if (recordType === 'tool_result') {
      const recordTs = record.timestamp || null;
      let toolId = record.tool_call_id || record.tool_use_id || '';
      if (!toolId) {
        toolId = pendingEmptyToolCallIds.shift() || `_orphan_${crypto.randomUUID()}`;
      }
      const resultContent = record.content ?? record.output ?? record.result ?? '';
      if (recordTs) toolResultTimestamps.set(toolId, recordTs);
      toolResultContents.set(toolId, resultContent);
      if (record.is_error) toolResultErrors.set(toolId, true);

      conversationRecords.push({
        type: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolId, content: resultContent, is_error: !!record.is_error }],
        timestamp: recordTs,
        promptIndex: currentPromptIndex,
        synthetic: false,
        skipFromHistory: false,
      });
      continue;
    }
  }

  if (!assistantSeen) {
    return { turns: [], nextOffset: fileSize };
  }

  const llmCalls = buildLlmCalls(conversationRecords, toolResultTimestamps, toolResultContents, toolResultErrors);
  const turns = splitIntoTurns(conversationRecords, llmCalls);
  return { turns, nextOffset: fileSize };
}

function extractToolUseTimestamps(content, fallbackTs) {
  const out = new Map();
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block && block.type === 'tool_use' && block.id) {
      out.set(block.id, fallbackTs);
    }
  }
  return out;
}

// Build content blocks for an assistant record, supporting both Anthropic-style
// (record.content as array of blocks) and OpenAI-style (record.content as string +
// record.tool_calls as [{id,name,arguments}] where arguments is a JSON string).
// Grok 0.2.x fixture emits tool_call.id as empty string → synthesize a stable id
// (`name_<assistantSeq>_<idxInAssistant>`) and push to pendingEmptyToolCallIds so
// subsequent top-level tool_result records with empty tool_call_id can be matched
// in FIFO order.
function buildAssistantContentBlocks(record, assistantSeq, pendingEmptyToolCallIds) {
  if (Array.isArray(record.content) && record.content.length > 0) {
    return record.content;
  }

  const blocks = [];
  const textContent = typeof record.content === 'string' ? record.content : '';
  if (textContent.trim()) {
    blocks.push({ type: 'text', text: record.content });
  }

  if (Array.isArray(record.tool_calls)) {
    record.tool_calls.forEach((tc, idx) => {
      if (!tc) return;
      let toolId = typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : '';
      if (!toolId) {
        const name = tc.name || 'tool';
        toolId = `${name}_${assistantSeq}_${idx + 1}`;
        pendingEmptyToolCallIds.push(toolId);
      }
      const input = parseToolCallArguments(tc.arguments ?? tc.input);
      blocks.push({
        type: 'tool_use',
        id: toolId,
        name: tc.name || 'unknown',
        input,
      });
    });
  }

  return blocks;
}

function parseToolCallArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    if (raw.length === 0) return {};
    try {
      const parsed = JSON.parse(raw);
      return (typeof parsed === 'object' && parsed !== null) ? parsed : { _raw: raw };
    } catch {
      return { _raw: raw };
    }
  }
  return {};
}

function buildLlmCalls(conversationRecords, toolResultTimestamps, toolResultContents, toolResultErrors) {
  const llmCalls = [];
  const conversationHistory = [];
  let prevCount = 0;
  const lastToolResultTsByPromptIndex = new Map();
  const updateLastToolResultTs = (promptIndex, ts) => {
    if (!ts) return;
    const key = promptIndex || MISSING_PROMPT_INDEX;
    const prev = lastToolResultTsByPromptIndex.get(key);
    if (!prev || ts > prev) lastToolResultTsByPromptIndex.set(key, ts);
  };

  for (const rec of conversationRecords) {
    if (rec.type === 'system') {
      conversationHistory.push({ role: 'system', content: rec.content });
      continue;
    }

    if (rec.type === 'user') {
      if (!rec.skipFromHistory) {
        conversationHistory.push({ role: 'user', content: rec.content });
      }
      if (Array.isArray(rec.content)) {
        for (const part of rec.content) {
          if (part && part.type === 'tool_result' && part.tool_use_id) {
            const ts = toolResultTimestamps.get(part.tool_use_id);
            updateLastToolResultTs(rec.promptIndex, ts);
          }
        }
      }
      continue;
    }

    if (rec.type === 'assistant') {
      const usage = rec.usage || {};
      const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
      const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheCreation = usage.cache_creation_input_tokens || 0;

      const delta = conversationHistory.slice(prevCount);

      const declaredToolIds = [];
      for (const block of rec.content) {
        if (block && block.type === 'tool_use' && block.id) {
          declaredToolIds.push(block.id);
        }
      }

      const toolDetails = new Map();
      for (const toolId of declaredToolIds) {
        const callTs = rec.toolUseTimestamps.get(toolId) || rec.timestamp;
        const resultTsRaw = toolResultTimestamps.get(toolId) || null;
        const resultContent = toolResultContents.get(toolId) || '';
        // grok 0.2.x fixture: tool_result often lacks timestamp; fall back to call/assistant ts
        // so a tool.result span still emits (truthy guard in buildTurnRecords).
        const resultTs = resultTsRaw || callTs || rec.timestamp || null;
        const isError = toolResultErrors.get(toolId) || false;
        toolDetails.set(toolId, { call: callTs, result: resultTs, resultContent, isError });
      }

      const requestStartTime = lastToolResultTsByPromptIndex.get(rec.promptIndex || MISSING_PROMPT_INDEX) || null;

      llmCalls.push({
        type: 'llm_call',
        timestamp: rec.timestamp,
        request_start_time: requestStartTime,
        protocol: 'anthropic',
        model: rec.model || 'grok',
        message_id: rec.msgId,
        input_messages: delta,
        _input_is_delta: true,
        output_content: rec.content,
        stop_reason: rec.stop_reason || 'end_turn',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        declaredToolIds,
        toolDetails,
        promptIndex: rec.promptIndex,
      });

      conversationHistory.push({ role: 'assistant', content: rec.content });
      prevCount = conversationHistory.length;

      for (const toolId of declaredToolIds) {
        const ts = toolResultTimestamps.get(toolId);
        updateLastToolResultTs(rec.promptIndex, ts);
      }
    }
  }

  return llmCalls;
}

function splitIntoTurns(conversationRecords, llmCalls) {
  if (llmCalls.length === 0) return [];

  const promptIndexOrder = [];
  const promptIndexSet = new Set();
  const promptIndexInfo = new Map();
  const promptIndexBoundaryTs = new Map();

  for (const rec of conversationRecords) {
    if (rec.type !== 'user' || !rec.promptIndex) continue;
    if (!promptIndexSet.has(rec.promptIndex)) {
      promptIndexSet.add(rec.promptIndex);
      promptIndexOrder.push(rec.promptIndex);
    }
    if (!promptIndexBoundaryTs.has(rec.promptIndex) && rec.timestamp) {
      promptIndexBoundaryTs.set(rec.promptIndex, rec.timestamp);
    }
    if (promptIndexInfo.has(rec.promptIndex) || rec.skipFromHistory || isToolResultContent(rec.content)) {
      continue;
    }
    promptIndexInfo.set(rec.promptIndex, {
      promptText: extractUserPromptText(rec.content),
      promptTimestamp: rec.timestamp,
    });
  }

  if (promptIndexOrder.length === 0) {
    const firstTs = llmCalls[0]?.timestamp || null;
    return [{
      prompt: '',
      promptTimestamp: firstTs,
      llmCalls,
    }];
  }

  const turns = [];
  for (const pid of promptIndexOrder) {
    const turnLlmCalls = llmCalls.filter((c) => c.promptIndex === pid);
    if (turnLlmCalls.length === 0) continue;

    const info = promptIndexInfo.get(pid) || {};
    const promptTimestamp = info.promptTimestamp || promptIndexBoundaryTs.get(pid) || turnLlmCalls[0]?.timestamp || null;

    let fallbackTs = promptTimestamp || turnLlmCalls[0]?.timestamp || null;
    for (const call of turnLlmCalls) {
      const candidate = call.request_start_time || fallbackTs || call.timestamp || null;
      call.request_start_time = normalizeRequestStart(candidate, call.timestamp);
      fallbackTs = laterTimestamp(fallbackTs, call.timestamp);
    }

    turns.push({
      prompt: info.promptText || '',
      promptTimestamp,
      llmCalls: turnLlmCalls,
    });
  }

  const orphanCalls = llmCalls.filter((c) => !c.promptIndex);
  if (orphanCalls.length > 0) {
    if (turns.length > 0) {
      turns[turns.length - 1].llmCalls.push(...orphanCalls);
    } else {
      turns.push({
        prompt: '',
        promptTimestamp: orphanCalls[0]?.timestamp || null,
        llmCalls: orphanCalls,
      });
    }
  }

  return turns;
}

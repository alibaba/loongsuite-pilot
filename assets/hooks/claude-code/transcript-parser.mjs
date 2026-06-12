// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-parser.mjs — Claude Code 原生 transcript JSONL 解析。
 *
 * Claude Code 在 ~/.claude/projects/<hash>/<sessionId>.jsonl 里存全部对话历史。
 * 同一 LLM 调用可能写入多条 assistant 记录(streaming chunks),共享 message.id;
 * 我们按 id 分组、合并、去重,提取每次 LLM 调用的 token usage、stop_reason、output content。
 *
 * v2 重构:
 *   - 时间戳全部从 transcript record.timestamp 字段获取(ISO8601),不再依赖 hook 事件推导
 *   - 新增 declaredToolIds: 从 output_content 的 tool_use block 提取 tool_use_id
 *   - 新增 toolDetails: 从 tool_use/tool_result record 提取每个 tool 的 call/result 时间和内容
 *   - turn 切分使用 user record 的 promptId 字段(Claude Code 的 turn 级标识符)
 *   - 支持 message.id 缺失的 assistant 记录(如 end_turn 的最终回答)
 *   - 删除 alignWithHookEvents / assignTimestamps (不再需要 hook 事件做时间校准)
 *
 * 增量约定:
 *   parseClaudeTranscript(path, byteOffset) 返回 { turns, nextOffset }
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50 MB safety limit

/**
 * 解析 Claude Code transcript JSONL 文件。
 *
 * @param {string} transcriptPath - transcript 文件路径
 * @param {number} byteOffset - 增量读取起点(字节偏移)
 * @returns {{ turns: Array, nextOffset: number }}
 *   turns: 按 promptId 切分的 turn 数组,每个 turn 包含 llmCalls + prompt + timestamps
 */
export function parseClaudeTranscript(transcriptPath, byteOffset = 0) {
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

  // Phase 1: 收集 assistant 分组 + 顺序的对话记录 + 时间戳
  const assistantGroups = new Map(); // message.id → group
  const conversationRecords = []; // [{ type:'user'|'assistant', ... }]
  const toolResultTimestamps = new Map(); // tool_use_id → ISO8601 timestamp
  const toolResultContents = new Map(); // tool_use_id → result content
  const toolResultErrors = new Map(); // tool_use_id → boolean (is_error)
  let currentPromptId = null; // 当前 turn 的 promptId(从 user record 提取)

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

    if (recordType === 'assistant') {
      const msg = record.message;
      if (!msg) continue;

      // 支持 msg.id 缺失: 生成合成 ID
      const msgId = msg.id || `_syn_${crypto.randomUUID()}`;
      const recordTs = record.timestamp || null;

      if (!assistantGroups.has(msgId)) {
        assistantGroups.set(msgId, {
          id: msgId,
          chunks: [],
          usage: null,
          model: null,
          stop_reason: null,
          order: conversationRecords.length,
          firstTimestamp: recordTs,
          toolUseTimestamps: new Map(),
          promptId: currentPromptId,
        });
        conversationRecords.push({ type: 'assistant', msgId, promptId: currentPromptId });
      }

      const group = assistantGroups.get(msgId);
      if (!group.firstTimestamp && recordTs) group.firstTimestamp = recordTs;

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          group.chunks.push(block);
          if (block.type === 'tool_use' && block.id && recordTs) {
            group.toolUseTimestamps.set(block.id, recordTs);
          }
        }
      }
      if (msg.usage) group.usage = msg.usage;
      if (msg.model) group.model = msg.model;
      if (msg.stop_reason) group.stop_reason = msg.stop_reason;
    } else if (recordType === 'user') {
      const msg = record.message;
      if (!msg) continue;
      const recordTs = record.timestamp || null;
      const promptId = record.promptId || null;

      // promptId 变化 = 新 turn 开始
      if (promptId) currentPromptId = promptId;

      // 提取 tool_result 的时间戳和内容
      const userContent = msg.content;
      if (Array.isArray(userContent)) {
        for (const part of userContent) {
          if (part && part.type === 'tool_result' && part.tool_use_id) {
            if (recordTs) toolResultTimestamps.set(part.tool_use_id, recordTs);
            const resultContent = part.content || part.output || part.result || '';
            toolResultContents.set(part.tool_use_id, resultContent);
            if (part.is_error) toolResultErrors.set(part.tool_use_id, true);
          }
        }
      }

      conversationRecords.push({
        type: 'user',
        content: userContent,
        timestamp: recordTs,
        promptId: currentPromptId,
      });
    }
  }

  if (assistantGroups.size === 0) {
    return { turns: [], nextOffset: fileSize };
  }

  // Phase 2: 每组内 content blocks 去重(streaming chunks 会重复)
  for (const group of assistantGroups.values()) {
    group.mergedContent = deduplicateContentBlocks(group.chunks);
    delete group.chunks;
  }

  // Phase 3: 构建 llm_call 事件(带时间戳 + tool 归属信息)
  const llmCalls = [];
  const conversationHistory = [];
  let prevCount = 0;
  let lastToolResultTs = null;

  for (const rec of conversationRecords) {
    if (rec.type === 'user') {
      conversationHistory.push({ role: 'user', content: rec.content });
      if (Array.isArray(rec.content)) {
        for (const part of rec.content) {
          if (part && part.type === 'tool_result' && part.tool_use_id) {
            const ts = toolResultTimestamps.get(part.tool_use_id);
            if (ts && (!lastToolResultTs || ts > lastToolResultTs)) {
              lastToolResultTs = ts;
            }
          }
        }
      }
    } else if (rec.type === 'assistant') {
      const group = assistantGroups.get(rec.msgId);
      if (!group) continue;

      const usage = group.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;

      const delta = conversationHistory.slice(prevCount);

      const declaredToolIds = [];
      for (const block of group.mergedContent) {
        if (block.type === 'tool_use' && block.id) {
          declaredToolIds.push(block.id);
        }
      }

      const toolDetails = new Map();
      for (const toolId of declaredToolIds) {
        const callTs = group.toolUseTimestamps.get(toolId) || group.firstTimestamp;
        const resultTs = toolResultTimestamps.get(toolId) || null;
        const resultContent = toolResultContents.get(toolId) || '';
        const isError = toolResultErrors.get(toolId) || false;
        toolDetails.set(toolId, { call: callTs, result: resultTs, resultContent, isError });
      }

      const requestStartTime = lastToolResultTs || null;

      llmCalls.push({
        type: 'llm_call',
        timestamp: group.firstTimestamp,
        request_start_time: requestStartTime,
        protocol: 'anthropic',
        model: group.model || 'unknown',
        message_id: group.id,
        input_messages: delta,
        _input_is_delta: true,
        output_content: group.mergedContent,
        stop_reason: group.stop_reason || 'end_turn',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        declaredToolIds,
        toolDetails,
        promptId: group.promptId,
      });

      conversationHistory.push({
        role: 'assistant',
        content: group.mergedContent,
      });
      prevCount = conversationHistory.length;

      for (const toolId of declaredToolIds) {
        const ts = toolResultTimestamps.get(toolId);
        if (ts && (!lastToolResultTs || ts > lastToolResultTs)) {
          lastToolResultTs = ts;
        }
      }
    }
  }

  // Phase 4: 按 promptId 切分 turns
  const turns = splitIntoTurns(conversationRecords, llmCalls);

  return { turns, nextOffset: fileSize };
}

/**
 * 按 promptId 切分 turns。
 *
 * Claude Code 的每条 user record 携带 promptId(turn 级标识符),
 * 同一 turn 内所有 user record 共享同一 promptId。
 * promptId 变化 = 新 turn 开始。
 */
function splitIntoTurns(conversationRecords, llmCalls) {
  if (llmCalls.length === 0) return [];

  // 收集所有出现的 promptId(按首次出现顺序)
  const promptIdOrder = [];
  const promptIdSet = new Set();
  const promptIdInfo = new Map(); // promptId → { promptText, promptTimestamp }

  for (const rec of conversationRecords) {
    if (rec.type !== 'user' || !rec.promptId) continue;
    if (!promptIdSet.has(rec.promptId)) {
      promptIdSet.add(rec.promptId);
      promptIdOrder.push(rec.promptId);

      // 每个 promptId 的首条 user record 决定 prompt 内容和时间
      const isToolResult = Array.isArray(rec.content) &&
        rec.content.every((p) => p && p.type === 'tool_result');
      if (!isToolResult) {
        const promptText = Array.isArray(rec.content)
          ? rec.content.map((p) => (p && p.type === 'text' ? (p.text || p.content || '') : '')).join('')
          : (typeof rec.content === 'string' ? rec.content : '');
        promptIdInfo.set(rec.promptId, {
          promptText,
          promptTimestamp: rec.timestamp,
        });
      }
    }
    // 补充: 如果首条是 tool_result 但后续有 prompt,更新 info
    if (!promptIdInfo.has(rec.promptId)) {
      const isToolResult = Array.isArray(rec.content) &&
        rec.content.every((p) => p && p.type === 'tool_result');
      if (!isToolResult) {
        const promptText = Array.isArray(rec.content)
          ? rec.content.map((p) => (p && p.type === 'text' ? (p.text || p.content || '') : '')).join('')
          : (typeof rec.content === 'string' ? rec.content : '');
        promptIdInfo.set(rec.promptId, {
          promptText,
          promptTimestamp: rec.timestamp,
        });
      }
    }
  }

  if (promptIdOrder.length === 0) {
    // 无 promptId (所有 user record 都是系统注入的),fallback 为单 turn
    const firstTs = llmCalls[0]?.timestamp || null;
    return [{
      prompt: '',
      promptTimestamp: firstTs,
      llmCalls,
    }];
  }

  // 按 promptId 分组 llmCalls
  const turns = [];
  for (const pid of promptIdOrder) {
    const turnLlmCalls = llmCalls.filter((c) => c.promptId === pid);
    if (turnLlmCalls.length === 0) continue;

    const info = promptIdInfo.get(pid) || {};

    // request_start_time: 首个 llmCall 的 request_start_time 若为空,用 prompt 时间
    if (turnLlmCalls[0] && !turnLlmCalls[0].request_start_time && info.promptTimestamp) {
      turnLlmCalls[0].request_start_time = info.promptTimestamp;
    }

    turns.push({
      prompt: info.promptText || '',
      promptTimestamp: info.promptTimestamp || turnLlmCalls[0]?.timestamp || null,
      llmCalls: turnLlmCalls,
    });
  }

  // 处理没有 promptId 的 llmCalls (edge case: assistant record 出现在任何 user record 之前)
  const orphanCalls = llmCalls.filter((c) => !c.promptId);
  if (orphanCalls.length > 0) {
    if (turns.length > 0) {
      // 归入最后一个 turn
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

/**
 * Streaming chunks 内容块去重:
 *   - text:取最长一份(streaming 中后到的更完整)
 *   - thinking:同上
 *   - tool_use:按 id 去重
 *   - 其他(image 等):原样保留
 */
export function deduplicateContentBlocks(blocks) {
  if (!blocks || blocks.length === 0) return [];

  const result = [];
  const seenToolUseIds = new Set();
  let bestText = null;
  let bestThinking = null;

  for (const block of blocks) {
    if (!block || !block.type) continue;

    if (block.type === 'text') {
      if (!bestText || (block.text || '').length > (bestText.text || '').length) {
        bestText = block;
      }
    } else if (block.type === 'thinking') {
      if (!bestThinking || (block.thinking || '').length > (bestThinking.thinking || '').length) {
        bestThinking = block;
      }
    } else if (block.type === 'tool_use') {
      if (block.id && !seenToolUseIds.has(block.id)) {
        seenToolUseIds.add(block.id);
        result.push(block);
      } else if (!block.id) {
        result.push(block);
      }
    } else {
      result.push(block);
    }
  }

  // 自然顺序:thinking → text → tool_use
  if (bestText) result.unshift(bestText);
  if (bestThinking) result.unshift(bestThinking);

  return result;
}

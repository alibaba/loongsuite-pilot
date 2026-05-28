// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-parser.mjs — Claude Code 原生 transcript JSONL 解析。
 *
 * 移植自 claude-code-plugin .../src/transcript.js,改 ESM 导出。
 *
 * Claude Code 在 ~/.claude/projects/<hash>/<sessionId>.jsonl 里存全部对话历史。
 * 同一 LLM 调用可能写入多条 assistant 记录(streaming chunks),共享 message.id;
 * 我们按 id 分组、合并、去重,提取每次 LLM 调用的 token usage、stop_reason、output content。
 *
 * 关键 bug fix(均已保留):
 *   7.5 byteOffset 增量读取 — 跨 turn 跳过已消费的字节
 *   7.6 PostToolUse 丢失排序 — alignWithHookEvents 用 prevEnd + 0.001 下界
 *   7.8 历史锚点抢占 — expectedCount + _discarded = true,只配对最末 N 条
 *
 * 增量约定:
 *   parseClaudeTranscript(path, startTime, stopTime, byteOffset) 返回 llm_call 事件数组,
 *   并在数组上挂 .nextOffset 属性,调用方持久化到 state.transcript_offset 即可下次只读增量。
 */

import fs from 'node:fs';

export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50 MB safety limit

export function parseClaudeTranscript(transcriptPath, startTime, stopTime, byteOffset = 0) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    const empty = [];
    empty.nextOffset = byteOffset;
    return empty;
  }

  let content;
  let fileSize;
  try {
    const stat = fs.statSync(transcriptPath);
    fileSize = stat.size;

    if (byteOffset >= fileSize) {
      const empty = [];
      empty.nextOffset = byteOffset;
      return empty;
    }

    const readFrom = Math.max(byteOffset, 0);
    const readLen = fileSize - readFrom;

    if (readLen > MAX_TRANSCRIPT_BYTES) {
      // 超过安全上限,退化为读最尾 50MB
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const tailOffset = fileSize - MAX_TRANSCRIPT_BYTES;
        const actualOffset = Math.max(tailOffset, readFrom);
        const actualLen = fileSize - actualOffset;
        const buf = Buffer.alloc(actualLen);
        fs.readSync(fd, buf, 0, actualLen, actualOffset);
        content = buf.toString('utf-8');
        if (actualOffset > readFrom) {
          // 截断了开头,丢弃首行(可能不完整)
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
    const empty = [];
    empty.nextOffset = byteOffset;
    return empty;
  }

  // Phase 1: 收集 assistant 分组 + 顺序的对话记录
  const assistantGroups = new Map(); // message.id → { chunks, usage, model, stop_reason, order }
  const conversationRecords = []; // [{ type:'user'|'assistant', ... }]

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
      if (!msg || !msg.id) continue;

      const msgId = msg.id;
      if (!assistantGroups.has(msgId)) {
        assistantGroups.set(msgId, {
          id: msgId,
          chunks: [],
          usage: null,
          model: null,
          stop_reason: null,
          order: conversationRecords.length,
        });
        conversationRecords.push({ type: 'assistant', msgId });
      }

      const group = assistantGroups.get(msgId);

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          group.chunks.push(block);
        }
      }
      if (msg.usage) group.usage = msg.usage;
      if (msg.model) group.model = msg.model;
      if (msg.stop_reason) group.stop_reason = msg.stop_reason;
    } else if (recordType === 'user') {
      const msg = record.message;
      if (!msg) continue;
      conversationRecords.push({ type: 'user', content: msg.content });
    }
    // 其余 record type(permission-mode、attachment、last-prompt 等)忽略
  }

  if (assistantGroups.size === 0) {
    const empty = [];
    empty.nextOffset = fileSize;
    return empty;
  }

  // Phase 2: 每组内 content blocks 去重(streaming chunks 会重复)
  for (const group of assistantGroups.values()) {
    group.mergedContent = deduplicateContentBlocks(group.chunks);
    delete group.chunks;
  }

  // Phase 3: 构建 llm_call 事件,input_messages 用 delta 形式(避免 O(N²) 复制)
  const llmEvents = [];
  const conversationHistory = [];
  let prevCount = 0;

  for (const rec of conversationRecords) {
    if (rec.type === 'user') {
      conversationHistory.push({ role: 'user', content: rec.content });
    } else if (rec.type === 'assistant') {
      const group = assistantGroups.get(rec.msgId);
      if (!group) continue;

      const usage = group.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;

      const delta = conversationHistory.slice(prevCount);

      llmEvents.push({
        type: 'llm_call',
        timestamp: 0,
        request_start_time: 0,
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
      });

      conversationHistory.push({
        role: 'assistant',
        content: group.mergedContent,
      });
      prevCount = conversationHistory.length;
    }
  }

  // Phase 4: 没有时间戳,按 startTime/stopTime 均匀分配(用于 span 顺序)
  if (llmEvents.length > 0) {
    assignTimestamps(llmEvents, startTime, stopTime);
  }

  llmEvents.nextOffset = fileSize;
  return llmEvents;
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

function assignTimestamps(llmEvents, startTime, stopTime) {
  const n = llmEvents.length;
  const duration = Math.max(stopTime - startTime, 1);
  const interval = duration / (n + 1);

  for (let i = 0; i < n; i++) {
    const ts = startTime + interval * (i + 1);
    llmEvents[i].timestamp = ts;
    llmEvents[i].request_start_time = ts - Math.min(interval * 0.5, 1);
  }
}

/**
 * 用 hook events 时间戳锚点对齐 transcript llm_call 时间。
 *
 * 模式:
 *   user_prompt_submit (t0)
 *     llm_call #1 → pre_tool_use (t1) → post_tool_use (t2)
 *     llm_call #2 → pre_tool_use (t3) → post_tool_use (t4)
 *     llm_call #3 → stop
 *
 * 关键修复:
 *   7.6 prevEnd + 0.001 下界 — 防止 PostToolUse 时间错位
 *   7.8 expectedCount + _discarded = true — 只配对最末 N 条 llm_call,
 *       避免历史 transcript 数据偷走当前 turn 的锚点
 */
export function alignWithHookEvents(llmEvents, hookEvents, stopTime) {
  if (llmEvents.length === 0 || hookEvents.length === 0) return;

  const anchors = [];
  for (const ev of hookEvents) {
    if (ev.type === 'user_prompt_submit' && ev.timestamp) {
      anchors.push({ type: 'start', ts: ev.timestamp });
    } else if (ev.type === 'pre_tool_use' && ev.timestamp) {
      anchors.push({ type: 'pre_tool', ts: ev.timestamp });
    } else if (ev.type === 'post_tool_use' && ev.timestamp) {
      anchors.push({ type: 'post_tool', ts: ev.timestamp });
    }
  }

  const preToolAnchors = anchors.filter((a) => a.type === 'pre_tool');
  const startAnchors = anchors.filter((a) => a.type === 'start' || a.type === 'post_tool');

  const expectedCount = preToolAnchors.length + 1;
  const startIdx = Math.max(0, llmEvents.length - expectedCount);

  for (let i = 0; i < startIdx; i++) {
    llmEvents[i]._discarded = true;
  }

  let preToolIdx = 0;
  for (let i = startIdx; i < llmEvents.length; i++) {
    const ev = llmEvents[i];
    const relIdx = i - startIdx;

    if (relIdx === 0 && startAnchors.length > 0) {
      ev.request_start_time = startAnchors[0].ts;
    } else if (relIdx > 0) {
      const prevEnd = llmEvents[i - 1].timestamp;
      const postAfterPrev = startAnchors.find((a) => a.ts >= prevEnd);
      if (postAfterPrev) {
        ev.request_start_time = postAfterPrev.ts;
      } else {
        ev.request_start_time = prevEnd + 0.001;
      }
    }

    if (relIdx < expectedCount - 1 && preToolIdx < preToolAnchors.length) {
      ev.timestamp = preToolAnchors[preToolIdx].ts;
      preToolIdx++;
    } else {
      ev.timestamp = stopTime;
    }

    if (ev.request_start_time >= ev.timestamp) {
      ev.request_start_time = ev.timestamp - 0.5;
    }
  }
}

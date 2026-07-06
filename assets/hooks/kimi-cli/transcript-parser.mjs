// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-parser.mjs — Kimi CLI wire.jsonl + context.jsonl 解析。
 *
 * wire.jsonl 是 kimi-cli 的 wire protocol 事件流（`kimi_cli/wire/file.py` 的
 * `WireFile.append_message` 异步 queue + recorder 落盘）。每行格式：
 *   {"timestamp": <unix_float>, "message": {"type": "...", "payload": {...}}}
 * 第一行是 metadata：{"type": "metadata", "protocol_version": "1.10"}
 *
 * context.jsonl 是 kimi-cli 的对话历史（`kimi_cli/soul/context.py` 的 `Context`
 * 同步 aiofiles 追加）。每行格式：
 *   {"role": "_system_prompt", "content": "..."}    // 系统提示词
 *   {"role": "_usage", "token_count": N}            // token checkpoint
 *   {"role": "_checkpoint", "id": N}                // 检查点
 *   {"role": "user"|"assistant"|"tool", "content": [...]}  // kosong Message
 *
 * 输出：turns 数组，每个 turn 包含 prompt / promptTimestamp / steps / toolResults /
 * endStatus / endTimestamp。每个 step 包含 stepBeginTs / stepEndTs / interrupted /
 * textParts / thinkParts / toolCalls / tokenUsage / messageId / model。
 *
 * SubagentEvent 暂不展开为独立 trace（v1）；解析器识别并跳过其嵌套 event，避免
 * 崩溃。后续可按 parent_tool_call_id 关联子 trace。
 *
 * 增量约定：parseKimiTranscript(wirePath, contextPath, byteOffset) 返回
 *   { turns, nextOffset, partial }
 */

import fs from 'node:fs';

export const MAX_WIRE_BYTES = 50 * 1024 * 1024;

function readTailLines(filePath, byteOffset) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { lines: [], nextOffset: byteOffset, fileSize: 0 };
  }
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  if (byteOffset >= fileSize) {
    return { lines: [], nextOffset: byteOffset, fileSize };
  }
  const readFrom = Math.max(byteOffset, 0);
  const readLen = fileSize - readFrom;
  let content;
  if (readLen > MAX_WIRE_BYTES) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const tailOffset = fileSize - MAX_WIRE_BYTES;
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
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, readFrom);
      content = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } else {
    content = fs.readFileSync(filePath, 'utf-8');
  }
  const lines = content.split('\n');
  // 末行可能不完整（read 块未对齐到换行）→ 丢弃，nextOffset 仍按 fileSize 推进
  // 实际 kimi wire.jsonl 每条事件都以 \n 结尾（recorder append_message 写 \n），
  // 末行不含 \n 说明该行还在写入中，跳过等下一轮解析。
  if (lines.length > 0 && !content.endsWith('\n')) {
    lines.pop();
  }
  return { lines, nextOffset: fileSize, fileSize };
}

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function unixFloatToNanos(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '0';
  const sec = Math.floor(ts);
  const frac = ts - sec;
  const ns = Math.round(frac * 1e9);
  return String(sec) + String(ns).padStart(9, '0');
}

/**
 * 从 context.jsonl 提取 system_prompt 全文 + user/assistant 消息历史。
 * 返回 { systemPrompt, messages }。messages 是 [{role, content}] 数组。
 */
function parseContextFile(contextPath) {
  const out = { systemPrompt: null, messages: [] };
  if (!contextPath || !fs.existsSync(contextPath)) return out;
  let raw;
  try {
    raw = fs.readFileSync(contextPath, 'utf-8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const parsed = parseJsonLine(line);
    if (!parsed || typeof parsed !== 'object') continue;
    const role = parsed.role;
    if (role === '_system_prompt') {
      if (typeof parsed.content === 'string') out.systemPrompt = parsed.content;
    } else if (role === '_usage' || role === '_checkpoint') {
      // skip — usage/checkpoint markers
    } else if (role === 'user' || role === 'assistant' || role === 'tool') {
      out.messages.push({
        role,
        content: Array.isArray(parsed.content) ? parsed.content : parsed.content,
      });
    }
  }
  return out;
}

function extractUserInputTextInput(userInput) {
  if (typeof userInput === 'string') return userInput;
  if (Array.isArray(userInput)) {
    return userInput
      .map((p) => (p && typeof p === 'object' && p.type === 'text' ? (p.text || '') : ''))
      .join('');
  }
  return '';
}

/**
 * 解析 wire.jsonl + context.jsonl，返回 turns 数组。
 *
 * @param {string} wirePath     - wire.jsonl 路径
 * @param {string} contextPath  - context.jsonl 路径（可为 null）
 * @param {number} byteOffset   - wire.jsonl 增量读取起点
 * @returns {{ turns: Array, nextOffset: number, partial: boolean, systemPrompt: string|null, contextMessages: Array }}
 */
export function parseKimiTranscript(wirePath, contextPath, byteOffset = 0) {
  const { lines, nextOffset } = readTailLines(wirePath, byteOffset);

  const wireEvents = [];
  for (const line of lines) {
    const parsed = parseJsonLine(line);
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.type === 'metadata') continue;
    if (typeof parsed.timestamp !== 'number') continue;
    const msg = parsed.message;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') continue;
    wireEvents.push({ timestamp: parsed.timestamp, type: msg.type, payload: msg.payload || {} });
  }

  // 按 TurnBegin 切分 turns
  const turns = [];
  let currentTurn = null;
  let currentStep = null;

  const beginStep = (turn, ts, n) => {
    if (currentStep) {
      // 上一步未显式闭合 → 用 StepBegin 时刻作为 end
      currentStep.stepEndTs = ts;
      currentStep.interrupted = false;
      turn.steps.push(currentStep);
    }
    currentStep = {
      n,
      stepBeginTs: ts,
      stepEndTs: null,
      interrupted: false,
      textParts: [],
      thinkParts: [],
      toolCalls: [],
      toolCallParts: [],
      tokenUsage: null,
      messageId: null,
      model: null,
    };
  };

  const closeStep = (turn, ts, interrupted) => {
    if (!currentStep) return;
    currentStep.stepEndTs = ts;
    currentStep.interrupted = interrupted;
    turn.steps.push(currentStep);
    currentStep = null;
  };

  for (const ev of wireEvents) {
    const { timestamp, type, payload } = ev;
    if (type === 'TurnBegin') {
      // 关闭未闭合的 turn
      if (currentTurn) {
        if (currentStep) closeStep(currentTurn, timestamp, false);
        currentTurn.endTs = timestamp;
        currentTurn.endStatus = 'TurnEnd';
        turns.push(currentTurn);
      }
      currentTurn = {
        prompt: extractUserInputTextInput(payload.user_input),
        promptTs: timestamp,
        steps: [],
        toolResults: [],
        endTs: null,
        endStatus: null,
      };
    } else if (type === 'TurnEnd') {
      if (!currentTurn) continue;
      if (currentStep) closeStep(currentTurn, timestamp, false);
      currentTurn.endTs = timestamp;
      currentTurn.endStatus = 'TurnEnd';
      turns.push(currentTurn);
      currentTurn = null;
    } else if (type === 'StepBegin') {
      if (!currentTurn) continue;
      beginStep(currentTurn, timestamp, typeof payload.n === 'number' ? payload.n : (currentTurn.steps.length + 1));
    } else if (type === 'StepInterrupted') {
      if (!currentTurn || !currentStep) continue;
      closeStep(currentTurn, timestamp, true);
    } else if (type === 'StepRetry') {
      // StepRetry 标志当前 step 失败重试；按 StepInterrupted 处理当前 step
      if (currentTurn && currentStep) closeStep(currentTurn, timestamp, true);
    } else if (type === 'ContentPart') {
      if (!currentTurn || !currentStep) continue;
      const ptype = payload.type;
      if (ptype === 'text' && typeof payload.text === 'string') {
        currentStep.textParts.push({ text: payload.text });
      } else if (ptype === 'thinking' && typeof payload.thinking === 'string') {
        currentStep.thinkParts.push({ thinking: payload.thinking });
      }
      // 其他类型（image/audio/video）暂不采集
    } else if (type === 'ToolCall') {
      if (!currentTurn || !currentStep) continue;
      const fn = payload.function || {};
      currentStep.toolCalls.push({
        id: typeof payload.id === 'string' ? payload.id : '',
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments: fn.arguments ?? '',
        timestamp,
      });
    } else if (type === 'ToolCallPart') {
      // ToolCallPart 是 streaming chunk 形式的 tool_call（部分 provider 使用）
      if (!currentTurn || !currentStep) continue;
      const id = typeof payload.id === 'string' ? payload.id : '';
      const name = typeof payload.name === 'string' ? payload.name : '';
      // 合并到 toolCalls：若 id 已存在则更新 name/arguments
      let existing = currentStep.toolCalls.find((c) => c.id && c.id === id);
      const argChunk = typeof payload.arguments === 'string' ? payload.arguments : '';
      if (!existing && id) {
        existing = {
          id,
          name: name || '',
          arguments: argChunk,
          timestamp,
        };
        currentStep.toolCalls.push(existing);
      } else if (existing) {
        if (name) existing.name = name;
        if (argChunk) existing.arguments = (existing.arguments || '') + argChunk;
      }
    } else if (type === 'StatusUpdate') {
      if (!currentTurn || !currentStep) continue;
      if (payload.token_usage && typeof payload.token_usage === 'object') {
        currentStep.tokenUsage = payload.token_usage;
      }
      if (typeof payload.message_id === 'string' && payload.message_id) {
        currentStep.messageId = payload.message_id;
      }
      // StatusUpdate 不结束 step
    } else if (type === 'SubagentEvent') {
      // v1: 跳过子代理嵌套事件（parser 识别不崩溃，但不展开为独立 trace）
      continue;
    } else if (type === 'ToolResult') {
      if (!currentTurn) continue;
      const rv = payload.return_value || {};
      currentTurn.toolResults.push({
        toolCallId: typeof payload.tool_call_id === 'string' ? payload.tool_call_id : '',
        isError: rv.is_error === true,
        output: typeof rv.output === 'string' ? rv.output : '',
        message: typeof rv.message === 'string' ? rv.message : '',
        returnValue: rv,
        timestamp,
      });
    }
    // 其他事件类型（CompactionBegin/End, HookTriggered/Resolved, MCPLoading*,
    // Notification, PlanDisplay, BtwBegin/End, ApprovalResponse, SteerInput,
    // SteerInput 等）暂不消费，但 parser 不崩溃
  }

  // 末尾未闭合的 turn（best-effort：partial=true 时常见）
  if (currentTurn) {
    if (currentStep) closeStep(currentTurn, currentTurn.endTs || currentStep.stepBeginTs, false);
    if (!currentTurn.endTs) {
      // 用最后一个 wire event 的 timestamp 兜底
      const lastTs = wireEvents.length > 0 ? wireEvents[wireEvents.length - 1].timestamp : currentTurn.promptTs;
      currentTurn.endTs = lastTs;
      currentTurn.endStatus = 'partial';
    }
    turns.push(currentTurn);
  }

  const { systemPrompt, messages: contextMessages } = parseContextFile(contextPath);

  return {
    turns,
    nextOffset,
    partial: false,
    systemPrompt,
    contextMessages,
  };
}

/**
 * 把 wire.jsonl 末尾几行解析为最后一条事件，用于 waitForWireStable 末行校验。
 * 返回末行 type（如 "TurnEnd" / "StepInterrupted"），或 null（无事件）。
 */
export function peekLastWireEventType(wirePath) {
  if (!wirePath || !fs.existsSync(wirePath)) return null;
  const stat = fs.statSync(wirePath);
  if (stat.size === 0) return null;
  // 读末尾 8KB（足够覆盖若干 wire 行）
  const fd = fs.openSync(wirePath, 'r');
  try {
    const readLen = Math.min(stat.size, 8192);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;
    const last = lines[lines.length - 1];
    const parsed = parseJsonLine(last);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.type === 'metadata') return 'metadata';
    const msg = parsed.message;
    return msg && typeof msg.type === 'string' ? msg.type : null;
  } finally {
    fs.closeSync(fd);
  }
}

export const _internal = { unixFloatToNanos, parseContextFile, extractUserInputTextInput };

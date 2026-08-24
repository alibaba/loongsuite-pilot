// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse Grok Build's shared, rotating unified.jsonl log.
 *
 * No persistent array index is used. Each hook reads the bounded current tail,
 * filters by session, and the caller selects records by the current turn window.
 */

import fs from 'node:fs';

// Grok Build rotates unified.jsonl at 5 MiB and retains roughly its newest
// half. Keep a small overshoot allowance for a concurrent final append, while
// preventing an unexpected/stale file from putting 50 MiB on the Hook path.
export const MAX_UNIFIED_BYTES = 8 * 1024 * 1024;

function parseTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoundedCompleteTail(filePath, maxBytes) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  if (stat.size <= 0) return [];

  let start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  if (start > 0) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline < 0) return [];
    start += firstNewline + 1;
    buffer = buffer.subarray(firstNewline + 1);
  }
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return [];
  return buffer.subarray(0, lastNewline + 1).toString('utf-8').split('\n');
}

export function parseGrokUnified(filePath, sessionId, options = {}) {
  if (!sessionId) return { groups: [], parseErrors: 0 };
  const lines = readBoundedCompleteTail(filePath, options.maxBytes ?? MAX_UNIFIED_BYTES);
  const records = [];
  let parseErrors = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (raw?.sid !== sessionId) continue;
    const timestampMs = parseTimestampMs(raw?.ts);
    if (timestampMs == null) continue;
    if (
      raw?.msg !== 'shell.turn.inference_start'
      && raw?.msg !== 'shell.turn.inference_done'
      && raw?.msg !== 'shell.tool.exec_done'
    ) {
      continue;
    }
    records.push({ timestampMs, msg: raw.msg, ctx: raw.ctx ?? {} });
  }

  records.sort((a, b) => a.timestampMs - b.timestampMs);
  const groups = [];
  let current = null;
  for (const record of records) {
    const ctx = record.ctx;
    if (record.msg === 'shell.turn.inference_start') {
      current = {
        loopIndex: numberOrNull(ctx.loop_index) ?? groups.length + 1,
        startMs: record.timestampMs,
        endMs: null,
        modelElapsedMs: null,
        promptTokens: null,
        cachedPromptTokens: null,
        cacheCreationInputTokens: null,
        completionTokens: null,
        reasoningTokens: null,
        tools: [],
      };
      groups.push(current);
      continue;
    }

    if (record.msg === 'shell.turn.inference_done') {
      let target = current?.endMs == null ? current : null;
      const loopIndex = numberOrNull(ctx.loop_index);
      if (!target || (loopIndex != null && target.loopIndex !== loopIndex)) {
        target = [...groups].reverse().find((group) => group.endMs == null
          && (loopIndex == null || group.loopIndex === loopIndex));
      }
      if (!target) {
        const elapsed = numberOrNull(ctx.model_elapsed_ms);
        target = {
          loopIndex: loopIndex ?? groups.length + 1,
          startMs: elapsed != null ? record.timestampMs - elapsed : record.timestampMs,
          endMs: null,
          modelElapsedMs: null,
          promptTokens: null,
          cachedPromptTokens: null,
          cacheCreationInputTokens: null,
          completionTokens: null,
          reasoningTokens: null,
          tools: [],
        };
        groups.push(target);
      }
      target.endMs = record.timestampMs;
      target.modelElapsedMs = numberOrNull(ctx.model_elapsed_ms);
      if (target.modelElapsedMs != null && target.startMs === target.endMs) {
        target.startMs = target.endMs - target.modelElapsedMs;
      }
      target.promptTokens = numberOrNull(ctx.prompt_tokens);
      target.cachedPromptTokens = numberOrNull(ctx.cached_prompt_tokens);
      target.cacheCreationInputTokens = numberOrNull(ctx.cache_creation_input_tokens);
      target.completionTokens = numberOrNull(ctx.completion_tokens);
      target.reasoningTokens = numberOrNull(ctx.reasoning_tokens);
      current = target;
      continue;
    }

    if (record.msg === 'shell.tool.exec_done') {
      const target = current?.endMs != null
        ? current
        : [...groups].reverse().find((group) => group.endMs != null);
      if (!target) continue;
      const elapsedMs = Math.max(0, numberOrNull(ctx.elapsed_ms) ?? 0);
      target.tools.push({
        name: typeof ctx.tool_name === 'string' && ctx.tool_name ? ctx.tool_name : 'unknown',
        startMs: record.timestampMs - elapsedMs,
        endMs: record.timestampMs,
        elapsedMs,
        success: typeof ctx.success === 'boolean' ? ctx.success : null,
      });
    }
  }

  return { groups, parseErrors };
}

export function selectUnifiedGroups(groups, {
  startMs = null,
  endMs = null,
  expectedCount = 0,
} = {}) {
  let selected = groups;
  if (Number.isFinite(startMs) || Number.isFinite(endMs)) {
    const lower = Number.isFinite(startMs) ? startMs - 2000 : Number.NEGATIVE_INFINITY;
    const upper = Number.isFinite(endMs) ? endMs + 2000 : Number.POSITIVE_INFINITY;
    selected = groups.filter((group) => {
      const observed = group.startMs ?? group.endMs;
      return observed != null && observed >= lower && observed <= upper;
    });
  }
  if (expectedCount > 0 && selected.length > expectedCount) {
    // A cancelled turn can contain a completed inference that produced the
    // assistant tool_call followed by a new inference_start with no matching
    // inference_done/chat assistant record. Do not let that trailing attempt
    // displace the completed inference that the chat record represents.
    const completed = selected.filter((group) => Number.isFinite(group.endMs));
    selected = completed.length >= expectedCount
      ? completed.slice(-expectedCount)
      : selected.slice(-expectedCount);
  }
  return selected;
}

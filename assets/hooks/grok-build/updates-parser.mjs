// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse Grok Build's durable updates.jsonl rail.
 *
 * Only newline-terminated records are consumed. A torn final line remains behind
 * the returned checkpoint and is retried by the next hook invocation.
 */

import fs from 'node:fs';

export const MAX_UPDATES_BYTES = 50 * 1024 * 1024;
const TOOL_PROGRESS_STATUSES = new Set([
  'in_progress',
  'in-progress',
  'pending',
  'running',
  'started',
]);

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function timestampMs(record, params) {
  const agentMs = finiteNumber(params?._meta?.agentTimestampMs);
  if (agentMs != null) return agentMs;

  const raw = record?.timestamp;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const numeric = finiteNumber(raw);
  if (numeric == null) return null;
  // updates.jsonl currently stores Unix seconds, while some fixtures use ms.
  return Math.abs(numeric) < 10_000_000_000 ? numeric * 1000 : numeric;
}

function normalizeStatus(raw) {
  if (typeof raw !== 'string') return null;
  const status = raw.trim().toLowerCase();
  if (status === 'completed' || status === 'complete' || status === 'success' || status === 'succeeded') {
    return 'success';
  }
  if (status === 'failed' || status === 'failure' || status === 'error') return 'failure';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return status ? 'unknown' : null;
}

function eventType(update) {
  const value = update?.sessionUpdate ?? update?.session_update ?? '';
  return typeof value === 'string'
    ? value
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/-/g, '_')
      .toLowerCase()
    : '';
}

function isProgressStatus(raw) {
  if (typeof raw !== 'string') return false;
  return TOOL_PROGRESS_STATUSES.has(raw.trim().toLowerCase());
}

function promptIdOf(params, update) {
  const value = params?._meta?.promptId
    ?? params?._meta?.prompt_id
    ?? update?.promptId
    ?? update?.prompt_id;
  return typeof value === 'string' && value ? value : null;
}

function promptIndexOf(update) {
  const value = update?._meta?.promptIndex ?? update?._meta?.prompt_index;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value) return value;
  return null;
}

function toolNameOf(update) {
  const meta = update?._meta?.['x.ai/tool'] ?? update?._meta?.x_ai_tool;
  const name = meta?.name ?? update?.toolName ?? update?.tool_name;
  return typeof name === 'string' && name ? name : null;
}

function toolIdOf(update) {
  const value = update?.toolCallId ?? update?.tool_call_id ?? '';
  return typeof value === 'string' ? value : '';
}

function terminalStopReason(update) {
  const value = update?.stopReason ?? update?.stop_reason;
  return typeof value === 'string' && value ? value : null;
}

function readCompleteLines(filePath, checkpoint = {}, maxBytes = MAX_UPDATES_BYTES) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return {
      lines: [],
      checkpoint: { offset: checkpoint?.offset || 0, ino: checkpoint?.ino || null, size: 0 },
      reset: false,
    };
  }

  const savedOffset = Number.isFinite(checkpoint?.offset) ? Math.max(0, checkpoint.offset) : 0;
  const savedIno = checkpoint?.ino != null ? String(checkpoint.ino) : null;
  const currentIno = stat.ino != null ? String(stat.ino) : null;
  const identityChanged = savedIno != null && currentIno != null && savedIno !== currentIno;
  const savedSize = Number.isFinite(checkpoint?.size) ? Math.max(0, checkpoint.size) : 0;
  const reset = identityChanged || savedOffset > stat.size || savedSize > stat.size;
  let start = reset ? 0 : savedOffset;

  if (stat.size - start > maxBytes) {
    start = Math.max(0, stat.size - maxBytes);
  }
  if (start >= stat.size) {
    return {
      lines: [],
      checkpoint: { offset: start, ino: currentIno, size: stat.size },
      reset,
    };
  }

  const fd = fs.openSync(filePath, 'r');
  let buffer;
  try {
    const len = stat.size - start;
    buffer = Buffer.alloc(len);
    fs.readSync(fd, buffer, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }

  // A tail cap can put us in the middle of a JSON object. Skip that fragment.
  if (start > (reset ? 0 : savedOffset)) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline < 0) {
      return {
        lines: [],
        checkpoint: { offset: savedOffset, ino: currentIno, size: stat.size },
        reset,
      };
    }
    start += firstNewline + 1;
    buffer = buffer.subarray(firstNewline + 1);
  }

  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return {
      lines: [],
      checkpoint: { offset: start, ino: currentIno, size: stat.size },
      reset,
    };
  }

  const complete = buffer.subarray(0, lastNewline + 1);
  const lines = [];
  let relativeOffset = 0;
  for (const lineBuffer of complete.toString('utf-8').split('\n')) {
    const byteLength = Buffer.byteLength(lineBuffer, 'utf-8') + 1;
    if (lineBuffer.trim()) {
      lines.push({
        text: lineBuffer,
        startOffset: start + relativeOffset,
        endOffset: start + relativeOffset + byteLength,
      });
    }
    relativeOffset += byteLength;
  }

  return {
    lines,
    checkpoint: {
      offset: start + complete.length,
      ino: currentIno,
      size: stat.size,
    },
    reset,
  };
}

function buildTurns(events, fallbackPromptId = null) {
  const turns = [];
  let segment = [];

  const finishSegment = (terminal = null) => {
    if (segment.length === 0 && !terminal) return;
    const all = terminal && !segment.includes(terminal) ? [...segment, terminal] : segment;
    const promptId = terminal?.promptId
      ?? all.find((event) => event.promptId)?.promptId
      ?? fallbackPromptId;
    const promptIndex = all.find((event) => event.promptIndex)?.promptIndex ?? null;
    const timestamps = all.map((event) => event.timestampMs).filter(Number.isFinite);
    const turnStarts = all.map((event) => event.turnStartMs).filter(Number.isFinite);
    turns.push({
      promptId,
      promptIndex,
      completed: !!terminal,
      stopReason: terminal?.stopReason ?? null,
      agentResult: terminal?.agentResult ?? null,
      usage: terminal?.usage ?? null,
      startMs: turnStarts.length > 0
        ? Math.min(...turnStarts)
        : (timestamps.length > 0 ? Math.min(...timestamps) : null),
      endMs: terminal?.timestampMs
        ?? (timestamps.length > 0 ? Math.max(...timestamps) : null),
      startOffset: all[0]?.startOffset ?? 0,
      endOffset: all.at(-1)?.endOffset ?? 0,
      events: all,
      toolStarts: all.filter((event) => event.kind === 'tool_start'),
      toolCompletions: all.filter((event) => event.kind === 'tool_completion'),
    });
    segment = [];
  };

  for (const event of events) {
    segment.push(event);
    if (event.kind === 'turn_completed') finishSegment(event);
  }
  if (segment.length > 0) finishSegment(null);
  return turns;
}

/**
 * @returns {{
 *   turns: Array,
 *   events: Array,
 *   checkpoint: {offset:number, ino:string|null, size:number},
 *   lastCompletedOffset: number,
 *   parseErrors: number,
 *   reset: boolean,
 * }}
 */
export function parseGrokUpdates(filePath, checkpoint = {}, options = {}) {
  const read = readCompleteLines(filePath, checkpoint, options.maxBytes);
  const events = [];
  let parseErrors = 0;

  for (const line of read.lines) {
    let raw;
    try {
      raw = JSON.parse(line.text);
    } catch {
      parseErrors += 1;
      continue;
    }
    const params = raw?.params ?? {};
    const update = params?.update ?? {};
    const type = eventType(update);
    const rawToolStatus = update?.status;
    const toolStatus = normalizeStatus(rawToolStatus);
    const isToolUpdate = type === 'tool_call_update';
    const hasToolStart = isToolUpdate && (
      update?.rawInput != null
      || update?.raw_input != null
      || update?.title != null
      || toolNameOf(update) != null
    );
    const isTerminalToolStatus = toolStatus === 'success'
      || toolStatus === 'failure'
      || toolStatus === 'cancelled';
    const hasToolOutput = update?.rawOutput != null
      || update?.raw_output != null
      || update?.content != null;
    const hasToolCompletion = isToolUpdate
      && (isTerminalToolStatus || (!hasToolStart && !isProgressStatus(rawToolStatus) && hasToolOutput));
    let kind = type || 'unknown';
    if (type === 'turn_completed') kind = 'turn_completed';
    else if (hasToolCompletion) kind = 'tool_completion';
    else if (hasToolStart) kind = 'tool_start';

    const event = {
      kind,
      type,
      promptId: promptIdOf(params, update),
      promptIndex: promptIndexOf(update),
      timestampMs: timestampMs(raw, params),
      turnStartMs: finiteNumber(params?._meta?.turnStartMs ?? params?._meta?.turn_start_ms),
      eventId: params?._meta?.eventId ?? params?._meta?.event_id ?? null,
      toolId: toolIdOf(update),
      toolName: toolNameOf(update),
      toolStatus,
      toolInput: update?.rawInput ?? update?.raw_input,
      toolOutput: update?.rawOutput ?? update?.raw_output ?? update?.content,
      stopReason: terminalStopReason(update),
      agentResult: update?.agentResult ?? update?.agent_result ?? null,
      usage: update?.usage ?? null,
      startOffset: line.startOffset,
      endOffset: line.endOffset,
      raw: update,
    };
    events.push(event);
  }

  const turns = buildTurns(events, options.fallbackPromptId ?? null);
  const completed = turns.filter((turn) => turn.completed);
  return {
    turns,
    events,
    checkpoint: read.checkpoint,
    lastCompletedOffset: completed.at(-1)?.endOffset ?? (checkpoint?.offset || 0),
    parseErrors,
    reset: read.reset,
  };
}

export { normalizeStatus as normalizeGrokToolStatus };

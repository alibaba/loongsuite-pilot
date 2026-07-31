// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-Bash-tool upstream trace context reservation for Claude Code.
 *
 * PreToolUse runs before the Bash subprocess exists. It reserves the span id
 * that Pilot will later use for the synthetic TOOL span and returns a
 * traceparent whose parent id is that reserved span id. The Stop processor
 * consumes the same record by tool_use_id while building tool.call/result.
 *
 * Files are intentionally one-per-tool so parallel PreToolUse hook processes
 * never contend on a shared session JSON document. Orphans live under
 * acp-correlate and are removed by the existing upstream-link retention job.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);
const TRACESTATE_MAX_LENGTH = 512;

function safeName(value) {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function correlateDir(dataDir) {
  return path.join(dataDir, 'acp-correlate');
}

function contextPath(dataDir, sessionId, toolUseId) {
  return path.join(
    correlateDir(dataDir),
    `${safeName(sessionId)}.${safeName(toolUseId)}.tool-context.json`,
  );
}

function consumedPath(dataDir, sessionId) {
  return path.join(correlateDir(dataDir), `${safeName(sessionId)}.tool-propagation.done`);
}

function parseTraceparent(value) {
  if (typeof value !== 'string') return null;
  const match = TRACEPARENT_RE.exec(value.trim());
  if (!match) return null;
  const traceId = match[1].toLowerCase();
  const parentSpanId = match[2].toLowerCase();
  const flags = match[3].toLowerCase();
  if (traceId === ZERO_TRACE || parentSpanId === ZERO_SPAN) return null;
  return { traceId, parentSpanId, flags };
}

function sanitizeTracestate(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > TRACESTATE_MAX_LENGTH) return undefined;
  // Environment values must not contain control bytes. Shell quoting handles
  // printable punctuation (including single quotes) below.
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return undefined;
  return trimmed;
}

function readRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.spanId === 'string'
      && /^[0-9a-f]{16}$/i.test(parsed.spanId)
      && parsed.spanId.toLowerCase() !== ZERO_SPAN
      && typeof parsed.traceparent === 'string'
      && parseTraceparent(parsed.traceparent)
    ) {
      return {
        ...parsed,
        spanId: parsed.spanId.toLowerCase(),
        tracestate: sanitizeTracestate(parsed.tracestate),
      };
    }
  } catch {
    // Missing, partial, or corrupt state is a fail-open miss.
  }
  return null;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function isToolPropagationConsumed(dataDir, sessionId) {
  try {
    return fs.statSync(consumedPath(dataDir, sessionId)).isFile();
  } catch {
    return false;
  }
}

/**
 * Reserve (or idempotently reload) the TOOL span context for one tool_use_id.
 */
export function reserveToolContext({
  dataDir,
  sessionId,
  toolUseId,
  traceparent,
  tracestate,
}) {
  if (!dataDir || !sessionId || !toolUseId) return null;
  if (isToolPropagationConsumed(dataDir, sessionId)) return null;

  const parsed = parseTraceparent(traceparent);
  if (!parsed) return null;

  const dir = correlateDir(dataDir);
  const file = contextPath(dataDir, sessionId, toolUseId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const existing = readRecord(file);
    if (existing) return existing;

    const spanId = crypto.randomBytes(8).toString('hex');
    const downstreamTraceparent = `00-${parsed.traceId}-${spanId}-${parsed.flags}`;
    const record = {
      type: 'tool',
      sessionId,
      toolUseId,
      traceId: parsed.traceId,
      spanId,
      traceparent: downstreamTraceparent,
      tracestate: sanitizeTracestate(tracestate),
      ts: new Date().toISOString(),
    };

    try {
      fs.writeFileSync(file, JSON.stringify(record), { encoding: 'utf-8', flag: 'wx' });
      return record;
    } catch (err) {
      // Duplicate hook invocation: the process that won O_EXCL owns the
      // record; reuse it so both invocations return the same context.
      if (err?.code === 'EEXIST') return readRecord(file);
      throw err;
    }
  } catch {
    return null;
  }
}

/**
 * Read and remove a reserved context after Stop has attached it to TOOL.
 */
export function consumeToolContext(dataDir, sessionId, toolUseId) {
  const file = contextPath(dataDir, sessionId, toolUseId);
  const record = readRecord(file);
  if (!record) return null;
  try { fs.unlinkSync(file); } catch {}
  return record;
}

/**
 * Mark the environment-supplied context consumed after the first Stop, keeping
 * downstream propagation aligned with TraceLinker's first-turn-only behavior.
 */
export function markToolPropagationConsumed(dataDir, sessionId) {
  if (!dataDir || !sessionId) return;
  try {
    const dir = correlateDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      consumedPath(dataDir, sessionId),
      JSON.stringify({ sessionId, ts: new Date().toISOString() }),
      { encoding: 'utf-8', flag: 'wx' },
    );
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      // fail-open
    }
  }
}

/**
 * Return a full Bash tool input replacement. No permission decision is
 * included: Claude Code must continue applying the user's existing policy.
 */
export function buildBashUpdatedInput(toolInput, context) {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  if (typeof toolInput.command !== 'string' || toolInput.command.length === 0) return null;
  if (!context || typeof context.traceparent !== 'string') return null;

  const exports = [`export TRACEPARENT=${shellSingleQuote(context.traceparent)}`];
  if (context.tracestate) {
    exports.push(`export TRACESTATE=${shellSingleQuote(context.tracestate)}`);
  }
  return {
    ...toolInput,
    command: `${exports.join('; ')};\n${toolInput.command}`,
  };
}

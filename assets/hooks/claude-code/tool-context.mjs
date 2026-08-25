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
 * Parallel hooks share one immutable turn record and publish it atomically,
 * then publish one immutable record per tool. Orphans live under acp-correlate
 * and are removed by the existing upstream-link retention job.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);
const TRACESTATE_MAX_LENGTH = 512;
const RESOURCE_ATTRIBUTES_MAX_LENGTH = 8 * 1024;
const ACP_SESSION_SCAN_MAX_BYTES = 64 * 1024;
const PUBLISHED_RECORD_READ_RETRIES = 20;
const PUBLISHED_RECORD_READ_RETRY_MS = 5;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

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

function turnContextPath(dataDir, sessionId, promptId) {
  return path.join(
    correlateDir(dataDir),
    `${safeName(sessionId)}.${safeName(promptId)}.turn-context.json`,
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

function sanitizeResourceAttributes(value) {
  if (typeof value !== 'string') return undefined;
  // File- and PowerShell-derived values commonly retain the final line ending.
  // Strip only terminal CR/LF bytes; embedded control bytes remain invalid.
  const normalized = value.replace(/[\r\n]+$/, '');
  if (!normalized.trim()
      || Buffer.byteLength(normalized, 'utf8') > RESOURCE_ATTRIBUTES_MAX_LENGTH) {
    return undefined;
  }
  if (/[\x00-\x1f\x7f]/.test(normalized)) return undefined;
  // This is an opaque carrier. Leave parsing and semantic validation to the
  // downstream OpenTelemetry SDK and preserve the caller's exact value.
  return normalized;
}

function waitForPublishedRecord() {
  Atomics.wait(WAIT_BUFFER, 0, 0, PUBLISHED_RECORD_READ_RETRY_MS);
}

function readPublishedRecord(file, reader) {
  for (let attempt = 0; attempt <= PUBLISHED_RECORD_READ_RETRIES; attempt++) {
    const record = reader(file);
    if (record) return record;
    if (attempt < PUBLISHED_RECORD_READ_RETRIES) waitForPublishedRecord();
  }
  return null;
}

/**
 * Publish a complete JSON record without ever exposing an empty/partial target.
 * A same-directory hard link is an atomic create-if-absent operation on the
 * supported local filesystems. Losers reuse the winner after a bounded retry,
 * which also interoperates with an older Pilot writer that created before write.
 */
function publishRecordExclusive(file, record, reader) {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, JSON.stringify(record), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      fs.linkSync(tmp, file);
      return record;
    } catch (err) {
      if (err?.code === 'EEXIST') return readPublishedRecord(file, reader);
      throw err;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function readTurnRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.traceId === 'string'
      && /^[0-9a-f]{32}$/i.test(parsed.traceId)
      && parsed.traceId.toLowerCase() !== ZERO_TRACE
      && typeof parsed.flags === 'string'
      && /^[0-9a-f]{2}$/i.test(parsed.flags)
      && (parsed.source === 'upstream-env' || parsed.source === 'local')
    ) {
      return {
        ...parsed,
        traceId: parsed.traceId.toLowerCase(),
        flags: parsed.flags.toLowerCase(),
        parentSpanId: typeof parsed.parentSpanId === 'string'
          && /^[0-9a-f]{16}$/i.test(parsed.parentSpanId)
          && parsed.parentSpanId.toLowerCase() !== ZERO_SPAN
          ? parsed.parentSpanId.toLowerCase()
          : undefined,
        tracestate: sanitizeTracestate(parsed.tracestate),
      };
    }
  } catch {
    // Missing, partial, or corrupt state is a fail-open miss.
  }
  return null;
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

/**
 * ACP writes its per-turn upstream record before sending the prompt. PreToolUse
 * cannot identify that record by prompt text, so generating a competing local
 * context would later be overwritten by TraceLinker and split the trace. Treat
 * a session containing ACP turn records as ACP-managed and fail open without
 * trace injection; resource attributes are still handled independently.
 */
function hasAcpTurnRecord(dataDir, sessionId) {
  const file = path.join(correlateDir(dataDir), `${safeName(sessionId)}.jsonl`);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return false;
    const length = Math.min(stat.size, ACP_SESSION_SCAN_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    const raw = buffer.subarray(0, bytesRead).toString('utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.type === 'turn' && parseTraceparent(parsed.traceparent)) return true;
      } catch {
        // A concurrently appended ACP record may be partial. The textual marker
        // is enough to choose the conservative no-local-trace path.
        if (/"type"\s*:\s*"turn"/.test(line)) return true;
      }
    }
    // A large session correlation file necessarily exceeds the bounded scan.
    // Conservatively avoid local generation rather than risk a split trace.
    return stat.size > ACP_SESSION_SCAN_MAX_BYTES;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

export function isToolPropagationConsumed(dataDir, sessionId) {
  try {
    return fs.statSync(consumedPath(dataDir, sessionId)).isFile();
  } catch {
    return false;
  }
}

/**
 * Read the trace context selected before Bash execution for one Claude turn.
 */
export function readTurnContext(dataDir, sessionId, promptId) {
  if (!dataDir || !sessionId || !promptId) return null;
  return readTurnRecord(turnContextPath(dataDir, sessionId, promptId));
}

function reserveTurnContext({
  dataDir,
  sessionId,
  promptId,
  traceparent,
  tracestate,
  generateTraceWhenMissing,
}) {
  if (!dataDir || !sessionId || !promptId) return null;

  const dir = correlateDir(dataDir);
  const file = turnContextPath(dataDir, sessionId, promptId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const existing = readTurnRecord(file);
    if (existing) {
      // Environment upstream context is first-turn-only. Do not let a delayed
      // duplicate hook resurrect it after Stop marked the session consumed.
      if (existing.source === 'upstream-env' && isToolPropagationConsumed(dataDir, sessionId)) {
        return null;
      }
      return existing;
    }

    const upstream = isToolPropagationConsumed(dataDir, sessionId)
      ? null
      : parseTraceparent(traceparent);
    if (!upstream && !generateTraceWhenMissing) return null;

    const record = upstream
      ? {
          type: 'turn',
          source: 'upstream-env',
          sessionId,
          promptId,
          traceId: upstream.traceId,
          parentSpanId: upstream.parentSpanId,
          flags: upstream.flags,
          tracestate: sanitizeTracestate(tracestate),
          ts: new Date().toISOString(),
        }
      : {
          type: 'turn',
          source: 'local',
          sessionId,
          promptId,
          traceId: crypto.randomBytes(16).toString('hex'),
          flags: '01',
          ts: new Date().toISOString(),
        };

    return publishRecordExclusive(file, record, readTurnRecord);
  } catch {
    return null;
  }
}

/**
 * Reserve (or idempotently reload) the TOOL span context for one tool_use_id.
 */
export function reserveToolContext({
  dataDir,
  sessionId,
  promptId,
  toolUseId,
  traceparent,
  tracestate,
  generateTraceWhenMissing = false,
}) {
  if (!dataDir || !sessionId || !toolUseId) return null;

  // ACP owns trace selection for the whole session. Without a reliable
  // PreToolUse prompt-to-turn key, injecting either the process upstream or a
  // local trace here could later disagree with the ACP turn selected by Pilot.
  if (hasAcpTurnRecord(dataDir, sessionId)) return null;

  let turnContext = null;
  if (promptId) {
    turnContext = reserveTurnContext({
      dataDir,
      sessionId,
      promptId,
      traceparent,
      tracestate,
      generateTraceWhenMissing,
    });
  } else if (!isToolPropagationConsumed(dataDir, sessionId)) {
    // Backward compatibility for Claude Code versions whose hooks do not
    // expose prompt_id: upstream propagation still works, but local trace
    // generation requires a stable turn identifier and therefore fails open.
    const parsed = parseTraceparent(traceparent);
    if (parsed) {
      turnContext = {
        type: 'turn',
        source: 'upstream-env',
        sessionId,
        traceId: parsed.traceId,
        parentSpanId: parsed.parentSpanId,
        flags: parsed.flags,
        tracestate: sanitizeTracestate(tracestate),
      };
    }
  }
  if (!turnContext) return null;

  const dir = correlateDir(dataDir);
  const file = contextPath(dataDir, sessionId, toolUseId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const existing = readRecord(file);
    if (existing) return existing;

    const spanId = crypto.randomBytes(8).toString('hex');
    const downstreamTraceparent = `00-${turnContext.traceId}-${spanId}-${turnContext.flags}`;
    const record = {
      type: 'tool',
      source: turnContext.source,
      sessionId,
      ...(promptId ? { promptId } : {}),
      toolUseId,
      traceId: turnContext.traceId,
      spanId,
      traceparent: downstreamTraceparent,
      tracestate: turnContext.tracestate,
      ts: new Date().toISOString(),
    };

    return publishRecordExclusive(file, record, readRecord);
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
  const file = consumedPath(dataDir, sessionId);
  try {
    const dir = correlateDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ sessionId, ts: new Date().toISOString() }),
      { encoding: 'utf-8', flag: 'wx' },
    );
  } catch (err) {
    // The marker already exists from an earlier turn. Refresh its mtime so the
    // mtime-based acp-correlate retention TTL does not reclaim the first-turn
    // marker of a session that is still active past the TTL window (which would
    // reset first-turn-only propagation and re-inject on later turns). Only a
    // truly idle session — no Stop for a full TTL — is then reclaimed.
    if (err?.code === 'EEXIST') {
      const now = new Date();
      try { fs.utimesSync(file, now, now); } catch {}
    }
    // Any other error is a fail-open miss.
  }
}

/**
 * Return a full Bash tool input replacement. No permission decision is
 * included: Claude Code must continue applying the user's existing policy.
 */
export function buildBashUpdatedInput(toolInput, context) {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  if (typeof toolInput.command !== 'string' || toolInput.command.length === 0) return null;
  const traceparent = typeof context?.traceparent === 'string' ? context.traceparent : undefined;
  const resourceAttributes = sanitizeResourceAttributes(context?.resourceAttributes);
  if (!traceparent && !resourceAttributes) return null;

  const exports = [];
  if (traceparent) exports.push(`export TRACEPARENT=${shellSingleQuote(traceparent)}`);
  if (traceparent && context.tracestate) {
    exports.push(`export TRACESTATE=${shellSingleQuote(context.tracestate)}`);
  }
  if (resourceAttributes) {
    exports.push(`export OTEL_RESOURCE_ATTRIBUTES=${shellSingleQuote(resourceAttributes)}`);
  }
  return {
    ...toolInput,
    command: `${exports.join('; ')};\n${toolInput.command}`,
  };
}

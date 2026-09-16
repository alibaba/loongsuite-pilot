// BUN_OPTIONS preload script for Claude Code fetch interception.
// Injected via: BUN_OPTIONS="--preload=<this-file>" claude ...
// Writes successful-response enrichment to:
//   ~/.loongsuite-pilot/intercept/claude-code/<session_id>/<response_id>.json
// and one metadata-only record per physical HTTP attempt to:
//   ~/.loongsuite-pilot/intercept/claude-code/<session_id>/attempts/<attempt_id>.json
//
// What it captures:
//   1. system_instructions — parsed from the outgoing /v1/messages request
//      body's `system` field, mapped to the MessagePart[] form defined by
//      loongsuite-pilot/specs/gen-ai-system_instructions.json (TextPart uses
//      `content`, not the Anthropic `text` field). The first block, which is
//      a Claude Code billing-header marker, is filtered out.
//   2. response_id — extracted from the first SSE `message_start` event's
//      `message.id`. Same value pilot already stores under
//      `gen_ai.response.id`, so the hook processor can join 1:1.
//   3. ttft_ns — performance.now() delta (ms) at the moment the first
//      content_block_delta (text_delta / thinking_delta / input_json_delta)
//      arrives, converted to integer nanoseconds.
//   4. every HTTP attempt — start/end time, status/outcome, provider/client
//      request ids, model, and a SHA-256 request-body hash. Request and response
//      bodies are never persisted.
//
// Design notes:
//   - SSE is parsed by splitting the accumulated buffer on `\n\n` event
//     boundaries. A sliding-window regex was tried first and silently
//     corrupted long preambles — do NOT change back.
//   - Once both response_id and ttft_ns are captured we stop parsing and
//     transparently pipe the rest of the stream, keeping memory bounded.
//   - All work is wrapped in try/catch; an exception here must never break
//     Claude Code's own fetch flow.
//   - NOTE: This file uses require() which is Bun-specific in .mjs context.
//     It only runs under BUN_OPTIONS --preload inside a compiled Bun binary
//     (Claude Code CLI).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const INTERCEPT_BASE = path.join(
  process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || '/tmp', '.loongsuite-pilot'),
  'intercept',
  'claude-code',
);
const LLM_URL_RE = /\/v1\/messages(?:\?|$|\/)/;
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';
const SSE_DELIMITER = '\n\n';
const ATTEMPT_SCHEMA_VERSION = 1;

// W3C Trace Context — https://www.w3.org/TR/trace-context/#traceparent-header-field-values
// Forward the launching process's TRACEPARENT (+ TRACESTATE when valid) into
// outbound /v1/messages requests so the gateway can join the caller's trace.
// The env vars are populated by whoever spawned Claude Code (upstream service
// or the loongsuite-pilot ACP linker); the preload does not mint new context.
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);
const TRACESTATE_MAX_LEN = 512;
const TRACESTATE_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

// ─── system_instructions extraction ──────────────────────────────────────

function extractSystemInstructions(systemField) {
  if (systemField == null) return null;
  // Defensive: accept a bare string and wrap (spec returns array form)
  if (typeof systemField === 'string') {
    if (systemField.startsWith(BILLING_HEADER_PREFIX)) return null;
    return [{ type: 'text', content: systemField }];
  }
  if (!Array.isArray(systemField)) return null;

  const result = [];
  for (const block of systemField) {
    if (!block || typeof block !== 'object') continue;
    const type = block.type;
    if (type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text.startsWith(BILLING_HEADER_PREFIX)) continue;
      result.push({ type: 'text', content: text });
    } else if (typeof type === 'string') {
      // Non-text block: pass through under GenericPart (spec allows
      // additionalProperties). Preserve all original fields so server-side
      // consumers see everything.
      const { type: t, ...rest } = block;
      result.push({ type: t, ...rest });
    }
  }
  return result.length > 0 ? result : null;
}

// ─── header / body helpers ────────────────────────────────────────────────

function dumpHeaders(h) {
  const out = {};
  if (!h) return out;
  try {
    if (typeof h.forEach === 'function') {
      h.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
    } else if (typeof h === 'object') {
      for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
    }
  } catch (_) {}
  return out;
}

function readBodyAsText(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) {
    try { return new TextDecoder().decode(body); } catch (_) { return null; }
  }
  if (body instanceof ArrayBuffer) {
    try { return new TextDecoder().decode(new Uint8Array(body)); } catch (_) { return null; }
  }
  return null;
}

function safeParseRequestMetadata(body) {
  const text = readBodyAsText(body);
  if (!text) return { systemInstructions: null, model: null, requestHash: null };
  const requestHash = crypto.createHash('sha256').update(text).digest('hex');
  try {
    const parsed = JSON.parse(text);
    return {
      systemInstructions: extractSystemInstructions(parsed.system),
      model: typeof parsed.model === 'string' ? parsed.model.slice(0, 256) : null,
      requestHash,
    };
  } catch (_) {
    return { systemInstructions: null, model: null, requestHash };
  }
}

// ─── intercept record writer ──────────────────────────────────────────────

function writeRecord(sessionId, record) {
  try {
    const dir = path.join(INTERCEPT_BASE, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${record.response_id}.json`);
    // Single record per file (~27KB worst case) — POSIX guarantees writes
    // under PIPE_BUF (~4KB) are atomic; for larger writes appendFileSync
    // could interleave, but writeFileSync writes once to a fresh inode so
    // partial reads aren't a concern in practice.
    fs.writeFileSync(file, JSON.stringify(record));
  } catch (_) {
    // intercept storage failure must not affect the host process
  }
}

function writeAttemptRecord(sessionId, record) {
  try {
    const dir = path.join(INTERCEPT_BASE, sessionId, 'attempts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${record.attempt_id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
  } catch (_) {
    // attempt telemetry is best-effort and must never affect Claude Code
  }
}

function responseRequestId(headers) {
  const values = dumpHeaders(headers);
  return values['request-id'] || values['x-request-id'] || null;
}

function httpErrorType(status) {
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  if (status === 401 || status === 403) return 'authentication_error';
  if (status >= 500) return 'server_error';
  return 'api_error';
}

function normalizeNetworkError(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 64);
  return normalized || 'network_error';
}

// ─── SSE event-block parsing ──────────────────────────────────────────────

/**
 * Parse a single complete SSE event block (text between two `\n\n`).
 * Returns { event, data } or null if malformed.
 */
function parseSseBlock(block) {
  let event = null;
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!event || dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

// ─── globalThis.fetch monkey-patch ───────────────────────────────────────

// Cache validated upstream context once. Env vars set on the Claude Code
// process are stable for its lifetime; re-parsing per-request is wasted work.
const UPSTREAM_TRACEPARENT = validateTraceparent(process.env.TRACEPARENT);
const UPSTREAM_TRACESTATE = UPSTREAM_TRACEPARENT ? validateTracestate(process.env.TRACESTATE) : null;

function validateTraceparent(raw) {
  if (typeof raw !== 'string') return null;
  const m = TRACEPARENT_RE.exec(raw.trim());
  if (!m) return null;
  const version = m[1].toLowerCase();
  const traceId = m[2].toLowerCase();
  const spanId = m[3].toLowerCase();
  const flags = m[4].toLowerCase();
  // Spec: 'ff' is reserved/invalid. Future versions may extend the format;
  // we only forward known-good '00' so we don't mis-propagate.
  if (version !== '00') return null;
  if (traceId === ZERO_TRACE_ID) return null;
  if (spanId === ZERO_SPAN_ID) return null;
  return `${version}-${traceId}-${spanId}-${flags}`;
}

function validateTracestate(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > TRACESTATE_MAX_LEN) return null;
  if (TRACESTATE_CONTROL_CHAR_RE.test(trimmed)) return null;
  return trimmed;
}

function normalizeHeaders(source) {
  const out = {};
  if (!source) return out;
  try {
    if (typeof source.forEach === 'function') {
      source.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
    } else if (Array.isArray(source)) {
      for (const pair of source) {
        if (Array.isArray(pair) && pair.length === 2) {
          out[String(pair[0]).toLowerCase()] = String(pair[1]);
        }
      }
    } else if (typeof source === 'object') {
      for (const k of Object.keys(source)) out[k.toLowerCase()] = String(source[k]);
    }
  } catch (_) {}
  return out;
}

// Inject upstream W3C context onto an outbound fetch pair. Preserves existing
// traceparent so a caller who already set the header (e.g. via a middleware)
// stays authoritative. When input is a Request instance, init.headers wins
// over Request.headers per fetch semantics, so we merge Request.headers into
// our normalized set before overwriting. Fail-open: any error returns the
// original pair unchanged.
function injectUpstreamTraceContext(input, init) {
  try {
    if (!UPSTREAM_TRACEPARENT) return { input, init };
    const source = init?.headers ?? (input && typeof input === 'object' ? input.headers : null);
    const normalized = normalizeHeaders(source);
    if (normalized.traceparent) return { input, init };
    normalized.traceparent = UPSTREAM_TRACEPARENT;
    if (UPSTREAM_TRACESTATE) normalized.tracestate = UPSTREAM_TRACESTATE;
    return { input, init: { ...(init || {}), headers: normalized } };
  } catch (_) {
    return { input, init };
  }
}

const origFetch = globalThis.fetch;
if (typeof origFetch === 'function') {
  globalThis.fetch = async function patchedFetch(input, init) {
    let url;
    try {
      url = typeof input === 'string' ? input
          : (input && typeof input === 'object' && typeof input.url === 'string') ? input.url
          : String(input);
    } catch (_) {
      url = '';
    }

    if (!url || !LLM_URL_RE.test(url)) {
      return origFetch.call(this, input, init);
    }

    // Forward the upstream W3C traceparent to the gateway. Runs before any
    // early return so the header lands even when we can't extract our own
    // session id — it's the gateway's concern, not ours.
    ({ input, init } = injectUpstreamTraceContext(input, init));

    // Header session_id is required to scope intercept output. Without it
    // we have no way for the hook processor to find this record, so we
    // skip writing — let the request go through normally.
    let sessionId = null;
    let systemInstructions = null;
    let model = null;
    let requestHash = null;
    let clientRequestId = null;
    try {
      const headers = dumpHeaders(
        init?.headers ?? (input && typeof input === 'object' ? input.headers : null),
      );
      sessionId = headers['x-claude-code-session-id'] || null;
      clientRequestId = headers['x-client-request-id'] || null;
      if (sessionId) {
        const body = init?.body
          ?? (input && typeof input === 'object' ? input.body : null);
        ({ systemInstructions, model, requestHash } = safeParseRequestMetadata(body));
      }
    } catch (_) {}

    if (!sessionId) {
      return origFetch.call(this, input, init);
    }

    const attemptId = crypto.randomUUID();
    const startedUnixNs = BigInt(Date.now()) * 1_000_000n;
    const startedMonoNs = process.hrtime.bigint();
    let attemptWritten = false;
    const writeAttempt = (fields) => {
      if (attemptWritten) return;
      const durationNs = process.hrtime.bigint() - startedMonoNs;
      writeAttemptRecord(sessionId, {
        schema_version: ATTEMPT_SCHEMA_VERSION,
        session_id: sessionId,
        attempt_id: attemptId,
        client_request_id: clientRequestId,
        request_hash: requestHash,
        model,
        start_time_unix_nano: String(startedUnixNs),
        end_time_unix_nano: String(startedUnixNs + durationNs),
        duration_ns: Number(durationNs <= BigInt(Number.MAX_SAFE_INTEGER)
          ? durationNs : BigInt(Number.MAX_SAFE_INTEGER)),
        ...fields,
      });
      attemptWritten = true;
    };

    const startMs = performance.now();
    let response;
    try {
      response = await origFetch.call(this, input, init);
    } catch (err) {
      writeAttempt({
        outcome: 'network_error',
        status_code: null,
        error_type: normalizeNetworkError(err),
        request_id: null,
        response_id: null,
        ttft_ns: null,
      });
      throw err;
    }

    if (!response.ok) {
      writeAttempt({
        outcome: 'http_error',
        status_code: response.status,
        error_type: httpErrorType(response.status),
        request_id: responseRequestId(response.headers),
        response_id: null,
        ttft_ns: null,
      });
      return response;
    }

    // No body (HEAD-style, 204, etc.) → can't observe stream.
    if (!response || !response.body) {
      writeAttempt({
        outcome: 'success',
        status_code: response?.status ?? null,
        error_type: null,
        request_id: responseRequestId(response?.headers),
        response_id: null,
        ttft_ns: null,
      });
      return response;
    }

    let responseId = null;
    let ttftNs = null;
    let recordWritten = false;
    let stopParsing = false;
    const decoder = new TextDecoder();
    let pending = '';

    const tryEmit = () => {
      if (recordWritten || !responseId) return;
      writeRecord(sessionId, {
        session_id: sessionId,
        response_id: responseId,
        ttft_ns: ttftNs,
        system_instructions: systemInstructions,
      });
      writeAttempt({
        outcome: 'success',
        status_code: response.status,
        error_type: null,
        request_id: responseRequestId(response.headers),
        response_id: responseId,
        ttft_ns: ttftNs,
      });
      recordWritten = true;
    };

    const processBlock = (block) => {
      const parsed = parseSseBlock(block);
      if (!parsed) return;
      if (parsed.event === 'message_start' && responseId === null) {
        try {
          const evt = JSON.parse(parsed.data);
          if (evt?.message?.id) responseId = String(evt.message.id);
        } catch (_) {}
      } else if (parsed.event === 'content_block_delta' && ttftNs === null) {
        try {
          const evt = JSON.parse(parsed.data);
          const dtype = evt?.delta?.type;
          if (dtype === 'text_delta' || dtype === 'thinking_delta' || dtype === 'input_json_delta') {
            const ms = performance.now() - startMs;
            ttftNs = Math.max(0, Math.round(ms * 1e6));
          }
        } catch (_) {}
      }
    };

    const parseChunk = (chunk) => {
      if (stopParsing) return;
      try {
        pending += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = pending.indexOf(SSE_DELIMITER)) !== -1) {
          const block = pending.slice(0, idx);
          pending = pending.slice(idx + SSE_DELIMITER.length);
          processBlock(block);
        }
        if (responseId && ttftNs !== null) {
          tryEmit();
          stopParsing = true;
          pending = '';
        }
      } catch (_) {}
    };

    let reader;
    try {
      reader = response.body.getReader();
    } catch (_) {
      writeAttempt({
        outcome: 'success', status_code: response.status, error_type: null,
        request_id: responseRequestId(response.headers), response_id: null, ttft_ns: null,
      });
      return response;
    }

    // Explicit ReadableStream wrapper instead of TransformStream. The
    // transformer's cancel() callback does NOT fire on Node 18 when the
    // consumer aborts an already-200 response, so a user interrupt would leave
    // the physical attempt with no telemetry. An explicit ReadableStream's
    // cancel() fires reliably across Node 18/20/22 and Bun.
    let canceled = false;
    let wrappedBody;
    try {
      wrappedBody = new ReadableStream({
        async pull(controller) {
          let result;
          try {
            result = await reader.read();
          } catch (err) {
            // Upstream body errored mid-stream after a 200: the physical
            // attempt failed. Record it and propagate the error to the
            // consumer so interception stays transparent.
            if (canceled) return;
            if (!attemptWritten) {
              writeAttempt({
                outcome: 'network_error',
                status_code: response.status,
                error_type: normalizeNetworkError(err),
                request_id: responseRequestId(response.headers),
                response_id: responseId,
                ttft_ns: ttftNs,
              });
            }
            controller.error(err);
            return;
          }
          // cancel() already ran (consumer aborted): the pending read resolves
          // done, but the attempt is recorded and the controller is closed —
          // don't emit a spurious success record or touch the controller.
          if (canceled) return;
          if (result.done) {
            // Stream ended normally without ever producing a content delta
            // (e.g. tool-only response that arrived as a single block, or
            // server returned an error mid-stream). Persist whatever we have.
            if (!recordWritten && responseId) tryEmit();
            if (!attemptWritten) {
              writeAttempt({
                outcome: 'success',
                status_code: response.status,
                error_type: null,
                request_id: responseRequestId(response.headers),
                response_id: responseId,
                ttft_ns: ttftNs,
              });
            }
            controller.close();
            return;
          }
          controller.enqueue(result.value); // pass through first, parsing is best-effort
          parseChunk(result.value);
        },
        cancel(reason) {
          // Downstream aborted an already-200 response mid-stream (user
          // interrupt / turn cancel). Cancel the upstream reader and record the
          // attempt. Not a success anchor: mark it non-success so retry grouping
          // doesn't treat it as the terminating success of a retry chain.
          canceled = true;
          try { reader.cancel(reason); } catch (_) {}
          if (attemptWritten) return;
          writeAttempt({
            outcome: 'network_error',
            status_code: response.status,
            error_type: 'aborted',
            request_id: responseRequestId(response.headers),
            response_id: responseId,
            ttft_ns: ttftNs,
          });
        },
      });
    } catch (_) {
      // ReadableStream construction failed (very old runtime): bail out and
      // return the original response untouched.
      try { reader.cancel(); } catch (_) {}
      writeAttempt({
        outcome: 'success', status_code: response.status, error_type: null,
        request_id: responseRequestId(response.headers), response_id: null, ttft_ns: null,
      });
      return response;
    }

    try {
      return new Response(wrappedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (_) {
      writeAttempt({
        outcome: 'success', status_code: response.status, error_type: null,
        request_id: responseRequestId(response.headers), response_id: null, ttft_ns: null,
      });
      return response;
    }
  };
}

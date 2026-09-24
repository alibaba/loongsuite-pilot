// BUN_OPTIONS preload script for Claude Code fetch interception.
// Injected via: BUN_OPTIONS="--preload=<this-file>" claude ...
// Writes early response enrichment to:
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
//   5. llm_span_id — the span id minted for this attempt and advertised to the
//      gateway as traceparent parent-id, recorded on both the response record
//      and the attempt record so the hook processor can reuse it.
//
// What it forwards:
//   - traceparent / tracestate — the W3C trace context inherited from the
//     process that launched Claude Code, injected onto the outgoing
//     /v1/messages request so a user-operated gateway can join the caller's
//     trace. trace-id/flags pass through untouched; parent-id is replaced with
//     llm_span_id. Off unless both `upstreamLink.enabled` and
//     `upstreamLink.propagateToLlm` are set. See the "W3C trace-context
//     forwarding" section below.
//
// Design notes:
//   - SSE is parsed by splitting the accumulated buffer on `\n\n` event
//     boundaries. A sliding-window regex was tried first and silently
//     corrupted long preambles — do NOT change back.
//   - Enrichment is emitted early; parsing continues until message_stop/error.
//   - Telemetry is best-effort; fetch, read and cancel errors still propagate.
//   - NOTE: This file uses require() which is Bun-specific in .mjs context.
//     It only runs under BUN_OPTIONS --preload inside a compiled Bun binary
//     (Claude Code CLI).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PILOT_DATA_DIR = process.env.LOONGSUITE_PILOT_DATA_DIR
  || path.join(process.env.HOME || '/tmp', '.loongsuite-pilot');
const INTERCEPT_BASE = path.join(PILOT_DATA_DIR, 'intercept', 'claude-code');
const LLM_URL_RE = /\/v1\/messages(?:\?|$|\/)/;
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';
// SSE frames a blank line as the event boundary; per spec the line
// terminator may be LF, CRLF, or a bare CR. Only splitting on `\n\n`
// misclassifies valid CRLF/CR streams as incomplete (false failures),
// so match all three forms — longest first so `\r\n\r\n` is not split.
const SSE_BOUNDARY_RE = /\r\n\r\n|\r\r|\n\n/g;
const SSE_LINE_RE = /\r\n|\r|\n/;
const ATTEMPT_SCHEMA_VERSION = 1;
const SSE_ERROR_TYPES = new Set([
  'invalid_request_error', 'authentication_error', 'permission_error',
  'not_found_error', 'request_too_large', 'rate_limit_error',
  'api_error', 'overloaded_error',
]);

// W3C Trace Context — https://www.w3.org/TR/trace-context/
// version-format for version 00 is exactly four hyphen-separated fields; a
// version-00 traceparent carrying trailing fields is invalid per spec.
const TRACEPARENT_RE = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_PARENT_ID = '0'.repeat(16);
const SPAN_ID_RE = /^[\da-f]{16}$/;
// Spec: tracestate holds at most 32 list-members and implementations may drop
// one larger than 512 bytes.
const TRACESTATE_MAX_BYTES = 512;
const TRACESTATE_MAX_MEMBERS = 32;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

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
    if (Array.isArray(h)) {
      for (const [k, v] of h) out[String(k).toLowerCase()] = v;
    } else if (typeof h.forEach === 'function') {
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
 * Parse a single complete SSE event block (text between two event
 * boundaries). Lines may be terminated by LF, CRLF, or a bare CR.
 * Returns { event, data } or null if malformed.
 */
function parseSseBlock(block) {
  let event = null;
  const dataLines = [];
  for (const line of block.split(SSE_LINE_RE)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!event || dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

// ─── W3C trace-context forwarding ─────────────────────────────────────────
// Claude Code's LLM traffic often terminates at a user-operated
// Anthropic-compatible gateway. When the process that launched Claude Code
// passed down a trace context, forwarding it as a real `traceparent` header
// lets that gateway (and anything behind it) attach its spans to the caller's
// trace instead of starting an orphan one.
//
// We never mint a trace id, so the trace stays the caller's. parent-id is a
// different matter: per spec it is "the ID of this request as known by the
// caller", so forwarding the upstream value verbatim would make the gateway's
// spans siblings of Claude Code's ENTRY span. Substituting the span id minted
// for this physical attempt nests them under the attempt that actually issued
// the request — a retried call emits one span per attempt, so a per-call id
// would leave the gateway pointing at an arbitrary one of them.

function parseTraceparent(raw) {
  if (typeof raw !== 'string') return null;
  const m = TRACEPARENT_RE.exec(raw.trim());
  if (!m) return null;
  const [, version, traceId, parentId, flags] = m.map((v) => v.toLowerCase());
  // 'ff' is forbidden outright; any other unknown version may carry extra
  // fields we cannot reason about, so only the format we fully understand is
  // forwarded.
  if (version !== '00') return null;
  if (traceId === ZERO_TRACE_ID || parentId === ZERO_PARENT_ID) return null;
  return { version, traceId, parentId, flags };
}

function formatTraceparent(parts, spanId) {
  const parentId = SPAN_ID_RE.test(spanId || '') && spanId !== ZERO_PARENT_ID
    ? spanId
    : parts.parentId;
  return `${parts.version}-${parts.traceId}-${parentId}-${parts.flags}`;
}

function mintSpanId() {
  try {
    return crypto.randomBytes(8).toString('hex');
  } catch (_) {
    return null;
  }
}

function validateTracestate(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (Buffer.byteLength(trimmed, 'utf8') > TRACESTATE_MAX_BYTES) return null;
  if (CONTROL_CHAR_RE.test(trimmed)) return null;
  const members = trimmed.split(',').filter((part) => part.trim() !== '');
  if (members.length === 0 || members.length > TRACESTATE_MAX_MEMBERS) return null;
  return trimmed;
}

function readHeaderValue(source, name) {
  if (!source) return null;
  try {
    if (typeof source.get === 'function') return source.get(name);
    if (Array.isArray(source)) {
      for (const pair of source) {
        if (Array.isArray(pair) && pair.length === 2 && String(pair[0]).toLowerCase() === name) {
          return String(pair[1]);
        }
      }
      return null;
    }
    if (typeof source === 'object') {
      for (const k of Object.keys(source)) {
        if (k.toLowerCase() === name) return String(source[k]);
      }
    }
  } catch (_) {}
  return null;
}

// Copy into a Headers instance rather than a plain object: Headers keeps
// duplicate-name semantics and case normalization that an object copy would
// silently flatten. Returning null makes the caller fail open.
function cloneHeaders(source) {
  if (typeof Headers !== 'function') return null;
  try {
    return source ? new Headers(source) : new Headers();
  } catch (_) {
    return null;
  }
}

// Reads the same `upstreamLink` block the collector and the hook processor read,
// duplicated here because this file runs through require() inside Bun and cannot
// import the ESM helper in agent-event-normalizer.mjs.
function llmPropagationEnabled() {
  const envBool = (name) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return null;
    return raw === '1' || raw.toLowerCase() === 'true';
  };
  let file = {};
  try {
    const configPath = process.env.AGENT_DATA_COLLECTION_CONFIG
      || path.join(PILOT_DATA_DIR, 'config.json');
    if (fs.existsSync(configPath)) file = JSON.parse(fs.readFileSync(configPath, 'utf-8')) || {};
  } catch (_) {
    file = {};
  }
  const link = file.upstreamLink && typeof file.upstreamLink === 'object' ? file.upstreamLink : {};
  const enabled = envBool('LOONGSUITE_PILOT_UPSTREAM_LINK') ?? link.enabled === true;
  const toLlm = envBool('LOONGSUITE_PILOT_UPSTREAM_LINK_PROPAGATE_TO_LLM')
    ?? link.propagateToLlm === true;
  // Both halves: forwarding a context the collector is not linking would point
  // the gateway at a span that only exists inside pilot's private trace.
  return enabled && toLlm;
}

// Evaluated after the validators are defined — a top-level const that called a
// hoisted function would throw at preload time the moment someone converted
// those declarations to arrow functions, and a throw here would leave fetch
// completely uninstrumented.
const UPSTREAM_TRACE_PARTS = (() => {
  try {
    if (!llmPropagationEnabled()) return null;
    return parseTraceparent(process.env.TRACEPARENT);
  } catch (_) {
    return null;
  }
})();
const UPSTREAM_TRACESTATE = (() => {
  try {
    // tracestate is meaningless without the traceparent it annotates.
    return UPSTREAM_TRACE_PARTS ? validateTracestate(process.env.TRACESTATE) : null;
  } catch (_) {
    return null;
  }
})();

function withUpstreamTraceContext(input, init, llmSpanId) {
  // No usable upstream context: hand back the exact original pair so the
  // untraced path behaves as if this feature did not exist.
  if (!UPSTREAM_TRACE_PARTS) return { input, init };
  try {
    const existing = init?.headers ?? (input && typeof input === 'object' ? input.headers : null);
    // Someone closer to the request already chose a parent; a propagator must
    // not overwrite a context it did not create.
    if (readHeaderValue(existing, 'traceparent') !== null) return { input, init };

    const headers = cloneHeaders(existing);
    if (!headers) return { input, init };
    headers.set('traceparent', formatTraceparent(UPSTREAM_TRACE_PARTS, llmSpanId));
    if (UPSTREAM_TRACESTATE) headers.set('tracestate', UPSTREAM_TRACESTATE);

    // Only headers are overridden. When `input` is a Request, fetch still
    // takes method/body/signal from it, so the body stream is never touched.
    return { input, init: { ...(init || {}), headers } };
  } catch (_) {
    return { input, init };
  }
}

// ─── globalThis.fetch monkey-patch ───────────────────────────────────────

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

    // Header session_id is required to scope intercept output. Without it
    // we have no way for the hook processor to find this record, so we
    // skip writing — let the request go through normally.
    let sessionId = null;
    let systemInstructions = null;
    let model = null;
    let requestHash = null;
    let clientRequestId = null;
    let llmSpanId = null;
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
        // Only mint when a record can be written: a parent-id nobody records
        // would point the gateway at a span pilot never emits, which is worse
        // than forwarding the upstream parent verbatim.
        if (UPSTREAM_TRACE_PARTS) llmSpanId = mintSpanId();
      }
    } catch (_) {}

    // Forward the caller's trace context before the session-id gate below:
    // that gate decides whether *we* can record telemetry, which has no
    // bearing on the gateway's ability to join the trace.
    ({ input, init } = withUpstreamTraceContext(input, init, llmSpanId));

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
        ...(llmSpanId ? { llm_span_id: llmSpanId } : {}),
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

    const isSse = /^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') || '');
    let responseId = null;
    let ttftNs = null;
    let recordWritten = false;
    let stopParsing = !isSse;
    const decoder = new TextDecoder();
    let pending = '';

    // Early enrichment must not finalize an attempt before its protocol terminal.
    const tryEmit = () => {
      if (recordWritten || !responseId) return;
      writeRecord(sessionId, {
        session_id: sessionId,
        response_id: responseId,
        ttft_ns: ttftNs,
        system_instructions: systemInstructions,
        ...(llmSpanId ? { llm_span_id: llmSpanId } : {}),
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
      } else if (parsed.event === 'message_stop' || parsed.event === 'error') {
        let errorType = null;
        if (parsed.event === 'error') {
          errorType = 'api_error';
          try {
            const type = JSON.parse(parsed.data)?.error?.type;
            if (SSE_ERROR_TYPES.has(type)) errorType = type;
          } catch (_) {}
        } else {
          tryEmit();
        }
        writeAttempt({
          outcome: errorType ? 'network_error' : 'success',
          status_code: response.status,
          error_type: errorType,
          request_id: responseRequestId(response.headers),
          response_id: responseId,
          ttft_ns: ttftNs,
        });
        stopParsing = true;
      }
      if (responseId && ttftNs !== null) tryEmit();
    };

    const parseChunk = (chunk) => {
      if (stopParsing) return;
      try {
        pending += decoder.decode(chunk, { stream: true });
        let match;
        SSE_BOUNDARY_RE.lastIndex = 0;
        while (!stopParsing && (match = SSE_BOUNDARY_RE.exec(pending)) !== null) {
          const block = pending.slice(0, match.index);
          pending = pending.slice(match.index + match[0].length);
          SSE_BOUNDARY_RE.lastIndex = 0;
          processBlock(block);
        }
        if (stopParsing) pending = '';
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
            // Propagate read errors without overwriting an observed protocol terminal.
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
            // SSE EOF without a protocol terminal is an incomplete attempt.
            if (!recordWritten && responseId) tryEmit();
            if (!attemptWritten) {
              writeAttempt({
                outcome: isSse ? 'network_error' : 'success',
                status_code: response.status,
                error_type: isSse ? 'incomplete_stream' : null,
                request_id: responseRequestId(response.headers),
                response_id: responseId,
                ttft_ns: ttftNs,
              });
            }
            controller.close();
            return;
          }
          parseChunk(result.value); // Persist the terminal before exposing it to the consumer.
          controller.enqueue(result.value);
        },
        cancel(reason) {
          // A protocol terminal wins over any later consumer cancellation.
          canceled = true;
          writeAttempt({
            outcome: 'network_error',
            status_code: response.status,
            error_type: 'aborted',
            request_id: responseRequestId(response.headers),
            response_id: responseId,
            ttft_ns: ttftNs,
          });
          return reader.cancel(reason);
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

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.resolve(__dirname, '../../../../assets/hooks/claude-code-fetch-intercept.mjs');

let DATA_DIR;
let INTERCEPT_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fetch-intercept-test-'));
  INTERCEPT_DIR = path.join(DATA_DIR, 'intercept', 'claude-code');
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

// Run the preload in a subprocess with offline fetch/Response streams.
function runScenario({
  url,
  sessionId,
  body,
  rawBody,
  sseEvents = [],
  rawChunks,
  responseText,
  networkDelayMs = 0,
  status = 200,
  responseHeaders = {},
  networkError = null,
  clientRequestId = null,
  requestHeaders,
  env = {},
  keepStreamOpen = false,
  cancelMidStream = false,
  cancelAfterReads = 1,
  rejectCancel = false,
  streamErrorAfterReads = 0,
  snapshotAfterReads = 0,
}) {
  const chunksJson = JSON.stringify(
    rawChunks !== undefined ? rawChunks
    : responseText !== undefined ? [responseText]
    : sseEvents.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
  const bodyJson = rawBody !== undefined ? rawBody : JSON.stringify(body);
  const headers = requestHeaders ?? {
    ...(sessionId ? { 'x-claude-code-session-id': sessionId } : {}),
    ...(clientRequestId ? { 'x-client-request-id': clientRequestId } : {}),
  };
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const assert = require('node:assert/strict');
    globalThis.ReadableStream = require('node:stream/web').ReadableStream;
    const chunks = ${chunksJson};
    const encoder = new TextEncoder();
    const requestHeaders = ${JSON.stringify(headers)};
    const cancelFailure = new Error('simulated cancel failure');
    let failStream;
    process.exitCode = 1;

    globalThis.fetch = async function (input, init) {
      fs.writeFileSync(${JSON.stringify(path.join(DATA_DIR, 'outbound-headers.json'))}, JSON.stringify({
        headers: init.headers,
        sameHeaders: init.headers === requestHeaders,
      }));
      if (${networkDelayMs} > 0) await new Promise(r => setTimeout(r, ${networkDelayMs}));
      if (${JSON.stringify(networkError)}) throw Object.assign(new Error('simulated network failure'), { name: ${JSON.stringify(networkError)} });
      let nextChunk = 0;
      const stream = new ReadableStream({
        start(controller) {
          failStream = () => controller.error(new TypeError('simulated stream failure'));
        },
        pull(controller) {
          if (nextChunk < chunks.length) controller.enqueue(encoder.encode(chunks[nextChunk++]));
          else if (!${JSON.stringify(keepStreamOpen)}) controller.close();
        },
        cancel(reason) {
          fs.writeFileSync(${JSON.stringify(path.join(DATA_DIR, 'cancel-reason.json'))}, JSON.stringify(reason));
          if (${JSON.stringify(rejectCancel)}) return Promise.reject(cancelFailure);
        },
      });
      return new Response(stream, {
        status: ${status},
        headers: { 'content-type': 'text/event-stream', ...${JSON.stringify(responseHeaders)} },
      });
    };

    process.env.LOONGSUITE_PILOT_DATA_DIR = ${JSON.stringify(DATA_DIR)};

    (async () => {
      await import(${JSON.stringify('file://' + PRELOAD)});
      const res = await globalThis.fetch(${JSON.stringify(url)}, {
        method: 'POST',
        headers: requestHeaders,
        body: ${JSON.stringify(bodyJson)},
      });

      if (res.body) {
        const reader = res.body.getReader();
        let reads = 0;
        while (true) {
          const { done } = await reader.read();
          if (done) break;
          reads++;
          if (reads === ${snapshotAfterReads}) {
            const dir = ${JSON.stringify(path.join(INTERCEPT_DIR, sessionId || 'missing'))};
            const readRecords = (p) => fs.existsSync(p)
              ? fs.readdirSync(p).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(p, n), 'utf8')))
              : [];
            fs.writeFileSync(${JSON.stringify(path.join(DATA_DIR, 'observed-records.json'))}, JSON.stringify({
              enrichment: readRecords(dir), attempts: readRecords(path.join(dir, 'attempts')),
            }));
          }
          if (reads === ${streamErrorAfterReads}) failStream();
          if (${JSON.stringify(cancelMidStream)} && reads === ${cancelAfterReads}) {
            const canceled = reader.cancel('test-abort');
            if (${JSON.stringify(rejectCancel)}) await assert.rejects(canceled, e => e === cancelFailure);
            else await canceled;
            break;
          }
        }
      }
      await new Promise(setImmediate);
    })().then(
      () => process.exit(0),
      (e) => { console.error(String(e)); process.exit(1); }
    );
  `;
  const baseEnv = { ...process.env };
  delete baseEnv.TRACEPARENT;
  delete baseEnv.TRACESTATE;
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf-8',
    env: { ...baseEnv, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR, ...env },
    timeout: 10_000,
  });
}

function readIntercept(sessionId) {
  const dir = path.join(INTERCEPT_DIR, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => ({
    name: n,
    record: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')),
  }));
}

function readAttempts(sessionId) {
  const dir = path.join(INTERCEPT_DIR, sessionId, 'attempts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) =>
    JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')));
}

const LLM_URL = 'https://api.anthropic.com/v1/messages';
const SESS = 'sess-12345';
const MSG_ID = 'msg_test_01';

function sseStream(opts = {}) {
  const events = [{
    event: 'message_start',
    data: { type: 'message_start', message: { id: opts.msgId ?? MSG_ID, model: 'claude-test', role: 'assistant' } },
  }];
  if (opts.includeContentDelta !== false) {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: 0 } });
    events.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: opts.deltaType ?? 'text_delta', text: 'hi' } },
    });
  }
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}

describe('claude-code-fetch-intercept preload', () => {
  test('captures system_instructions in spec format (text → content, filters billing header)', () => {
    const body = {
      model: 'claude-opus-4-7',
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.119;' },
        { type: 'text', text: 'You are a Claude agent.' },
        { type: 'text', text: 'CLAUDE.md content here.' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    };
    const r = runScenario({ url: LLM_URL, sessionId: SESS, body, sseEvents: sseStream() });
    expect(r.status).toBe(0);

    const files = readIntercept(SESS);
    expect(files).toHaveLength(1);
    const rec = files[0].record;
    expect(rec.session_id).toBe(SESS);
    expect(rec.response_id).toBe(MSG_ID);
    expect(rec.system_instructions).toEqual([
      { type: 'text', content: 'You are a Claude agent.' },
      { type: 'text', content: 'CLAUDE.md content here.' },
    ]);
    expect(readAttempts(SESS)).toMatchObject([{
      schema_version: 1,
      session_id: SESS,
      outcome: 'success',
      status_code: 200,
      response_id: MSG_ID,
      model: 'claude-opus-4-7',
    }]);
  });

  test('captures TTFT as integer nanoseconds for text_delta', () => {
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { system: 'sys', messages: [] },
      sseEvents: sseStream(),
      networkDelayMs: 30,
    });
    expect(r.status).toBe(0);
    const [{ record }] = readIntercept(SESS);
    expect(typeof record.ttft_ns).toBe('number');
    expect(Number.isInteger(record.ttft_ns)).toBe(true);
    expect(record.ttft_ns).toBeGreaterThan(0);
    expect(record.ttft_ns).toBeLessThan(60_000_000_000); // < 60s
  });

  test.each(['thinking_delta', 'input_json_delta'])('TTFT also captures on %s', (deltaType) => {
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { system: 'sys', messages: [] },
      sseEvents: sseStream({ deltaType }),
    });
    expect(r.status).toBe(0);
    const [{ record }] = readIntercept(SESS);
    expect(typeof record.ttft_ns).toBe('number');
  });

  test('filename = response_id and record.response_id matches', () => {
    const customMsg = 'msg_custom_xyz';
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { system: 'sys', messages: [] },
      sseEvents: sseStream({ msgId: customMsg }),
    });
    expect(r.status).toBe(0);
    const files = readIntercept(SESS);
    expect(files[0].name).toBe(`${customMsg}.json`);
    expect(files[0].record.response_id).toBe(customMsg);
  });

  test('non-/v1/messages requests are not intercepted', () => {
    const r = runScenario({
      url: 'https://api.anthropic.com/v1/some_other_endpoint', sessionId: SESS,
      body: { system: 'sys' },
      sseEvents: sseStream(),
    });
    expect(r.status).toBe(0);
    expect(readIntercept(SESS)).toHaveLength(0);
  });

  test('requests missing session header are passed through (no intercept file)', () => {
    const r = runScenario({
      url: LLM_URL, sessionId: null,
      body: { system: 'sys', messages: [] },
      sseEvents: sseStream(),
    });
    expect(r.status).toBe(0);
    // No session dir at all should be created
    expect(fs.existsSync(INTERCEPT_DIR)).toBe(false);
  });

  test('stream without content_block_delta still emits at message_stop (ttft_ns = null)', () => {
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { system: 'sys', messages: [] },
      sseEvents: sseStream({ includeContentDelta: false }),
    });
    expect(r.status).toBe(0);
    const [{ record }] = readIntercept(SESS);
    expect(record.response_id).toBe(MSG_ID);
    expect(record.ttft_ns).toBeNull();
  });

  test('malformed JSON body does not crash the host fetch', () => {
    // Send a string body that's not valid JSON. The preload's safe parse
    // should yield system_instructions = null and still complete the fetch.
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      rawBody: '<not-json>',
      sseEvents: sseStream(),
    });
    expect(r.status).toBe(0);
    const [{ record }] = readIntercept(SESS);
    expect(record.response_id).toBe(MSG_ID);
    expect(record.system_instructions).toBeNull();
  });

  test('records every retryable HTTP failure without storing the request body', () => {
    const secret = 'must-not-be-written';
    const r = runScenario({
      url: LLM_URL,
      sessionId: SESS,
      clientRequestId: 'client-attempt-2',
      body: { model: 'claude-test', messages: [{ role: 'user', content: secret }] },
      status: 529,
      responseHeaders: { 'request-id': 'req-attempt-2' },
    });
    expect(r.status).toBe(0);

    const [attempt] = readAttempts(SESS);
    expect(attempt).toMatchObject({
      client_request_id: 'client-attempt-2',
      outcome: 'http_error',
      status_code: 529,
      error_type: 'overloaded_error',
      request_id: 'req-attempt-2',
      model: 'claude-test',
      response_id: null,
    });
    expect(attempt.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt.duration_ns).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(attempt)).not.toContain(secret);
    expect(readIntercept(SESS)).toHaveLength(0);
  });

  test('records a network-error attempt and rethrows to the host', () => {
    const r = runScenario({
      url: LLM_URL,
      sessionId: SESS,
      clientRequestId: 'client-network-1',
      body: { model: 'claude-test', messages: [] },
      networkError: 'TimeoutError',
    });
    expect(r.status).toBe(1);
    expect(readAttempts(SESS)).toMatchObject([{
      client_request_id: 'client-network-1',
      outcome: 'network_error',
      status_code: null,
      error_type: 'timeouterror',
    }]);
  });

  test('an aborted 200 SSE stream still records an attempt via cancel()', () => {
    const r = runScenario({
      url: LLM_URL,
      sessionId: SESS,
      clientRequestId: 'client-aborted-1',
      body: { model: 'claude-test', messages: [] },
      // No protocol terminal or EOF: only consumer cancellation ends the attempt.
      sseEvents: [{
        event: 'message_start',
        data: { type: 'message_start', message: { id: MSG_ID, model: 'claude-test', role: 'assistant' } },
      }],
      status: 200,
      responseHeaders: { 'request-id': 'req-aborted-1' },
      keepStreamOpen: true,
      cancelMidStream: true,
    });
    expect(r.status).toBe(0);

    const attempts = readAttempts(SESS);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      client_request_id: 'client-aborted-1',
      outcome: 'network_error',
      status_code: 200,
      error_type: 'aborted',
      request_id: 'req-aborted-1',
    });
  });

  test('an abort AFTER the first content delta is recorded as aborted, not success', () => {
    // Early enrichment must not latch the attempt as success.
    const r = runScenario({
      url: LLM_URL,
      sessionId: SESS,
      clientRequestId: 'client-aborted-2',
      body: { model: 'claude-test', messages: [] },
      // message_start + one content_block_delta, then the consumer aborts after
      // reading both chunks — tryEmit fires (response_id + ttft) before cancel.
      sseEvents: [
        {
          event: 'message_start',
          data: { type: 'message_start', message: { id: MSG_ID, model: 'claude-test', role: 'assistant' } },
        },
        {
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        },
      ],
      status: 200,
      responseHeaders: { 'request-id': 'req-aborted-2' },
      keepStreamOpen: true,
      cancelMidStream: true,
      cancelAfterReads: 2,
    });
    expect(r.status).toBe(0);

    const attempts = readAttempts(SESS);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      client_request_id: 'client-aborted-2',
      outcome: 'network_error',
      status_code: 200,
      error_type: 'aborted',
      request_id: 'req-aborted-2',
    });
    // The enrichment record still lands (we did observe the first token).
    const enrich = readIntercept(SESS).map((e) => e.record);
    expect(enrich.some((rec) => rec.response_id === MSG_ID)).toBe(true);
  });

  const readObservedRecords = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'observed-records.json'), 'utf8'));

  test.each(['before message_start', 'before delta', 'after delta'])('records SSE error %s without persisting error content', (phase) => {
    const prefix = phase === 'before message_start' ? []
      : sseStream({ includeContentDelta: phase === 'after delta' }).slice(0, -1);
    const secret = 'private-response-detail';
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      responseHeaders: { 'request-id': 'req-stream-error' },
      sseEvents: [...prefix, {
        event: 'error',
        data: { type: 'error', error: { type: 'overloaded_error', message: secret }, body: secret },
      }, { event: 'message_stop', data: { type: 'message_stop' } }],
      snapshotAfterReads: prefix.length + 1,
    });
    expect(r.status, r.stderr).toBe(0);
    const attempts = readAttempts(SESS);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      outcome: 'network_error', status_code: 200, error_type: 'overloaded_error',
      request_id: 'req-stream-error', response_id: prefix.length ? MSG_ID : null,
      ttft_ns: phase === 'after delta' ? expect.any(Number) : null,
    });
    expect(readObservedRecords().attempts).toEqual(attempts);
    expect(JSON.stringify([attempts, readIntercept(SESS)])).not.toContain(secret);
  });

  test.each([
    ['unknown', 'private-error-type'],
    ['oversized', `overloaded_error${'private'.repeat(1000)}`],
    ['missing', undefined],
    ['non-string', { message: 'private-error-detail' }],
  ])('maps %s SSE error types to a bounded safe label', (_, type) => {
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      sseEvents: [{ event: 'error', data: { error: { type, message: 'private-message' } } }],
    });
    expect(r.status, r.stderr).toBe(0);
    const attempts = readAttempts(SESS);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'network_error', error_type: 'api_error' });
    expect(JSON.stringify(attempts)).not.toContain('private');
    expect(readIntercept(SESS)).toHaveLength(0);
  });

  test('malformed SSE error data is still a failure', () => {
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      responseText: 'event: error\ndata: not-json-private-message\n\n',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readAttempts(SESS)).toMatchObject([{ outcome: 'network_error', error_type: 'api_error' }]);
    expect(JSON.stringify(readAttempts(SESS))).not.toContain('private-message');
  });

  test.each(['empty', 'before delta', 'after delta'])('SSE EOF %s without message_stop is incomplete', (phase) => {
    const events = phase === 'empty' ? []
      : sseStream({ includeContentDelta: phase === 'after delta' }).slice(0, -1);
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      sseEvents: events,
    });
    expect(r.status, r.stderr).toBe(0);
    const attempts = readAttempts(SESS);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      outcome: 'network_error', error_type: 'incomplete_stream', status_code: 200,
      response_id: events.length ? MSG_ID : null,
    });
  });

  test('non-SSE EOF remains success without a protocol terminal', () => {
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [], stream: true },
      responseHeaders: { 'content-type': 'application/json' },
      responseText: JSON.stringify({ id: MSG_ID, content: [] }),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readAttempts(SESS)).toMatchObject([{ outcome: 'success', error_type: null }]);
    expect(readIntercept(SESS)).toHaveLength(0);
  });

  test.each(['cancel', 'cancel rejection', 'read error'])('message_stop finalizes before EOF and stays success after %s', (ending) => {
    const events = sseStream();
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      sseEvents: events,
      keepStreamOpen: true,
      snapshotAfterReads: events.length,
      cancelMidStream: ending !== 'read error',
      cancelAfterReads: events.length,
      rejectCancel: ending === 'cancel rejection',
      streamErrorAfterReads: ending === 'read error' ? events.length : 0,
    });
    expect(r.status, r.stderr).toBe(ending === 'read error' ? 1 : 0);
    if (ending === 'read error') expect(r.stderr).toContain('TypeError: simulated stream failure');
    const observed = readObservedRecords();
    expect(observed.attempts).toHaveLength(1);
    expect(observed.attempts[0]).toMatchObject({
      outcome: 'success', error_type: null, response_id: MSG_ID, ttft_ns: expect.any(Number),
    });
    expect(observed.enrichment).toHaveLength(1);
    expect(readAttempts(SESS)).toEqual(observed.attempts);
  });

  test('message_stop without a delta finalizes before EOF', () => {
    const events = sseStream({ includeContentDelta: false });
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      sseEvents: events,
      keepStreamOpen: true,
      snapshotAfterReads: events.length,
      cancelMidStream: true,
      cancelAfterReads: events.length,
    });
    expect(r.status, r.stderr).toBe(0);
    const observed = readObservedRecords();
    expect(observed.attempts).toMatchObject([{ outcome: 'success', ttft_ns: null }]);
    expect(observed.enrichment).toMatchObject([{ response_id: MSG_ID, ttft_ns: null }]);
    expect(readAttempts(SESS)).toEqual(observed.attempts);
  });

  test.each([false, true])('transport error before terminal writes one failure (delta=%s)', (includeContentDelta) => {
    const events = sseStream({ includeContentDelta }).slice(0, -1);
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      sseEvents: events,
      keepStreamOpen: true,
      snapshotAfterReads: events.length,
      streamErrorAfterReads: events.length,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TypeError: simulated stream failure');
    const observed = readObservedRecords();
    expect(observed.attempts).toHaveLength(0);
    expect(observed.enrichment).toHaveLength(includeContentDelta ? 1 : 0);
    const attempts = readAttempts(SESS);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      outcome: 'network_error', error_type: 'typeerror', status_code: 200,
      response_id: MSG_ID, ttft_ns: includeContentDelta ? expect.any(Number) : null,
    });
    expect(JSON.stringify(attempts)).not.toContain('simulated stream failure');
  });

  test.each([false, true])('cancel rejection propagates and records one aborted attempt (delta=%s)', (includeContentDelta) => {
    const events = sseStream({ includeContentDelta }).slice(0, -1);
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      sseEvents: events,
      keepStreamOpen: true,
      cancelMidStream: true,
      cancelAfterReads: events.length,
      snapshotAfterReads: events.length,
      rejectCancel: true,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(readObservedRecords().attempts).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cancel-reason.json'), 'utf8'))).toBe('test-abort');
    const attempts = readAttempts(SESS);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      outcome: 'network_error', error_type: 'aborted', response_id: MSG_ID,
      ttft_ns: includeContentDelta ? expect.any(Number) : null,
    });
  });

  const TRACE_ENV = {
    TRACEPARENT: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    TRACESTATE: 'vendor=value,other=1',
  };
  const readOutboundHeaders = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'outbound-headers.json'), 'utf8'));

  test.each(['object', 'tuple-array'])('passes %s headers untouched despite trace env vars', (kind) => {
    const pairs = [
      ['X-Claude-Code-Session-Id', SESS],
      ['X-Client-Request-Id', 'client-passthrough'],
      ['X-Custom', 'caller-value'],
    ];
    const headers = kind === 'object' ? Object.fromEntries(pairs) : [...pairs, ['X-Custom', 'second-value']];
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      sseEvents: sseStream(), requestHeaders: headers, env: TRACE_ENV,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readOutboundHeaders()).toEqual({ headers, sameHeaders: true });
    expect(readAttempts(SESS)).toMatchObject([{ outcome: 'success', client_request_id: 'client-passthrough' }]);
    expect(readIntercept(SESS)).toHaveLength(1);
  });

  test.each(['object', 'tuple-array'])('preserves caller trace headers in %s headers', (kind) => {
    const pairs = [
      ['X-Claude-Code-Session-Id', SESS],
      ['Traceparent', '00-11111111111111111111111111111111-2222222222222222-00'],
      ['Tracestate', 'caller=value'],
    ];
    const headers = kind === 'object' ? Object.fromEntries(pairs) : pairs;
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      sseEvents: sseStream(), requestHeaders: headers, env: TRACE_ENV,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readOutboundHeaders()).toEqual({ headers, sameHeaders: true });
  });

  test('does not inject trace headers when the session id is missing', () => {
    const r = runScenario({
      url: LLM_URL, sessionId: null,
      body: { model: 'claude-test', messages: [] },
      sseEvents: sseStream(), env: TRACE_ENV,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readOutboundHeaders()).toEqual({ headers: {}, sameHeaders: true });
    expect(fs.existsSync(INTERCEPT_DIR)).toBe(false);
  });

  // Regression: SSE event boundaries may use LF, CRLF, or bare CR line
  // terminators. Splitting only on `\n\n` misclassified valid CRLF/CR
  // streams as incomplete_stream (false failures). All framings must parse
  // to the same success outcome and enrichment.
  const buildSse = (nl) => sseStream()
    .map((e) => `event: ${e.event}${nl}data: ${JSON.stringify(e.data)}${nl}${nl}`)
    .join('');

  test.each([
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('%s-terminated message_stop is success, not incomplete', (_, nl) => {
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      rawChunks: [buildSse(nl)],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readAttempts(SESS)).toMatchObject([{
      outcome: 'success', error_type: null, status_code: 200, response_id: MSG_ID,
    }]);
    expect(readIntercept(SESS)).toMatchObject([{ record: { response_id: MSG_ID } }]);
  });

  test('a CRLF boundary split across chunk reads still parses to success', () => {
    // Slice the full CRLF stream mid-boundary so `\r\n\r\n` straddles two
    // reads — the accumulated buffer must still recognize the boundary.
    const full = buildSse('\r\n');
    const cut = full.indexOf('\r\n\r\n') + 2; // between the two CRLFs of the first boundary
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      rawChunks: [full.slice(0, cut), full.slice(cut)],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readAttempts(SESS)).toMatchObject([{
      outcome: 'success', error_type: null, response_id: MSG_ID,
    }]);
  });

  test('mixed LF and CRLF framing in one stream parses to success', () => {
    const events = sseStream();
    const nls = ['\n', '\r\n', '\r'];
    const raw = events
      .map((e, i) => `event: ${e.event}${nls[i % 3]}data: ${JSON.stringify(e.data)}${nls[i % 3]}${nls[i % 3]}`)
      .join('');
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { model: 'claude-test', messages: [] },
      rawChunks: [raw],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readAttempts(SESS)).toMatchObject([{
      outcome: 'success', error_type: null, response_id: MSG_ID,
    }]);
  });
});

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

/**
 * Build a Node bootstrap script that:
 *  1. Stubs globalThis.fetch to return a fake Response with a synthetic SSE
 *     ReadableStream we drive chunk-by-chunk.
 *  2. require()s the preload script (which overrides globalThis.fetch with
 *     its instrumented version).
 *  3. Awaits the wrapped fetch + drains the returned response.body so the
 *     TransformStream actually processes chunks.
 *  4. Returns success exit code.
 *
 * The preload writes JSON files to <DATA_DIR>/intercept/claude-code/<sid>/...
 */
function runScenario({
  url,
  sessionId,
  body,
  rawBody,
  sseEvents = [],
  networkDelayMs = 0,
  env = {},
  extraRequestHeaders = null,
  headersAs = 'object',
  inputAs = 'url',
}) {
  const chunksJson = JSON.stringify(sseEvents.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
  // rawBody (string) takes precedence — use it verbatim as fetch body so tests
  // can exercise malformed/non-JSON bodies without going through JSON.stringify.
  const bodyJson = rawBody !== undefined ? rawBody : JSON.stringify(body);
  const observedFile = path.join(DATA_DIR, 'observed-request.json');
  const requestHeaders = {
    ...(sessionId ? { 'x-claude-code-session-id': sessionId } : {}),
    ...(extraRequestHeaders || {}),
  };
  const script = `
    const { ReadableStream, TransformStream } = require('node:stream/web');
    globalThis.ReadableStream = ReadableStream;
    globalThis.TransformStream = TransformStream;
    // globalThis.Response is native in Node 18.17+ / 20+ / 22+; no fallback needed.

    const chunks = ${chunksJson};
    const encoder = new TextEncoder();
    const observedFile = ${JSON.stringify(observedFile)};

    // Stub original fetch — preload will wrap this.
    globalThis.fetch = async function (input, init) {
      // Record what the wrapper actually handed us. Mirrors real fetch
      // precedence: init.headers overrides a Request's own headers.
      try {
        const carrier = (init && init.headers) || (input && input.headers) || null;
        const headers = {};
        if (carrier && typeof carrier.forEach === 'function') {
          carrier.forEach((v, k) => { headers[String(k).toLowerCase()] = String(v); });
        } else if (carrier && typeof carrier === 'object') {
          for (const k of Object.keys(carrier)) headers[k.toLowerCase()] = String(carrier[k]);
        }
        // Read the body back so we can prove header injection never consumed
        // or replaced the request payload.
        let observedBody = null;
        if (init && typeof init.body === 'string') observedBody = init.body;
        else if (input && typeof input.text === 'function') observedBody = await input.text();
        require('node:fs').writeFileSync(observedFile, JSON.stringify({
          headers,
          body: observedBody,
          method: (init && init.method) || (input && input.method) || null,
          carrierIsHeaders: !!(carrier && typeof carrier.forEach === 'function' && typeof carrier.get === 'function'),
        }));
      } catch (_) {}

      // Simulate network latency before response headers arrive.
      if (${networkDelayMs} > 0) await new Promise(r => setTimeout(r, ${networkDelayMs}));
      const stream = new ReadableStream({
        async start(controller) {
          for (const c of chunks) {
            await new Promise(r => setTimeout(r, 5));
            controller.enqueue(encoder.encode(c));
          }
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    process.env.LOONGSUITE_PILOT_DATA_DIR = ${JSON.stringify(DATA_DIR)};

    (async () => {
      // Node 18 forbids require() of .mjs (ERR_REQUIRE_ESM); use dynamic import.
      await import(${JSON.stringify('file://' + PRELOAD)});

      const rawHeaders = ${JSON.stringify(requestHeaders)};
      const headersAs = ${JSON.stringify(headersAs)};
      const headers = headersAs === 'Headers' ? new Headers(rawHeaders)
        : headersAs === 'entries' ? Object.entries(rawHeaders)
        : rawHeaders;

      const url = ${JSON.stringify(url)};
      const bodyText = ${JSON.stringify(bodyJson)};
      let res;
      if (${JSON.stringify(inputAs)} === 'Request') {
        // Exercise the Request-as-input path: method/body must survive our
        // headers-only override untouched.
        res = await globalThis.fetch(new Request(url, { method: 'POST', headers, body: bodyText }));
      } else {
        res = await globalThis.fetch(url, { method: 'POST', headers, body: bodyText });
      }

      // Drain stream so TransformStream sees every chunk.
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }

      // Tiny grace so writeFileSync inside transform has time to land
      // (writes themselves are sync, but we want all chunks pumped).
      await new Promise(r => setTimeout(r, 50));
    })().then(
      () => process.exit(0),
      (e) => { console.error(String(e)); process.exit(1); }
    );
  `;
  // Strip inherited trace context so a TRACEPARENT exported in the test
  // runner's shell cannot silently satisfy scenarios that assert no injection.
  const baseEnv = { ...process.env };
  delete baseEnv.TRACEPARENT;
  delete baseEnv.TRACESTATE;
  // Same for the forwarding switch and the config path it would otherwise read
  // from the developer's machine.
  delete baseEnv.AGENT_DATA_COLLECTION_CONFIG;
  delete baseEnv.LOONGSUITE_PILOT_UPSTREAM_LINK;
  delete baseEnv.LOONGSUITE_PILOT_UPSTREAM_LINK_PROPAGATE_TO_LLM;
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf-8',
    env: {
      ...baseEnv,
      LOONGSUITE_PILOT_DATA_DIR: DATA_DIR,
      // Forwarding is opt-in; most scenarios exercise the enabled path, and a
      // case can switch it back off by passing an empty string.
      LOONGSUITE_PILOT_UPSTREAM_LINK: '1',
      LOONGSUITE_PILOT_UPSTREAM_LINK_PROPAGATE_TO_LLM: '1',
      ...env,
    },
    timeout: 10_000,
  });
}

function readObservedRequest() {
  const p = path.join(DATA_DIR, 'observed-request.json');
  if (!fs.existsSync(p)) return { headers: {}, body: null };
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function readIntercept(sessionId) {
  const dir = path.join(INTERCEPT_DIR, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => ({
    name: n,
    record: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')),
  }));
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

  test('TTFT also captures on thinking_delta and input_json_delta', () => {
    const r = runScenario({
      url: LLM_URL, sessionId: SESS,
      body: { system: 'sys', messages: [] },
      sseEvents: sseStream({ deltaType: 'thinking_delta' }),
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

  test('stream without content_block_delta still emits via flush (ttft_ns = null)', () => {
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

  // ─── W3C trace-context forwarding ──────────────────────────────────────
  // https://www.w3.org/TR/trace-context/

  describe('W3C trace-context forwarding', () => {
    const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
    const UPSTREAM_PARENT_ID = '00f067aa0ba902b7';
    const FLAGS = '01';
    const TP = `00-${TRACE_ID}-${UPSTREAM_PARENT_ID}-${FLAGS}`;
    const TS = 'congo=t61rcWkgMzE,rojo=00f067aa0ba902b7';

    /**
     * parent-id is replaced with the span id minted for this LLM call, so the
     * expected header value is only knowable from the record the preload wrote.
     */
    function expectSubstitutedParent(observedTraceparent, sessionId = SESS) {
      const records = readIntercept(sessionId).map((e) => e.record);
      expect(records).toHaveLength(1);
      const spanId = records[0].llm_span_id;
      expect(spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(spanId).not.toBe(UPSTREAM_PARENT_ID);
      expect(spanId).not.toBe('0'.repeat(16));
      expect(observedTraceparent).toBe(`00-${TRACE_ID}-${spanId}-${FLAGS}`);
    }

    test('forwards the inherited trace but substitutes this call\'s span id', () => {
      const r = runScenario({
        url: LLM_URL, sessionId: SESS,
        body: { system: 'sys', messages: [] },
        sseEvents: sseStream(),
        env: { TRACEPARENT: TP, TRACESTATE: TS },
      });
      expect(r.status).toBe(0);
      const { headers } = readObservedRequest();
      expectSubstitutedParent(headers.traceparent);
      // tracestate is opaque to us and passes through byte for byte.
      expect(headers.tracestate).toBe(TS);
    });

    test('forwards traceparent alone when no tracestate is inherited', () => {
      const r = runScenario({
        url: LLM_URL, sessionId: SESS,
        body: { system: 'sys', messages: [] },
        sseEvents: sseStream(),
        env: { TRACEPARENT: TP },
      });
      expect(r.status).toBe(0);
      const { headers } = readObservedRequest();
      expectSubstitutedParent(headers.traceparent);
      expect(headers.tracestate).toBeUndefined();
    });

    test('normalizes an uppercase-hex traceparent to the lowercase spec form', () => {
      const r = runScenario({
        url: LLM_URL, sessionId: SESS,
        body: { system: 'sys', messages: [] },
        sseEvents: sseStream(),
        env: { TRACEPARENT: '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01' },
      });
      expect(r.status).toBe(0);
      expectSubstitutedParent(readObservedRequest().headers.traceparent);
    });

    test.each([
      ['garbage', 'not-a-traceparent'],
      ['all-zero trace-id', '00-00000000000000000000000000000000-00f067aa0ba902b7-01'],
      ['all-zero parent-id', '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'],
      ['forbidden version ff', 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ['unknown future version', '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ['missing trace-flags', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7'],
      ['trailing field on version 00', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra'],
      ['short trace-id', '00-4bf92f3577b34da6-00f067aa0ba902b7-01'],
      ['non-hex trace-id', '00-4bf92f3577b34da6a3ce929d0e0e473g-00f067aa0ba902b7-01'],
      ['empty', ''],
    ])('rejects an invalid traceparent (%s) and injects nothing', (_label, value) => {
      const r = runScenario({
        url: LLM_URL, sessionId: SESS,
        body: { system: 'sys', messages: [] },
        sseEvents: sseStream(),
        env: { TRACEPARENT: value },
      });
      expect(r.status).toBe(0);
      const { headers } = readObservedRequest();
      expect(headers.traceparent).toBeUndefined();
      expect(headers.tracestate).toBeUndefined();
      // Nothing was advertised, so nothing may be minted either.
      expect(readIntercept(SESS)[0].record.llm_span_id).toBeUndefined();
    });

    test.each([
      ['over the 512-byte budget', `a=${'x'.repeat(520)}`],
      ['more than 32 list-members', Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(',')],
      ['containing a control character', 'congo=t61r\nckgMzE'],
      ['blank', '   '],
    ])('drops an invalid tracestate (%s) but still forwards traceparent', (_label, value) => {
      const r = runScenario({
        url: LLM_URL, sessionId: SESS,
        body: { system: 'sys', messages: [] },
        sseEvents: sseStream(),
        env: { TRACEPARENT: TP, TRACESTATE: value },
      });
      expect(r.status).toBe(0);
      const { headers } = readObservedRequest();
      expectSubstitutedParent(headers.traceparent);
      expect(headers.tracestate).toBeUndefined();
    });

    test('never overwrites a traceparent the caller already set', () => {
      // A propagator must not replace a context it did not create, even when
      // the caller's value looks less trustworthy than ours.
      const callerTp = '00-11111111111111111111111111111111-2222222222222222-00';
      const r = runScenario({
        url: LLM_URL, sessionId: SESS,
        body: { system: 'sys', messages: [] },
        sseEvents: sseStream(),
        extraRequestHeaders: { traceparent: callerTp },
        env: { TRACEPARENT: TP, TRACESTATE: TS },
      });
      expect(r.status).toBe(0);
      const { headers } = readObservedRequest();
      expect(headers.traceparent).toBe(callerTp);
      // tracestate rides with our traceparent; skipping one skips both.
      expect(headers.tracestate).toBeUndefined();
    });

    test.each(['object', 'Headers', 'entries'])(
      'injects without dropping existing headers when the carrier is %s',
      (headersAs) => {
        const r = runScenario({
          url: LLM_URL, sessionId: SESS,
          body: { system: 'sys', messages: [] },
          sseEvents: sseStream(),
          headersAs,
          extraRequestHeaders: { 'x-custom-marker': 'kept' },
          env: { TRACEPARENT: TP },
        });
        expect(r.status).toBe(0);
        const { headers } = readObservedRequest();
        expectSubstitutedParent(headers.traceparent);
        expect(headers['x-claude-code-session-id']).toBe(SESS);
        expect(headers['x-custom-marker']).toBe('kept');
      },
    );

    test('leaves method and body intact when input is a Request object', () => {
      // Injection rewrites init.headers only. If it ever rebuilt the Request,
      // the body stream would be consumed and the upload would break.
      const payload = { system: 'sys', messages: [{ role: 'user', content: 'keep me' }] };
      const r = runScenario({
        url: LLM_URL, sessionId: SESS,
        body: payload,
        sseEvents: sseStream(),
        inputAs: 'Request',
        env: { TRACEPARENT: TP, TRACESTATE: TS },
      });
      expect(r.status).toBe(0);
      const observed = readObservedRequest();
      expectSubstitutedParent(observed.headers.traceparent);
      expect(observed.headers.tracestate).toBe(TS);
      expect(observed.headers['x-claude-code-session-id']).toBe(SESS);
      expect(observed.method).toBe('POST');
      expect(JSON.parse(observed.body)).toEqual(payload);
    });

    test('hands the gateway a real Headers carrier, not a flattened object', () => {
      const r = runScenario({
        url: LLM_URL, sessionId: SESS,
        body: { system: 'sys', messages: [] },
        sseEvents: sseStream(),
        env: { TRACEPARENT: TP },
      });
      expect(r.status).toBe(0);
      expect(readObservedRequest().carrierIsHeaders).toBe(true);
    });

    test('does not inject on non-/v1/messages URLs', () => {
      const r = runScenario({
        url: 'https://api.anthropic.com/v1/some_other_endpoint', sessionId: SESS,
        body: { system: 'sys' },
        sseEvents: sseStream(),
        env: { TRACEPARENT: TP },
      });
      expect(r.status).toBe(0);
      expect(readObservedRequest().headers.traceparent).toBeUndefined();
    });

    test('injects the upstream parent verbatim when there is no session id', () => {
      // The session-id gate governs pilot's own capture; the gateway's ability
      // to join the trace must not depend on it. But without a record to write,
      // a minted parent-id would name a span pilot never emits, so the upstream
      // parent is the better answer here.
      const r = runScenario({
        url: LLM_URL, sessionId: null,
        body: { system: 'sys', messages: [] },
        sseEvents: sseStream(),
        env: { TRACEPARENT: TP },
      });
      expect(r.status).toBe(0);
      expect(readObservedRequest().headers.traceparent).toBe(TP);
      expect(fs.existsSync(INTERCEPT_DIR)).toBe(false);
    });

    test('leaves the request untouched when no trace context is inherited', () => {
      const r = runScenario({
        url: LLM_URL, sessionId: SESS,
        body: { system: 'sys', messages: [] },
        sseEvents: sseStream(),
      });
      expect(r.status).toBe(0);
      const { headers } = readObservedRequest();
      expect(headers.traceparent).toBeUndefined();
      expect(headers.tracestate).toBeUndefined();
      // Capture still works — forwarding is independent of it.
      const [{ record }] = readIntercept(SESS);
      expect(record.response_id).toBe(MSG_ID);
      expect(record.llm_span_id).toBeUndefined();
    });

    // ─── forwarding switch (upstreamLink.propagateToLlm) ──────────────────
    // Passing an empty string unsets the env override, so the preload falls
    // back to config.json — absent unless a case writes one.
    describe('opt-in switch', () => {
      const OFF = {
        LOONGSUITE_PILOT_UPSTREAM_LINK: '',
        LOONGSUITE_PILOT_UPSTREAM_LINK_PROPAGATE_TO_LLM: '',
      };

      function writeConfig(upstreamLink) {
        const p = path.join(DATA_DIR, 'config.json');
        fs.writeFileSync(p, JSON.stringify({ upstreamLink }), 'utf-8');
        return p;
      }

      test('forwards nothing while the switch is off', () => {
        const r = runScenario({
          url: LLM_URL, sessionId: SESS,
          body: { system: 'sys', messages: [] },
          sseEvents: sseStream(),
          env: { ...OFF, TRACEPARENT: TP, TRACESTATE: TS },
        });
        expect(r.status).toBe(0);
        const { headers } = readObservedRequest();
        expect(headers.traceparent).toBeUndefined();
        expect(headers.tracestate).toBeUndefined();
        // Capture keeps working; only forwarding is gated.
        const [{ record }] = readIntercept(SESS);
        expect(record.response_id).toBe(MSG_ID);
        expect(record.llm_span_id).toBeUndefined();
      });

      test('needs propagateToLlm too, not just upstreamLink.enabled', () => {
        const r = runScenario({
          url: LLM_URL, sessionId: SESS,
          body: { system: 'sys', messages: [] },
          sseEvents: sseStream(),
          env: { ...OFF, LOONGSUITE_PILOT_UPSTREAM_LINK: '1', TRACEPARENT: TP },
        });
        expect(r.status).toBe(0);
        expect(readObservedRequest().headers.traceparent).toBeUndefined();
      });

      test('reads both halves from config.json when no env override is set', () => {
        const configPath = writeConfig({ enabled: true, propagateToLlm: true });
        const r = runScenario({
          url: LLM_URL, sessionId: SESS,
          body: { system: 'sys', messages: [] },
          sseEvents: sseStream(),
          env: { ...OFF, AGENT_DATA_COLLECTION_CONFIG: configPath, TRACEPARENT: TP },
        });
        expect(r.status).toBe(0);
        expectSubstitutedParent(readObservedRequest().headers.traceparent);
      });

      test('honours a config.json that enables linking but not LLM forwarding', () => {
        const configPath = writeConfig({ enabled: true });
        const r = runScenario({
          url: LLM_URL, sessionId: SESS,
          body: { system: 'sys', messages: [] },
          sseEvents: sseStream(),
          env: { ...OFF, AGENT_DATA_COLLECTION_CONFIG: configPath, TRACEPARENT: TP },
        });
        expect(r.status).toBe(0);
        expect(readObservedRequest().headers.traceparent).toBeUndefined();
      });
    });
  });
});

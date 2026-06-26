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
function runScenario({ url, sessionId, body, rawBody, sseEvents, networkDelayMs = 0 }) {
  const chunksJson = JSON.stringify(sseEvents.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
  // rawBody (string) takes precedence — use it verbatim as fetch body so tests
  // can exercise malformed/non-JSON bodies without going through JSON.stringify.
  const bodyJson = rawBody !== undefined ? rawBody : JSON.stringify(body);
  const script = `
    const { ReadableStream, TransformStream } = require('node:stream/web');
    globalThis.ReadableStream = ReadableStream;
    globalThis.TransformStream = TransformStream;
    // globalThis.Response is native in Node 18.17+ / 20+ / 22+; no fallback needed.

    const chunks = ${chunksJson};
    const encoder = new TextEncoder();

    // Stub original fetch — preload will wrap this.
    globalThis.fetch = async function (input, init) {
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

      const res = await globalThis.fetch(${JSON.stringify(url)}, {
        method: 'POST',
        headers: ${JSON.stringify(sessionId ? { 'x-claude-code-session-id': sessionId } : {})},
        body: ${JSON.stringify(bodyJson)},
      });

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
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf-8',
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR },
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
});

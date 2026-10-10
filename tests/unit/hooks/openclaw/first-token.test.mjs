// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { channel } from 'node:diagnostics_channel';
import { installFirstTokenObserver } from '../../../../assets/plugins/openclaw/first-token.mjs';

const KEY = Symbol.for('loongsuite-pilot.openclaw.first-token');
const encode = value => new TextEncoder().encode(value);
const block = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const tick = () => new Promise(resolve => setImmediate(resolve));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); globalThis[KEY]?.dispose(); });

function harness() {
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const queue = [];
  const fetchMock = vi.fn(async () => queue.shift());
  vi.stubGlobal('fetch', fetchMock);
  const observer = installFirstTokenObserver();
  return {
    observer, fetchMock, setTime: value => { now = value; },
    async request(endpoint = 'chat/completions', options = {}) {
      let controller;
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ start(c) { controller = c; }, cancel }), {
        headers: { 'content-type': options.contentType || 'text/event-stream' }, status: options.status || 200,
      });
      Object.defineProperty(response, 'url', { value: `https://example.test/v1/${endpoint}` });
      queue.push(response);
      const wrapped = await fetch(response.url, { method: 'POST' });
      return {
        response, wrapped, cancel,
        async send(time, bytes) { now = time; controller.enqueue(encode(bytes)); await tick(); },
        close() { controller.close(); },
        fail(error) { controller.error(error); },
      };
    },
  };
}

const choices = (id, delta) => ({ id, choices: [{ delta }] });

describe('OpenClaw first effective output observer', () => {
  it('observes guarded Undici requests without calling or replacing their transport', () => {
    const h = harness();
    const publish = (name, data) => channel(`undici:request:${name}`).publish(data);
    const request = { method: 'POST', origin: 'https://example.test', path: '/v1/chat/completions' };
    publish('create', { request });
    publish('headers', { request, response: { statusCode: 200, headers: ['content-type', 'text/event-stream'] } });
    h.setTime(105);
    publish('bodyChunkReceived', { request, chunk: encode(block(choices('native', { role: 'assistant', content: '' }))) });
    h.setTime(150);
    publish('bodyChunkReceived', { request, chunk: encode(block(choices('native', { content: 'answer' }))) });
    publish('trailers', { request });
    expect(h.observer.take('openai-completions', 'native')).toBe(50_000_000);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each([['error', 200, undefined], ['trailers', 200, undefined], [null, 401, undefined], [null, 200, 'gzip']])(
    'does not infer a token after cleanup or from unsupported wire bodies: %s %s %s', (end, statusCode, encoding) => {
      const h = harness();
      const publish = (name, data) => channel(`undici:request:${name}`).publish(data);
      const request = { method: 'POST', origin: 'https://example.test', path: '/v1/chat/completions' };
      publish('create', { request });
      publish('headers', { request, response: { statusCode, headers: ['content-type', 'text/event-stream', 'content-encoding', encoding || 'identity'] } });
      if (end) publish(end, { request });
      h.setTime(150);
      publish('bodyChunkReceived', { request, chunk: encode(block(choices('r', { content: 'answer' }))) });
      expect(h.observer.take('openai-completions', 'r')).toBeUndefined();
    },
  );

  it('deduplicates native and fetch observations using the same async request context', async () => {
    const h = harness();
    const request = { method: 'POST', origin: 'https://example.test', path: '/v1/chat/completions' };
    const payload = block(choices('same', { content: 'answer' }));
    h.fetchMock.mockImplementationOnce(async () => {
      channel('undici:request:create').publish({ request });
      channel('undici:request:headers').publish({ request, response: { statusCode: 200, headers: ['content-type', 'text/event-stream'] } });
      h.setTime(125);
      channel('undici:request:bodyChunkReceived').publish({ request, chunk: encode(payload) });
      channel('undici:request:trailers').publish({ request });
      return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
    });
    expect(await (await fetch('https://example.test/v1/chat/completions', { method: 'POST' })).text()).toBe(payload);
    expect(h.observer.take('openai-completions', 'same')).toBe(25_000_000);
  });
  it.each([
    ['text', { content: 'answer' }], ['reasoning', { reasoning_content: 'think' }],
    ['reasoning alias', { reasoning: 'think' }], ['tool name', { tool_calls: [{ function: { name: 'read' } }] }],
    ['tool arguments', { tool_calls: [{ function: { arguments: '{' } }] }],
  ])('timestamps the first %s, excluding metadata/empty/usage frames', async (_name, delta) => {
    const h = harness(); const s = await h.request(); const read = s.wrapped.text();
    const frames = [block(choices('r', { role: 'assistant', content: '' })),
      block({ id: 'r', choices: [], usage: { completion_tokens: 1 } }),
      block(choices('r', { tool_calls: [{ id: 'tool-id', function: { name: '', arguments: '' } }] })),
      block(choices('r', delta)), block(choices('r', { content: 'later' }))];
    for (let i = 0; i < frames.length; i++) await s.send(110 + i * 10, frames[i]);
    s.close(); expect(await read).toBe(frames.join(''));
    expect(h.observer.take('openai-completions', 'r')).toBe(40_000_000);
    expect(h.observer.take('openai-completions', 'r')).toBeUndefined();
    expect(s.wrapped.url).toBe(s.response.url);
    expect(s.wrapped.headers.get('content-type')).toBe('text/event-stream');
  });

  it.each([
    ['messages', 'anthropic-messages', { type: 'message_start', message: { id: 'r' } }, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'think' } }],
    ['messages', 'anthropic-messages', { type: 'message_start', message: { id: 'r' } }, { type: 'content_block_start', content_block: { type: 'tool_use', name: 'read' } }],
    ['messages', 'anthropic-messages', { type: 'message_start', message: { id: 'r' } }, { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }],
    ['responses', 'openai-responses', { type: 'response.created', response: { id: 'r' } }, { type: 'response.output_text.delta', delta: 'answer' }],
    ['responses', 'openai-responses', { type: 'response.created', response: { id: 'r' } }, { type: 'response.reasoning_summary_text.delta', delta: 'think' }],
    ['responses', 'openai-responses', { type: 'response.created', response: { id: 'r' } }, { type: 'response.output_item.added', item: { type: 'function_call', name: 'read' } }],
  ])('handles %s native event %j', async (endpoint, api, start, output) => {
    const h = harness(); const s = await h.request(endpoint); const read = s.wrapped.text();
    await s.send(105, block(start)); await s.send(130, block(output)); s.close(); await read;
    expect(h.observer.take(api, 'r')).toBe(30_000_000);
  });

  it('keeps interleaved streams and reverse completion isolated by exact ID', async () => {
    const h = harness(); const a = await h.request(); const readA = a.wrapped.text();
    h.setTime(120); const b = await h.request(); const readB = b.wrapped.text();
    await b.send(130, block(choices('b', { content: 'B' })));
    await a.send(150, block(choices('a', { content: 'A' })));
    b.close(); a.close(); await Promise.all([readA, readB]);
    expect(h.observer.take('openai-completions', 'b')).toBe(10_000_000);
    expect(h.observer.take('openai-completions', 'a')).toBe(50_000_000);
    expect(h.observer.take('anthropic-messages', 'a')).toBeUndefined();
  });

  it('handles fragmented SSE and malformed frames without changing bytes', async () => {
    const h = harness(); const s = await h.request(); const read = s.wrapped.text();
    const payload = block(choices('split', { content: '答案' }));
    const prefix = 'data: {bad}\r\n\r\n: heartbeat\r\n\r\n';
    await s.send(110, prefix + payload.slice(0, 19)); await s.send(145, payload.slice(19));
    s.close(); expect(await read).toBe(prefix + payload);
    expect(h.observer.take('openai-completions', 'split')).toBe(45_000_000);
  });

  it.each([
    { id: 'r', choices: [{ delta: { role: 'assistant', content: '' } }] },
    { choices: [{ delta: { content: 'no ID' } }] },
  ])('omits unobserved timing for %j', async event => {
    const h = harness(); const s = await h.request(); const read = s.wrapped.text();
    await s.send(150, block(event)); s.close(); await read;
    expect(h.observer.take('openai-completions', 'r')).toBeUndefined();
  });

  it('ignores oversized events, and rejects expired and duplicate response IDs', async () => {
    const h = harness(); const s = await h.request(); const read = s.wrapped.text();
    await s.send(120, `data: ${'x'.repeat(256 * 1024 + 1)}`);
    await s.send(130, '\n\n' + block(choices('huge', { content: 'answer' })));
    s.close(); await read; expect(h.observer.take('openai-completions', 'huge')).toBeUndefined();
    for (const start of [200, 300]) {
      h.setTime(start); const s = await h.request(); const read = s.wrapped.text();
      await s.send(start + 20, block(choices('duplicate', { content: 'answer' }))); s.close(); await read;
    }
    expect(h.observer.take('openai-completions', 'duplicate')).toBeUndefined();
    const expiring = await h.request(); const expiredRead = expiring.wrapped.text();
    await expiring.send(400, block(choices('expired', { content: 'answer' }))); expiring.close(); await expiredRead;
    h.setTime(400 + 5 * 60_000 + 1);
    expect(h.observer.take('openai-completions', 'expired')).toBeUndefined();
  });

  it('preserves failure/cancellation and does not stack wrappers on re-registration', async () => {
    const h = harness(); const wrapper = globalThis.fetch;
    expect(installFirstTokenObserver()).toBe(h.observer); expect(globalThis.fetch).toBe(wrapper);
    const s = await h.request(); const failure = new Error('synthetic stream failure');
    const read = s.wrapped.text(); s.fail(failure); await expect(read).rejects.toBe(failure);
    const cancelled = await h.request(); await cancelled.wrapped.body.cancel(); await tick();
    expect(cancelled.cancel).toHaveBeenCalledOnce();
    h.fetchMock.mockRejectedValueOnce(failure);
    await expect(fetch('https://example.test/v1/chat/completions', { method: 'POST' })).rejects.toBe(failure);
  });

  it.each([['chat/completions', { contentType: 'application/json' }], ['messages', { status: 401 }], ['other', {}]])('passes through unsupported response %s %j', async (endpoint, options) => {
    const h = harness(); const s = await h.request(endpoint, options);
    expect(s.wrapped).toBe(s.response); await s.wrapped.body.cancel();
  });
});

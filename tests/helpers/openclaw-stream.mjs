// Synthetic protocol fixtures only; these are not real Agent E2E evidence.
import { vi } from 'vitest';
import { performance } from 'node:perf_hooks';

export function fakeStreamingFetch() {
  let source;
  vi.stubGlobal('fetch', vi.fn(async () => source));
  return async (id, { api = 'openai-completions', delta = { content: 'answer' }, delayMs = 50 } = {}) => {
    let controller;
    source = new Response(new ReadableStream({ start(value) { controller = value; } }), {
      headers: { 'content-type': 'text/event-stream' },
    });
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const send = async event => {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      await new Promise(resolve => setImmediate(resolve));
    };
    try {
      const endpoint = api === 'anthropic-messages' ? 'messages' : api === 'openai-responses' ? 'responses' : 'chat/completions';
      const response = await fetch(`https://example.test/v1/${endpoint}`, { method: 'POST' });
      const read = response.text();
      now += 5;
      if (api === 'openai-completions') await send({ id, choices: [{ delta: { role: 'assistant', content: '' } }] });
      else if (api === 'anthropic-messages') await send({ type: 'message_start', message: { id } });
      else await send({ type: 'response.created', response: { id } });
      now = 100 + delayMs;
      if (api === 'openai-completions') await send({ id, choices: [{ delta }] });
      else if (api === 'anthropic-messages') await send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } });
      else await send({ type: 'response.output_text.delta', delta: 'answer' });
      controller.close();
      await read;
    } finally { clock.mockRestore(); }
  };
}

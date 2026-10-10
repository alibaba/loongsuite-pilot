// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
// Adapted from Pilot's Claude Code SSE observer: pass bytes through unchanged,
// identify first generated output, and join by provider response ID. No content
// or credentials are retained. Native OpenClaw TTFB is not a token boundary.
import { performance } from 'node:perf_hooks';
import { channel } from 'node:diagnostics_channel';
import { AsyncLocalStorage } from 'node:async_hooks';

const OBSERVER = Symbol.for('loongsuite-pilot.openclaw.first-token');
const MAX_BUFFER = 256 * 1024;
const MAX_TIMINGS = 512;
const TTL_MS = 5 * 60_000;
const nonempty = value => typeof value === 'string' && value.length > 0;

function streamEvent(api, event) {
  if (api === 'openai-completions') {
    const delta = event.choices?.[0]?.delta;
    return { id: event.id, output: delta && (
      nonempty(delta.content) || nonempty(delta.reasoning_content) || nonempty(delta.reasoning)
      || delta.tool_calls?.some(tool => nonempty(tool.function?.name) || nonempty(tool.function?.arguments))
    ) };
  }
  if (api === 'anthropic-messages') {
    const delta = event.delta;
    const block = event.content_block;
    return {
      id: event.type === 'message_start' ? event.message?.id : undefined,
      output: (event.type === 'content_block_delta' && (
        (delta?.type === 'text_delta' && nonempty(delta.text))
        || (delta?.type === 'thinking_delta' && nonempty(delta.thinking))
        || (delta?.type === 'input_json_delta' && nonempty(delta.partial_json))
      )) || (event.type === 'content_block_start' && (
        (block?.type === 'tool_use' && nonempty(block.name))
        || (block?.type === 'text' && nonempty(block.text))
        || (block?.type === 'thinking' && nonempty(block.thinking))
      )),
    };
  }
  return {
    id: event.response?.id,
    output: (['response.output_text.delta', 'response.reasoning_text.delta',
      'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta'].includes(event.type)
      && nonempty(event.delta)) || (event.type === 'response.output_item.added'
      && event.item?.type === 'function_call' && nonempty(event.item.name)),
  };
}

function requestApi(input, init) {
  const method = init?.method || input?.method || 'GET';
  if (String(method).toUpperCase() !== 'POST') return;
  const pathname = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
  if (/\/chat\/completions\/?$/.test(pathname)) return 'openai-completions';
  if (/\/responses\/?$/.test(pathname)) return 'openai-responses';
  if (/\/messages\/?$/.test(pathname)) return 'anthropic-messages';
}

// Bounded incremental parser shared by the native Undici observer and fetch fallback.
function observeSse(api, started, remember) {
  let id, firstNs, stopped = false, buffer = '';
  const decoder = new TextDecoder();
  return chunk => {
    if (stopped) return;
    try {
      buffer += decoder.decode(chunk, { stream: true });
      let match;
      while (!stopped && (match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (block.length > MAX_BUFFER) { stopped = true; break; }
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data || data === '[DONE]') continue;
        let signal;
        try { signal = streamEvent(api, JSON.parse(data)); } catch { continue; }
        if (nonempty(signal.id) && signal.id.length <= 512) {
          if (id && id !== signal.id) { stopped = true; break; }
          id = signal.id;
        }
        if (firstNs === undefined && signal.output) firstNs = Math.round((performance.now() - started) * 1e6);
        if (id && firstNs !== undefined) {
          if (Number.isSafeInteger(firstNs) && firstNs >= 0) remember(api, id, firstNs);
          stopped = true;
        }
      }
      if (stopped || buffer.length > MAX_BUFFER) { stopped = true; buffer = ''; }
    } catch { stopped = true; buffer = ''; }
  };
}

export function installFirstTokenObserver() {
  if (globalThis[OBSERVER]) return globalThis[OBSERVER];
  const timings = new Map();
  const prune = () => {
    const now = performance.now();
    for (const [key, value] of timings) if (now - value.createdAt > TTL_MS) timings.delete(key);
  };
  const remember = (api, id, ns) => {
    prune();
    const key = `${api}:${id}`;
    timings.set(key, { ns: timings.has(key) ? undefined : ns, createdAt: performance.now() });
    while (timings.size > MAX_TIMINGS) timings.delete(timings.keys().next().value);
  };
  // Some OpenClaw distributions use dedicated Undici transports, bypassing global
  // fetch and the SDK provider registry. Subscribe without replacing transport,
  // provider, headers, TLS/security policy, body consumption, or cancellation.
  const requests = new WeakMap();
  const fetchContext = new AsyncLocalStorage();
  const subscriptions = [];
  const subscribe = (name, fn) => {
    const listener = value => { try { fn(value); } catch { /* fail open for the host */ } };
    const ch = channel(`undici:request:${name}`);
    ch.subscribe(listener);
    subscriptions.push(() => ch.unsubscribe(listener));
  };
  subscribe('create', ({ request }) => {
    const api = requestApi(new URL(request.path, request.origin), { method: request.method });
    if (!api) return;
    const context = fetchContext.getStore();
    const state = { consume: undefined };
    state.parser = observeSse(api, context?.started ?? performance.now(), (...args) => {
      if (context) context.observed = true;
      remember(...args);
    });
    requests.set(request, state);
  });
  subscribe('headers', ({ request, response }) => {
    const state = requests.get(request);
    if (!state) return;
    const headers = new Map();
    for (let i = 0; i < response.headers.length; i += 2) {
      headers.set(String(response.headers[i]).toLowerCase(), String(response.headers[i + 1]).toLowerCase());
    }
    // Diagnostics publish wire bytes, before decompression. Never parse a
    // compressed body as SSE; global fetch fallback can observe decoded bytes.
    const encoding = headers.get('content-encoding');
    if (response.statusCode >= 200 && response.statusCode < 300
      && headers.get('content-type')?.includes('text/event-stream')
      && (!encoding || encoding === 'identity')) state.consume = state.parser;
    else requests.delete(request);
  });
  subscribe('bodyChunkReceived', ({ request, chunk }) => requests.get(request)?.consume?.(chunk));
  subscribe('trailers', ({ request }) => requests.delete(request));
  subscribe('error', ({ request }) => requests.delete(request));

  const originalFetch = globalThis.fetch;
  const wrappedFetch = async function (...args) {
    let api;
    try { api = requestApi(args[0], args[1]); } catch { /* unrelated request */ }
    if (!api) return Reflect.apply(originalFetch, this, args);
    const context = { started: performance.now(), observed: false };
    const response = await fetchContext.run(context, () => Reflect.apply(originalFetch, this, args));
    if (!response.ok || !response.body
      || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response;
    const consume = observeSse(api, context.started, (...values) => {
      // Exact async request context suppresses double observation of one fetch;
      // it never associates concurrent requests by timing or a latest-call slot.
      if (!context.observed) remember(...values);
    });
    try {
      const transform = new TransformStream({ transform(chunk, controller) {
        controller.enqueue(chunk);
        if (!context.observed) consume(chunk);
      } });
      const wrapped = new Response(transform.readable, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
      for (const key of ['url', 'redirected', 'type']) Object.defineProperty(wrapped, key, { value: response[key] });
      response.body.pipeTo(transform.writable).catch(() => {});
      return wrapped;
    } catch { return response; }
  };
  if (typeof originalFetch === 'function') globalThis.fetch = wrappedFetch;
  const observer = {
    take(api, id) {
      prune();
      if (!nonempty(id)) return;
      const value = timings.get(`${api}:${id}`);
      if (!value) return;
      const ns = value.ns;
      value.ns = undefined;
      return ns;
    },
    dispose() {
      for (const unsubscribe of subscriptions) unsubscribe();
      if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
      if (globalThis[OBSERVER] === observer) delete globalThis[OBSERVER];
      timings.clear();
    },
  };
  globalThis[OBSERVER] = observer;
  return observer;
}

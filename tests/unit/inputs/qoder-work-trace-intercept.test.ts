import { describe, expect, it, vi } from 'vitest';
import type { AgentActivityEntry } from '../../../src/types/index.js';

// Mock the git enricher so the class can be instantiated without a repo.
vi.mock('../../../src/normalization/enrich-git-context.js', () => ({
  enrichCanonicalEntryWithGit: vi.fn(),
}));

import { QoderWorkTraceInput } from '../../../src/inputs/qoder-work-trace/qoder-work-trace-input.js';

// Minimal StateStore stub — only the BaseInput ctor touches it.
function makeStateStore() {
  return {
    getOffset: () => 0,
    setOffset: () => {},
    update: () => {},
    get: () => undefined,
  } as unknown as ConstructorParameters<typeof QoderWorkTraceInput>[0]['stateStore'];
}

function makeInput() {
  const input = new QoderWorkTraceInput({ stateStore: makeStateStore() });
  return input as unknown as {
    interceptTokens: import('../../../src/inputs/qoder-trace/intercept-token-reader.js').InterceptTokenData[];
    applyInterceptTokenUsage: (request: AgentActivityEntry, response: AgentActivityEntry) => void;
    applyUsage: (response: AgentActivityEntry, usage: Record<string, unknown>) => boolean;
  };
}

const MS = 1_783_000_000_000;
function nano(ms: number) { return String(BigInt(ms) * 1_000_000n); }

describe('QoderWorkTraceInput — intercept token fallback', () => {
  it('fills token usage from the closest intercept record when SDK/segment tokens are 0', () => {
    const input = makeInput();
    input.interceptTokens = [
      { id: 'chatcmpl-a', ts: MS + 100, promptTokens: 242, completionTokens: 3, cachedTokens: 0, reasoningTokens: 0, totalTokens: 245 },
      { id: 'chatcmpl-b', ts: MS + 5_000, promptTokens: 33837, completionTokens: 226, cachedTokens: 0, reasoningTokens: 0, totalTokens: 34063 },
    ];

    const request = { 'event.name': 'llm.request', time_unix_nano: nano(MS) } as AgentActivityEntry;
    const response = { 'event.name': 'llm.response', time_unix_nano: nano(MS + 100) } as AgentActivityEntry;

    input.applyInterceptTokenUsage(request, response);

    expect(response['gen_ai.usage.input_tokens']).toBe(242);
    expect(response['gen_ai.usage.output_tokens']).toBe(3);
    expect(response['gen_ai.usage.total_tokens']).toBe(245);
    // consumed once
    expect(input.interceptTokens).toHaveLength(1);
    expect(input.interceptTokens[0].id).toBe('chatcmpl-b');
  });

  it('does not match when the nearest token is outside the tolerance window', () => {
    const input = makeInput();
    input.interceptTokens = [
      { id: 'far', ts: MS + 60_000, promptTokens: 100, completionTokens: 10, cachedTokens: 0, reasoningTokens: 0, totalTokens: 110 },
    ];
    const request = { 'event.name': 'llm.request', time_unix_nano: nano(MS) } as AgentActivityEntry;
    const response = { 'event.name': 'llm.response', time_unix_nano: nano(MS) } as AgentActivityEntry;

    input.applyInterceptTokenUsage(request, response);

    expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(input.interceptTokens).toHaveLength(1); // not consumed
  });

  it('falls back to request time when response time is absent', () => {
    const input = makeInput();
    input.interceptTokens = [
      { id: 't', ts: MS + 2_000, promptTokens: 500, completionTokens: 50, cachedTokens: 30, reasoningTokens: 0, totalTokens: 550 },
    ];
    const request = { 'event.name': 'llm.request', time_unix_nano: nano(MS + 1_000) } as AgentActivityEntry;
    const response = { 'event.name': 'llm.response' } as AgentActivityEntry;

    input.applyInterceptTokenUsage(request, response);

    expect(response['gen_ai.usage.input_tokens']).toBe(500);
    expect(response['gen_ai.usage.cache_read.input_tokens']).toBe(30);
    // intercept has no cache_creation field — must stay unset, not zeroed
    expect(response['gen_ai.usage.cache_creation.input_tokens']).toBeUndefined();
  });

  it('is a no-op when no intercept tokens are available', () => {
    const input = makeInput();
    input.interceptTokens = [];
    const request = { 'event.name': 'llm.request', time_unix_nano: nano(MS) } as AgentActivityEntry;
    const response = { 'event.name': 'llm.response', time_unix_nano: nano(MS) } as AgentActivityEntry;

    expect(() => input.applyInterceptTokenUsage(request, response)).not.toThrow();
    expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
  });
});

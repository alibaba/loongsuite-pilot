import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { enrichZCodeModelSpans } from '../../../../src/flushers/zcode-model-outcomes.js';
import { stripAgentMessageContent } from '../../../../src/normalization/agent-content-policy.js';
import { buildAgentActivityEntry } from '../../../../src/normalization/entry-builder.js';
import { readZCodeRequestMaxTokens, readZCodeToolDefinitions } from '../../../../src/normalization/zcode-request-metadata.js';

const parameters = { type: 'object', properties: { path: { type: 'string' } } };
const tool = { type: 'function', name: 'Read', description: 'Read a file', parameters };

describe('ZCode request metadata', () => {
  it('normalizes nested and flat native tool schemas', () => {
    const nested = { type: 'function', function: { name: tool.name, description: tool.description, parameters } };
    const flat = { name: tool.name, description: tool.description, input_schema: parameters };
    expect(readZCodeToolDefinitions({ request: { body: { tools: [null, nested] } } })).toEqual([tool]);
    expect(readZCodeToolDefinitions({ request: { function_definitions: [flat] } })).toEqual([tool]);
  });

  it('preserves an explicit empty registry and distinguishes omitted tool definitions', () => {
    expect(readZCodeToolDefinitions({ request: { body: { tools: [] }, tools: [tool] } })).toEqual([]);
    expect(readZCodeToolDefinitions({ request: { toolNames: ['Read'] } })).toBeUndefined();
  });

  it('reads the provider limit and falls back to valid legacy fields', () => {
    expect(readZCodeRequestMaxTokens({ body: { max_completion_tokens: 256, max_tokens: 128 } })).toBe(256);
    expect(readZCodeRequestMaxTokens({ body: { max_completion_tokens: -1, max_tokens: 128 } })).toBe(128);
    expect(readZCodeRequestMaxTokens({ maxOutputTokens: 64 })).toBe(64);
    expect(readZCodeRequestMaxTokens({ body: { max_completion_tokens: '256', max_tokens: 0.5 } })).toBeUndefined();
  });

  it('projects each request onto the corresponding span and retains only safe numeric metadata after redaction', () => {
    const request = (id: string, maxTokens: number, tools: typeof tool[]) => buildAgentActivityEntry({
      'event.name': 'llm.request', 'gen_ai.response.id': id,
      'gen_ai.request.max_tokens': maxTokens, 'gen_ai.tool.definitions': tools,
    });
    const span = (id: string) => ({
      attributes: {
        'gen_ai.span.kind': 'LLM',
        'gen_ai.response.id': id,
        'gen_ai.tool.definitions': JSON.stringify([tool]),
      },
      status: { code: 0 },
    }) as unknown as ReadableSpan;
    const first = span('first');
    const second = span('second');
    const redacted = span('redacted');
    delete redacted.attributes['gen_ai.tool.definitions'];
    const duplicate = span('duplicate');
    enrichZCodeModelSpans([
      request('first', 128, [tool]),
      request('second', 256, []),
      stripAgentMessageContent(request('redacted', 512, [tool])),
      request('duplicate', 128, [tool]),
      request('duplicate', 256, []),
    ], [first, second, redacted, duplicate]);

    expect(first.attributes['gen_ai.tool.definitions']).toBe(JSON.stringify([tool]));
    expect(first.attributes['gen_ai.request.max_tokens']).toBe(128);
    expect(second.attributes['gen_ai.tool.definitions']).toBeUndefined();
    expect(second.attributes['gen_ai.request.max_tokens']).toBe(256);
    expect(redacted.attributes['gen_ai.tool.definitions']).toBeUndefined();
    expect(redacted.attributes['gen_ai.request.max_tokens']).toBe(512);
    expect(duplicate.attributes['gen_ai.request.max_tokens']).toBeUndefined();
  });
});

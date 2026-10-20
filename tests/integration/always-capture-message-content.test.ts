import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InputManager } from '../../src/core/input-manager.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { MockFlusher } from '../helpers/mock-flusher.js';

function makeTurn(content: string): AgentActivityEntry[] {
  const common = {
    'user.id': 'test-user',
    'gen_ai.agent.type': 'claude-code',
    'gen_ai.provider.name': 'anthropic',
    'gen_ai.session.id': 'test-session',
    'gen_ai.turn.id': 'test-turn',
    'gen_ai.step.id': 'test-step',
    'gen_ai.request.model': 'test-model',
  };
  return [
    {
      ...common,
      time_unix_nano: '1700000000000000000',
      'event.id': 'request',
      'event.name': 'llm.request',
      'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content }] }],
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content }] }],
      'gen_ai.system_instructions': [{ type: 'text', content: `system ${content}` }],
      'gen_ai.tool.definitions': [{ type: 'function', name: 'test_tool', description: content, parameters: {} }],
    },
    {
      ...common,
      time_unix_nano: '1700000000100000000',
      'event.id': 'tool-call',
      'event.name': 'tool.call',
      'gen_ai.tool.name': 'test_tool',
      'gen_ai.tool.call.id': 'test-call',
      'gen_ai.tool.call.arguments': { text: content },
    },
    {
      ...common,
      time_unix_nano: '1700000000200000000',
      'event.id': 'tool-result',
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'test_tool',
      'gen_ai.tool.call.id': 'test-call',
      'gen_ai.tool.call.result': { text: content },
    },
    {
      ...common,
      time_unix_nano: '1700000000300000000',
      'event.id': 'response',
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 5,
      'gen_ai.usage.output_tokens': 3,
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content }] }],
    },
  ];
}

function traceSink(captured: ReadableSpan[]): OtlpTraceFlusher {
  return new OtlpTraceFlusher({
    enabled: true,
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
    protocol: 'http/protobuf',
    serviceName: 'always-capture-test',
    captureMessageContent: false,
  }, undefined, () => ({
    export(spans, callback) {
      captured.push(...spans);
      callback({ code: ExportResultCode.SUCCESS });
    },
    async shutdown() {},
  }));
}

describe('always-on message content through the real Trace converter', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, '', 'NO_CONTENT', 'EVENT_ONLY', 'SPAN_ONLY', 'SPAN_AND_EVENT', 'invalid'])
  ('exports complete content despite inherited SDK capture mode %s', async (mode) => {
    vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', mode);
    vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'http');
    const spans: ReadableSpan[] = [];
    const flusher = traceSink(spans);
    try {
      await flusher.sendBatch(makeTurn('content-sentinel'));
    } finally {
      await flusher.shutdown();
    }

    expect(process.env.OTEL_SEMCONV_STABILITY_OPT_IN).toBe('http,gen_ai_latest_experimental');
    const llm = spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    const tool = spans.find(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(llm).toBeDefined();
    for (const key of ['gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.system_instructions', 'gen_ai.tool.definitions']) {
      expect(String(llm!.attributes[key])).toContain('content-sentinel');
    }
    expect(tool).toBeDefined();
    expect(String(tool!.attributes['gen_ai.tool.call.arguments'])).toContain('content-sentinel');
    expect(String(tool!.attributes['gen_ai.tool.call.result'])).toContain('content-sentinel');
    expect(llm!.attributes['gen_ai.usage.input_tokens']).toBe(5);
    expect(llm!.attributes['gen_ai.usage.output_tokens']).toBe(3);
  });

  it('keeps ordinary content while masking secrets across every destination despite legacy false', async () => {
    vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'NO_CONTENT');
    vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', '');
    const spans: ReadableSpan[] = [];
    const sinks = ['jsonl', 'sls', 'http'].map(name => new MockFlusher(name));
    const output = new MultiFlusher([...sinks, traceSink(spans)]);
    const manager = new InputManager();
    manager.setAgentsConfig({ 'claude-code': { captureMessageContent: false } });
    manager.setMaskConfig({ mode: 'all', types: [], replacementMode: 'placeholder' });
    manager.setFlusher(output);
    const apiKey = 'sk-1234567890abcdefghijklmnop';
    try {
      await manager.flushPreparedEntries(makeTurn(`ordinary-content ${apiKey}`));
    } finally {
      await output.shutdown();
    }

    for (const sink of sinks) {
      const entries = sink.batchCalls.flat();
      expect(entries).toHaveLength(4);
      const text = JSON.stringify(entries);
      expect(text).toContain('ordinary-content');
      expect(text).toContain('[APIKEY_MASKED]');
      expect(text).not.toContain(apiKey);
    }
    expect(spans.length).toBeGreaterThan(0);
    const text = JSON.stringify(spans.map(span => span.attributes));
    expect(text).toContain('ordinary-content');
    expect(text).toContain('[APIKEY_MASKED]');
    expect(text).not.toContain(apiKey);
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toHaveLength(1);
  });
});

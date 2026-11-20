import { describe, expect, it } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const base = {
  trace_id: '1234567890abcdef1234567890abcdef',
  'gen_ai.session.id': 'grok-session',
  'gen_ai.turn.id': 'grok-prompt',
  'gen_ai.agent.type': 'grok-build',
  'gen_ai.agent.id': 'grok-session',
  'gen_ai.framework': 'grok-build',
  'user.id': 'test-user',
} as const;

// Use a realistic epoch. The OpenTelemetry SDK may normalize timestamps close
// to Unix epoch against its process-relative clock when the full suite runs
// alongside fake-timer tests, which turns an otherwise valid fixture span into
// a zero-duration span.
const FIXTURE_EPOCH_MS = Date.parse('2026-07-29T03:48:00.000Z');

function record(
  eventName: AgentActivityEntry['event.name'],
  eventId: string,
  millis: number,
  fields: Record<string, unknown> = {},
): AgentActivityEntry {
  return {
    ...base,
    time_unix_nano: `${FIXTURE_EPOCH_MS + millis}000000`,
    'event.id': eventId,
    'event.name': eventName,
    ...fields,
  } as AgentActivityEntry;
}

function completeToolTurn(options: {
  toolStatus?: 'success' | 'failure' | 'cancelled';
  toolDuration?: number;
  terminal?: 'stop' | 'cancelled';
} = {}): AgentActivityEntry[] {
  const toolStatus = options.toolStatus ?? 'failure';
  const terminal = options.terminal ?? 'stop';
  return [
    record('other', 'prompt', 1_000, {
      'gen_ai.agent.description': 'Grok Build coding agent',
      'gen_ai.data_source.id': 'grok-build',
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'read' }] }],
    }),
    record('llm.request', 'request-1', 1_100, {
      'gen_ai.step.id': 'step-1',
      'gen_ai.response.id': 'response-1',
      'gen_ai.provider.name': 'x_ai',
      'gen_ai.request.model': 'grok-code-fast-1',
      'gen_ai.input.messages_hash': 'hash-1',
      'gen_ai.input.messages_delta': [
        { role: 'system', parts: [{ type: 'text', content: 'SYSTEM-CONTENT' }] },
        { role: 'user', parts: [{ type: 'text', content: 'read' }] },
      ],
      'gen_ai.system_instructions': [{ type: 'text', content: 'SYSTEM-CONTENT' }],
      'loongsuite.grok.timing.source': 'unified',
    }),
    record('llm.response', 'response-event-1', 3_100, {
      'gen_ai.step.id': 'step-1',
      'gen_ai.response.id': 'response-1',
      'gen_ai.provider.name': 'x_ai',
      'gen_ai.request.model': 'grok-code-fast-1',
      'gen_ai.response.model': 'grok-code-fast-1',
      'gen_ai.response.finish_reasons': ['tool_call'],
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cache_read.input_tokens': 10,
      'gen_ai.usage.cache_creation.input_tokens': 0,
      'gen_ai.usage.total_tokens': 120,
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'tool-1', name: 'read_file', arguments: {} }] }],
      'loongsuite.grok.timing.source': 'unified',
    }),
    record('tool.call', 'tool-call', 3_200, {
      'gen_ai.step.id': 'step-1',
      'gen_ai.tool.name': 'read_file',
      'gen_ai.tool.call.id': 'tool-1',
      'gen_ai.tool.call.arguments': { target_file: 'README.md' },
      'loongsuite.grok.match.strategy': 'id',
      'loongsuite.grok.timing.source': 'unified',
    }),
    record('tool.result', 'tool-result', 3_325, {
      'gen_ai.step.id': 'step-1',
      'gen_ai.tool.name': 'read_file',
      'gen_ai.tool.call.id': 'tool-1',
      'tool.result.status': toolStatus,
      ...(options.toolDuration !== undefined
        ? { 'gen_ai.tool.call.duration': options.toolDuration }
        : {}),
      ...(toolStatus === 'failure' ? { 'error.type': 'ToolError' } : {}),
      'loongsuite.grok.match.strategy': 'id',
      'loongsuite.grok.timing.source': 'unified',
    }),
    record('llm.request', 'request-2', 3_400, {
      'gen_ai.step.id': 'step-2',
      'gen_ai.response.id': 'response-2',
      'gen_ai.provider.name': 'x_ai',
      'gen_ai.request.model': 'grok-code-fast-1',
      'gen_ai.input.messages_hash': 'hash-2',
      'gen_ai.input.messages_delta': [{ role: 'tool', parts: [] }],
      'loongsuite.grok.timing.source': 'unified',
    }),
    record('llm.response', 'response-event-2', 7_900, {
      'gen_ai.step.id': 'step-2',
      'gen_ai.response.id': 'response-2',
      'gen_ai.provider.name': 'x_ai',
      'gen_ai.request.model': 'grok-code-fast-1',
      'gen_ai.response.model': 'grok-code-fast-1',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 130,
      'gen_ai.usage.output_tokens': 25,
      'gen_ai.usage.total_tokens': 155,
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'done' }] }],
      'loongsuite.grok.timing.source': 'unified',
    }),
    record('other', 'terminal', 8_000, {
      'gen_ai.response.finish_reasons': [terminal],
    }),
  ];
}

async function convert(records: AgentActivityEntry[]): Promise<ReadableSpan[]> {
  const exported: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({
    enabled: true,
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
    protocol: 'http/protobuf',
    serviceName: 'grok-unit',
  }, undefined, () => ({
    export: (spans, callback) => {
      exported.push(...spans);
      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: async () => {},
  }));
  await flusher.sendBatch(records);
  await flusher.shutdown();
  return exported;
}

describe('Grok Build OTLP reconstruction', () => {
  it('builds ENTRY → AGENT → STEP → LLM/TOOL and scopes reconstructed attributes', async () => {
    const spans = await convert(completeToolTurn({ toolDuration: 125 }));
    const kinds = spans.map(span => span.attributes['gen_ai.span.kind']);
    expect(kinds.filter(kind => kind === 'ENTRY')).toHaveLength(1);
    expect(kinds.filter(kind => kind === 'AGENT')).toHaveLength(1);
    expect(kinds.filter(kind => kind === 'STEP')).toHaveLength(2);
    expect(kinds.filter(kind => kind === 'LLM')).toHaveLength(2);
    expect(kinds.filter(kind => kind === 'TOOL')).toHaveLength(1);

    const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!;
    expect(agent.attributes['gen_ai.agent.description']).toBe('Grok Build coding agent');
    expect(agent.attributes['gen_ai.data_source.id']).toBe('grok-build');
    expect(agent.resource.attributes['gen_ai.agent.system']).toBe('grok');

    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms.filter(span => span.attributes['gen_ai.system_instructions'])).toHaveLength(1);
    expect(llms[0].attributes['gen_ai.system_instructions']).toContain('SYSTEM-CONTENT');
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] !== 'LLM')
      .every(span => span.attributes['gen_ai.system_instructions'] === undefined)).toBe(true);
    expect(spans.every(span =>
      !String(span.attributes['gen_ai.input.messages'] ?? '').includes('SYSTEM-CONTENT'))).toBe(true);

    const tool = spans.find(span => span.attributes['gen_ai.span.kind'] === 'TOOL')!;
    expect(tool.attributes['gen_ai.tool.call.duration']).toBe(125);
    expect(tool.attributes['loongsuite.grok.match.strategy']).toBe('id');
    expect(tool.attributes['loongsuite.grok.timing.source']).toBe('unified');
    expect(tool.status.code).toBe(2);
    expect(tool.attributes['error.type']).toBe('ToolError');
    expect(spans.filter(span => span !== tool)
      .every(span => span.attributes['gen_ai.tool.call.duration'] === undefined)).toBe(true);

    const entry = spans.find(span => span.attributes['gen_ai.span.kind'] === 'ENTRY')!;
    const durationMs = entry.duration[0] * 1_000 + entry.duration[1] / 1_000_000;
    expect(durationMs).toBeCloseTo(7_000, 3);
  });

  it('omits a truthful zero duration instead of fabricating a positive value', async () => {
    const spans = await convert(completeToolTurn({ toolStatus: 'success', toolDuration: 0 }));
    const tool = spans.find(span => span.attributes['gen_ai.span.kind'] === 'TOOL')!;
    expect(tool.attributes['gen_ai.tool.call.duration']).toBeUndefined();
    expect(tool.status.code).not.toBe(2);
  });

  it('marks cancelled TOOL/AGENT/ENTRY while preserving the real tool_call LLM outcome', async () => {
    const records = completeToolTurn({ toolStatus: 'cancelled', terminal: 'cancelled' }).slice(0, 5);
    records.push(record('other', 'terminal-cancelled', 3_400, {
      'gen_ai.response.finish_reasons': ['cancelled'],
    }));
    const spans = await convert(records);
    const llm = spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')!;
    expect(llm.status.code).not.toBe(2);
    for (const kind of ['TOOL', 'AGENT', 'ENTRY']) {
      const span = spans.find(candidate => candidate.attributes['gen_ai.span.kind'] === kind)!;
      expect(span.status.code).toBe(2);
    }
    expect(spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!
      .attributes['error.type']).toBe('cancelled');
  });

  it('marks a classified failed LLM attempt and both root spans', async () => {
    const records = completeToolTurn({ toolStatus: 'success' }).slice(0, 3);
    records[2]['gen_ai.response.finish_reasons'] = ['error'];
    records[2]['error.type'] = 'rate_limit';
    records.push(record('other', 'terminal-error', 3_200, {
      'gen_ai.response.finish_reasons': ['error'],
      'error.type': 'rate_limit',
    }));
    const spans = await convert(records);
    for (const kind of ['LLM', 'AGENT', 'ENTRY']) {
      const span = spans.find(candidate => candidate.attributes['gen_ai.span.kind'] === kind)!;
      expect(span.status.code).toBe(2);
      expect(span.attributes['error.type']).toBe('rate_limit');
      expect(span.attributes['error.message']).toBe('model request failed');
    }
  });

  it('keeps a prompt-only StopFailure as failed ENTRY/AGENT without an invented LLM', async () => {
    const spans = await convert([
      record('other', 'prompt-only', 1_000, {
        'gen_ai.agent.description': 'Grok Build coding agent',
        'gen_ai.data_source.id': 'grok-build',
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'fail' }] }],
      }),
      record('other', 'terminal-only', 1_100, {
        'gen_ai.response.finish_reasons': ['error'],
        'error.type': 'network_error',
      }),
    ]);
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(0);
    for (const kind of ['AGENT', 'ENTRY']) {
      const span = spans.find(candidate => candidate.attributes['gen_ai.span.kind'] === kind)!;
      expect(span.status.code).toBe(2);
      expect(span.attributes['error.type']).toBe('network_error');
    }
  });

  it('waits for the explicit turn terminal when records arrive one at a time', async () => {
    const exported: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
      protocol: 'http/protobuf',
      serviceName: 'grok-unit',
    }, undefined, () => ({
      export: (spans, callback) => {
        exported.push(...spans);
        callback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => {},
    }));
    const records = completeToolTurn({ toolStatus: 'success' });
    for (const item of records.slice(0, -1)) await flusher.send(item);
    expect(exported).toEqual([]);

    await flusher.send(records.at(-1)!);
    await flusher.flush();
    expect(exported.filter(span => span.attributes['gen_ai.span.kind'] === 'ENTRY')).toHaveLength(1);
    expect(exported.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toHaveLength(1);
    await flusher.shutdown();
  });
});

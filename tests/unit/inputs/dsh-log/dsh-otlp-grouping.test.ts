import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { TraceExporterLike } from '../../../../src/flushers/otlp-trace-flusher.js';
import {
  newState,
  transformDshRecord,
} from '../../../../src/inputs/dsh/dsh-event-transform.js';
import { ClientType } from '../../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

function transformTurn(sid: string, baseTime: number): AgentActivityEntry[] {
  const state = newState();
  const records: Record<string, unknown>[] = [
    { type: 'turn/start', sid, time: baseTime, data: { turn: 1 } },
    { type: 'step/start', sid, time: baseTime + 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', sid, time: baseTime + 2, data: { content: [{ type: 'text', text: 'hello' }] } },
    {
      type: 'request/header', sid, time: baseTime + 3,
      data: { header: { config: { provider: 'deepseek', model: 'deepseek-test' } } },
    },
    { type: 'request/context', sid, time: baseTime + 4, data: {} },
    {
      type: 'assistant/chunk', sid, time: baseTime + 5,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'done' } },
    },
    {
      type: 'assistant/chunk', sid, time: baseTime + 6,
      data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    },
    {
      type: 'assistant/message', sid, time: baseTime + 7,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: `${sid}-response`,
          content: [{ type: 'text', text: 'done' }],
          source: { provider: 'deepseek', model: 'deepseek-test' },
        },
        usage: {
          inputTokens: 3,
          outputTokens: 5,
          cacheReadTokens: 7,
          cacheWriteTokens: 11,
          reasoningTokens: 2,
        },
      },
    },
  ];
  return records
    .map(record => transformDshRecord(record, ClientType.Dsh, state))
    .filter((entry): entry is AgentActivityEntry => entry !== null);
}

describe('DSH session-scoped turn ids in OTLP buffering', () => {
  let captured: ReadableSpan[];
  let flusher: OtlpTraceFlusher;

  beforeEach(() => {
    captured = [];
    const exporter: TraceExporterLike = {
      export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
        captured.push(...spans);
        callback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    };
    flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'test', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
      protocol: 'http/protobuf',
      serviceName: 'dsh-test',
    }, undefined, () => exporter);
  });

  afterEach(async () => {
    await flusher.shutdown();
  });

  it('exports both sessions when each uses native turn 1', async () => {
    const a = transformTurn('session-a', 1_800_000_000_000);
    const b = transformTurn('session-b', 1_800_000_001_000);
    expect(new Set(a.map(entry => entry['gen_ai.turn.id']))).toEqual(new Set(['session-a:1']));
    expect(new Set(b.map(entry => entry['gen_ai.turn.id']))).toEqual(new Set(['session-b:1']));

    await flusher.sendBatch(a);
    await flusher.flush();
    await flusher.sendBatch(b);
    await flusher.flush();

    const entrySpans = captured.filter(span => span.attributes['gen_ai.span.kind'] === 'ENTRY');
    const agentSpans = captured.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
    expect(entrySpans).toHaveLength(2);
    expect(agentSpans).toHaveLength(2);
    expect(new Set(entrySpans.map(span => span.spanContext().traceId)).size).toBe(2);
    const llmSpans = captured.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llmSpans).toHaveLength(2);
    expect(llmSpans.map(span => span.attributes['gen_ai.response.time_to_first_token']))
      .toEqual([1_000_000, 1_000_000]);
    for (const span of [...llmSpans, ...agentSpans]) {
      expect(span.attributes['gen_ai.usage.input_tokens']).toBe(21);
      expect(span.attributes['gen_ai.usage.output_tokens']).toBe(5);
      expect(span.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(7);
      expect(span.attributes['gen_ai.usage.cache_creation.input_tokens']).toBe(11);
      expect(span.attributes['gen_ai.usage.total_tokens']).toBe(26);
    }
    for (const span of captured) {
      expect(span.resource.attributes['gen_ai.agent.type']).toBe('dsh');
      expect(span.resource.attributes['gen_ai.agent.system']).toBe('dsh');
    }
  });
});

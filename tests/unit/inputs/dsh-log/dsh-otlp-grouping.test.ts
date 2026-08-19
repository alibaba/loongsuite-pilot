import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
    {
      type: 'user/message',
      sid,
      time: baseTime + 2,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    },
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

interface SpanMessage {
  role?: string;
  parts?: Array<{ content?: string }>;
}

function readInputMessages(span: ReadableSpan): SpanMessage[] {
  return JSON.parse(String(span.attributes['gen_ai.input.messages'])) as SpanMessage[];
}

function messageText(message: SpanMessage): string {
  return message.parts?.map(part => part.content ?? '').join('') ?? '';
}

function compareSpanStart(a: ReadableSpan, b: ReadableSpan): number {
  return a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1];
}

describe('DSH event-to-span OTLP flow', () => {
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

  it('keeps injected context on LLM spans but excludes it from ENTRY and AGENT', async () => {
    const fixturePath = path.resolve('tests/fixtures/dsh/dsh-probe-events-real.jsonl');
    const fixture = await fs.readFile(fixturePath, 'utf8');
    const records = fixture.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const state = newState();
    const entries = records
      .map(record => transformDshRecord(record, ClientType.Dsh, state))
      .filter((entry): entry is AgentActivityEntry => entry !== null);

    await flusher.sendBatch(entries);
    await flusher.flush();

    const entry = captured.find(span => span.attributes['gen_ai.span.kind'] === 'ENTRY');
    const agent = captured.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
    expect(entry).toBeDefined();
    expect(agent).toBeDefined();

    const entryInput = readInputMessages(entry!);
    const agentInput = readInputMessages(agent!);
    expect(entryInput).toHaveLength(1);
    expect(agentInput).toEqual(entryInput);
    expect(messageText(entryInput[0])).toContain('Create a hello.txt file');
    expect(messageText(entryInput[0])).not.toContain('Current runtime context');

    const llmSpans = captured
      .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')
      .sort(compareSpanStart);
    expect(llmSpans).toHaveLength(3);
    const llmInputs = llmSpans.map(readInputMessages);
    expect(llmInputs.map(messages => messages.map(message => message.role))).toEqual([
      ['user', 'user'],
      ['user', 'user', 'assistant', 'tool'],
      ['user', 'user', 'assistant', 'tool', 'assistant', 'tool'],
    ]);
    expect(messageText(llmInputs[0][0])).toContain('Create a hello.txt file');
    expect(messageText(llmInputs[0][1])).toContain('Current runtime context');
  });
});

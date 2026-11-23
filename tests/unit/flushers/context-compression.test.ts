import { describe, expect, it } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';
import { hasActiveCompression } from '../../../src/flushers/context-compression.js';
import { buildAgentActivityEntry } from '../../../src/normalization/entry-builder.js';
import { newState, transformDshRecord } from '../../../src/inputs/dsh/dsh-event-transform.js';
import { ClientType, type AgentActivityEntry } from '../../../src/types/index.js';

const base = { 'gen_ai.agent.type': 'pi-coding-agent', 'gen_ai.session.id': 'session',
  'gen_ai.turn.id': 'compress-1', 'gen_ai.context.compress.id': 'attempt',
  'user.id': 'tester', trace_id: '1234567890abcdef1234567890abcdef' };
const start = Date.now() - 6000;
function event(name: string, offset: number, extra = {}) {
  return buildAgentActivityEntry({ ...base, 'event.name': name, 'event.id': `${name}-${offset}`,
    time_unix_nano: String(BigInt(start + offset) * 1_000_000n), ...extra });
}
async function flush(records: AgentActivityEntry[], captureMessageContent = true) {
  const spans: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'compression-test',
    captureMessageContent, protocol: 'http/protobuf',
    endpoints: [{ endpoint: 'http://localhost:4318/v1/traces' }] }, undefined,
  () => ({ export(batch, done) { spans.push(...batch); done({ code: ExportResultCode.SUCCESS }); }, shutdown: async () => {} }));
  try { await flusher.sendBatch(records); await flusher.flush(); return spans; }
  finally { await flusher.shutdown(); }
}

describe('context compression through the real flusher and SDK', () => {
  it('exports one timed INTERNAL child and preserves source counts without charging LLM tokens', async () => {
    const records = [event('gen_ai.context.compress.start', 0),
      event('gen_ai.context.compress', 1234, { 'gen_ai.context.compress.status': 'success',
        'gen_ai.context.compress.standalone': true, 'gen_ai.context.tokens_before': 10000,
        'gen_ai.context.tokens_after': 2500, 'gen_ai.context.compression_ratio': 0.25 })];
    const spans = await flush([...records, records[1]]);
    const compression = spans.filter(s => s.name === 'gen_ai.context.compress');
    expect(compression).toHaveLength(1);
    expect(compression[0].kind).toBe(0);
    expect(compression[0].duration).toEqual([1, 234000000]);
    expect(compression[0].attributes).toMatchObject({ 'gen_ai.span.kind': 'COMPRESSION',
      'gen_ai.context.tokens_before': 10000, 'gen_ai.context.tokens_after': 2500,
      'gen_ai.context.compress.duration': 1.234 });
    const agent = spans.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT')!;
    expect(compression[0].parentSpanId).toBe(agent.spanContext().spanId);
    expect(spans.find(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')?.parentSpanId).toBeUndefined();
    expect(agent.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(0);
  });

  it('retains completion-only evidence in logs without fabricating a timed trace', async () => {
    const spans = await flush([event('gen_ai.context.compress', 1000)]);
    expect(spans).toHaveLength(0);
  });

  it('reconstructs the source interval from seconds and omits private summary content', async () => {
    const spans = await flush([event('gen_ai.context.compress', 3000,
      { 'gen_ai.context.compress.duration': 2, 'gen_ai.context.compress.status': 'error',
        'gen_ai.context.compress.standalone': true, 'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'private summary' }] }] })], false);
    const compression = spans.find(s => s.name === 'gen_ai.context.compress')!;
    expect(compression.duration).toEqual([2, 0]);
    expect(compression.status.code).toBe(2);
    expect(JSON.stringify(spans.map(s => s.attributes))).not.toContain('private summary');
  });

  it('delays idle sealing only while a bounded attempt is active', () => {
    const record = event('gen_ai.context.compress.start', 0);
    expect(hasActiveCompression([record], start + 120000)).toBe(true);
    expect(hasActiveCompression([record, event('gen_ai.context.compress', 1234)], start + 120000)).toBe(false);
    expect(hasActiveCompression([record], start + 3600001)).toBe(false);
  });

  it('keeps an active long compression after an LLM stop and accepts later completion', async () => {
    const spans: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'compression-live',
      protocol: 'http/protobuf', turnIdleTimeoutMs: 1,
      endpoints: [{ endpoint: 'http://localhost:4318/v1/traces' }] }, undefined,
    () => ({ export(batch, done) { spans.push(...batch); done({ code: ExportResultCode.SUCCESS }); }, shutdown: async () => {} }));
    try {
      await flusher.sendBatch([event('gen_ai.context.compress.start', 0),
        event('llm.request', 1, { 'gen_ai.step.id': 's1', 'gen_ai.request.model': 'test', 'gen_ai.provider.name': 'qwen' }),
        event('llm.response', 100, { 'gen_ai.step.id': 's1', 'gen_ai.request.model': 'test', 'gen_ai.provider.name': 'qwen',
          'gen_ai.response.finish_reasons': ['stop'] })]);
      (flusher as unknown as { tickIdleTimeout(): void }).tickIdleTimeout();
      expect(spans).toHaveLength(0);
      await flusher.sendBatch([event('gen_ai.context.compress', 3000, { 'gen_ai.context.compress.status': 'success' })]);
      expect(spans.filter(s => s.name === 'gen_ai.context.compress')).toHaveLength(1);
      expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
    } finally { await flusher.shutdown(); }
  });

  it('keeps a DSH manual transaction independent from the previous numbered turn', async () => {
    const state = newState();
    state.currentTurn = 7;
    const first = transformDshRecord({ sid: 'dsh-session', type: 'compaction/start', time: start,
      data: { compactionId: 'c1', turn: null } }, ClientType.Dsh, state)!;
    const last = transformDshRecord({ sid: 'dsh-session', type: 'compaction/end', time: start + 2500,
      data: { compactionId: 'c1', turn: null, error: 'model failed' } }, ClientType.Dsh, state)!;
    expect(first['gen_ai.turn.id']).toBe('dsh-session:compression:c1');
    expect(last['gen_ai.context.compress.duration']).toBe(2.5);
    expect(last['gen_ai.context.compress.status']).toBe('error');
    expect((await flush([first, last])).filter(s => s.name === 'gen_ai.context.compress')).toHaveLength(1);
  });

  it('drops stale DSH full context after a top-level surface rewrite', () => {
    const state = newState();
    const transform = (type: string, data = {}, extra = {}) => transformDshRecord({
      sid: 'dsh-session', type, time: start, data: { turn: 1, step: 1, ...data }, ...extra,
    }, ClientType.Dsh, state);
    transform('turn/start');
    transform('user/message', { content: 'original context' });
    transform('user/message', { content: 'compressed summary' }, { surfaceOp: { op: 'replace' } });
    const request = transform('assistant/chunk', { chunk: { type: 'text-delta', delta: 'answer' } });
    expect(request?.['event.name']).toBe('llm.request');
    expect(request?.['gen_ai.input.messages']).toBeUndefined();
    expect(request?.['gen_ai.input.messages_delta']).toBeUndefined();
  });

  it('keeps compacted context attributes local to the matched LLM request', async () => {
    const spans = await flush([
      event('llm.request', 0, { 'gen_ai.step.id': 's1', 'gen_ai.request.model': 'test',
        'gen_ai.provider.name': 'qwen', 'gen_ai.context.tokens_used': 100,
        'gen_ai.context.window_size': 1000, 'gen_ai.context.window_usage_pct': 0.1,
        'gen_ai.conversation.compacted': true }),
      event('llm.response', 100, { 'gen_ai.step.id': 's1', 'gen_ai.request.model': 'test',
        'gen_ai.provider.name': 'qwen', 'gen_ai.response.id': 'r1', 'gen_ai.response.finish_reasons': ['tool_calls'] }),
      event('llm.request', 101, { 'gen_ai.step.id': 's2', 'gen_ai.request.model': 'test', 'gen_ai.provider.name': 'qwen' }),
      event('llm.response', 200, { 'gen_ai.step.id': 's2', 'gen_ai.request.model': 'test',
        'gen_ai.provider.name': 'qwen', 'gen_ai.response.id': 'r2', 'gen_ai.response.finish_reasons': ['stop'] }),
    ]);
    const llms = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms).toHaveLength(2);
    expect(llms.find(s => s.attributes['gen_ai.response.id'] === 'r1')?.attributes).toMatchObject({
      'gen_ai.context.tokens_used': 100, 'gen_ai.context.window_size': 1000,
      'gen_ai.context.window_usage_pct': 0.1, 'gen_ai.conversation.compacted': true,
    });
    expect(llms.find(s => s.attributes['gen_ai.response.id'] === 'r2')?.attributes)
      .not.toHaveProperty('gen_ai.conversation.compacted');
  });
});

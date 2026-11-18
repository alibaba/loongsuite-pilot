import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';
import { TurnBoundaryProcessor } from '../../../src/normalization/turn-boundary-processor.js';
import { InputManager } from '../../../src/core/input-manager.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

// Synthetic fixtures specifically test collector buffering; real runtime evidence is in the E2E harness.
function turn(session: string, run: string): AgentActivityEntry[] {
  const scope = (kind: string, id: string, parent: string, phase: string, time: string): AgentActivityEntry => ({
    time_unix_nano: time, 'event.id': `${session}-${run}-${kind}-${phase}`,
    'event.name': kind === 'llm' ? (phase === 'start' ? 'llm.request' : 'llm.response') : 'other',
    'gen_ai.agent.type': 'qwenpaw', 'gen_ai.session.id': session, 'gen_ai.turn.id': run,
    'agent.qwenpaw.span.id': id, 'agent.qwenpaw.parent.id': parent,
    ...(kind === 'llm' ? {} : { 'agent.qwenpaw.boundary': `${kind}.${phase}` }),
    ...(kind === 'llm' && phase === 'end' ? { 'gen_ai.response.finish_reasons': ['stop'] } : {}),
    ...(kind === 'entry' && phase === 'end' ? { 'gen_ai.turn.end': true } : {}),
    'user.id': 'user-' + session,
  });
  const specs = [['entry', '1111111111111111', ''], ['agent', '2222222222222222', '1111111111111111'], ['step', '3333333333333333', '2222222222222222'], ['llm', '4444444444444444', '3333333333333333']];
  return [...specs.map(([k, id, p], i) => scope(k, id, p, 'start', String(1700000000000000000n + BigInt(i) * 1000000n))),
    ...[...specs].reverse().map(([k, id, p], i) => scope(k, id, p, 'end', String(1700000000100000000n + BigInt(i) * 1000000n)))];
}

describe('QwenPaw collector lifecycle isolation', () => {
  let flusher: OtlpTraceFlusher;
  let spans: ReadableSpan[];
  beforeEach(() => {
    spans = [];
    flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://localhost:4318/v1/traces', headers: {} }], protocol: 'http/protobuf', serviceName: 'parity', debug: false }, undefined,
      () => ({ export: (batch, callback) => { spans.push(...batch); callback({ code: ExportResultCode.SUCCESS }); }, shutdown: async () => {} }));
  });
  afterEach(async () => { await flusher.shutdown(); vi.restoreAllMocks(); });

  it('waits for bounded export before converting the next lifecycle and retains content', async () => {
    await flusher.shutdown();
    const stoppedModels = vi.spyOn(ExtendedTelemetryHandler.prototype, 'stopLlm');
    let release!: () => void;
    let first = true;
    flusher = new OtlpTraceFlusher({
      enabled: true, serviceName: 'streaming', protocol: 'http/protobuf', maxExportBatchBytes: 1,
      endpoints: [{ name: 'test', endpoint: 'http://unused:4318' }],
    }, undefined, () => ({
      export(batch, done) {
        spans.push(...batch);
        if (first) { first = false; release = () => done({ code: ExportResultCode.SUCCESS }); }
        else done({ code: ExportResultCode.SUCCESS });
      }, shutdown: async () => {},
    }));
    const records = turn('session', 'run');
    const content = 'retained content '.repeat(10_000);
    records[3]['gen_ai.input.messages'] = [{ role: 'user', parts: [{ type: 'text', content }] }];
    let complete = false;
    const sending = flusher.sendBatch(records).then(() => { complete = true; });
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      expect(stoppedModels).not.toHaveBeenCalled();
      expect(complete).toBe(false);
    } finally { release?.(); }
    await sending;
    expect(spans).toHaveLength(4);
    expect(spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')?.attributes['gen_ai.input.messages']).toContain(content);
  });

  it('does not restore spilled message content when the trace exporter disables capture', async () => {
    await flusher.shutdown();
    flusher = new OtlpTraceFlusher({
      enabled: true, serviceName: 'private', protocol: 'http/protobuf', captureMessageContent: false,
      endpoints: [{ name: 'test', endpoint: 'http://unused:4318' }],
    }, undefined, () => ({ export: (batch, done) => { spans.push(...batch); done({ code: ExportResultCode.SUCCESS }); }, shutdown: async () => {} }));
    const records = turn('session', 'private');
    records[3]['gen_ai.input.messages'] = [{ role: 'user', parts: [{ type: 'text', content: 'private-message' }] }];
    records[4]['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: 'private-answer' }] }];
    await flusher.sendBatch(records);
    expect(spans).toHaveLength(4);
    const exported = JSON.stringify(spans.map(span => ({ attributes: span.attributes, events: span.events })));
    expect(exported).not.toContain('private-message');
    expect(exported).not.toContain('private-answer');
  });

  it('keeps masked content masked after payload spill and span conversion', async () => {
    const secret = 'AKIA' + 'QWERTYUIOPASDFGH';
    const records = turn('session', 'masked');
    records[0]['gen_ai.input.messages'] = [{ role: 'user', parts: [{ type: 'text', content: secret }] }];
    records[3]['gen_ai.input.messages'] = [{ role: 'user', parts: [{ type: 'text', content: secret }] }];
    records[4]['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: secret }] }];
    const manager = new InputManager();
    manager.setFlusher(flusher);
    manager.setMaskConfig({ mode: 'all', types: [] });
    await manager.flushPreparedEntries(records);
    expect(spans).toHaveLength(4);
    const exported = JSON.stringify(spans.map(span => ({ attributes: span.attributes, events: span.events })));
    expect(exported).not.toContain(secret);
    expect(exported).toContain('[ACCESSKEY_MASKED]');
  });

  it('does not end an ENTRY on LLM stop, and preserves native request identity', async () => {
    const records = turn('session', 'run');
    const initial = records.slice(0, 5);
    new TurnBoundaryProcessor().enrich(initial);
    expect(initial[4]['gen_ai.turn.end']).toBeUndefined();
    await flusher.sendBatch(initial);
    expect(spans).toHaveLength(0);
    await flusher.sendBatch(records.slice(5));
    await flusher.flush();
    expect(spans).toHaveLength(4);
    expect(spans.every(span => span.attributes['gen_ai.session.id'] === 'session')).toBe(true);
    expect(spans.every(span => span.attributes['gen_ai.turn.id'] === 'run')).toBe(true);
  });

  it('keeps overlapping runs in one session buffered independently', async () => {
    const a = turn('session', 'a');
    const b = turn('session', 'b');
    await flusher.sendBatch(a.slice(0, 5));
    await flusher.sendBatch(b.slice(0, 5));
    expect(spans).toHaveLength(0);
    await flusher.sendBatch(a.slice(5));
    await flusher.sendBatch(b.slice(5));
    await flusher.flush();
    expect(spans).toHaveLength(8);
    expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(2);
    expect(spans.filter(span => span.attributes['gen_ai.turn.id'] === 'a')).toHaveLength(4);
  });

  it('isolates equal run IDs from different sessions and suppresses late duplicate terminal records', async () => {
    const a = turn('session-a', 'same');
    const b = turn('session-b', 'same');
    await flusher.sendBatch(a.slice(0, 5));
    await flusher.sendBatch(b.slice(0, 5));
    await flusher.sendBatch(a.slice(5));
    await flusher.sendBatch(b.slice(5));
    await flusher.sendBatch(a);
    await flusher.flush();
    expect(spans).toHaveLength(8);
    expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(2);
    expect(spans.filter(span => span.attributes['gen_ai.session.id'] === 'session-a')).toHaveLength(4);
  });
});

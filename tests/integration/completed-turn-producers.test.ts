import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import * as stream from '../../src/flushers/turn-stream.js';
import { openCodeProducer, hermesProducer, claudeProducer } from '../helpers/completed-turn-producers.mjs';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-producer-turn-')); roots.push(dir); return dir; }
function snapshot(spans: ReadableSpan[]) {
  const key = (s: ReadableSpan) => JSON.stringify([s.attributes['gen_ai.span.kind'], s.attributes['gen_ai.response.id'],
    s.attributes['gen_ai.tool.call.id'], s.attributes['gen_ai.react.round'], s.startTime]);
  const byId = new Map(spans.map(s => [s.spanContext().spanId, key(s)]));
  return spans.map(s => ({ key: key(s), name: s.name, trace: s.spanContext().traceId,
    parent: byId.get(s.parentSpanId!) ?? s.parentSpanId,
    start: s.startTime, end: s.endTime, status: s.status,
    attributes: Object.fromEntries(Object.entries(s.attributes).sort(([a], [b]) => a.localeCompare(b))),
  })).sort((a, b) => a.key.localeCompare(b.key));
}
async function convert(records: any[], batch = false) {
  if (batch) vi.spyOn(stream, 'planTurnStream').mockReturnValueOnce(undefined);
  const exported: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'producer-parity',
    maxExportBatchBytes: 3000, endpoints: [{ endpoint: 'http://unused:4318' }] }, undefined,
    () => ({ export(spans, callback) { exported.push(...spans); callback({ code: 0 }); }, shutdown: async () => {} }));
  try { await flusher.sendBatch(records); await flusher.flush(); } finally { await flusher.shutdown(); }
  return exported;
}

describe('Shipped producers through shared completed-turn conversion', () => {
  it.each(['opencode', 'opencode-cancelled', 'hermes', 'claude-code'])(
    'preserves every span and message from the real %s producer module', async agent => {
      const records = agent.startsWith('opencode') ? await openCodeProducer({ cancelled: agent.endsWith('cancelled') })
        : agent === 'hermes' ? hermesProducer(root()) : claudeProducer(root());
      const original = JSON.stringify(records);
      const expected = await convert(records, true);
      const planner = vi.spyOn(stream, 'planTurnStream');
      const actual = await convert(records);
      expect(planner.mock.results.some(result => typeof result.value === 'function')).toBe(true);
      expect(snapshot(actual)).toEqual(snapshot(expected));
      expect(JSON.stringify(records)).toBe(original);
      expect(actual.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(8);
      expect(new Set(actual.map(s => s.spanContext().spanId)).size).toBe(actual.length);
      const llms = actual.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
      const aggregate = actual.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT')!;
      for (const key of ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.cache_read.input_tokens',
        'gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.reasoning_tokens']) {
        const sum = llms.reduce((total, s) => total + Number(s.attributes[key] ?? 0), 0);
        if (sum > 0) expect(aggregate.attributes[key]).toBe(sum);
      }
    },
  );
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import * as stream from '../../src/flushers/turn-stream.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

const plan = stream.planTurnStream;
const count = (rows: AgentActivityEntry[], name: string) => rows.filter(row => row['event.name'] === name).length;
function shape(rows: AgentActivityEntry[], streamed: boolean) {
  const requests = rows.filter(row => row['event.name'] === 'llm.request');
  const steps = new Map<string, number>();
  for (const request of requests) {
    const step = String(request['gen_ai.step.id'] ?? '');
    steps.set(step, (steps.get(step) ?? 0) + 1);
  }
  return { streamed, agentTypes: [...new Set(rows.map(row => row['gen_ai.agent.type']))],
    records: rows.length, requests: requests.length, responses: count(rows, 'llm.response'),
    steps: steps.size, requestsWithoutStep: requests.filter(row => !row['gen_ai.step.id']).length,
    maxRequestsPerStep: Math.max(0, ...steps.values()),
    inlineChildRecords: rows.filter(row => row['gen_ai.agent.scope'] === 'subagent').length,
    fullInputs: requests.filter(row => row['gen_ai.input.messages'] !== undefined).length,
    deltaInputs: requests.filter(row => row['gen_ai.input.messages_delta'] !== undefined).length };
}
function normalized(spans: ReadableSpan[], source: AgentActivityEntry[]) {
  const traces = new Set(source.map(row => row.trace_id).filter(Boolean));
  const sourceSpanIds = new Set(source.map(row => row.span_id).filter(Boolean));
  const key = (span: ReadableSpan) => JSON.stringify(['gen_ai.span.kind', 'gen_ai.turn.id', 'gen_ai.step.id',
    'gen_ai.response.id', 'gen_ai.tool.call.id', 'gen_ai.react.round'].map(name => span.attributes[name]).concat([span.startTime]));
  const byId = new Map(spans.map(span => [span.spanContext().spanId, key(span)]));
  return spans.map(span => JSON.stringify({ name: span.name, kind: span.kind,
    trace: traces.has(span.spanContext().traceId) ? span.spanContext().traceId : 'SDK_ALLOCATED',
    spanId: sourceSpanIds.has(span.spanContext().spanId) ? span.spanContext().spanId : 'SDK_ALLOCATED',
    parent: byId.get(span.parentSpanId!) ?? span.parentSpanId,
    start: span.startTime, end: span.endTime, status: span.status,
    attributes: Object.fromEntries(Object.entries(span.attributes).sort(([a], [b]) => a.localeCompare(b))),
  })).sort();
}

/** Compare actual producer/Input output through Pilot, including adapter preparation
 * and post-conversion enrichment. Optional evidence contains counts/digests only. */
export async function expectTurnStrategyParity(source: AgentActivityEntry[], label: string) {
  // Some native-format unit fixtures intentionally use epoch 0/1970. The SDK
  // treats small numbers as performance timestamps. Fix only the execution
  // clock for deterministic A/B; never rewrite those source timestamps.
  const now = Date.now();
  const ownedWallClock = !vi.isMockFunction(Date.now), ownedMonotonicClock = !vi.isMockFunction(performance.now);
  const wallClock = vi.spyOn(Date, 'now'), monotonicClock = vi.spyOn(performance, 'now');
  const previousWallClock = wallClock.getMockImplementation(), previousMonotonicClock = monotonicClock.getMockImplementation();
  wallClock.mockReturnValue(now); monotonicClock.mockReturnValue(0);
  const original = JSON.stringify(source);
  const decisions: ReturnType<typeof shape>[] = [];
  const planner = vi.spyOn(stream, 'planTurnStream');
  async function collect(batch: boolean) {
    planner.mockImplementation((records, options) => {
      if (batch) return undefined;
      const selected = plan(records, options);
      decisions.push(shape(records as AgentActivityEntry[], !!selected));
      return selected;
    });
    const spans: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'turn-impact',
      maxExportBatchBytes: 3000, endpoints: [{ endpoint: 'http://unused:4318' }] }, undefined,
      () => ({ export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {} }));
    try { await flusher.sendBatch(structuredClone(source)); await flusher.flush(); }
    finally { await flusher.shutdown(); }
    assert.equal(new Set(spans.map(span => `${span.spanContext().traceId}:${span.spanContext().spanId}`)).size,
      spans.length, label + ': duplicate exported Span IDs');
    return spans;
  }
  try {
    const batch = await collect(true);
    const current = await collect(false);
    const expected = normalized(batch, source), actual = normalized(current, source);
    const same = JSON.stringify(expected) === JSON.stringify(actual);
    const kinds = (spans: ReadableSpan[]) => Object.fromEntries([...new Set(spans.map(s => String(s.attributes['gen_ai.span.kind'])))]
      .map(kind => [kind, spans.filter(s => s.attributes['gen_ai.span.kind'] === kind).length]));
    const result = { label, source: shape(source, false), decisions, batchSpans: batch.length, currentSpans: current.length,
      batchKinds: kinds(batch), currentKinds: kinds(current), parityPass: same,
      normalizedDigest: createHash('sha256').update(JSON.stringify(actual)).digest('hex') };
    const dir = process.env.PILOT_TURN_IMPACT_DIR;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      const name = label.replace(/[^a-z0-9-]/gi, '-').slice(0, 100);
      fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(result, null, 2));
      if (process.env.PILOT_TURN_IMPACT_RECORDS === '1') {
        fs.mkdirSync(path.join(dir, 'records'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'records', name + '.jsonl'), source.map(row => JSON.stringify(row)).join('\n') + '\n');
      }
    }
    assert.equal(same, true, label + ': completed-turn strategy changes observable spans (see optional impact evidence)');
    assert.equal(JSON.stringify(source), original, label + ': converter changed source events');
    return result;
  } finally {
    planner.mockRestore();
    if (ownedMonotonicClock) monotonicClock.mockRestore(); else monotonicClock.mockImplementation(previousMonotonicClock!);
    if (ownedWallClock) wallClock.mockRestore(); else wallClock.mockImplementation(previousWallClock!);
  }
}

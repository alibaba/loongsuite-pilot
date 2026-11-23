import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildEnvelopeRecords } from '../../../../assets/hooks/zcode-hook-processor.mjs';
import { toW3CTraceId } from '../../../../assets/hooks/shared/event-emitter.mjs';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { ZCodeRolloutInput } from '../../../../src/inputs/zcode-rollout/zcode-rollout-input.js';
import { buildAgentActivityEntry } from '../../../../src/normalization/entry-builder.js';

let dataDir: string;
let input: ZCodeRolloutInput;
let flusher: OtlpTraceFlusher;
let spans: ReadableSpan[];
let lines: Array<Record<string, unknown>>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  dataDir = await mkdtemp(join(tmpdir(), 'pilot-zcode-trace-'));
  input = new ZCodeRolloutInput({ stateStore: new StateStore(join(dataDir, 'state.json')), rolloutDir: dataDir });
  const fixture = await readFile(new URL('./fixtures/rollout-cross-batch-react.jsonl', import.meta.url), 'utf8');
  lines = fixture.trim().split('\n').map(line => JSON.parse(line));
  spans = [];
  flusher = new OtlpTraceFlusher({
    enabled: true, endpoints: [{ endpoint: 'http://127.0.0.1:4318' }], protocol: 'http/protobuf',
    serviceName: 'zcode-test', dataDir, zcodeSourceWaitMs: 1_000,
  }, undefined, () => ({
    export(batch, callback) { spans.push(...batch); callback({ code: 0 }); },
    async shutdown() {},
  }));
});

afterEach(async () => {
  try {
    await flusher.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  } finally {
    vi.useRealTimers();
  }
});

function envelope(records = lines) {
  const { sessionId, turnId, traceId } = records[0]!;
  return buildEnvelopeRecords({
    sessionId, turnId, traceId: toW3CTraceId(traceId), timestamp: records.at(-1)!.completedAt,
    userId: 'local-validation', cwd: dataDir, stopReason: 'end_turn',
  }).map(buildAgentActivityEntry);
}

function spansOf(kind: string, traceId = lines[0]!.traceId): ReadableSpan[] {
  return spans.filter(span => span.attributes['gen_ai.span.kind'] === kind
    && span.spanContext().traceId === toW3CTraceId(traceId));
}

it.each(['hook', 'rollout'])('joins both inputs into one trace when %s is polled first', async first => {
  const hook = envelope();
  const rollout = input.buildEntriesFromRolloutLines(lines);
  await flusher.sendBatch(first === 'hook' ? hook : rollout);
  expect(spans).toHaveLength(0);
  await flusher.sendBatch(first === 'hook' ? rollout : hook);
  expect(spansOf('LLM')).toHaveLength(4);
  expect(spansOf('TOOL')).toHaveLength(3);
  expect(spansOf('AGENT')).toHaveLength(1);
  expect(spansOf('ENTRY')).toHaveLength(1);
  expect(spansOf('AGENT')[0]?.parentSpanId).toBe(spansOf('ENTRY')[0]?.spanContext().spanId);
  expect(spansOf('STEP').map(step => step.parentSpanId))
    .toEqual(Array(4).fill(spansOf('AGENT')[0]?.spanContext().spanId));
});

it('retains rollout after an already installed hook emits a session-only entry', async () => {
  const [entry, agent] = envelope();
  const sessionEntry = { ...entry };
  delete sessionEntry['gen_ai.turn.id'];
  await flusher.sendBatch([sessionEntry, agent!]);
  await flusher.sendBatch(input.buildEntriesFromRolloutLines(lines));
  expect(spansOf('LLM')).toHaveLength(4);
  expect(spansOf('TOOL')).toHaveLength(3);
  expect(spansOf('ENTRY')).toHaveLength(1);
  expect(spansOf('AGENT')).toHaveLength(1);
});

it('exports rollout without a hook by the source deadline', async () => {
  await flusher.sendBatch(input.buildEntriesFromRolloutLines(lines));
  expect(spans).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(spansOf('LLM')).toHaveLength(4));
  await flusher.sendBatch(envelope());
  expect(spansOf('LLM')).toHaveLength(4);
  expect(spansOf('AGENT')).toHaveLength(1);
});

it('releases a hook-only turn without suppressing subsequent rollout', async () => {
  await flusher.sendBatch(envelope());
  expect(flusher.getTraceRuntimeSnapshot().find(agent => agent.agent_type === 'zcode')?.pending_buffers).toBe(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(flusher.getTraceRuntimeSnapshot().find(agent => agent.agent_type === 'zcode')?.pending_buffers).toBe(0);
  await flusher.sendBatch(input.buildEntriesFromRolloutLines(lines));
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(spansOf('LLM')).toHaveLength(4));
});

it('does not seal a turn when a failed attempt arrives after its hook and before a retry', async () => {
  const last = lines.at(-1)!;
  const failed = {
    ...last, requestId: 'failed-attempt', response: { ...(last.response as object), finishReason: 'error' },
  };
  await flusher.sendBatch(envelope());
  await flusher.sendBatch(input.buildEntriesFromRolloutLines([failed]));
  expect(spans).toHaveLength(0);
  await flusher.sendBatch(input.buildEntriesFromRolloutLines(lines));
  expect(spansOf('LLM')).toHaveLength(5);
  expect(spansOf('TOOL')).toHaveLength(3);
});

it('does not seal a turn on a model response that requests tools and reports stop', async () => {
  const [first, ...rest] = lines;
  const toolRequest = { ...first, response: { ...(first?.response as object), finishReason: 'stop' } };
  await flusher.sendBatch(envelope());
  await flusher.sendBatch(input.buildEntriesFromRolloutLines([toolRequest]));
  expect(spans).toHaveLength(0);
  await flusher.sendBatch(input.buildEntriesFromRolloutLines(rest));
  expect(spansOf('LLM')).toHaveLength(4);
  expect(spansOf('TOOL')).toHaveLength(3);
});

it('retains an older turn when another turn from the same session completes', async () => {
  const nextTrace = 'e294f5ce-30c2-4817-92be-d035412905a1';
  const nextLines = [{ ...lines.at(-1)!, turnId: 'next-turn', traceId: nextTrace }];
  await flusher.sendBatch(envelope());
  await flusher.sendBatch(input.buildEntriesFromRolloutLines(lines.slice(0, 2)));
  await flusher.sendBatch(envelope(nextLines));
  await flusher.sendBatch(input.buildEntriesFromRolloutLines(nextLines));
  expect(spansOf('LLM', nextTrace)).toHaveLength(1);
  expect(spansOf('LLM')).toHaveLength(0);
  await flusher.sendBatch(input.buildEntriesFromRolloutLines(lines.slice(2)));
  expect(spansOf('LLM')).toHaveLength(4);
  expect(spansOf('TOOL')).toHaveLength(3);
});

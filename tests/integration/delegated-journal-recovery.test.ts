import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

afterEach(() => vi.useRealTimers());

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delegated-journal-recovery-'));
  const spans: ReadableSpan[] = [];
  const create = () => {
    const journal = new CodexTurnJournal(dir, 10_000, ['codex', 'hermes', 'openclaw']);
    const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'journal-recovery',
      turnIdleTimeoutMs: 60_000, endpoints: [{ name: 'test', endpoint: 'http://localhost:4318', headers: {} }] },
    undefined, () => ({ export(batch, done) { spans.push(...batch); done({ code: 0 }); }, async shutdown() {} }), journal);
    return { flusher, journal };
  };
  return { dir, spans, create, llms: () => spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM') };
}

function calls(agent: string, count: number, bytes = 0, session = 'child'): AgentActivityEntry[] {
  const base = { 'user.id': 'synthetic-user', 'gen_ai.agent.type': agent, 'gen_ai.session.id': session,
    'gen_ai.turn.id': `${session}-turn`, trace_id: createHash('sha256').update(session).digest('hex').slice(0, 32), 'gen_ai.provider.name': 'test',
    'gen_ai.request.model': 'synthetic-model',
    ...(agent === 'hermes' ? { 'agent.hermes.collection': 'realtime-v1' } : {}) };
  return Array.from({ length: count }, (_, i) => [
    { ...base, 'event.name': 'llm.request', 'event.id': `${session}-request-${i}`, 'gen_ai.step.id': `step-${i}`,
      'gen_ai.response.id': `response-${i}`, span_id: createHash('sha256').update(`${session}:${i}`).digest('hex').slice(0, 16),
      time_unix_nano: String(1700000000000000000n + BigInt(i * 2) * 1000000n),
      'gen_ai.input.messages': [{ role: 'user', parts: bytes
        ? Array.from({ length: 4 }, () => ({ type: 'text', content: 'x'.repeat(bytes / 4) }))
        : [{ type: 'text', content: 'task' }] }] },
    { ...base, 'event.name': 'llm.response', 'event.id': `${session}-response-${i}`, 'gen_ai.step.id': `step-${i}`,
      'gen_ai.response.id': `response-${i}`, span_id: createHash('sha256').update(`${session}:${i}`).digest('hex').slice(0, 16),
      time_unix_nano: String(1700000000000000000n + BigInt(i * 2 + 1) * 1000000n),
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'reply' }] }],
      'gen_ai.response.finish_reasons': ['tool_calls'], 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 2 },
  ]).flat() as AgentActivityEntry[];
}

function terminal(rows: AgentActivityEntry[]): AgentActivityEntry {
  return { ...rows[0], 'event.name': 'other', 'event.id': `${rows[0]['gen_ai.session.id']}-terminal`,
    time_unix_nano: '1700000001000000000', 'gen_ai.turn.end': true, 'agent.openclaw.hook': 'llm_output' };
}

it.each(['hermes', 'openclaw'])('%s exports the full spilled prefix and continuation before ACK', async agent => {
  const f = await fixture(); const { flusher, journal } = f.create();
  const rows = calls(agent, 100, 100 * 1024);
  try {
    await flusher.sendBatch(rows);
    expect(f.llms()).toHaveLength(0);
    await flusher.sendBatch([terminal(rows)]);
    expect(f.llms()).toHaveLength(100);
    expect(new Set(f.llms().map(s => s.spanContext().spanId))).toEqual(new Set(rows.map(row => row.span_id)));
    expect(f.llms().reduce((sum, s) => sum + Number(s.attributes['gen_ai.usage.input_tokens']), 0)).toBe(1000);
    expect(await journal.isAcknowledged(rows[0])).toBe(true);
    const count = f.spans.length;
    await flusher.sendBatch([...rows, terminal(rows)]);
    expect(f.spans).toHaveLength(count);
  } finally { await flusher.shutdown(); await fs.rm(f.dir, { recursive: true, force: true }); }
}, 30_000);

it.each(['hermes', 'openclaw'])('%s does not count repeated prefixes as resident payload or lose their suffix', async agent => {
  const f = await fixture(); const { flusher } = f.create();
  const rows = calls(agent, 2, 16 * 1024);
  try {
    await flusher.sendBatch(Array.from({ length: 600 }, () => rows[0]));
    const snapshot = flusher.getTraceRuntimeSnapshot().find(a => a.agent_type === agent)!;
    expect(snapshot.resident_payload_bytes).toBeLessThan(32 * 1024);
    expect(snapshot.spilled_buffers).toBe(0);
    await flusher.sendBatch([...rows.slice(1), terminal(rows)]);
    expect(f.llms()).toHaveLength(2);
    expect(f.llms().reduce((sum, s) => sum + Number(s.attributes['gen_ai.usage.output_tokens']), 0)).toBe(4);
  } finally { await flusher.shutdown(); await fs.rm(f.dir, { recursive: true, force: true }); }
}, 30_000);

it('restores a spilled turn after restart before accepting its final continuation', async () => {
  const f = await fixture(); let { flusher } = f.create();
  const rows = calls('hermes', 100, 100 * 1024);
  try {
    await flusher.sendBatch(rows.slice(0, 180));
    await flusher.shutdown();
    expect(f.llms()).toHaveLength(0);
    flusher = f.create().flusher;
    await flusher.start();
    await flusher.sendBatch([...rows.slice(180), terminal(rows)]);
    expect(f.llms()).toHaveLength(100);
    expect(new Set(f.llms().map(s => s.spanContext().spanId)).size).toBe(100);
  } finally { await flusher.shutdown(); await fs.rm(f.dir, { recursive: true, force: true }); }
}, 30_000);

it('retains all turns when aggregate payload spills before any per-turn limit', async () => {
  const f = await fixture(); const { flusher } = f.create();
  const turns = Array.from({ length: 7 }, (_, i) => calls('hermes', 48, 100 * 1024, `session-${i}`));
  try {
    for (const rows of turns) await flusher.sendBatch(rows);
    const snapshot = flusher.getTraceRuntimeSnapshot().find(a => a.agent_type === 'hermes')!;
    expect(snapshot.spilled_buffers).toBeGreaterThan(0);
    expect(snapshot.resident_payload_bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    await flusher.sendBatch(turns.map(terminal));
    expect(f.llms()).toHaveLength(7 * 48);
    for (const rows of turns) {
      expect(f.llms().filter(span => span.attributes['gen_ai.session.id'] === rows[0]['gen_ai.session.id'])).toHaveLength(48);
    }
  } finally { await flusher.shutdown(); await fs.rm(f.dir, { recursive: true, force: true }); }
}, 30_000);

it('rebuilds replay identity after an unpersistable event rehydrates a spilled turn', async () => {
  const f = await fixture(); const { flusher } = f.create();
  const rows = calls('hermes', 100, 100 * 1024);
  try {
    await flusher.sendBatch(rows);
    const extra = { ...rows[0], 'event.name': 'other', 'gen_ai.input.messages': [] } as AgentActivityEntry;
    delete (extra as Record<string, unknown>)['event.id'];
    await flusher.sendBatch([extra, rows[0]]);
    const snapshot = flusher.getTraceRuntimeSnapshot().find(a => a.agent_type === 'hermes')!;
    expect(snapshot.pending_records).toBe(rows.length + 1);
    await flusher.sendBatch([terminal(rows)]);
    expect(f.llms()).toHaveLength(100);
  } finally { await flusher.shutdown(); await fs.rm(f.dir, { recursive: true, force: true }); }
}, 30_000);

it.each([undefined, false, 'true', true])('honors Hermes completion capability %s with the production journal', async capability => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const f = await fixture(); const { flusher, journal } = f.create();
  const rows = calls('hermes', 1).map(row => ({ ...row, 'agent.hermes.native_run_observer': capability }));
  try {
    await flusher.sendBatch(rows);
    await vi.advanceTimersByTimeAsync(62_000);
    await flusher.flush();
    expect(f.llms()).toHaveLength(capability === true ? 0 : 1);
    expect(await journal.isAcknowledged(rows[0])).toBe(capability !== true);
    if (capability === true) {
      await flusher.sendBatch([terminal(rows)]);
      expect(f.llms()).toHaveLength(1);
    }
  } finally { await flusher.shutdown(); await fs.rm(f.dir, { recursive: true, force: true }); }
});

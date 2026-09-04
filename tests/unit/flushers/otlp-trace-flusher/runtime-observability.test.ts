import { afterEach, describe, expect, it, vi } from 'vitest';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: [], spanCount: 0, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));

function entry(turn = 'turn', agent = 'codex', session = 'session'): AgentActivityEntry {
  return {
    'event.name': 'llm.response',
    'gen_ai.agent.type': agent,
    'gen_ai.turn.id': turn,
    'gen_ai.session.id': session,
    'gen_ai.output.messages': 'private body',
  } as unknown as AgentActivityEntry;
}

const active: OtlpTraceFlusher[] = [];
function createFlusher() {
  const flusher = new OtlpTraceFlusher({
    enabled: true, serviceName: 'test', protocol: 'http/protobuf',
    endpoints: [{ endpoint: 'http://unused:4318', headers: {} }],
  });
  active.push(flusher);
  return flusher;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(active.splice(0).map(flusher => flusher.shutdown()));
});

describe('Trace runtime scalar snapshots', () => {
  it('reads largest/oldest buffers without serializing or copying event content', async () => {
    let now = 10;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const flusher = createFlusher();
    const memory = vi.spyOn(process, 'memoryUsage');
    const stringify = vi.spyOn(JSON, 'stringify');
    await flusher.send(entry('older', 'codex', 'a'), 20);
    now = 110;
    await flusher.sendBatch([entry('larger', 'codex', 'b'), entry('larger', 'codex', 'b')], [40, 60]);
    now = 210;
    const rows = flusher.getTraceRuntimeSnapshot();
    expect(rows[0]).toMatchObject({
      pending_buffers: 2, pending_records: 3, pending_logical_bytes: 120,
      pending_unmeasured_records: 0, largest_buffer_turn_id: 'larger',
      largest_buffer_session_id: 'b', largest_buffer_logical_bytes: 100,
      largest_buffer_records: 2, largest_buffer_age_ms: 100, oldest_buffer_age_ms: 200,
    });
    expect(stringify).not.toHaveBeenCalled();
    expect(memory).not.toHaveBeenCalled();
    expect(Object.values(rows[0])).not.toContain('private body');
    rows[0].removed_buffers_total = 999;
    expect(flusher.getTraceRuntimeSnapshot()[0].removed_buffers_total).toBe(0);
  });

  it('accounts bytes before a same-batch successor can remove the previous buffer', async () => {
    const flusher = createFlusher();
    await flusher.sendBatch([entry('first'), ...Array.from({ length: 64 }, () => entry('next'))],
      [123, ...Array(64).fill(10)]);
    expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({
      removed_buffers_total: 1, removed_logical_bytes_total: 123,
      pending_buffers: 1, pending_records: 64, pending_logical_bytes: 640,
    });
    await flusher.flush();
    const cleared = flusher.getTraceRuntimeSnapshot();
    expect(cleared[0]).toMatchObject({ pending_buffers: 0, removed_buffers_total: 2, removed_logical_bytes_total: 763 });
    await flusher.flush();
    expect(flusher.getTraceRuntimeSnapshot()).toEqual(cleared);
  });

  it('marks unavailable byte measurements without blocking collection', async () => {
    const flusher = createFlusher();
    await flusher.sendBatch([entry(), entry()], [100]);
    await flusher.send(entry(), NaN);
    await flusher.send(entry(), -1);
    await flusher.send(entry(), 0);
    expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({
      pending_records: 5, pending_logical_bytes: 0, pending_unmeasured_records: 4,
    });
    await flusher.flush();
    expect(flusher.getTraceRuntimeSnapshot()[0].removed_unmeasured_records_total).toBe(4);
  });

  it('removal is recorded before conversion settles and never leaves a second turn state', async () => {
    const flusher = createFlusher();
    let finish!: () => void;
    const conversion = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(flusher as any, 'convertAndExport').mockReturnValue(conversion);
    try {
      await flusher.send(entry('first'), 12);
      await flusher.send(entry('next'), 34);
      expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({
        pending_buffers: 1, pending_logical_bytes: 34, removed_logical_bytes_total: 12,
      });
    } finally { finish(); }
    await flusher.flush();
    expect(flusher.getTraceRuntimeSnapshot()[0].pending_buffers).toBe(0);
  });

  it('keeps counters cumulative across idle reports and preserves existing buffer eviction', async () => {
    const flusher = createFlusher();
    for (let i = 0; i < 70; i++) await flusher.send(entry(`turn-${i}`, 'codex', `session-${i}`), 1);
    expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({ pending_buffers: 65, removed_buffers_total: 5 });
    await flusher.flush();
    const snapshot = flusher.getTraceRuntimeSnapshot();
    expect(snapshot[0].removed_buffers_total).toBe(70);
    expect(flusher.getTraceRuntimeSnapshot()).toEqual(snapshot);
    await flusher.send(entry('fresh'), 7);
    expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({ removed_buffers_total: 70, pending_logical_bytes: 7 });
  });

  it('caps diagnostic dimensions without dropping business records', async () => {
    const flusher = createFlusher();
    for (let i = 0; i < 70; i++) await flusher.send(entry(`turn-${i}`, `agent-${i}`, `session-${i}`), 1);
    expect(flusher.getTraceRuntimeSnapshot()).toHaveLength(64);
    expect((flusher as any).turnBuffers.size).toBe(65);
    await flusher.flush();
    expect((flusher as any).turnBuffers.size).toBe(0);
    expect(flusher.getTraceRuntimeSnapshot()).toHaveLength(64);
  });
});

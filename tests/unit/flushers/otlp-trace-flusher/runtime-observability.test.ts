import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { CodexTurnJournal } from '../../../../src/flushers/codex-turn-journal.js';
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
function createFlusher(journal?: CodexTurnJournal) {
  const flusher = new OtlpTraceFlusher({
    enabled: true, serviceName: 'test', protocol: 'http/protobuf',
    endpoints: [{ endpoint: 'http://unused:4318', headers: {} }],
  }, undefined, undefined, journal);
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
    await flusher.sendBatch([entry('first', 'claude-code'), ...Array.from({ length: 64 }, () => entry('next', 'claude-code'))],
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
      await flusher.send(entry('first', 'claude-code'), 12);
      await flusher.send(entry('next', 'claude-code'), 34);
      expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({
        pending_buffers: 1, pending_logical_bytes: 34, removed_logical_bytes_total: 12,
      });
    } finally { finish(); }
    await flusher.flush();
    expect(flusher.getTraceRuntimeSnapshot()[0].pending_buffers).toBe(0);
  });

  it('keeps concurrent Codex native turns until their own terminal evidence', async () => {
    const flusher = createFlusher();
    await flusher.send(entry('first'), 12);
    await flusher.send(entry('next'), 34);
    expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({
      pending_buffers: 2, pending_logical_bytes: 46, removed_buffers_total: 0,
    });
    await flusher.send({ ...entry('first'), 'gen_ai.turn.end': true,
      'agent.codex.turn_status': 'completed' }, 0);
    expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({ pending_buffers: 1, pending_logical_bytes: 34 });
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

  it.each(['single', 'batch', 'batch-restored'])('retains the Codex prefix when its %s continuation arrives at capacity', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-resident-capacity-'));
    const journal = new CodexTurnJournal(root);
    const flusher = createFlusher(journal);
    const converted = vi.spyOn(flusher as any, 'convertAndExport').mockResolvedValue(true);
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
    const durable = (turn: string, id: string, terminal = false): AgentActivityEntry => ({
      ...entry(turn, 'codex', turn), 'user.id': 'owner', 'event.id': id,
      ...(terminal ? { 'gen_ai.turn.end': true, 'agent.codex.turn_status': 'completed' } : {}),
    });
    const prefix = { ...durable('turn-0', 'prefix'), 'gen_ai.step.id': 'step-1',
      'gen_ai.response.id': 'response-1', 'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 7 };
    await flusher.send(prefix);
    for (let i = 1; i < 65; i++) await flusher.send(durable(`turn-${i}`, `prefix-${i}`));
    expect(flusher.getTraceRuntimeSnapshot()[0].pending_buffers).toBe(65);
    expect(converted).not.toHaveBeenCalled();
    expect(await journal.isAcknowledged(prefix)).toBe(false);

    if (mode === 'batch-restored') await flusher.send(durable('turn-65', 'prefix-65'));
    const terminal = durable('turn-0', 'terminal', true);
    if (mode === 'single') await flusher.send(terminal);
    else await flusher.sendBatch([
      ...Array.from({ length: mode === 'batch-restored' ? 65 : 1 }, (_, i) => durable(`new-turn-${i}`, `new-prefix-${i}`)),
      terminal,
    ]);
    await flusher.flush();

    expect(converted).toHaveBeenCalledTimes(1);
    expect(converted.mock.calls[0][1]).toEqual([prefix, terminal]);
    const submitted = converted.mock.calls[0][1] as AgentActivityEntry[];
    expect(submitted.reduce((total, record) => total + Number(record['gen_ai.usage.input_tokens'] ?? 0)
      + Number(record['gen_ai.usage.output_tokens'] ?? 0), 0)).toBe(18);
    expect(flusher.getTraceRuntimeSnapshot()[0].pending_buffers).toBeLessThanOrEqual(64);
    expect(await journal.isAcknowledged(prefix)).toBe(true);
  });

  it('keeps terminal flushing deferred until overlapping batches both finish appending', async () => {
    const flusher = createFlusher();
    const converted = vi.spyOn(flusher as any, 'convertAndExport').mockResolvedValue(true);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let enteredFirst!: () => void;
    let enteredSecond!: () => void;
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
    const secondEntered = new Promise<void>(resolve => { enteredSecond = resolve; });
    const firstReady = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondReady = new Promise<void>(resolve => { releaseSecond = resolve; });
    vi.spyOn(flusher as any, 'persistCodexEntries').mockImplementation(async (...args: unknown[]) => {
      const records = args[0] as AgentActivityEntry[];
      if (records[0]['gen_ai.turn.id'] === 'first') { enteredFirst(); await firstReady; }
      else { enteredSecond(); await secondReady; }
    });
    const terminal = (turn: string): AgentActivityEntry => ({ ...entry(turn),
      'gen_ai.turn.end': true, 'agent.codex.turn_status': 'completed' });
    const first = flusher.sendBatch([terminal('first')]);
    await firstEntered;
    const second = flusher.sendBatch([terminal('second')]);
    await secondEntered;
    try {
      releaseFirst();
      await first;
      expect.soft(converted).not.toHaveBeenCalled();
    } finally {
      releaseSecond();
      await second;
    }
    expect(converted).toHaveBeenCalledTimes(2);
    await flusher.send(terminal('next'));
    expect(converted).toHaveBeenCalledTimes(3);
  });

  it('restores terminal flushing when batch preparation fails', async () => {
    const flusher = createFlusher();
    const converted = vi.spyOn(flusher as any, 'convertAndExport').mockResolvedValue(true);
    vi.spyOn(flusher as any, 'persistCodexEntries').mockRejectedValueOnce(new Error('journal unavailable'));
    await expect(flusher.sendBatch([entry('failed')])).rejects.toThrow('journal unavailable');
    await flusher.send({ ...entry('next'), 'gen_ai.turn.end': true, 'agent.codex.turn_status': 'completed' });
    expect(converted).toHaveBeenCalledTimes(1);
  });
});

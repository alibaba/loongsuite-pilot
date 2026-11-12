import { afterEach, expect, it, vi } from 'vitest';
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
const roots: string[] = [];
const flushers: OtlpTraceFlusher[] = [];
function record(id: string, bytes = 0, terminal = false, turn = 'turn'): AgentActivityEntry {
  return { 'event.name': terminal ? 'other' : 'llm.request', 'event.id': id,
    'user.id': 'owner', 'gen_ai.agent.type': 'codex', 'gen_ai.session.id': 'session',
    'gen_ai.turn.id': turn, 'gen_ai.input.messages': 'x'.repeat(bytes),
    ...(terminal ? { 'gen_ai.turn.end': true, 'agent.codex.turn_status': 'completed' } : {}),
  } as AgentActivityEntry;
}
function flusher(journal: CodexTurnJournal) {
  const f = new OtlpTraceFlusher({ enabled: true, serviceName: 'test', protocol: 'http/protobuf',
    endpoints: [{ endpoint: 'http://unused:4318', headers: {} }] }, undefined, undefined, journal);
  flushers.push(f); return f;
}
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-spill-')); roots.push(root); return root;
}
afterEach(async () => {
  for (const f of flushers.splice(0)) await f.shutdown();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it('spills a live long turn, retains accounting and exports the entire prefix only at its real terminal', async () => {
  const journal = new CodexTurnJournal(await directory()); const f = flusher(journal);
  const convert = vi.spyOn(f as any, 'convertAndExport').mockResolvedValue(true);
  const prefix = record('prefix', 9 * 1024 * 1024);
  // The payload budget must not trust an understated caller logical size.
  await f.send(prefix, 1);
  await f.send(record('tool-result'));
  expect(f.getTraceRuntimeSnapshot()[0]).toMatchObject({ pending_records: 2,
    pending_unmeasured_records: 0, resident_records: 0, resident_payload_bytes: 0, spilled_records: 2 });
  expect([...((f as any).turnBuffers.values())][0].records).toEqual([]);
  await f.flush(); expect(convert).not.toHaveBeenCalled();
  expect(await journal.isAcknowledged(prefix)).toBe(false);
  await f.send(record('terminal', 0, true)); await f.flush();
  expect(convert).toHaveBeenCalledTimes(1);
  expect(convert.mock.calls[0][1].map((r: AgentActivityEntry) => r['event.id']))
    .toEqual(['prefix', 'tool-result', 'terminal']);
  expect(await journal.isAcknowledged(prefix)).toBe(true);
});

it('restores a long pending turn in bounded batches, measures bytes, and survives another restart before terminal', async () => {
  const root = await directory(); const prefix = record('prefix', 3 * 1024 * 1024);
  await new CodexTurnJournal(root).append([prefix, record('second', 3 * 1024 * 1024), record('third', 3 * 1024 * 1024)]);
  for (let restart = 0; restart < 2; restart++) {
    const f = flusher(new CodexTurnJournal(root));
    vi.spyOn(f as any, 'convertAndExport').mockResolvedValue(true);
    await f.start();
    expect(f.getTraceRuntimeSnapshot()[0]).toMatchObject({ pending_records: 3, pending_unmeasured_records: 0,
      resident_records: 0, spilled_records: 3 });
    expect(f.getTraceRuntimeSnapshot()[0].pending_logical_bytes).toBeGreaterThan(9 * 1024 * 1024);
    await f.shutdown();
  }
  const journal = new CodexTurnJournal(root); const f = flusher(journal);
  const convert = vi.spyOn(f as any, 'convertAndExport').mockResolvedValue(true);
  await f.send(record('terminal', 0, true)); await f.flush();
  expect(convert.mock.calls[0][1].map((r: AgentActivityEntry) => r['event.id']))
    .toEqual(['prefix', 'second', 'third', 'terminal']);
  expect(await journal.isAcknowledged(prefix)).toBe(true);
});

it('keeps a terminal in the middle of a journal batch sequence from truncating later records', async () => {
  const root = await directory(); const journal = new CodexTurnJournal(root);
  await journal.append([record('prefix', 9 * 1024 * 1024), record('terminal', 0, true), record('late-tool', 2 * 1024 * 1024)]);
  const f = flusher(journal); const convert = vi.spyOn(f as any, 'convertAndExport').mockResolvedValue(true);
  await f.start();
  expect(convert).toHaveBeenCalledTimes(1);
  expect(convert.mock.calls[0][1].map((r: AgentActivityEntry) => r['event.id']))
    .toEqual(['prefix', 'terminal', 'late-tool']);
});

it('caps total resident durable payload across many small turns and retains failed exports for retry', async () => {
  const root = await directory(); const journal = new CodexTurnJournal(root); const f = flusher(journal);
  const convert = vi.spyOn(f as any, 'convertAndExport').mockResolvedValue(false);
  for (let i = 0; i < 10; i++) await f.send(record(`prefix-${i}`, 4 * 1024 * 1024, false, `turn-${i}`));
  expect(f.getTraceRuntimeSnapshot()[0].resident_payload_bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(f.getTraceRuntimeSnapshot()[0].pending_records).toBe(10);
  expect(convert).not.toHaveBeenCalled();
  await f.send(record('terminal', 0, true, 'turn-0')); await f.flush();
  expect(await journal.isAcknowledged(record('prefix-0', 0, false, 'turn-0'))).toBe(false);
  const retry = flusher(new CodexTurnJournal(root));
  const retried = vi.spyOn(retry as any, 'convertAndExport').mockResolvedValue(true);
  await retry.start();
  expect(retried.mock.calls[0][1].map((r: AgentActivityEntry) => r['event.id'])).toEqual(['prefix-0', 'terminal']);
});

it('serializes rehydration through export when multiple large turns finish together', async () => {
  const journal = new CodexTurnJournal(await directory()); const f = flusher(journal);
  await f.send(record('a', 9 * 1024 * 1024, false, 'a'));
  await f.send(record('b', 9 * 1024 * 1024, false, 'b'));
  const rehydrate = vi.spyOn(f as any, 'rehydrateCodexTurn');
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const convert = vi.spyOn(f as any, 'convertAndExport').mockImplementationOnce(async () => {
    entered(); await gate; return true;
  }).mockResolvedValue(true);
  const ending = f.sendBatch([record('end-a', 0, true, 'a'), record('end-b', 0, true, 'b')]);
  await ready;
  try { expect(rehydrate).toHaveBeenCalledTimes(1); }
  finally { release(); }
  await ending;
  expect(rehydrate).toHaveBeenCalledTimes(2);
  expect(convert).toHaveBeenCalledTimes(2);
});

it('preserves order when an unpersistable event precedes an already-journaled terminal suffix', async () => {
  const f = flusher(new CodexTurnJournal(await directory()));
  const convert = vi.spyOn(f as any, 'convertAndExport').mockResolvedValue(true);
  await f.send(record('prefix', 9 * 1024 * 1024));
  const invalid = record('temporary'); delete (invalid as any)['event.id'];
  await f.sendBatch([invalid, record('terminal', 0, true)]);
  expect(convert).toHaveBeenCalledTimes(1);
  expect(convert.mock.calls[0][1].map((r: AgentActivityEntry) => r['event.id']))
    .toEqual(['prefix', undefined, 'terminal']);
});

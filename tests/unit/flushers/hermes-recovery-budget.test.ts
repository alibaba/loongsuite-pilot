import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexTurnJournal } from '../../../src/flushers/codex-turn-journal.js';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

vi.mock('../../../src/flushers/hermes-process-identity.js', () => ({
  currentHermesProcessNamespace: async () => ({ pidNamespace: 'test', bootId: 'test' }),
  isHermesProcessDead: async () => true,
  hermesProcessIdentity: (entry: AgentActivityEntry) => ({
    pid: 1, startTicks: '1', pidNamespace: 'test', bootId: 'test', sourceToken: entry['test.source'],
  }),
}));

afterEach(() => vi.useRealTimers());

it('limits source scans and advances past sources that cannot be drained', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-recovery-budget-'));
  const checked: string[] = [];
  const journal = new CodexTurnJournal(dir, 100, ['hermes']);
  vi.useFakeTimers({ toFake: ['Date'] });
  const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'test', protocol: 'http/protobuf',
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }] }, undefined,
  () => ({ export(_batch, done) { done({ code: 0 }); }, async shutdown() {} }), journal, undefined,
  async token => { checked.push(token); return false; });
  try {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      'event.name': 'llm.request', 'event.id': `e-${index}`, 'user.id': 'test',
      'gen_ai.agent.type': 'hermes', 'agent.hermes.collection': 'realtime-v1',
      'gen_ai.session.id': `session-${index}`, 'gen_ai.turn.id': `turn-${index}`,
      'test.source': `source-${index}`, time_unix_nano: '1794900000000000000',
      trace_id: (index + 1).toString(16).repeat(32),
    }) as AgentActivityEntry);
    await flusher.sendBatch(rows);
    vi.setSystemTime(Date.now() + 300_000);
    await (flusher as any).recoverAbandonedHermesTurns();
    vi.setSystemTime(Date.now() + 60_000);
    await (flusher as any).recoverAbandonedHermesTurns();
    expect(checked).toEqual(['source-0', 'source-1']);
    await (flusher as any).recoverAbandonedHermesTurns();
    expect(checked).toEqual(['source-0', 'source-1', 'source-2', 'source-3']);
    await (flusher as any).recoverAbandonedHermesTurns();
    expect(checked).toContain('source-4');
    expect(checked).toHaveLength(5);
    await (flusher as any).recoverAbandonedHermesTurns();
    expect(checked).toHaveLength(5);
    vi.setSystemTime(Date.now() + 30_000);
    await (flusher as any).recoverAbandonedHermesTurns();
    expect(checked).toHaveLength(7);
    expect(flusher.getTraceRuntimeSnapshot()[0].pending_buffers).toBe(5);
  } finally {
    await flusher.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('keeps a shared source protected until every pending turn is acknowledged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-protected-source-'));
  const journal = new CodexTurnJournal(dir, 100, ['hermes']);
  const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'test', protocol: 'http/protobuf',
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }] }, undefined,
  () => ({ export(_batch, done) { done({ code: 0 }); }, async shutdown() {} }), journal);
  const entry = (index: number, end = false) => ({
    'user.id': 'test', 'gen_ai.agent.type': 'hermes', 'agent.hermes.collection': 'realtime-v1',
    'gen_ai.session.id': `session-${index}`, 'gen_ai.turn.id': `turn-${index}`,
    'test.source': 'source-shared', trace_id: (index ? 'bb' : 'aa').repeat(16),
    'event.name': end ? 'other' : 'llm.request', 'event.id': `${index}-${end ? 'end' : 'request'}`,
    ...(end ? { 'gen_ai.turn.end': true } : {}), time_unix_nano: '1794900000000000000',
  }) as AgentActivityEntry;
  try {
    await flusher.sendBatch([entry(0), entry(1)]);
    expect(flusher.hasPendingHermesSource('source-shared')).toBe(true);
    await flusher.sendBatch([entry(0, true)]);
    expect(flusher.hasPendingHermesSource('source-shared')).toBe(true);
    await flusher.sendBatch([entry(1, true)]);
    expect(flusher.hasPendingHermesSource('source-shared')).toBe(false);
  } finally {
    await flusher.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('does not pin raw sources when a turn has ambiguous producer ownership', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-ambiguous-source-'));
  const journal = new CodexTurnJournal(dir, 100, ['hermes']);
  const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'test', protocol: 'http/protobuf',
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }] }, undefined,
  () => ({ export(_batch, done) { done({ code: 0 }); }, async shutdown() {} }), journal);
  const first = { 'user.id': 'test', 'gen_ai.agent.type': 'hermes', 'agent.hermes.collection': 'realtime-v1',
    'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'turn', 'test.source': 'source-a',
    trace_id: 'aa'.repeat(16), 'event.name': 'llm.request', 'event.id': 'first',
    time_unix_nano: '1794900000000000000' } as AgentActivityEntry;
  try {
    await flusher.sendBatch([first]);
    expect(flusher.hasPendingHermesSource('source-a')).toBe(true);
    await flusher.sendBatch([{ ...first, 'event.id': 'second', 'test.source': 'source-b' }]);
    expect(flusher.hasPendingHermesSource('source-a')).toBe(false);
    expect(flusher.hasPendingHermesSource('source-b')).toBe(false);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 660_000);
    await (flusher as any).recoverAbandonedHermesTurns();
    expect(await journal.isAcknowledged(first)).toBe(false);
  } finally {
    await flusher.shutdown();
    vi.useRealTimers();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('allows raw retention after a normal terminal is journaled even if OTLP is unavailable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-complete-offline-'));
  const journal = new CodexTurnJournal(path.join(dir, 'journal'), 100, ['hermes']);
  const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'test', dataDir: dir, protocol: 'http/protobuf',
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }] }, undefined,
  () => ({ export(_batch, done) { done({ code: 1, error: new Error('offline') }); }, async shutdown() {} }), journal);
  const common = { 'user.id': 'test', 'gen_ai.agent.type': 'hermes', 'agent.hermes.collection': 'realtime-v1',
    'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'turn', 'test.source': 'source-offline',
    'gen_ai.step.id': 'step', 'gen_ai.response.id': 'response', 'gen_ai.request.model': 'model',
    'gen_ai.provider.name': 'test', trace_id: 'aa'.repeat(16), span_id: 'bb'.repeat(8) };
  const entries = [
    { ...common, 'event.name': 'llm.request', 'event.id': 'request', time_unix_nano: '1794900000000000000' },
    { ...common, 'event.name': 'llm.response', 'event.id': 'response', time_unix_nano: '1794900001000000000',
      'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 2 },
    { ...common, 'event.name': 'other', 'event.id': 'end', time_unix_nano: '1794900002000000000',
      'gen_ai.turn.end': true },
  ] as AgentActivityEntry[];
  try {
    await flusher.sendBatch(entries.slice(0, 2));
    expect(flusher.hasPendingHermesSource('source-offline')).toBe(true);
    await flusher.sendBatch([entries[2]]);
    expect(await journal.isAcknowledged(entries[0])).toBe(false);
    expect(flusher.hasPendingHermesSource('source-offline')).toBe(false);
    expect((await fs.readdir(path.join(dir, 'journal'))).some(name => name.endsWith('.jsonl'))).toBe(true);
  } finally {
    await flusher.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('recovers dead journaled turns evicted by the existing in-memory buffer limit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-recovery-evicted-'));
  const journal = new CodexTurnJournal(dir, 1000, ['hermes']);
  vi.useFakeTimers({ toFake: ['Date'] });
  const spans: Array<{ attributes: Record<string, unknown> }> = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'test', protocol: 'http/protobuf',
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }] }, undefined,
  () => ({ export(batch, done) { spans.push(...batch); done({ code: 0 }); }, async shutdown() {} }),
  journal, undefined, async () => true);
  try {
    const entries = Array.from({ length: 70 }, (_, index) => {
      const trace = (index + 1).toString(16).padStart(2, '0').repeat(16);
      const common = { 'user.id': 'test', 'gen_ai.agent.type': 'hermes',
        'agent.hermes.collection': 'realtime-v1', 'agent.hermes.native_run_observer': true,
        'gen_ai.session.id': `session-${index}`, 'gen_ai.turn.id': `turn-${index}`,
        'gen_ai.step.id': `step-${index}`, 'gen_ai.response.id': `response-${index}`,
        'gen_ai.request.model': 'model', 'gen_ai.provider.name': 'test',
        'test.source': `source-${index}`, trace_id: trace, span_id: trace.slice(0, 16) };
      return [
        { ...common, 'event.name': 'llm.request', 'event.id': `request-${index}`,
          time_unix_nano: '1794900000000000000' },
        { ...common, 'event.name': 'llm.response', 'event.id': `response-${index}`,
          time_unix_nano: '1794900001000000000', 'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 2 },
      ] as AgentActivityEntry[];
    });
    await flusher.sendBatch(entries.flat());
    expect(flusher.getTraceRuntimeSnapshot()[0].pending_buffers).toBeLessThanOrEqual(64);
    expect(await journal.isAcknowledged(entries[0][0])).toBe(false);
    const resumed = entries[1][0];
    await flusher.sendBatch([
      { ...resumed, 'event.id': 'late-tool-call', 'event.name': 'tool.call',
        'gen_ai.tool.call.id': 'late-tool', 'gen_ai.tool.name': 'terminal',
        'gen_ai.tool.call.arguments': { command: 'echo test' }, span_id: '99'.repeat(8),
        time_unix_nano: '1794900002000000000' },
      { ...resumed, 'event.id': 'late-tool-result', 'event.name': 'tool.result',
        'gen_ai.tool.call.id': 'late-tool', 'gen_ai.tool.name': 'terminal',
        'gen_ai.tool.call.result': { output: 'test' }, span_id: '99'.repeat(8),
        time_unix_nano: '1794900003000000000' },
      { ...resumed, 'event.id': 'late-turn-end', 'event.name': 'other',
        'gen_ai.turn.end': true, time_unix_nano: '1794900004000000000' },
    ] as AgentActivityEntry[]);
    expect(await journal.isAcknowledged(entries[1][0])).toBe(true);
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toHaveLength(1);
    expect(spans.every(span => span.attributes['agent.hermes.collection.incomplete'] !== true)).toBe(true);
    vi.setSystemTime(Date.now() + 300_000);
    for (let index = 0; index < 4; index++) await (flusher as any).recoverAbandonedHermesTurns();
    vi.setSystemTime(Date.now() + 60_000);
    for (let index = 0; index < 80 && !await journal.isAcknowledged(entries[0][0]); index++) {
      await (flusher as any).recoverAbandonedHermesTurns();
      await flusher.flush();
    }
    expect(await journal.isAcknowledged(entries[0][0])).toBe(true);
    expect(spans.some(span => span.attributes['gen_ai.collection.incomplete'] === true
      || span.attributes['agent.hermes.collection.incomplete'] === true)).toBe(true);
  } finally {
    await flusher.shutdown();
    vi.useRealTimers();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 15_000);

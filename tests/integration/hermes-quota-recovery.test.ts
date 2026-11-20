import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { LogRetentionService } from '../../src/core/log-retention-service.js';
import { HermesLogInput } from '../../src/inputs/hermes-log/hermes-log-input.js';
import { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';

vi.mock('../../src/flushers/hermes-process-identity.js', () => ({
  currentHermesProcessNamespace: async () => ({ pidNamespace: 'test', bootId: 'test' }),
  isHermesProcessDead: async () => true,
  hermesProcessIdentity: (entry: AgentActivityEntry) => ({
    pid: 1, startTicks: '1', pidNamespace: 'test', bootId: 'test',
    sourceToken: (entry['agent.hermes.process'] as { source_token: string }).source_token,
  }),
}));

function rows(id: string): AgentActivityEntry[] {
  const sourceToken = `${id}-123-abcdef12`;
  const common = {
    'user.id': 'test-user', 'gen_ai.agent.type': 'hermes', 'agent.hermes.collection': 'realtime-v1',
    'agent.hermes.native_run_observer': true, 'agent.hermes.process': { source_token: sourceToken },
    'gen_ai.session.id': `session-${id}`, 'gen_ai.turn.id': `turn-${id}`,
    'gen_ai.step.id': `step-${id}`, 'gen_ai.response.id': `response-${id}`,
    'gen_ai.request.model': 'test-model', 'gen_ai.provider.name': 'test',
    trace_id: (id === '101' ? 'aa' : 'bb').repeat(16), span_id: (id === '101' ? '11' : '22').repeat(8),
  };
  return [
    { ...common, 'event.id': `request-${id}`, 'event.name': 'llm.request',
      time_unix_nano: '1794900000000000000' },
    { ...common, 'event.id': `response-${id}`, 'event.name': 'llm.response',
      time_unix_nano: '1794900001000000000', 'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 2, 'gen_ai.response.finish_reasons': ['tool_calls'] },
  ] as AgentActivityEntry[];
}

it.each([false, true])('handles quota backpressure without exporting an unread source (partial tail=%s)', async partialTail => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-quota-recovery-'));
  const sourceDir = path.join(root, 'logs/hermes-agent');
  await fs.mkdir(sourceDir, { recursive: true });
  const sourceA = path.join(sourceDir, 'hermes-agent-101-123-abcdef12.jsonl');
  const sourceB = path.join(sourceDir, 'hermes-agent-102-123-abcdef12.jsonl');
  const serialize = (entries: AgentActivityEntry[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  await fs.writeFile(sourceA, serialize(rows('101')));
  const state = new StateStore(path.join(root, 'state.json'));
  const manager = new InputManager();
  manager.setConfiguredUserId('test-user');
  const journal = new CodexTurnJournal(path.join(root, 'journal'), 100, ['hermes'], 1024 * 1024);
  const exported: ReadableSpan[] = [];
  const output = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'test',
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }] }, undefined,
  () => ({ export(batch, done) { exported.push(...batch); done({ code: 0 }); }, async shutdown() {} }),
  journal, undefined, token => manager.confirmHermesSourceDrained(token));
  const input = new HermesLogInput({ stateStore: state, sessionDir: sourceDir, pollIntervalMs: 3_600_000 });
  manager.setFlusher(output);
  manager.registerInput(input);
  let pendingRecovery: Promise<void> | undefined;
  try {
    await manager.startInput(input.id);
    await (manager as any).drainInputQueue(input.id);
    await vi.waitFor(() => expect(state.isPersisted(`${input.id}:${sourceA}`)).toBe(true));
    const journalFiles = (await fs.readdir(path.join(root, 'journal'))).filter(name => name.endsWith('.jsonl'));
    expect(journalFiles).toHaveLength(1);
    const bytesA = (await fs.stat(path.join(root, 'journal', journalFiles[0]))).size;
    (journal as any).maxPendingBytes = bytesA * 2 - 1;
    const append = vi.spyOn(journal, 'append');
    if (partialTail) await fs.appendFile(sourceA, '{"incomplete":');
    await fs.writeFile(sourceB, serialize(rows('102')));
    const blockedCycle = (input as any).runCycle() as Promise<void>;
    await vi.waitFor(() => expect(append).toHaveBeenCalled());
    expect(state.isPersisted(`${input.id}:${sourceB}`)).toBe(false);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 300_000);
    await (output as any).recoverAbandonedHermesTurns();
    vi.setSystemTime(Date.now() + 60_000);
    const recovery = (output as any).recoverAbandonedHermesTurns() as Promise<void>;
    pendingRecovery = recovery;
    const finished = await Promise.race([
      recovery.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 400)),
    ]);
    expect(finished).toBe(true);
    if (partialTail) {
      expect(exported).toHaveLength(0);
      expect(await journal.isAcknowledged(rows('101')[0])).toBe(false);
      expect(state.isPersisted(`${input.id}:${sourceB}`)).toBe(false);
    } else {
      await vi.waitFor(() => expect(exported.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1));
      await vi.waitFor(() => expect(state.isPersisted(`${input.id}:${sourceB}`)).toBe(true), { timeout: 4000 });
      await blockedCycle;
      expect(exported[0].attributes['agent.hermes.collection.incomplete']).toBe(true);
    }
  } finally {
    await manager.stopAll();
    await pendingRecovery;
    await output.shutdown();
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 10_000);

it('keeps a consumed dead producer source until its pending turn has been recovered', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-retention-recovery-')));
  const sourceDir = path.join(root, 'logs/hermes-agent');
  await fs.mkdir(sourceDir, { recursive: true });
  const source = path.join(sourceDir, 'hermes-agent-101-123-abcdef12.jsonl');
  await fs.writeFile(source, rows('101').map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const old = new Date(Date.now() - 10 * 86400_000);
  await fs.utimes(source, old, old);
  const state = new StateStore(path.join(root, 'state.json'));
  const manager = new InputManager();
  manager.setConfiguredUserId('test-user');
  const journal = new CodexTurnJournal(path.join(root, 'journal'), 100, ['hermes']);
  const exported: ReadableSpan[] = [];
  const output = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'test',
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }] }, undefined,
  () => ({ export(batch, done) { exported.push(...batch); done({ code: 0 }); }, async shutdown() {} }),
  journal, undefined, token => manager.confirmHermesSourceDrained(token));
  const input = new HermesLogInput({ stateStore: state, sessionDir: sourceDir, pollIntervalMs: 3_600_000 });
  manager.setFlusher(output);
  manager.registerInput(input);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  const config = { enabled: true, intervalMs: 3600_000, hookHistoryDays: 7, hookErrorDays: 7,
    hookDebugDays: 7, outputDays: 7, slsFailedDays: 7, otlpFailedDays: 7, metricAlarmDays: 7 };
  const retention = new (LogRetentionService as any)(root, config, state,
    (token: string) => (output as any).hasPendingHermesSource?.(token) ?? false) as LogRetentionService;
  try {
    await manager.startInput(input.id);
    await (manager as any).drainInputQueue(input.id);
    await vi.waitFor(() => expect(state.isPersisted(`${input.id}:${source}`)).toBe(true));
    await retention.runCleanup();
    await expect(fs.stat(source)).resolves.toBeDefined();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 300_000);
    await (output as any).recoverAbandonedHermesTurns();
    vi.setSystemTime(Date.now() + 60_000);
    await (output as any).recoverAbandonedHermesTurns();
    await output.flush();
    expect(exported.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
    expect(await journal.isAcknowledged(rows('101')[0])).toBe(true);
    await retention.runCleanup();
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    kill.mockRestore();
    await manager.stopAll();
    await output.shutdown();
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 10_000);

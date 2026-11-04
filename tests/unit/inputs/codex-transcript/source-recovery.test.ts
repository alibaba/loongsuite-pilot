import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CodexTranscriptInput } from '../../../../src/inputs/codex-transcript/codex-transcript-input.js';
import { InputRuntimeAccumulator } from '../../../../src/inputs/base/input-runtime-metrics.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import type { CodexTranscriptCheckpoint } from '../../../../src/inputs/codex-transcript/codex-transcript-types.js';

const roots: string[] = [];
const inputs: CodexTranscriptInput[] = [];
afterEach(async () => {
  for (const input of inputs.splice(0)) await (input as any).onStop();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function row(type: string, payload: Record<string, unknown>, seconds = 0): string {
  return JSON.stringify({ timestamp: new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000).toISOString(), type, payload }) + '\n';
}
const meta = () => row('session_meta', { id: 'session', model_provider: 'openai' });
const diagnostic = () => row('event_msg', { type: 'unknown_fixture', padding: 'x'.repeat(64 * 1024) });
function completed(turn: string, header = true): string {
  return (header ? meta() : '')
    + row('turn_context', { turn_id: turn, model: 'synthetic-model' }, 1)
    + row('event_msg', { type: 'task_started', turn_id: turn }, 2)
    + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }, 3)
    + row('event_msg', { type: 'agent_message', message: 'answer', phase: 'final' }, 4)
    + row('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: 'answer' }, 5);
}
async function fixture(root?: string, store?: StateStore) {
  if (!root) { root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-source-recovery-')); roots.push(root); }
  const sessions = path.join(root, 'sessions'); await fs.mkdir(sessions, { recursive: true });
  const state = store ?? new StateStore(path.join(root, 'state.json'));
  const input = new CodexTranscriptInput({ stateStore: state, sessionDir: sessions,
    wakeupDir: path.join(root, 'wakeups'), spanContextDir: path.join(root, 'contexts') });
  inputs.push(input);
  const entries: AgentActivityEntry[] = [];
  input.on('entries', batch => entries.push(...batch));
  return { root, state, input, probe: input as any, entries, file: path.join(sessions, 'rollout-session.jsonl') };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const key = (f: Fixture) => `codex-transcript:${f.file}`;
function checkpoint(f: Fixture): CodexTranscriptCheckpoint {
  return f.state.get(key(f)).extra!.codexTranscript as CodexTranscriptCheckpoint;
}
async function measure(f: Fixture, action: () => Promise<unknown>) {
  const runtime = new InputRuntimeAccumulator(); f.probe.activeRuntimeAccumulator = runtime;
  try { await action(); } finally { f.probe.activeRuntimeAccumulator = null; }
  return runtime.finish(0);
}
async function processFile(f: Fixture) { return measure(f, () => f.probe.processFile(f.file)); }
const responses = (f: Fixture, turn: string) => f.entries.filter(e => e['event.name'] === 'llm.response'
  && e['agent.codex.transcript_turn_id'] === turn);

it('does not repeat missing-owner probes after startup baselining', async () => {
  const f = await fixture(); const text = diagnostic().repeat(32); await fs.writeFile(f.file, text);
  const start = await measure(f, () => f.probe.onStart());
  // Baseline reconstruction still needs its own pass to identify active turns.
  expect(start.rawReadBytes).toBeLessThanOrEqual(2 * Buffer.byteLength(text));
  const update = vi.spyOn(f.state, 'update');
  for (let i = 0; i < 3; i++) {
    const cycle = await measure(f, () => f.probe.collect());
    expect(cycle.rawReadBytes).toBe(0); expect(cycle.rawInBytes).toBe(0);
  }
  expect(update).not.toHaveBeenCalled();
  expect(checkpoint(f).ownerSessionMetaOffset).toBeNull();
});

it('does not rescan an absent-owner inventory larger than the probe LRU, including after restart', async () => {
  const f = await fixture();
  const sessions = path.dirname(f.file);
  const text = row('event_msg', { type: 'historical_without_owner', padding: 'x'.repeat(128) });
  for (let start = 0; start < 2056; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 2056 - start) }, (_, i) =>
      fs.writeFile(path.join(sessions, `rollout-missing-${start + i}.jsonl`), text)));
  }
  await f.probe.onStart();
  const update = vi.spyOn(f.state, 'update');
  for (let i = 0; i < 2; i++) {
    const cycle = await measure(f, () => f.probe.collect());
    expect(cycle.rawReadBytes).toBe(0);
    expect(cycle.rawReadCalls).toBe(0);
    expect(cycle.rawInBytes).toBe(0);
  }
  expect(update).not.toHaveBeenCalled();
  expect(f.entries).toHaveLength(0);
  await f.state.save();
  await f.probe.onStop();
  const restored = new StateStore(path.join(f.root, 'state.json'));
  await restored.load();
  const restarted = await fixture(f.root, restored);
  const startup = await measure(restarted, () => restarted.probe.onStart());
  expect(startup.rawReadBytes).toBe(0);
  expect((await measure(restarted, () => restarted.probe.collect())).rawReadBytes).toBe(0);
}, 30_000);

it('still consumes normal turns without a session header', async () => {
  const f = await fixture(); await fs.writeFile(f.file, completed('normal', false));
  await processFile(f);
  expect(responses(f, 'normal')).toHaveLength(1);
  expect((await processFile(f)).rawReadBytes).toBe(0);
});

it.each(['append', 'same-size', 'new-inode', 'truncate'])('invalidates an absent-owner result after %s repair', async mode => {
  const f = await fixture(); const original = diagnostic(); await fs.writeFile(f.file, original);
  expect(await f.probe.findOwnerOffset(f.file, await fs.stat(f.file))).toBeNull();
  if (mode === 'append') await fs.appendFile(f.file, meta());
  else {
    const body = mode === 'same-size' ? meta() + ' '.repeat(Buffer.byteLength(original) - Buffer.byteLength(meta()) - 1) + '\n' : meta();
    if (mode === 'new-inode') { await fs.writeFile(f.file + '.new', body); await fs.rename(f.file + '.new', f.file); }
    else await fs.writeFile(f.file, body);
  }
  const stat = await fs.stat(f.file); await fs.utimes(f.file, stat.atime, new Date(stat.mtimeMs + 1000));
  expect(await f.probe.findOwnerOffset(f.file, await fs.stat(f.file)))
    .toBe(mode === 'append' ? Buffer.byteLength(original) : 0);
});

it.each(['append', 'same-size', 'new-inode', 'truncate'])('invalidates persisted owner absence after %s repair with an empty LRU', async mode => {
  const f = await fixture();
  const original = diagnostic();
  await fs.writeFile(f.file, original);
  const stat = await fs.stat(f.file);
  await f.probe.findOwnerOffset(f.file, stat);
  expect(f.state.get(key(f)).extra?.codexOwnerAbsentVersion).toBeTypeOf('string');
  // An absence marker is not a checkpoint and must not skip first baseline.
  expect(f.probe.readCheckpoint(key(f))).toBeNull();
  f.probe.ownerOffsetProbes.clear();
  if (mode === 'append') await fs.appendFile(f.file, meta());
  else {
    const body = mode === 'same-size'
      ? meta() + ' '.repeat(Buffer.byteLength(original) - Buffer.byteLength(meta()) - 1) + '\n'
      : meta();
    if (mode === 'new-inode') {
      await fs.writeFile(f.file + '.new', body);
      await fs.rename(f.file + '.new', f.file);
    } else await fs.writeFile(f.file, body);
  }
  // Restore mtime so ctime/inode/size must invalidate the persisted result.
  await fs.utimes(f.file, stat.atime, stat.mtime);
  expect(await f.probe.findOwnerOffset(f.file, await fs.stat(f.file)))
    .toBe(mode === 'append' ? Buffer.byteLength(original) : 0);
  expect(f.state.get(key(f)).extra?.codexOwnerAbsentVersion).toBeUndefined();
});

it.each(['prefix', 'incomplete'])('does not persist %s owner probes as full-file absence', async kind => {
  const f = await fixture();
  const prefix = diagnostic();
  await fs.writeFile(f.file, prefix + (kind === 'prefix' ? meta() : '{"unfinished":'));
  const stat = await fs.stat(f.file);
  await f.probe.findOwnerOffset(f.file, stat, kind === 'prefix' ? Buffer.byteLength(prefix) : stat.size);
  expect(f.state.get(key(f)).extra?.codexOwnerAbsentVersion).toBeUndefined();
});

it.each([123, {}, 'x'.repeat(257)])('ignores malformed persisted owner absence %j', async value => {
  const f = await fixture();
  await fs.writeFile(f.file, meta());
  f.state.update(key(f), { extra: { codexOwnerAbsentVersion: value } });
  expect(await f.probe.findOwnerOffset(f.file, await fs.stat(f.file))).toBe(0);
  expect(f.state.get(key(f)).extra?.codexOwnerAbsentVersion).toBeUndefined();
});

it('does not memoize a negative probe when a writer changes the file during its read', async () => {
  const f = await fixture(); await fs.writeFile(f.file, diagnostic()); const before = await fs.stat(f.file);
  const runtime = new InputRuntimeAccumulator(); f.probe.activeRuntimeAccumulator = runtime;
  const observe = runtime.observeRead.bind(runtime); let changed = false;
  vi.spyOn(runtime, 'observeRead').mockImplementation((...args) => {
    observe(...args);
    if (!changed) { changed = true; fsSync.appendFileSync(f.file, meta()); }
  });
  expect(await f.probe.findOwnerOffset(f.file, before)).toBeNull();
  expect(f.probe.ownerOffsetProbes.size).toBe(0);
  expect(f.state.get(key(f)).extra?.codexOwnerAbsentVersion).toBeUndefined();
  expect(await f.probe.findOwnerOffset(f.file, await fs.stat(f.file))).not.toBeNull();
});

it('does not reread an incomplete tail after finding the fork baseline boundary', async () => {
  const f = await fixture();
  const prefix = diagnostic();
  await fs.writeFile(f.file, prefix + '{"unfinished":"' + 'x'.repeat(3 * 1024 * 1024));
  const stat = await fs.stat(f.file);
  const cycle = await measure(f, () => f.probe.parkForkBaseline(f.file, key(f)));
  expect(checkpoint(f).scanOffset).toBe(Buffer.byteLength(prefix));
  expect(checkpoint(f).ownerSessionMetaOffset).toBeNull();
  // The backwards boundary search reads the tail once; the owner probe reads only the prefix.
  expect(cycle.rawReadBytes).toBeLessThanOrEqual(stat.size + Buffer.byteLength(prefix) + 1);
});

it.each(['limited-first', 'full-first'])('isolates and reuses alternating owner-probe boundaries (%s)', async order => {
  const f = await fixture();
  const prefix = diagnostic();
  await fs.writeFile(f.file, prefix + meta());
  const stat = await fs.stat(f.file);
  const boundary = Buffer.byteLength(prefix);
  if (order === 'full-first') expect(await f.probe.findOwnerOffset(f.file, stat)).toBe(boundary);
  expect(await f.probe.findOwnerOffset(f.file, stat, boundary)).toBeNull();
  expect((await measure(f, () => f.probe.findOwnerOffset(f.file, stat, boundary))).rawReadBytes).toBe(0);
  expect(await f.probe.findOwnerOffset(f.file, stat)).toBe(boundary);
  for (let i = 0; i < 3; i++) {
    expect((await measure(f, async () => {
      expect(await f.probe.findOwnerOffset(f.file, stat, boundary)).toBeNull();
      expect(await f.probe.findOwnerOffset(f.file, stat)).toBe(boundary);
    })).rawReadBytes).toBe(0);
  }
});

it('keeps filename-dependent owner selection separate for hard-linked rollout paths', async () => {
  const f = await fixture();
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  const firstPath = path.join(f.root, 'sessions', `rollout-${firstId}.jsonl`);
  const secondPath = path.join(f.root, 'sessions', `rollout-${secondId}.jsonl`);
  const firstHeader = row('session_meta', { id: firstId, model_provider: 'openai' });
  await fs.writeFile(firstPath, firstHeader + row('session_meta', { id: secondId, model_provider: 'openai' }) + diagnostic());
  await fs.link(firstPath, secondPath);
  const firstStat = await fs.stat(firstPath);
  const secondStat = await fs.stat(secondPath);
  expect([firstStat.dev, firstStat.ino, firstStat.size, firstStat.mtimeMs, firstStat.ctimeMs])
    .toEqual([secondStat.dev, secondStat.ino, secondStat.size, secondStat.mtimeMs, secondStat.ctimeMs]);
  expect(await f.probe.findOwnerOffset(firstPath, firstStat)).toBe(0);
  expect(await f.probe.findOwnerOffset(secondPath, secondStat)).toBe(Buffer.byteLength(firstHeader));
  expect((await measure(f, async () => {
    expect(await f.probe.findOwnerOffset(firstPath, firstStat)).toBe(0);
    expect(await f.probe.findOwnerOffset(secondPath, secondStat)).toBe(Buffer.byteLength(firstHeader));
  })).rawReadBytes).toBe(0);
});

it('keeps indexing healthy files when a probed file disappears before the final stat', async () => {
  const f = await fixture();
  await fs.writeFile(f.file, diagnostic());
  const healthy = path.join(f.root, 'sessions', 'rollout-healthy.jsonl');
  await fs.writeFile(healthy, meta());
  const runtime = new InputRuntimeAccumulator();
  f.probe.activeRuntimeAccumulator = runtime;
  const observe = runtime.observeRead.bind(runtime);
  let removed = false;
  vi.spyOn(runtime, 'observeRead').mockImplementation((...args) => {
    observe(...args);
    if (!removed) { removed = true; fsSync.unlinkSync(f.file); }
  });
  await expect(f.probe.indexDiscoveredTranscriptOwners([
    { filePath: f.file }, { filePath: healthy },
  ])).resolves.toBeUndefined();
  expect(removed).toBe(true);
  expect(f.probe.ownerOffsetProbes.size).toBe(1);
  expect(f.probe.transcriptMetaByPath.has(healthy)).toBe(true);
});

it('bounds probe metadata and clears it on stop', async () => {
  const f = await fixture(); await fs.writeFile(f.file, diagnostic());
  for (let i = 0; i < 2048; i++) f.probe.ownerOffsetProbes.set(`old-${i}`, null);
  await f.probe.findOwnerOffset(f.file, await fs.stat(f.file));
  expect(f.probe.ownerOffsetProbes.size).toBe(2048);
  expect(f.probe.ownerOffsetProbes.has('old-0')).toBe(false);
  await f.probe.onStop(); expect(f.probe.ownerOffsetProbes.size).toBe(0);
});

it.each([false, true])('keeps a recently used owner probe resident under cache churn (has owner: %s)', async hasOwner => {
  const f = await fixture();
  await fs.writeFile(f.file, (hasOwner ? meta() : '') + diagnostic());
  const stat = await fs.stat(f.file);
  const expected = hasOwner ? 0 : null;
  expect(await f.probe.findOwnerOffset(f.file, stat)).toBe(expected);
  // Fill the rest of the metadata cache without creating thousands of files.
  for (let i = 0; i < 2047; i++) f.probe.ownerOffsetProbes.set(`cold-${i}`, null);
  expect((await measure(f, () => f.probe.findOwnerOffset(f.file, stat))).rawReadBytes).toBe(0);
  const added = path.join(f.root, 'sessions', 'rollout-added.jsonl');
  await fs.writeFile(added, diagnostic());
  await f.probe.findOwnerOffset(added, await fs.stat(added));
  expect((await measure(f, () => f.probe.findOwnerOffset(f.file, stat))).rawReadBytes).toBe(0);
  expect(f.probe.ownerOffsetProbes.has('cold-0')).toBe(false);
  expect(f.probe.ownerOffsetProbes.size).toBe(2048);
});

async function pendingFixture(size = 2 * 1024 * 1024) {
  const f = await fixture();
  const header = meta();
  const failed = row('event_msg', { type: 'task_started', turn_id: 'old' }, 1)
    + diagnostic().repeat(Math.ceil(size / Buffer.byteLength(diagnostic())));
  const end = Buffer.byteLength(header + failed);
  await fs.writeFile(f.file, header + failed + completed('later', false));
  const stat = await fs.stat(f.file);
  f.state.update(key(f), { lastOffset: end, extra: { codexTranscript: {
    inode: stat.ino, scanOffset: end, ownerSessionMetaOffset: 0,
    activeTurn: { turnId: 'old', startOffset: Buffer.byteLength(header), startedAtMs: Date.parse('2026-01-01T00:00:01Z') },
    pendingTerminal: { turnId: 'old', terminalEndOffset: end }, pendingFusion: null, pendingSubagent: null,
  } } });
  return { ...f, header, failed, end };
}

it('defers an unparseable legacy range, consumes the later turn, and never rereads unchanged data', async () => {
  // Explicitly seeded legacy pending state: this tests recovery, not its original entry path.
  // Retained history exceeds the normal 16 MiB scan budget. Keep real file I/O
  // so this also covers oversized-range recovery, tail progress and restart reads.
  const f = await pendingFixture(17 * 1024 * 1024);
  const initial = checkpoint(f);
  Object.assign(initial.activeTurn!, { emittedPrompt: true, emittedStepCount: 7,
    emittedStepRequestIds: ['request-before-failure'], emittedStepResponseIds: ['response-before-failure'],
    emittedToolCallIds: ['tool-before-failure'], emittedToolResultIds: ['tool-before-failure'],
    emittedTraceId: 'a'.repeat(32) });
  f.state.update(key(f), { extra: { codexTranscript: initial } });
  expect((await processFile(f)).rawReadBytes).toBeGreaterThan(17 * 1024 * 1024);
  expect(responses(f, 'later')).toHaveLength(1);
  expect(checkpoint(f).pendingTerminal).toBeNull();
  expect(checkpoint(f).deferredTerminals).toHaveLength(1);
  expect(checkpoint(f).deferredTerminals![0]!.pendingTerminal.retryCount).toBe(1);
  const update = vi.spyOn(f.state, 'update');
  for (let i = 0; i < 3; i++) expect((await processFile(f)).rawReadBytes).toBe(0);
  expect(update).not.toHaveBeenCalled();
  await f.state.save();
  expect((await fs.stat(f.file)).size).toBeGreaterThan(f.end);
  // Persist offsets/semantic context, never the failed diagnostic body.
  expect((await fs.stat(path.join(f.root, 'state.json'))).size).toBeLessThan(16 * 1024);
  const state = new StateStore(path.join(f.root, 'state.json')); await state.load();
  const restarted = await fixture(f.root, state);
  expect((await processFile(restarted)).rawReadBytes).toBeLessThanOrEqual(64 * 1024);
  expect((await processFile(restarted)).rawReadBytes).toBe(0);
  expect(restarted.entries).toEqual([]);
  expect(checkpoint(restarted).deferredTerminals![0]!.pendingTerminal.retryCount).toBe(1);
  expect(checkpoint(restarted).deferredTerminals![0]!.activeTurn).toMatchObject({ emittedPrompt: true,
    emittedStepCount: 7, emittedStepRequestIds: ['request-before-failure'],
    emittedStepResponseIds: ['response-before-failure'], emittedToolCallIds: ['tool-before-failure'],
    emittedToolResultIds: ['tool-before-failure'], emittedTraceId: 'a'.repeat(32) });
});

it('recovers a repaired same-size deferred range after backoff, once, without replaying later work', async () => {
  const f = await pendingFixture(); let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
  await processFile(f);
  const repaired = completed('old', false);
  const fill = Buffer.byteLength(f.failed) - Buffer.byteLength(repaired);
  expect(fill).toBeGreaterThan(0);
  await fs.writeFile(f.file, f.header + repaired + ' '.repeat(fill - 1) + '\n' + completed('later', false));
  const stat = await fs.stat(f.file); await fs.utimes(f.file, stat.atime, new Date(stat.mtimeMs + 1000));
  expect((await processFile(f)).rawReadBytes).toBe(0);
  clock += 1001;
  await processFile(f);
  expect(checkpoint(f).deferredTerminals ?? []).toEqual([]);
  expect(responses(f, 'old')).toHaveLength(1);
  expect(responses(f, 'later')).toHaveLength(1);
  expect(new Set(f.entries.map(e => e['event.id'])).size).toBe(f.entries.length);
  expect((await processFile(f)).rawReadBytes).toBe(0);
});

it('never retries an unchanged failed version even after the retry deadline expires', async () => {
  const f = await pendingFixture(1024); let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
  await processFile(f); clock += 3600_000;
  expect((await processFile(f)).rawReadBytes).toBe(0);
  expect(checkpoint(f).deferredTerminals![0]!.pendingTerminal.retryCount).toBe(1);
});

it('backs off repeated failures on changing files and caps the retry delay', async () => {
  const f = await pendingFixture(1024); let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
  await processFile(f);
  for (let i = 0; i < 10; i++) {
    const pending = checkpoint(f).deferredTerminals![0]!.pendingTerminal;
    await fs.appendFile(f.file, row('event_msg', { type: 'unknown_append', index: i }));
    clock = pending.failure!.retryAtMs;
    await processFile(f);
    expect(checkpoint(f).deferredTerminals![0]!.pendingTerminal.retryCount).toBe(i + 2);
    expect(checkpoint(f).deferredTerminals![0]!.pendingTerminal.failure!.delayMs).toBeLessThanOrEqual(60_000);
  }
  expect(checkpoint(f).deferredTerminals![0]!.pendingTerminal.failure!.delayMs).toBe(60_000);
  const recover = vi.spyOn(f.probe, 'recoverTurnSegment');
  await fs.appendFile(f.file, row('event_msg', { type: 'unknown_append', index: 'not-due' }));
  await processFile(f); expect(recover).not.toHaveBeenCalled();
});

it('retains all failed ranges and the blocking cursor when the deferred capacity is full', async () => {
  const f = await pendingFixture(1024); const cp = checkpoint(f); const stat = await fs.stat(f.file);
  const warn = vi.spyOn(f.probe.logger, 'warn');
  const pendingRecovery = vi.spyOn(f.probe, 'recoverPendingTerminal');
  const recover = vi.spyOn(f.probe, 'recoverTurnSegment');
  cp.deferredTerminals = Array.from({ length: 4 }, (_, index) => ({
    activeTurn: { ...cp.activeTurn!, turnId: `deferred-${index}` },
    pendingTerminal: { turnId: `deferred-${index}`, terminalEndOffset: f.end,
      failure: { sourceVersion: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'), retryAtMs: 0, delayMs: 1000 } },
  }));
  cp.deferredTerminals[0]!.pendingTerminal.failure!.sourceVersion = 'previous-version';
  f.state.update(key(f), { extra: { codexTranscript: cp } });
  await processFile(f); await f.state.save();
  expect(await pendingRecovery.mock.results[0]!.value).toMatchObject({ blocked: true, processedTerminalCount: 1 });
  expect(checkpoint(f).deferredTerminals).toHaveLength(4);
  expect(checkpoint(f).pendingTerminal?.turnId).toBe('old');
  expect(checkpoint(f).scanOffset).toBe(f.end);
  expect(responses(f, 'later')).toHaveLength(0);
  expect(warn).toHaveBeenCalledWith(
    'Codex terminal turn could not be parsed; retained until source changes and backoff expires',
    expect.objectContaining({ recoveryPhase: 'pending', deferred: false, blocked: true,
      deferredRanges: 4, deferredLimit: 4, retryDelayMs: 1000 }),
  );
  expect(warn).toHaveBeenCalledWith(
    'Codex terminal turn could not be parsed; retained until source changes and backoff expires',
    expect.objectContaining({ recoveryPhase: 'deferred', turnId: 'deferred-0', deferred: true, blocked: true,
      blockingTurnId: 'old', range: { startOffset: Buffer.byteLength(f.header), endOffset: f.end },
      deferredRanges: 4, deferredLimit: 4 }),
  );
  const update = vi.spyOn(f.state, 'update');
  recover.mockClear();
  expect((await processFile(f)).rawReadBytes).toBe(0);
  expect(await pendingRecovery.mock.results[1]!.value).toMatchObject({ blocked: true, processedTerminalCount: 0 });
  expect(recover).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  const healthy = path.join(f.root, 'sessions', 'rollout-healthy.jsonl');
  await fs.writeFile(healthy, completed('healthy'));
  await f.probe.processFile(healthy); expect(responses(f, 'healthy')).toHaveLength(1);
});

it('attempts at most one eligible deferred range per file cycle', async () => {
  const f = await pendingFixture(1024); const cp = checkpoint(f);
  cp.deferredTerminals = ['a', 'b'].map(turn => ({ activeTurn: { ...cp.activeTurn!, turnId: turn },
    pendingTerminal: { turnId: turn, terminalEndOffset: f.end,
      failure: { sourceVersion: 'previous-version', retryAtMs: 0, delayMs: 1000 } } }));
  cp.pendingTerminal = null; cp.activeTurn = null; cp.scanOffset = (await fs.stat(f.file)).size;
  f.state.update(key(f), { extra: { codexTranscript: cp } });
  const recover = vi.spyOn(f.probe, 'recoverTurnSegment');
  await processFile(f); expect(recover).toHaveBeenCalledTimes(1);
  recover.mockClear(); await processFile(f); expect(recover).toHaveBeenCalledTimes(1);
});

it('bounds an oversized persisted deferred queue while preserving the blocking cursor', async () => {
  const f = await pendingFixture(1024);
  const cp = checkpoint(f);
  const stat = await fs.stat(f.file);
  cp.deferredTerminals = Array.from({ length: 10_000 }, (_, index) => ({
    activeTurn: { ...cp.activeTurn!, turnId: `retained-${index}` },
    pendingTerminal: { turnId: `retained-${index}`, terminalEndOffset: f.end,
      failure: { sourceVersion: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'),
        retryAtMs: 0, delayMs: 1000 } },
  }));
  f.state.update(key(f), { extra: { codexTranscript: cp } });
  await f.state.save();
  await f.state.load();
  const parsed = f.probe.readCheckpoint(key(f));
  expect(parsed.deferredTerminals).toHaveLength(4);
  expect(parsed.deferredTerminals.map((item: any) => item.activeTurn.turnId))
    .toEqual(['retained-0', 'retained-1', 'retained-2', 'retained-3']);
  await processFile(f);
  expect(checkpoint(f).pendingTerminal?.turnId).toBe('old');
  expect(checkpoint(f).scanOffset).toBe(f.end);
  expect(responses(f, 'later')).toHaveLength(0);
  await f.state.save();
  await f.state.load();
  expect(checkpoint(f).deferredTerminals).toHaveLength(4);
  expect((await processFile(f)).rawReadBytes).toBe(0);
});

it('keeps remaining deferred ranges and omits the field after the final recovery', async () => {
  const f = await fixture();
  const first = completed('first');
  const text = first + completed('second', false);
  await fs.writeFile(f.file, text);
  const stat = await fs.stat(f.file);
  f.state.update(key(f), { extra: { codexTranscript: {
    inode: stat.ino, scanOffset: stat.size, ownerSessionMetaOffset: 0,
    activeTurn: null, pendingTerminal: null, pendingFusion: null, pendingSubagent: null,
    deferredTerminals: [
      { activeTurn: { turnId: 'first', startOffset: 0, startedAtMs: Date.parse('2026-01-01T00:00:01Z') },
        pendingTerminal: { turnId: 'first', terminalEndOffset: Buffer.byteLength(first) } },
      { activeTurn: { turnId: 'second', startOffset: Buffer.byteLength(first), startedAtMs: Date.parse('2026-01-01T00:00:01Z') },
        pendingTerminal: { turnId: 'second', terminalEndOffset: stat.size } },
    ],
  } } });
  await processFile(f);
  expect(checkpoint(f).deferredTerminals).toHaveLength(1);
  expect(checkpoint(f).deferredTerminals![0]!.activeTurn.turnId).toBe('second');
  expect(responses(f, 'first')).toHaveLength(1);
  expect(responses(f, 'second')).toHaveLength(0);
  await processFile(f);
  expect(responses(f, 'second')).toHaveLength(1);
  expect(checkpoint(f)).not.toHaveProperty('deferredTerminals');
  await f.state.save();
  await f.state.load();
  expect(checkpoint(f)).not.toHaveProperty('deferredTerminals');
  expect((await processFile(f)).rawReadBytes).toBe(0);
  expect(responses(f, 'first')).toHaveLength(1);
  expect(responses(f, 'second')).toHaveLength(1);
});

it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid terminal end offset %s without blocking later collection', async offset => {
    const f = await pendingFixture(1024);
    const cp = checkpoint(f);
    cp.pendingTerminal!.terminalEndOffset = offset;
    cp.deferredTerminals = [{ activeTurn: { ...cp.activeTurn! }, pendingTerminal: { ...cp.pendingTerminal! } }];
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    const parsed = f.probe.readCheckpoint(key(f));
    expect(parsed.pendingTerminal).toBeNull();
    expect(parsed.deferredTerminals ?? []).toEqual([]);
    // Keep the valid active context so ordinary scanning can close this turn
    // and collect the subsequent healthy turn using real source boundaries.
    expect(parsed.activeTurn).toMatchObject({ turnId: 'old' });
    await processFile(f);
    expect(responses(f, 'later')).toHaveLength(1);
  },
);

it('rejects an overflowing JSON offset after loading a persisted checkpoint', async () => {
  const f = await pendingFixture(1024);
  await f.state.save();
  const statePath = path.join(f.root, 'state.json');
  const text = await fs.readFile(statePath, 'utf8');
  expect(text).toMatch(/"terminalEndOffset"\s*:\s*\d+/);
  // Valid JSON numbers may overflow JavaScript's finite numeric range.
  await fs.writeFile(statePath, text.replace(/("terminalEndOffset"\s*:\s*)\d+/, (_, prefix) => prefix + '1e309'));
  await f.state.load();
  expect(checkpoint(f).pendingTerminal!.terminalEndOffset).toBe(Infinity);
  expect(f.probe.readCheckpoint(key(f)).pendingTerminal).toBeNull();
  await processFile(f);
  expect(responses(f, 'later')).toHaveLength(1);
});

it.each(['processed', 'unparseable', 'gated-pending'])('uses the terminal budget for %s recovery', async mode => {
  const f = await fixture();
  const initial = mode === 'processed' ? completed('deferred')
    : meta() + row('event_msg', { type: 'task_started', turn_id: 'deferred' }) + diagnostic();
  const boundary = Buffer.byteLength(initial);
  await fs.writeFile(f.file, initial + Array.from({ length: 100 }, (_, i) => completed(`turn-${i}`, false)).join(''));
  const stat = await fs.stat(f.file);
  f.state.update(key(f), { extra: { codexTranscript: {
    inode: stat.ino, scanOffset: boundary, ownerSessionMetaOffset: 0,
    activeTurn: null, pendingTerminal: null, pendingFusion: null, pendingSubagent: null,
    deferredTerminals: [{ activeTurn: { turnId: 'deferred', startOffset: 0, startedAtMs: Date.parse('2026-01-01T00:00:01Z') },
      pendingTerminal: { turnId: 'deferred', terminalEndOffset: boundary } }],
  } } });
  if (mode === 'gated-pending') {
    const cp = checkpoint(f);
    const retained = cp.deferredTerminals![0]!;
    cp.activeTurn = retained.activeTurn;
    cp.pendingTerminal = retained.pendingTerminal;
    cp.pendingTerminal.failure = { sourceVersion: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'),
      retryAtMs: Date.now() + 1000_000, delayMs: 1000 };
    cp.deferredTerminals = [];
    f.state.update(key(f), { extra: { codexTranscript: cp } });
  }
  await processFile(f);
  expect(responses(f, 'turn-98')).toHaveLength(1);
  expect(responses(f, 'turn-99')).toHaveLength(mode === 'gated-pending' ? 1 : 0);
  expect(f.entries.filter(e => e['event.name'] === 'llm.response')).toHaveLength(mode === 'unparseable' ? 99 : 100);
  if (mode === 'gated-pending') expect(checkpoint(f).scanOffset).toBe(stat.size);
  else expect(checkpoint(f).scanOffset).toBeLessThan(stat.size);
  await processFile(f);
  expect(responses(f, 'turn-99')).toHaveLength(1);
  expect(responses(f, 'turn-98')).toHaveLength(1);
});

it('initially probes a deferred range without failure metadata once and persists retry gating across restart', async () => {
  const f = await pendingFixture(1024);
  let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const cp = checkpoint(f);
  cp.deferredTerminals = [{ activeTurn: cp.activeTurn!, pendingTerminal: cp.pendingTerminal! }];
  cp.activeTurn = null; cp.pendingTerminal = null; cp.scanOffset = (await fs.stat(f.file)).size;
  f.state.update(key(f), { extra: { codexTranscript: cp } });
  const recover = vi.spyOn(f.probe, 'recoverTurnSegment');
  const firstFailureAt = clock;
  await processFile(f);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(checkpoint(f).deferredTerminals![0]!.pendingTerminal.failure).toBeDefined();
  expect(checkpoint(f).deferredTerminals![0]!.pendingTerminal).toMatchObject({
    firstPendingAtMs: firstFailureAt, lastAttemptAtMs: firstFailureAt,
  });
  clock += 3600_000;
  for (let i = 0; i < 3; i++) expect((await processFile(f)).rawReadBytes).toBe(0);
  expect(recover).toHaveBeenCalledTimes(1);
  await f.state.save(); await f.state.load();
  const restarted = await fixture(f.root, f.state);
  const restartedRecover = vi.spyOn(restarted.probe, 'recoverTurnSegment');
  const retryWarn = vi.spyOn(restarted.probe.logger, 'warn');
  await processFile(restarted);
  expect(restartedRecover).not.toHaveBeenCalled();
  expect(retryWarn).not.toHaveBeenCalled();
  expect(checkpoint(restarted).deferredTerminals![0]!.pendingTerminal.retryCount).toBe(1);
  await fs.appendFile(f.file, diagnostic());
  await processFile(restarted);
  expect(restartedRecover).toHaveBeenCalledTimes(1);
  expect(checkpoint(restarted).deferredTerminals![0]!.pendingTerminal).toMatchObject({
    firstPendingAtMs: firstFailureAt, lastAttemptAtMs: clock, retryCount: 2,
  });
  expect(retryWarn).toHaveBeenCalledWith(
    'Codex terminal turn could not be parsed; retained until source changes and backoff expires',
    expect.objectContaining({ recoveryPhase: 'deferred', deferred: true, blocked: false,
      range: { startOffset: Buffer.byteLength(f.header), endOffset: f.end },
      deferredRanges: 1, deferredLimit: 4, firstPendingAtMs: firstFailureAt, lastAttemptAtMs: clock }),
  );
  await f.state.save(); await f.state.load();
  expect(checkpoint(restarted).deferredTerminals![0]!.pendingTerminal.firstPendingAtMs).toBe(firstFailureAt);
});

it.each(['missing-active', 'mismatched-turn', 'reversed-range', 'legacy-reversed-range'])(
  'rejects inconsistent pending recovery (%s) and still collects later work', async mode => {
    const f = await pendingFixture(1024);
    const cp = checkpoint(f);
    if (mode === 'missing-active') cp.activeTurn = null;
    else if (mode === 'mismatched-turn') cp.pendingTerminal!.turnId = 'different-turn';
    else if (mode === 'legacy-reversed-range') {
      cp.pendingTerminal = null;
      cp.pendingSubagent = { turnId: 'old', terminalEndOffset: 0 } as any;
    } else cp.pendingTerminal!.terminalEndOffset = 0;
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    const parsed = f.probe.readCheckpoint(key(f));
    expect(parsed.pendingTerminal).toBeNull();
    if (mode !== 'missing-active') expect(parsed.activeTurn?.turnId).toBe('old');
    await processFile(f);
    expect(responses(f, 'later')).toHaveLength(1);
  },
);

it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid active/deferred start offset %s without blocking later work', async offset => {
    const f = await pendingFixture(1024);
    const cp = checkpoint(f);
    cp.activeTurn!.startOffset = offset;
    cp.deferredTerminals = [{ activeTurn: { ...cp.activeTurn! }, pendingTerminal: { ...cp.pendingTerminal! } }];
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    const parsed = f.probe.readCheckpoint(key(f));
    expect(parsed.activeTurn).toBeNull();
    expect(parsed.pendingTerminal).toBeNull();
    expect(parsed.deferredTerminals ?? []).toEqual([]);
    await processFile(f);
    expect(responses(f, 'later')).toHaveLength(1);
  },
);

it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'drops malformed optional recovery metadata %s while retaining recoverable ranges', async value => {
    const f = await pendingFixture(1024);
    const cp = checkpoint(f);
    Object.assign(cp.pendingTerminal!, { retryCount: value, firstPendingAtMs: value,
      lastAttemptAtMs: value, sourceRecordCount: value });
    cp.deferredTerminals = [{ activeTurn: { ...cp.activeTurn!, turnId: 'retained' },
      pendingTerminal: { ...cp.pendingTerminal!, turnId: 'retained' } }];
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    const parsed = f.probe.readCheckpoint(key(f));
    for (const pending of [parsed.pendingTerminal, parsed.deferredTerminals[0].pendingTerminal]) {
      expect(pending.terminalEndOffset).toBe(f.end);
      for (const field of ['retryCount', 'firstPendingAtMs', 'lastAttemptAtMs', 'sourceRecordCount']) {
        expect(pending).not.toHaveProperty(field);
      }
    }
    await processFile(f);
    expect(responses(f, 'later')).toHaveLength(1);
    expect(checkpoint(f).deferredTerminals).toHaveLength(2);
    for (const item of checkpoint(f).deferredTerminals!) expect(item.pendingTerminal.retryCount).toBe(1);
  },
);

it('rejects invalid retry deadlines and fractional delays while keeping valid zero-valued metadata', async () => {
  const f = await pendingFixture(1024);
  const cp = checkpoint(f);
  const pending = cp.pendingTerminal!;
  Object.assign(pending, { retryCount: 0, firstPendingAtMs: 0, lastAttemptAtMs: 0, sourceRecordCount: 0 });
  pending.failure = { sourceVersion: 'old-version', retryAtMs: 0, delayMs: 1000 };
  f.state.update(key(f), { extra: { codexTranscript: cp } });
  expect(f.probe.readCheckpoint(key(f)).pendingTerminal).toEqual(pending);
  for (const invalid of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    pending.failure.retryAtMs = invalid;
    expect(f.probe.readCheckpoint(key(f)).pendingTerminal.failure).toBeUndefined();
  }
  pending.failure.retryAtMs = 0;
  pending.failure.delayMs = 1000.5;
  expect(f.probe.readCheckpoint(key(f)).pendingTerminal.failure).toBeUndefined();
  await processFile(f);
  expect(responses(f, 'later')).toHaveLength(1);
  expect(checkpoint(f).deferredTerminals![0]!.pendingTerminal.failure?.delayMs).toBe(1000);
});

it.each(['pending', 'deferred'])('keeps a maximum persisted retry counter safe during %s recovery', async location => {
  const f = await pendingFixture(1024);
  const cp = checkpoint(f);
  cp.pendingTerminal!.retryCount = Number.MAX_SAFE_INTEGER;
  if (location === 'deferred') {
    cp.deferredTerminals = [{ activeTurn: cp.activeTurn!, pendingTerminal: cp.pendingTerminal! }];
    cp.activeTurn = null; cp.pendingTerminal = null; cp.scanOffset = (await fs.stat(f.file)).size;
  }
  f.state.update(key(f), { extra: { codexTranscript: cp } });
  await processFile(f);
  expect(checkpoint(f).deferredTerminals![0]!.pendingTerminal.retryCount).toBe(Number.MAX_SAFE_INTEGER);
  await f.state.save(); await f.state.load();
  expect((await processFile(f)).rawReadBytes).toBe(0);
});

it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid scan offset %s and collects subsequent new work', async offset => {
    const f = await pendingFixture(1024);
    const cp = checkpoint(f); cp.scanOffset = offset;
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    expect(f.probe.readCheckpoint(key(f))).toBeNull();
    await processFile(f);
    expect(Number.isSafeInteger(checkpoint(f).scanOffset)).toBe(true);
    expect(checkpoint(f).scanOffset).toBeGreaterThanOrEqual(0);
    await fs.appendFile(f.file, completed('after-invalid-cursor', false));
    await processFile(f);
    expect(responses(f, 'after-invalid-cursor')).toHaveLength(1);
  },
);

function legacyRecoveryState(cp: CodexTranscriptCheckpoint, end: number) {
  cp.pendingFusion = { turnId: 'old', parentThreadId: 'parent', parentTraceId: 'a'.repeat(32),
    terminalEndOffset: end, children: [{ parentToolCallId: 'tool', parentTraceId: 'a'.repeat(32), spawnedAtMs: 0 }] };
  cp.pendingSubagent = { turnId: 'old', parentThreadId: 'parent', parentTurnId: 'parent-turn',
    parentTraceId: 'a'.repeat(32), parentToolCallId: 'tool', confidence: 'explicit_id',
    terminalEndOffset: end, activeTurn: { ...cp.activeTurn! } };
  cp.forkBootstrap = { state: 'live-pending', searchOffset: 0 };
}

it.each(['fusion', 'captured-subagent'])(
  'rejects legacy %s boundaries beyond the saved cursor without blocking later work', async kind => {
    const f = await pendingFixture(1024);
    for (const end of [f.end + 1, Number.MAX_SAFE_INTEGER]) {
      const cp = checkpoint(f);
      legacyRecoveryState(cp, end);
      cp.pendingTerminal = null; cp.forkBootstrap = undefined;
      if (kind === 'fusion') cp.pendingSubagent = null;
      else cp.pendingFusion = null;
      f.state.update(key(f), { extra: { codexTranscript: cp } });
      await f.state.save(); await f.state.load();
      const parsed = f.probe.readCheckpoint(key(f));
      expect(parsed.pendingFusion).toBeNull();
      expect(parsed.pendingSubagent).toBeNull();
      expect(parsed.pendingTerminal).toBeNull();
      expect(parsed.activeTurn).toMatchObject({ turnId: 'old' });
    }
    const releaseParent = vi.spyOn(f.probe, 'releaseParentFusionIndependently');
    const releaseChild = vi.spyOn(f.probe, 'releaseCapturedSubagentIndependently');
    await processFile(f);
    expect(releaseParent).not.toHaveBeenCalled();
    expect(releaseChild).not.toHaveBeenCalled();
    expect(responses(f, 'later')).toHaveLength(1);
  },
);

it.each(['mismatched-turn', 'reversed-range'])(
  'rejects legacy fusion inconsistent with its active context (%s)', async mode => {
    const f = await pendingFixture(1024); const cp = checkpoint(f);
    legacyRecoveryState(cp, f.end);
    cp.pendingTerminal = null; cp.pendingSubagent = null; cp.forkBootstrap = undefined;
    if (mode === 'mismatched-turn') cp.pendingFusion!.turnId = 'different-turn';
    else cp.pendingFusion!.terminalEndOffset = 0;
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    expect(f.probe.readCheckpoint(key(f)).pendingFusion).toBeNull();
    await processFile(f);
    expect(responses(f, 'later')).toHaveLength(1);
  },
);

it.each(['at', 'behind', 'without-active'])('retains valid legacy barriers (%s)', async location => {
  const f = await pendingFixture(1024); const cp = checkpoint(f);
  legacyRecoveryState(cp, f.end);
  const startOffset = cp.activeTurn!.startOffset;
  if (location === 'without-active') cp.activeTurn = null;
  cp.pendingTerminal = null; cp.forkBootstrap = undefined;
  cp.scanOffset = location === 'at' ? f.end : (await fs.stat(f.file)).size;
  f.state.update(key(f), { extra: { codexTranscript: cp } });
  await f.state.save(); await f.state.load();
  const parsed = f.probe.readCheckpoint(key(f));
  expect(parsed.pendingFusion).toMatchObject({ terminalEndOffset: f.end });
  expect(parsed.pendingSubagent).toMatchObject({ terminalEndOffset: f.end,
    activeTurn: { turnId: 'old', startOffset } });
});

it('parses legacy pending-subagent migration deterministically without manufacturing retry attempts', async () => {
  const f = await pendingFixture(1024); const cp = checkpoint(f);
  cp.pendingTerminal = null;
  cp.pendingSubagent = { turnId: 'old', terminalEndOffset: f.end } as any;
  f.state.update(key(f), { extra: { codexTranscript: cp } });
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const update = vi.spyOn(f.state, 'update');
  const first = f.probe.readCheckpoint(key(f));
  now += 30_000;
  expect(f.probe.readCheckpoint(key(f))).toEqual(first);
  expect(first.pendingTerminal).toEqual({ turnId: 'old', terminalEndOffset: f.end });
  expect(update).not.toHaveBeenCalled();
});

it('records the first actual legacy-migration recovery attempt once and retains its time across restart', async () => {
  const f = await pendingFixture(1024); const cp = checkpoint(f);
  cp.pendingTerminal = null;
  cp.pendingSubagent = { turnId: 'old', terminalEndOffset: f.end } as any;
  f.state.update(key(f), { extra: { codexTranscript: cp } });
  const firstAttempt = Date.now(); let now = firstAttempt;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await processFile(f);
  const pending = checkpoint(f).deferredTerminals![0]!.pendingTerminal;
  expect(pending).toMatchObject({ retryCount: 1, firstPendingAtMs: firstAttempt, lastAttemptAtMs: firstAttempt });
  expect(responses(f, 'later')).toHaveLength(1);
  await f.state.save(); await f.state.load();
  const restarted = await fixture(f.root, f.state);
  now += 3600_000;
  const recover = vi.spyOn(restarted.probe, 'recoverTurnSegment');
  await processFile(restarted);
  expect(recover).not.toHaveBeenCalled();
  expect(checkpoint(restarted).deferredTerminals![0]!.pendingTerminal).toMatchObject({
    retryCount: 1, firstPendingAtMs: firstAttempt, lastAttemptAtMs: firstAttempt,
  });
});

it.each(['eof', 'unsafe-range'])('repairs persisted owner offsets outside the current file (%s)', async mode => {
  const f = await pendingFixture(1024); const cp = checkpoint(f);
  cp.ownerSessionMetaOffset = mode === 'eof' ? (await fs.stat(f.file)).size : Number.MAX_SAFE_INTEGER;
  f.state.update(key(f), { extra: { codexTranscript: cp } });
  await f.state.save(); await f.state.load();
  const findOwner = vi.spyOn(f.probe, 'findOwnerOffset');
  await processFile(f);
  expect(findOwner).toHaveBeenCalledTimes(1);
  expect(checkpoint(f).ownerSessionMetaOffset).toBe(0);
  expect(responses(f, 'later')).toHaveLength(1);
});

it('retains a valid owner ahead of a parked live-fork scan cursor across restart', async () => {
  const f = await fixture();
  const ownerId = '019b76da-a800-7000-8000-000000000001';
  f.file = path.join(path.dirname(f.file), `rollout-${ownerId}.jsonl`);
  const copiedMeta = row('session_meta', { id: 'parent', model_provider: 'openai' });
  await fs.writeFile(f.file, copiedMeta
    + row('session_meta', { id: ownerId, model_provider: 'openai', forked_from_id: 'parent' })
    + completed('copied-parent-turn', false));
  await processFile(f);
  expect(checkpoint(f)).toMatchObject({ scanOffset: 0, ownerSessionMetaOffset: Buffer.byteLength(copiedMeta),
    forkBootstrap: { state: 'live-pending' } });
  await f.state.save(); await f.state.load();
  const restarted = await fixture(f.root, f.state);
  restarted.file = f.file;
  expect(restarted.probe.readCheckpoint(key(restarted)).ownerSessionMetaOffset).toBe(Buffer.byteLength(copiedMeta));
  const findOwner = vi.spyOn(restarted.probe, 'findOwnerOffset');
  await processFile(restarted);
  expect(findOwner).not.toHaveBeenCalled();
  expect(checkpoint(restarted)).toMatchObject({ scanOffset: 0, ownerSessionMetaOffset: Buffer.byteLength(copiedMeta) });
  expect(restarted.entries).toEqual([]);
});

it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid owner/legacy recovery byte offsets %s without blocking later work', async offset => {
    const f = await pendingFixture(1024); const cp = checkpoint(f);
    legacyRecoveryState(cp, f.end);
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    const valid = f.probe.readCheckpoint(key(f));
    expect(valid.pendingFusion).not.toBeNull();
    expect(valid.pendingSubagent).not.toBeNull();
    expect(valid.forkBootstrap?.searchOffset).toBe(0);
    cp.pendingTerminal = null; cp.ownerSessionMetaOffset = offset;
    cp.pendingFusion!.terminalEndOffset = offset;
    cp.pendingSubagent!.terminalEndOffset = offset;
    cp.forkBootstrap!.searchOffset = offset;
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    const parsed = f.probe.readCheckpoint(key(f));
    expect(parsed.ownerSessionMetaOffset).toBeNull();
    expect(parsed.pendingFusion).toBeNull();
    expect(parsed.pendingSubagent).toBeNull();
    expect(parsed.pendingTerminal).toBeNull();
    expect(parsed.forkBootstrap).toBeUndefined();
    await processFile(f);
    expect(responses(f, 'later')).toHaveLength(1);
  },
);

it.each(['mismatched-turn', 'reversed-range'])(
  'rejects inconsistent captured legacy recovery (%s)', async mode => {
    const f = await pendingFixture(1024); const cp = checkpoint(f);
    legacyRecoveryState(cp, f.end);
    cp.pendingFusion = null; cp.forkBootstrap = undefined; cp.pendingTerminal = null;
    if (mode === 'mismatched-turn') cp.pendingSubagent!.turnId = 'different';
    else cp.pendingSubagent!.terminalEndOffset = 0;
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    const parsed = f.probe.readCheckpoint(key(f));
    expect(parsed.pendingSubagent).toBeNull();
    expect(parsed.pendingTerminal).toBeNull();
    await processFile(f);
    expect(responses(f, 'later')).toHaveLength(1);
  },
);

it('accepts zero as a valid terminal boundary', async () => {
  const f = await pendingFixture(1024);
  const cp = checkpoint(f);
  cp.scanOffset = 0;
  cp.activeTurn!.startOffset = 0;
  cp.activeTurn!.startedAtMs = 0;
  cp.activeTurn!.nextStepStartedAtMs = 0;
  cp.activeTurn!.subagentSpawns = [{ parentToolCallId: 'tool', parentTraceId: 'trace', spawnedAtMs: 0 }];
  cp.pendingTerminal!.terminalEndOffset = 0;
  f.state.update(key(f), { extra: { codexTranscript: cp } });
  expect(f.probe.readCheckpoint(key(f)).pendingTerminal?.terminalEndOffset).toBe(0);
  expect(f.probe.readCheckpoint(key(f)).scanOffset).toBe(0);
  expect(f.probe.readCheckpoint(key(f)).activeTurn).toMatchObject({ startedAtMs: 0, nextStepStartedAtMs: 0,
    subagentSpawns: [{ spawnedAtMs: 0, parentToolCallId: 'tool', parentTraceId: 'trace' }] });
});

it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid required active/deferred timestamps %s and collects later work', async timestamp => {
    const f = await pendingFixture(1024); const cp = checkpoint(f);
    cp.activeTurn!.startedAtMs = timestamp;
    cp.deferredTerminals = [{ activeTurn: { ...cp.activeTurn! }, pendingTerminal: { ...cp.pendingTerminal! } }];
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    const parsed = f.probe.readCheckpoint(key(f));
    expect(parsed.activeTurn).toBeNull();
    expect(parsed.pendingTerminal).toBeNull();
    expect(parsed.deferredTerminals ?? []).toEqual([]);
    await processFile(f);
    expect(responses(f, 'later')).toHaveLength(1);
  },
);

it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'omits invalid optional active/deferred/spawn timestamps %s while keeping valid context', async timestamp => {
    const f = await pendingFixture(1024); const cp = checkpoint(f);
    cp.activeTurn!.nextStepStartedAtMs = timestamp;
    cp.activeTurn!.subagentSpawns = [{ parentToolCallId: 'tool', parentTraceId: 'trace', spawnedAtMs: timestamp }];
    cp.deferredTerminals = [{ activeTurn: { ...cp.activeTurn! }, pendingTerminal: { ...cp.pendingTerminal! } }];
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    const parsed = f.probe.readCheckpoint(key(f));
    for (const active of [parsed.activeTurn, parsed.deferredTerminals[0].activeTurn]) {
      expect(active).toMatchObject({ turnId: 'old', startedAtMs: cp.activeTurn!.startedAtMs });
      expect(active).not.toHaveProperty('nextStepStartedAtMs');
      expect(active.subagentSpawns).toEqual([]);
    }
    await processFile(f);
    expect(responses(f, 'later')).toHaveLength(1);
  },
);

it.each(['pending', 'deferred', 'legacy-pending'])(
  'rejects %s terminal boundaries beyond the persisted scan cursor', async location => {
    const f = await pendingFixture(1024);
    for (const end of [f.end + 1, Number.MAX_SAFE_INTEGER]) {
      const cp = checkpoint(f);
      const pending = { turnId: 'old', terminalEndOffset: end };
      cp.pendingTerminal = location === 'pending' ? pending : null;
      cp.deferredTerminals = location === 'deferred'
        ? [{ activeTurn: { ...cp.activeTurn! }, pendingTerminal: pending }] : [];
      // Older captured checkpoints migrate through the same pending validator.
      cp.pendingSubagent = location === 'legacy-pending' ? pending as any : null;
      f.state.update(key(f), { extra: { codexTranscript: cp } });
      await f.state.save(); await f.state.load();
      const parsed = f.probe.readCheckpoint(key(f));
      expect(parsed.pendingTerminal).toBeNull();
      expect(parsed.deferredTerminals ?? []).toEqual([]);
      expect(parsed.activeTurn).toMatchObject({ turnId: 'old' });
    }
    const recover = vi.spyOn(f.probe, 'recoverTurnSegment');
    await processFile(f);
    expect(recover.mock.calls.every(call => (call[2] as number) <= (fsSync.statSync(f.file)).size)).toBe(true);
    expect(responses(f, 'later')).toHaveLength(1);
  },
);

it.each(['terminal', 'pending', 'deferred'])(
  'uses one failure timestamp for %s retry diagnostics and deadline', async phase => {
    const f = await pendingFixture(1024);
    const cp = checkpoint(f);
    if (phase === 'deferred') {
      cp.deferredTerminals = [{ activeTurn: cp.activeTurn!, pendingTerminal: cp.pendingTerminal! }];
      cp.activeTurn = null; cp.pendingTerminal = null;
    } else if (phase === 'terminal') {
      cp.pendingTerminal = null;
      // Exercise the normal terminal failure branch without relying on an
      // incidental source shape to make conversion fail.
      vi.spyOn(f.probe, 'recoverTurnSegment').mockResolvedValueOnce({
        kind: 'unparseable', entries: [], diagnostics: { sourceRecordCount: 0 },
      });
    }
    f.state.update(key(f), { extra: { codexTranscript: cp } });
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
    await processFile(f);
    const pending = checkpoint(f).deferredTerminals![0]!.pendingTerminal;
    expect(pending.firstPendingAtMs).toBe(pending.lastAttemptAtMs);
    expect(pending.failure!.retryAtMs).toBe(pending.lastAttemptAtMs! + pending.failure!.delayMs);
  },
);

it('recovers a valid legacy terminal directly without creating a deferred range', async () => {
  const f = await fixture(); const text = completed('normal'); await fs.writeFile(f.file, text);
  const stat = await fs.stat(f.file);
  f.state.update(key(f), { extra: { codexTranscript: { inode: stat.ino, scanOffset: stat.size, ownerSessionMetaOffset: 0,
    activeTurn: { turnId: 'normal', startOffset: 0, startedAtMs: Date.parse('2026-01-01T00:00:01Z') },
    pendingTerminal: { turnId: 'normal', terminalEndOffset: stat.size }, pendingFusion: null, pendingSubagent: null } } });
  await processFile(f);
  expect(responses(f, 'normal')).toHaveLength(1);
  expect(checkpoint(f).deferredTerminals ?? []).toEqual([]);
  expect(checkpoint(f).pendingTerminal).toBeNull();
});

import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CodexTranscriptInput } from '../../../../src/inputs/codex-transcript/codex-transcript-input.js';

const roots: string[] = [];
const inputs: CodexTranscriptInput[] = [];
afterEach(async () => {
  for (const input of inputs.splice(0)) await (input as any).onStop();
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-wakeup-scheduling-')); roots.push(root);
  const state = new StateStore(path.join(root, 'state.json'));
  const input = new CodexTranscriptInput({ stateStore: state, sessionDir: root, wakeupDir: path.join(root, 'wakeups') });
  inputs.push(input); return { root, state, input, probe: input as any };
}
async function scheduler() {
  const f = await fixture(); const p = f.probe;
  vi.useFakeTimers(); vi.spyOn(f.input, 'running', 'get').mockReturnValue(true);
  const files = ['a', 'b', 'c'].map(id => ({ filePath: `/sessions/${id}`, baselineOnStart: false }));
  for (const file of files) p.transcriptMetaByPath.set(file.filePath, { threadId: path.basename(file.filePath), depth: 0 });
  const discover = vi.spyOn(p, 'discoverSessionFiles').mockResolvedValue(files);
  vi.spyOn(p, 'cleanupExpiredSpanContexts').mockResolvedValue(undefined);
  vi.spyOn(p, 'indexDiscoveredTranscriptOwners').mockResolvedValue(undefined);
  const process = vi.spyOn(p, 'processFile').mockResolvedValue(0);
  const retry = vi.spyOn(p, 'retryPendingAgentResults').mockResolvedValue(0);
  vi.spyOn(p, 'reportSubagentLinks').mockReturnValue(undefined);
  await p.collect(); discover.mockClear(); process.mockClear(); retry.mockClear();
  const jobs: Promise<unknown>[] = [];
  const request = vi.spyOn(p, 'requestCollection').mockImplementation(() => { jobs.push(p.collect()); });
  return { ...f, discover, process, retry, request, jobs, files };
}

it('merges a sustained burst in a fixed window and visits only dirty known sessions', async () => {
  const f = await scheduler();
  for (let i = 0; i < 1000; i++) f.probe.noteWakeup('a.json');
  f.probe.noteWakeup('b.json'); f.probe.noteWakeup('.a.json.123.tmp'); f.probe.noteWakeup('._a.json');
  await vi.advanceTimersByTimeAsync(199); expect(f.request).not.toHaveBeenCalled();
  f.probe.noteWakeup('a.json'); // This must not push the original deadline back.
  await vi.advanceTimersByTimeAsync(1); await Promise.all(f.jobs);
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.process.mock.calls.map(call => call[0])).toEqual(['/sessions/a', '/sessions/b']);
  expect(f.discover).not.toHaveBeenCalled(); expect(f.retry).not.toHaveBeenCalled();
});

it('keeps notifications while a cycle is busy and retries until collect consumes them', async () => {
  const f = await scheduler(); f.request.mockImplementation(() => {});
  f.probe.noteWakeup('a.json'); await vi.advanceTimersByTimeAsync(600);
  expect(f.probe.dirtyWakeupMarkers.has('a.json')).toBe(true);
  f.request.mockImplementation(() => { f.jobs.push(f.probe.collect()); });
  await vi.advanceTimersByTimeAsync(200); await Promise.all(f.jobs);
  expect(f.process).toHaveBeenCalledWith('/sessions/a');
  expect(f.probe.dirtyWakeupMarkers.size).toBe(0);
});

it('retains same-session updates arriving during collection for a following cycle', async () => {
  const f = await scheduler();
  f.process.mockImplementationOnce(async () => { f.probe.noteWakeup('a.json'); return 0; });
  f.probe.noteWakeup('a.json'); await vi.advanceTimersByTimeAsync(400); await Promise.all(f.jobs);
  expect(f.process.mock.calls.map(call => call[0])).toEqual(['/sessions/a', '/sessions/a']);
});

it('discovers unknown sessions on full polling and also forces full scans under continuous wakeups', async () => {
  const f = await scheduler();
  f.probe.noteWakeup('new.json'); await vi.advanceTimersByTimeAsync(200); await Promise.all(f.jobs);
  expect(f.discover).not.toHaveBeenCalled();
  f.probe.transcriptMetaByPath.set('/sessions/new', { threadId: 'new', depth: 0 });
  f.discover.mockResolvedValue([...f.files, { filePath: '/sessions/new', baselineOnStart: false }]);
  await f.probe.collect(); // Periodic BaseInput timer always requests a full pass.
  expect(f.process).toHaveBeenCalledWith('/sessions/new');
  f.discover.mockClear();
  await vi.advanceTimersByTimeAsync(10000);
  f.probe.noteWakeup('a.json'); await vi.advanceTimersByTimeAsync(200); await Promise.all(f.jobs);
  expect(f.discover).toHaveBeenCalledTimes(1);
});

it('preserves filename-less evidence until a full pass and checks cold files too', async () => {
  const f = await scheduler();
  vi.spyOn(f.probe, 'historicalRolloutSkipPaths').mockReturnValue(new Set(['/sessions/a', '/sessions/b']));
  f.probe.noteWakeup(); await vi.advanceTimersByTimeAsync(200); await Promise.all(f.jobs);
  expect(f.probe.wakeupDiscoveryPending).toBe(true);
  expect(f.discover).not.toHaveBeenCalled();
  await f.probe.collect();
  expect(f.process.mock.calls.map(call => call[0])).toEqual(['/sessions/a', '/sessions/b', '/sessions/c']);
  expect(f.probe.wakeupDiscoveryPending).toBe(false);
});

it('cancels queued wakeups at shutdown', async () => {
  const f = await scheduler(); f.probe.noteWakeup('a.json'); await f.probe.onStop();
  await vi.advanceTimersByTimeAsync(1000); expect(f.request).not.toHaveBeenCalled();
});

it('does not dirty persisted EOF forks, but still saves new ownership evidence', async () => {
  const { root, state, probe } = await fixture();
  const file = path.join(root, 'rollout-fork.jsonl');
  await fs.writeFile(file, JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: {
    id: 'fork', forked_from_id: 'parent', model_provider: 'openai',
  } }) + '\n');
  const stat = await fs.stat(file); const key = `codex-transcript:${file}`;
  state.update(key, { extra: { codexTranscript: { inode: stat.ino, scanOffset: 0, ownerSessionMetaOffset: 0,
    activeTurn: null, pendingTerminal: null, pendingFusion: null, pendingSubagent: null,
    forkBootstrap: { state: 'live-pending', searchOffset: stat.size } } } });
  await probe.processFile(file); await state.save();
  const update = vi.spyOn(state, 'update');
  for (let i = 0; i < 10; i++) { await probe.processFile(file); await state.save(); }
  expect(update).not.toHaveBeenCalled(); expect(state.isPersisted(key)).toBe(true);
  await fs.mkdir(path.join(root, 'wakeups'), { recursive: true });
  await fs.writeFile(path.join(root, 'wakeups/fork.json'), JSON.stringify({ session_id: 'fork', initial_turn_id: 'owned' }));
  await probe.processFile(file);
  expect(update).toHaveBeenCalled();
  expect((state.get(key).extra?.codexTranscript as any).forkBootstrap.initialTurnId).toBe('owned');
});

it('does not create empty delegation state on startup, but persists clearing real state', async () => {
  const { state, probe } = await fixture();
  const update = vi.spyOn(state, 'update');
  probe.saveDelegationState(); await state.save();
  expect(update).not.toHaveBeenCalled();
  probe.deliveredInvocations.add('delivered'); probe.saveDelegationState();
  expect(update).toHaveBeenCalledTimes(1);
  probe.deliveredInvocations.clear(); probe.saveDelegationState();
  expect(update).toHaveBeenCalledTimes(2);
  expect(state.get('codex-transcript').extra?.codexResultInvocations).toEqual([]);
});

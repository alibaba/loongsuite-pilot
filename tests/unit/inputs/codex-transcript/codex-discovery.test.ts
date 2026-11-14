import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CodexTranscriptInput } from '../../../../src/inputs/codex-transcript/codex-transcript-input.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const fixtures: Array<{ root: string; input: CodexTranscriptInput }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { root, input } of fixtures.splice(0)) {
    await input.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-discovery-'));
  const stateStore = new StateStore(path.join(root, 'state.json'));
  await stateStore.load();
  const wakeupDir = path.join(root, 'wakeups');
  const sessionDir = path.join(root, 'default', 'sessions');
  const home = path.join(root, 'custom');
  const input = new CodexTranscriptInput({
    stateStore, sessionDir, wakeupDir, spanContextDir: path.join(root, 'contexts'), pollIntervalMs: 60_000,
  });
  fixtures.push({ root, input });
  const entries: AgentActivityEntry[] = [];
  input.on('entries', batch => entries.push(...batch));
  const collect = () => collectInput(input);
  const ends = () => entries.filter(entry => entry['gen_ai.turn.end'] === true);
  const marker = async (id: string, fields: Record<string, unknown> = {}) => {
    await fs.mkdir(wakeupDir, { recursive: true });
    await fs.writeFile(path.join(wakeupDir, `${id}.json`), JSON.stringify({
      session_id: id, codex_home: home, received_at: new Date().toISOString(), ...fields,
    }));
  };
  return { root, stateStore, input, home, wakeupDir, sessionDir, entries, collect, ends, marker };
}

function turn(id: string, turnId = 'turn-1'): string {
  const record = (type: string, payload: Record<string, unknown>) => JSON.stringify({
    timestamp: '2026-11-11T09:00:00.000Z', type, payload,
  });
  return [
    record('session_meta', { id, model_provider: 'openai' }),
    record('turn_context', { turn_id: turnId, model: 'gpt-test', cwd: '/tmp/project' }),
    record('event_msg', { type: 'task_started', turn_id: turnId }),
    record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
    record('event_msg', { type: 'agent_message', message: 'done', phase: 'final' }),
    record('event_msg', { type: 'token_count', info: { last_token_usage: {
      input_tokens: 10, output_tokens: 2, total_tokens: 12,
    } } }),
    record('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: 'done' }),
  ].join('\n') + '\n';
}

async function rollout(home: string, day: string, id: string, text = '', inactive = false) {
  const file = path.join(home, 'sessions', '2026', '11', day, `rollout-${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  if (inactive) {
    const past = new Date(Date.now() - 16 * 60_000);
    await fs.utimes(file, past, past);
  }
  return file;
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for collected turn');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function collectInput(input: CodexTranscriptInput) {
  const completed = new Promise<void>(resolve => input.once('input-runtime-delta', () => resolve()));
  (input as unknown as { requestCollection(): void }).requestCollection();
  await completed;
}

describe('Codex bounded discovery progress', () => {
  it('collects a resumed old-day session from its actual Hook even beyond the marker and directory caps', async () => {
    const f = await fixture();
    const id = '0000-old';
    const transcript = await rollout(f.home, '01', id, '', true);
    for (let day = 2; day <= 11; day++) await rollout(f.home, String(day).padStart(2, '0'), 'inactive', '', true);
    for (let index = 0; index < 256; index++) await f.marker(`9999-${index}`, { codex_home: undefined });
    await f.input.start();
    await fs.appendFile(transcript, turn(id));
    await f.marker(id, { transcript_path: transcript });
    await waitFor(() => f.ends().length === 1);
    await f.collect();
    expect(f.ends()).toHaveLength(1);
    expect(f.entries.some(entry => entry['event.name'] === 'llm.response')).toBe(true);
    const canonical = await fs.realpath(transcript);
    expect(f.stateStore.get(`codex-transcript:${canonical}`).lastOffset).toBe((await fs.stat(transcript)).size);
  });

  it('recovers a Hook-identified terminal after the rollout has become inactive', async () => {
    const f = await fixture();
    const transcript = await rollout(f.home, '01', 'old', turn('old'), true);
    await f.marker('old', { transcript_path: transcript });
    await f.input.start();
    expect(f.ends()).toHaveLength(1);
    await f.collect();
    expect(f.ends()).toHaveLength(1);
  });

  it('continues legacy directory scans until an older active date is collected', async () => {
    const f = await fixture();
    await rollout(f.home, '01', 'old', turn('old'));
    for (let day = 2; day <= 11; day++) await rollout(f.home, String(day).padStart(2, '0'), 'inactive', '', true);
    await f.marker('old');
    await f.input.start();
    for (let cycle = 0; cycle < 10 && !f.ends().length; cycle++) await f.collect();
    expect(f.ends()).toHaveLength(1);
    expect(f.ends()[0]!['gen_ai.session.id']).toBe('old');
  });

  it.each([
    { count: 256, inactive: true },
    { count: 64, inactive: false },
  ])('continues past $count newer files (inactive=$inactive)', async ({ count, inactive }) => {
    const f = await fixture();
    await rollout(f.home, '11', '0000-old', turn('0000-old'));
    for (let index = 0; index < count; index++) await rollout(f.home, '11', `9999-${index}`, '', inactive);
    await f.marker('0000-old');
    await f.input.start();
    for (let cycle = 0; cycle < 4 && !f.ends().length; cycle++) await f.collect();
    expect(f.ends()).toHaveLength(1);
  });

  it('rotates marker pages both for activation and for legacy collection', async () => {
    const f = await fixture();
    await rollout(f.home, '11', '0000-old', turn('0000-old'));
    await f.marker('0000-old');
    for (let index = 0; index < 256; index++) await f.marker(`9999-${index}`, { codex_home: undefined });
    expect(await CodexTranscriptInput.checkAvailability(f.wakeupDir, f.sessionDir)).toBe(false);
    expect(await CodexTranscriptInput.checkAvailability(f.wakeupDir, f.sessionDir)).toBe(true);
    await f.input.start();
    for (let cycle = 0; cycle < 3 && !f.ends().length; cycle++) await f.collect();
    expect(f.ends()).toHaveLength(1);
  });

  it('gives every root a turn when more than 64 custom homes are active', async () => {
    const f = await fixture();
    for (let index = 0; index < 65; index++) {
      const home = path.join(f.root, `home-${index}`);
      const id = `session-${index}`;
      await rollout(home, '11', id, turn(id));
      await f.marker(id, { codex_home: home });
    }
    await f.input.start();
    for (let cycle = 0; cycle < 4 && f.ends().length < 65; cycle++) await f.collect();
    expect(f.ends()).toHaveLength(65);
    expect(new Set(f.ends().map(entry => entry['gen_ai.session.id'])).size).toBe(65);
  });

  it('bounds explicit-path batches while reserving progress for a legacy root', async () => {
    const f = await fixture();
    for (let index = 0; index < 100; index++) {
      const id = `explicit-${index}`;
      const transcript = await rollout(f.home, '11', id, turn(id), true);
      await f.marker(id, { transcript_path: transcript });
    }
    const legacyHome = path.join(f.root, 'legacy');
    await rollout(legacyHome, '01', 'legacy', turn('legacy'));
    for (let day = 2; day <= 11; day++) await rollout(legacyHome, String(day).padStart(2, '0'), 'inactive', '', true);
    await f.marker('legacy', { codex_home: legacyHome });
    await f.input.start();
    expect(f.ends().length).toBeLessThanOrEqual(64);
    for (let cycle = 0; cycle < 10 && f.ends().length < 101; cycle++) {
      const before = f.ends().length;
      await f.collect();
      expect(f.ends().length - before).toBeLessThanOrEqual(64);
    }
    expect(f.ends()).toHaveLength(101);
    expect(new Set(f.ends().map(entry => entry['gen_ai.session.id'])).size).toBe(101);
  });

  it('keeps a legacy sweep eligible when scanning takes longer than 15 minutes', async () => {
    const f = await fixture();
    await rollout(f.home, '01', 'old', turn('old'));
    for (let day = 2; day <= 20; day++) await rollout(f.home, String(day).padStart(2, '0'), 'inactive', '', true);
    await f.marker('old');
    await f.input.start();
    expect(f.ends()).toHaveLength(0);
    const future = Date.now() + 16 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    for (let cycle = 0; cycle < 15 && !f.ends().length; cycle++) await f.collect();
    expect(f.ends()).toHaveLength(1);
  });

  it('finishes checkpointed legacy turns even after their file ages out of the hot window', async () => {
    const f = await fixture();
    const lines = turn('old').trimEnd().split('\n');
    const terminal = lines.pop()!;
    const transcript = await rollout(f.home, '11', 'old', lines.join('\n') + '\n');
    await f.marker('old');
    await f.input.start();
    expect(f.ends()).toHaveLength(0);
    await fs.appendFile(transcript, terminal + '\n');
    const past = new Date(Date.now() - 16 * 60_000);
    await fs.utimes(transcript, past, past);
    for (let cycle = 0; cycle < 3 && !f.ends().length; cycle++) await f.collect();
    expect(f.ends()).toHaveLength(1);
  });

  it('keeps rotating explicit paths under repeated notifications for a large batch', async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let index = 0; index < 100; index++) {
      const id = `explicit-${index}`;
      ids.push(id);
      const transcript = await rollout(f.home, '11', id, turn(id), true);
      await f.marker(id, { transcript_path: transcript });
    }
    await f.input.start();
    const internal = f.input as unknown as { dirtyWakeupMarkers: Set<string> };
    for (let cycle = 0; cycle < 10 && f.ends().length < 100; cycle++) {
      for (const id of ids) internal.dirtyWakeupMarkers.add(`${id}.json`);
      await f.collect();
    }
    expect(f.ends()).toHaveLength(100);
    expect(new Set(f.ends().map(entry => entry['gen_ai.session.id'])).size).toBe(100);
  });

  it('expires cached Hook evidence rather than extending its lifetime on each poll', async () => {
    const f = await fixture();
    // Expiration cleanup unlinks the marker, which is itself a watcher event.
    // Exercise periodic cache expiry independently of that wakeup fast path.
    vi.spyOn(f.input as unknown as { noteWakeup(name?: string): void }, 'noteWakeup')
      .mockImplementation(() => {});
    const transcript = await rollout(f.home, '11', 'old', turn('old'));
    await f.marker('old', { transcript_path: transcript });
    await f.input.start();
    expect(f.ends()).toHaveLength(1);
    await fs.appendFile(transcript, turn('old', 'turn-2'));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 49 * 60 * 60_000);
    await f.collect();
    expect(f.ends()).toHaveLength(1);
  });

  it('retains the consumed offset across a collector restart', async () => {
    const f = await fixture();
    const transcript = await rollout(f.home, '01', 'old', turn('old'), true);
    await f.marker('old', { transcript_path: transcript });
    await f.input.start();
    expect(f.ends()).toHaveLength(1);
    await f.input.stop();
    const store = new StateStore(path.join(f.root, 'state.json'));
    await store.load();
    const restarted = new CodexTranscriptInput({
      stateStore: store, sessionDir: f.sessionDir, wakeupDir: f.wakeupDir,
      spanContextDir: path.join(f.root, 'contexts'), pollIntervalMs: 60_000,
    });
    const entries: AgentActivityEntry[] = [];
    restarted.on('entries', batch => entries.push(...batch));
    try {
      await restarted.start();
      expect(entries).toHaveLength(0);
      await fs.appendFile(transcript, turn('old', 'turn-2'));
      await collectInput(restarted);
      expect(entries.filter(entry => entry['gen_ai.turn.end'] === true)).toHaveLength(1);
      expect(entries.find(entry => entry['gen_ai.turn.end'] === true)!['gen_ai.turn.id']).toBe('old:turn-2');
    } finally {
      await restarted.stop();
    }
  });

  it('does not follow a date directory replaced with a symlink between walk pages', async () => {
    const f = await fixture();
    for (let day = 1; day <= 20; day++) await rollout(f.home, String(day).padStart(2, '0'), 'inactive', '', true);
    await f.marker('legacy');
    await f.input.start();
    const outsideHome = path.join(f.root, 'outside');
    await rollout(outsideHome, '01', 'outside', turn('outside'));
    const year = path.join(f.home, 'sessions', '2026');
    await fs.rm(year, { recursive: true });
    await fs.symlink(path.join(outsideHome, 'sessions', '2026'), year, 'dir');
    for (let cycle = 0; cycle < 10; cycle++) await f.collect();
    expect(f.entries).toHaveLength(0);
  });

  it.each(['outside-home', 'symlink', 'expired', 'relative'])('rejects an unsafe explicit transcript: %s', async mode => {
    const f = await fixture();
    const outside = await rollout(path.join(f.root, 'outside'), '01', 'old', turn('old'));
    await fs.mkdir(path.join(f.home, 'sessions'), { recursive: true });
    let transcript = outside;
    if (mode === 'symlink') {
      transcript = await rollout(f.home, '01', 'old');
      await fs.rm(transcript);
      await fs.symlink(outside, transcript);
    } else if (mode === 'relative') {
      transcript = path.relative(f.root, outside);
    }
    await f.marker('old', {
      transcript_path: transcript,
      ...(mode === 'expired' ? { codex_home: path.join(f.root, 'outside'),
        received_at: new Date(Date.now() - 49 * 60 * 60_000).toISOString() } : {}),
    });
    await f.input.start();
    await f.collect();
    expect(f.entries).toHaveLength(0);
    expect(f.stateStore.get(`codex-transcript:${await fs.realpath(outside)}`).lastOffset).toBeUndefined();
  });
});

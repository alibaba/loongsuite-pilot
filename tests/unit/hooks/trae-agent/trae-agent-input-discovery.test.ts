import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TraeAgentTrajectoryInput } from '../../../../src/inputs/trae-agent-trajectory/trae-agent-trajectory-input.js';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

// Fixture source: researcher comment fe220457 attachment (52KB), a real trae-agent
// run with qwen-max via DashScope's Anthropic-compatible proxy (15 steps).
const FIXTURE_SRC = path.resolve(__dirname, 'fixtures/fixture_trajectory_qwen_max.json');
const CONVERTER_PATH = path.resolve(__dirname, '../../../../assets/hooks/trae-agent/trajectory-converter.mjs');

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trae-discovery-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function fixtureJson(): Record<string, any> {
  return JSON.parse(fsSync.readFileSync(FIXTURE_SRC, 'utf8'));
}

function retimeFinalizedRun(j: Record<string, any>, startTime?: string): void {
  if (!startTime) return;
  const durationMs = Date.parse(j.end_time) - Date.parse(j.start_time);
  j.start_time = startTime;
  j.end_time = new Date(Date.parse(startTime) + durationMs).toISOString();
}

/** Full 15-step trajectory (=> 58 entries), optionally with a new start_time. */
function full(startTime?: string): string {
  const j = fixtureJson();
  retimeFinalizedRun(j, startTime);
  return JSON.stringify(j, null, 2);
}
/** Trajectory truncated to `n` steps (n req + n resp + n call + n result entries). */
function truncated(n: number, startTime?: string): string {
  const j = fixtureJson();
  j.agent_steps = j.agent_steps.slice(0, n);
  j.llm_interactions = j.llm_interactions.slice(0, n);
  retimeFinalizedRun(j, startTime);
  return JSON.stringify(j, null, 2);
}

/** In-progress trajectory whose finalization fields have not been written yet. */
function inProgress(n: number, startTime: string): string {
  const j = fixtureJson();
  j.agent_steps = j.agent_steps.slice(0, n);
  j.llm_interactions = j.llm_interactions.slice(0, n);
  j.start_time = startTime;
  j.end_time = '';
  j.success = false;
  j.final_result = null;
  j.execution_time = 0;
  return JSON.stringify(j, null, 2);
}

async function newStore(): Promise<StateStore> {
  const store = new StateStore(path.join(tmpDir, `state-${Math.random().toString(36).slice(2)}.json`));
  await store.load();
  return store;
}

describe('TraeAgentTrajectoryInput - P1-1 directory discovery', () => {
  test('polls every trajectory*.json in stable oldest-first order', async () => {
    const dir = path.join(tmpDir, 'trajectories');
    await fs.mkdir(dir, { recursive: true });
    // Two distinct runs are created between polling cycles. The old 3-step run
    // contributes 12 entries and the newer full run contributes 58 entries.
    const oldFile = path.join(dir, 'trajectory_20260101_000000.json');
    const newFile = path.join(dir, 'trajectory_20260102_000000.json');
    await fs.writeFile(oldFile, truncated(3, '2026-08-24T10:00:17.058504'));
    await fs.writeFile(newFile, full('2026-08-25T10:00:17.058504'));
    const now = Date.now();
    await fs.utimes(oldFile, new Date(now - 20_000), new Date(now - 20_000));
    await fs.utimes(newFile, new Date(now), new Date(now));

    const input = new TraeAgentTrajectoryInput({
      stateStore: await newStore(),
      trajectoryFile: dir,
      trajectoryDir: dir,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error: protected
    const out = (await input.collect()) as AgentActivityEntry[];
    expect(out.length).toBe(12 + 58);
    const oldSession = out[0]['gen_ai.session.id'];
    const newSession = out[12]['gen_ai.session.id'];
    expect(newSession).not.toBe(oldSession);
    expect(out.slice(0, 12).every(entry => entry['gen_ai.session.id'] === oldSession)).toBe(true);
    expect(out.slice(12).every(entry => entry['gen_ai.session.id'] === newSession)).toBe(true);
  });

  test('successive runs: a newer timestamped file is discovered on the next cycle', async () => {
    const dir = path.join(tmpDir, 'trajectories');
    await fs.mkdir(dir, { recursive: true });
    const now = Date.now();
    const fileA = path.join(dir, 'trajectory_A.json');
    await fs.writeFile(fileA, full('2026-08-25T10:00:17.058504'));
    await fs.utimes(fileA, new Date(now - 20_000), new Date(now - 20_000));

    const input = new TraeAgentTrajectoryInput({
      stateStore: await newStore(),
      trajectoryFile: dir,
      trajectoryDir: dir,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error: protected
    const a = (await input.collect()) as AgentActivityEntry[];
    expect(a.length).toBe(58);
    const sessionA = a[0]['gen_ai.session.id'];

    // trae-agent's next run writes a NEWER timestamped file (new start_time).
    const fileB = path.join(dir, 'trajectory_B.json');
    await fs.writeFile(fileB, full('2026-08-26T09:00:00.000000'));
    await fs.utimes(fileB, new Date(now), new Date(now));
    // @ts-expect-error: protected
    const b = (await input.collect()) as AgentActivityEntry[];
    // Discovery re-resolved to fileB, and its distinct run identity reset dedup
    // (P1-3) so the whole new run re-emits with a session_reset marker.
    expect(b.length).toBe(58);
    expect(b[0]['gen_ai.session.id']).not.toBe(sessionA);
    expect(b.filter(e => e['agent.trajectory.session_reset'] === true).length).toBe(b.length);
  });

  test('A -> B -> A file order keeps independent per-run dedup checkpoints', async () => {
    const dir = path.join(tmpDir, 'trajectories');
    await fs.mkdir(dir, { recursive: true });
    const fileA = path.join(dir, 'trajectory_A.json');
    const fileB = path.join(dir, 'trajectory_B.json');
    await fs.writeFile(fileA, full('2026-08-25T10:00:17.058504'));
    await fs.writeFile(fileB, full('2026-08-26T10:00:17.058504'));
    const now = Date.now();
    await fs.utimes(fileA, new Date(now - 20_000), new Date(now - 20_000));
    await fs.utimes(fileB, new Date(now - 10_000), new Date(now - 10_000));

    const input = new TraeAgentTrajectoryInput({
      stateStore: await newStore(),
      trajectoryFile: dir,
      trajectoryDir: dir,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // First cycle processes A then B.
    // @ts-expect-error: protected
    const first = (await input.collect()) as AgentActivityEntry[];
    expect(first.length).toBe(58 + 58);

    // Make A newest so the next scan processes B then A. Neither run may emit
    // again: switching between known runs must not clear either seen-step set.
    await fs.utimes(fileA, new Date(now), new Date(now));
    // @ts-expect-error: protected
    const second = (await input.collect()) as AgentActivityEntry[];
    expect(second).toEqual([]);
  });

  test('run identity is a stable digest and never persists raw task content', async () => {
    const dir = path.join(tmpDir, 'trajectories');
    await fs.mkdir(dir, { recursive: true });
    const firstRaw = fixtureJson();
    const secondRaw = fixtureJson();
    firstRaw.task = 'private task alpha with secret-shaped text';
    secondRaw.task = 'private task beta with other sensitive text';
    // Same start time ensures task content participates in the digest.
    secondRaw.start_time = firstRaw.start_time;
    await fs.writeFile(path.join(dir, 'trajectory_A.json'), JSON.stringify(firstRaw));
    await fs.writeFile(path.join(dir, 'trajectory_B.json'), JSON.stringify(secondRaw));
    const store = await newStore();
    const input = new TraeAgentTrajectoryInput({
      stateStore: store,
      trajectoryFile: dir,
      trajectoryDir: dir,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });

    // @ts-expect-error: protected
    const first = (await input.collect()) as AgentActivityEntry[];
    expect(first.length).toBe(58 + 58);
    // @ts-expect-error: protected
    expect(await input.collect()).toEqual([]);
    const extra = store.get('trae-agent-trajectory').extra as Record<string, any>;
    const runIds = Object.keys(extra.runsById);
    expect(runIds).toHaveLength(2);
    expect(new Set(runIds).size).toBe(2);
    expect(runIds.every(runId => /^trajectory-run-v3:[0-9a-f]{32}$/.test(runId))).toBe(true);
    const persisted = JSON.stringify(extra);
    expect(persisted).not.toContain(firstRaw.task);
    expect(persisted).not.toContain(secondRaw.task);
  });

  test('migrates v2 per-run plaintext keys without replay or task persistence', async () => {
    const dir = path.join(tmpDir, 'trajectories');
    await fs.mkdir(dir, { recursive: true });
    const rawA = fixtureJson();
    const rawB = fixtureJson();
    rawB.start_time = '2026-08-26T10:00:17.058504';
    const fileA = path.join(dir, 'trajectory_A.json');
    const fileB = path.join(dir, 'trajectory_B.json');
    await fs.writeFile(fileA, JSON.stringify(rawA));
    await fs.writeFile(fileB, JSON.stringify(rawB));
    const statA = await fs.stat(fileA);
    const statB = await fs.stat(fileB);
    const legacyA = `${rawA.start_time}|${rawA.task}`;
    const legacyB = `${rawB.start_time}|${rawB.task}`;
    const seen = Array.from({ length: 15 }, (_, index) => index + 1);
    const store = await newStore();
    store.set('trae-agent-trajectory', {
      extra: {
        trajectoryStateVersion: 2,
        activeRunId: legacyB,
        runId: legacyB,
        runsById: {
          [legacyA]: { fingerprint: `${statA.ino}:${statA.size}:${statA.mtimeMs}`, seenStepNumbers: seen, runCompletionEmitted: true, lastFile: fileA },
          [legacyB]: { fingerprint: `${statB.ino}:${statB.size}:${statB.mtimeMs}`, seenStepNumbers: seen, runCompletionEmitted: true, lastFile: fileB },
        },
      },
    });
    const input = new TraeAgentTrajectoryInput({
      stateStore: store,
      trajectoryFile: dir,
      trajectoryDir: dir,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });

    // @ts-expect-error: protected
    expect(await input.collect()).toEqual([]);
    const extra = store.get('trae-agent-trajectory').extra as Record<string, any>;
    expect(extra.trajectoryStateVersion).toBe(3);
    expect(Object.keys(extra.runsById)).toHaveLength(2);
    expect(Object.keys(extra.runsById).every(key => /^trajectory-run-v3:[0-9a-f]{32}$/.test(key))).toBe(true);
    expect(JSON.stringify(extra)).not.toContain(rawA.task);
    expect(JSON.stringify(extra)).not.toContain(legacyA);
    expect(JSON.stringify(extra)).not.toContain(legacyB);
  });

  test('ignores files that do not match the trajectory*.json pattern', async () => {
    const dir = path.join(tmpDir, 'trajectories');
    await fs.mkdir(dir, { recursive: true });
    const match = path.join(dir, 'trajectory_keep.json');
    await fs.writeFile(match, truncated(3));            // 12 entries
    // Newer decoys that must NOT be picked: wrong extension + wrong prefix.
    const decoyTxt = path.join(dir, 'notes.txt');
    const decoyPrefix = path.join(dir, 'my_trajectory.json');
    await fs.writeFile(decoyTxt, full());
    await fs.writeFile(decoyPrefix, full());
    const now = Date.now();
    await fs.utimes(match, new Date(now - 20_000), new Date(now - 20_000));
    await fs.utimes(decoyTxt, new Date(now), new Date(now));
    await fs.utimes(decoyPrefix, new Date(now), new Date(now));

    const input = new TraeAgentTrajectoryInput({
      stateStore: await newStore(),
      trajectoryFile: dir,
      trajectoryDir: dir,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error: protected
    const out = (await input.collect()) as AgentActivityEntry[];
    expect(out.length).toBe(12);   // only trajectory_keep.json, decoys ignored
  });

  test('one malformed trajectory does not block other valid files in the same cycle', async () => {
    const dir = path.join(tmpDir, 'trajectories');
    await fs.mkdir(dir, { recursive: true });
    const fileA = path.join(dir, 'trajectory_A.json');
    const badFile = path.join(dir, 'trajectory_B.json');
    const fileC = path.join(dir, 'trajectory_C.json');
    await fs.writeFile(fileA, truncated(3, '2026-08-24T10:00:17.058504'));
    await fs.writeFile(badFile, '{not-json');
    await fs.writeFile(fileC, truncated(3, '2026-08-26T10:00:17.058504'));
    const now = Date.now();
    await fs.utimes(fileA, new Date(now - 30_000), new Date(now - 30_000));
    await fs.utimes(badFile, new Date(now - 20_000), new Date(now - 20_000));
    await fs.utimes(fileC, new Date(now - 10_000), new Date(now - 10_000));

    const input = new TraeAgentTrajectoryInput({
      stateStore: await newStore(),
      trajectoryFile: dir,
      trajectoryDir: dir,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error: protected
    const out = (await input.collect()) as AgentActivityEntry[];
    expect(out.length).toBe(12 + 12);
    expect(new Set(out.map(entry => entry['gen_ai.session.id'])).size).toBe(2);
  });

  test('no matching file in the directory produces no entries (no crash)', async () => {
    const dir = path.join(tmpDir, 'trajectories');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
    const input = new TraeAgentTrajectoryInput({
      stateStore: await newStore(),
      trajectoryFile: dir,
      trajectoryDir: dir,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error: protected
    const out = (await input.collect()) as AgentActivityEntry[];
    expect(out).toEqual([]);
  });

  test('a missing directory produces no entries (no crash)', async () => {
    const dir = path.join(tmpDir, 'does-not-exist');
    const input = new TraeAgentTrajectoryInput({
      stateStore: await newStore(),
      trajectoryFile: dir,
      trajectoryDir: dir,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error: protected
    const out = (await input.collect()) as AgentActivityEntry[];
    expect(out).toEqual([]);
  });
});

describe('TraeAgentTrajectoryInput - P1-3 run identity reset (same path)', () => {
  test('closes an unfinished old run before a new run overwrites the same file', async () => {
    const file = path.join(tmpDir, 'trajectory.json');
    await fs.writeFile(file, inProgress(3, '2026-08-25T10:00:17.058504'));
    const store = await newStore();
    const input = new TraeAgentTrajectoryInput({
      stateStore: store,
      trajectoryFile: file,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });

    // @ts-expect-error: protected
    const first = (await input.collect()) as AgentActivityEntry[];
    const firstSession = first[0]['gen_ai.session.id'];
    expect(first).toHaveLength(12);
    expect(first.some(entry => entry['gen_ai.turn.end'] === true)).toBe(false);

    await fs.writeFile(file, full('2026-08-26T10:00:17.058504'));
    // @ts-expect-error: protected
    const second = (await input.collect()) as AgentActivityEntry[];
    const replacementMarkers = second.filter(entry =>
      entry['agent.trajectory.flush_only'] === true
      && entry['agent.trajectory.completion.reason'] === 'source_replaced');
    expect(replacementMarkers).toHaveLength(1);
    expect(replacementMarkers[0]).toMatchObject({
      'event.name': 'other',
      'gen_ai.session.id': firstSession,
      'gen_ai.turn.id': firstSession,
      'gen_ai.turn.end': true,
      'agent.trajectory.collection.incomplete': true,
    });
    const currentRunEntries = second.filter(entry => entry['gen_ai.session.id'] !== firstSession);
    expect(currentRunEntries).toHaveLength(58);

    // @ts-expect-error: protected
    expect(await input.collect()).toEqual([]);
    const extra = store.get('trae-agent-trajectory').extra as Record<string, any>;
    expect(Object.keys(extra.runsById)).toHaveLength(1);
    expect(Object.values(extra.runsById)[0]).toMatchObject({ runCompletionEmitted: true });
  });

  test('a new run reusing the same file (same inode, same size) resets dedup', async () => {
    // trae-agent rewrites its trajectory via open(path, "w"): inode stays stable
    // and a new run can present an equal-or-larger file, so the size-shrink /
    // inode-change truncation heuristic alone would keep the previous run's
    // seenStepNumbers and silently drop the new run's same-numbered steps.
    const file = path.join(tmpDir, 'trajectory.json');
    await fs.writeFile(file, full('2026-08-25T10:00:17.058504'));
    const input = new TraeAgentTrajectoryInput({
      stateStore: await newStore(),
      trajectoryFile: file,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error: protected
    const first = (await input.collect()) as AgentActivityEntry[];
    expect(first.length).toBe(58);
    const session1 = first[0]['gen_ai.session.id'];

    // Run 2: SAME path, SAME inode (writeFile truncates in place), SAME size
    // (start_time swapped for an equal-length string). Only the run identity can
    // distinguish it, so a full re-emit here proves the P1-3 reset fired.
    const before = fsSync.statSync(file);
    await fs.writeFile(file, full('2026-08-26T10:00:17.058504'));
    const after = fsSync.statSync(file);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);

    // @ts-expect-error: protected
    const second = (await input.collect()) as AgentActivityEntry[];
    expect(second.length).toBe(58);   // NOT suppressed to 0 by the stale seen set
    expect(second.filter(e => e['agent.trajectory.session_reset'] === true).length).toBe(second.length);
    expect(second[0]['gen_ai.session.id']).not.toBe(session1);
  });

  test('re-polling the SAME unchanged run stays suppressed (no spurious reset)', async () => {
    // Guard against the reset firing on every poll: identical content => identical
    // run identity => seenStepNumbers persist => nothing re-emits.
    const file = path.join(tmpDir, 'trajectory.json');
    await fs.writeFile(file, full());
    const input = new TraeAgentTrajectoryInput({
      stateStore: await newStore(),
      trajectoryFile: file,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error: protected
    const first = (await input.collect()) as AgentActivityEntry[];
    expect(first.length).toBe(58);
    // @ts-expect-error: protected
    const second = (await input.collect()) as AgentActivityEntry[];
    expect(second.length).toBe(0);
  });
});

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
/** Full 15-step trajectory (=> 58 entries), optionally with a new start_time. */
function full(startTime?: string): string {
  const j = fixtureJson();
  if (startTime) j.start_time = startTime;
  return JSON.stringify(j, null, 2);
}
/** Trajectory truncated to `n` steps (n req + n resp + n call + n result entries). */
function truncated(n: number, startTime?: string): string {
  const j = fixtureJson();
  j.agent_steps = j.agent_steps.slice(0, n);
  j.llm_interactions = j.llm_interactions.slice(0, n);
  if (startTime) j.start_time = startTime;
  return JSON.stringify(j, null, 2);
}

async function newStore(): Promise<StateStore> {
  const store = new StateStore(path.join(tmpDir, `state-${Math.random().toString(36).slice(2)}.json`));
  await store.load();
  return store;
}

describe('TraeAgentTrajectoryInput - P1-1 directory discovery', () => {
  test('polls the newest trajectory*.json in the configured directory', async () => {
    const dir = path.join(tmpDir, 'trajectories');
    await fs.mkdir(dir, { recursive: true });
    // old file = 3-step truncation (12 entries); new file = full fixture (58).
    const oldFile = path.join(dir, 'trajectory_20260101_000000.json');
    const newFile = path.join(dir, 'trajectory_20260102_000000.json');
    await fs.writeFile(oldFile, truncated(3));
    await fs.writeFile(newFile, full());
    const now = Date.now();
    await fs.utimes(oldFile, new Date(now - 20_000), new Date(now - 20_000));
    await fs.utimes(newFile, new Date(now), new Date(now));

    // trajectoryFile is the DIRECTORY (mirrors the orchestrator wiring): if
    // discovery were broken and fell back to it, stat(dir).isFile() is false and
    // collect() would return [] — so 58 entries proves discovery picked newFile.
    const input = new TraeAgentTrajectoryInput({
      stateStore: await newStore(),
      trajectoryFile: dir,
      trajectoryDir: dir,
      converterPath: CONVERTER_PATH,
      pollIntervalMs: 1000,
    });
    // @ts-expect-error: protected
    const out = (await input.collect()) as AgentActivityEntry[];
    expect(out.length).toBe(58);
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

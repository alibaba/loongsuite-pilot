import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CodexTranscriptInput } from '../../../../src/inputs/codex-transcript/codex-transcript-input.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const tempDirs: string[] = [];
afterEach(async () => {
  vi.mocked(fs.readdir).mockClear();
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

it.each(['root', 'leaf'])('rediscovers a rollout published during a %s directory scan', async level => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-discovery-race-'));
  tempDirs.push(root);
  const sessionDir = path.join(root, 'sessions');
  const leaf = path.join(sessionDir, '2026', '06', '24');
  const scannedDir = level === 'root' ? sessionDir : leaf;
  await fs.mkdir(scannedDir, { recursive: true });
  const oldAt = new Date('2026-01-01T00:00:00.000Z');
  await fs.utimes(scannedDir, oldAt, oldAt);
  const transcript = path.join(leaf, 'rollout-new.jsonl');
  const stateStore = new StateStore(path.join(root, 'input-state.json'));
  const input = new CodexTranscriptInput({ stateStore, sessionDir });
  const listFiles = () => (input as unknown as {
    listDefaultRolloutFiles(): Promise<string[]>;
  }).listDefaultRolloutFiles();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let published = false;
  vi.mocked(fs.readdir).mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
    const snapshot = await actual.readdir(...args);
    if (String(args[0]) === scannedDir && !published) {
      published = true;
      // Publish after readdir's snapshot but before the caller can stat the
      // directory. The old cache records the new mtime with the old listing.
      await fs.mkdir(leaf, { recursive: true });
      await fs.writeFile(transcript, '{}\n');
      await fs.utimes(scannedDir, new Date(), new Date());
    }
    return snapshot;
  }) as typeof fs.readdir);

  expect(await listFiles()).toEqual([]);
  expect(published).toBe(true);
  expect(await listFiles()).toEqual([transcript]);
  // Preserve the idle optimization once a coherent listing is cached.
  const reads = vi.mocked(fs.readdir).mock.calls.length;
  expect(await listFiles()).toEqual([transcript]);
  expect(vi.mocked(fs.readdir).mock.calls.length).toBe(reads);
});

it.each(['root', 'leaf'])('retries a failed %s scan without requiring a directory mtime change', async level => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-discovery-failure-'));
  tempDirs.push(root);
  const sessionDir = path.join(root, 'sessions');
  const leaf = path.join(sessionDir, '2026', '06', '24');
  await fs.mkdir(leaf, { recursive: true });
  const transcript = path.join(leaf, 'rollout-existing.jsonl');
  await fs.writeFile(transcript, '{}\n');
  const input = new CodexTranscriptInput({ stateStore: new StateStore(path.join(root, 'state.json')), sessionDir });
  const list = () => (input as any).listDefaultRolloutFiles();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let fail = true;
  vi.mocked(fs.readdir).mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
    if (String(args[0]) === (level === 'root' ? sessionDir : leaf) && fail) {
      fail = false;
      throw Object.assign(new Error('temporary enumeration failure'), { code: 'EMFILE' });
    }
    return actual.readdir(...args);
  }) as typeof fs.readdir);
  expect(await list()).toEqual([]);
  expect((input as any).cachedDefaultRollout).toBeNull();
  expect(await list()).toEqual([transcript]);
  const reads = vi.mocked(fs.readdir).mock.calls.length;
  expect(await list()).toEqual([transcript]);
  expect(vi.mocked(fs.readdir).mock.calls.length).toBe(reads);
});

it('invalidates a cached rollout listing when a directory is replaced with the same mtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-directory-replacement-'));
  tempDirs.push(root);
  const sessionDir = path.join(root, 'sessions');
  const leaf = path.join(sessionDir, 'day');
  const stamp = new Date('2026-01-01T00:00:00.000Z');
  await fs.mkdir(leaf, { recursive: true });
  const oldRollout = path.join(leaf, 'rollout-original.jsonl');
  await fs.writeFile(oldRollout, '{}\n');
  await fs.utimes(leaf, stamp, stamp);
  await fs.utimes(sessionDir, stamp, stamp);
  const original = await fs.stat(leaf);

  const input = new CodexTranscriptInput({ stateStore: new StateStore(path.join(root, 'state.json')), sessionDir });
  const listFiles = () => (input as unknown as { listDefaultRolloutFiles(): Promise<string[]> }).listDefaultRolloutFiles();
  expect(await listFiles()).toEqual([oldRollout]);

  await fs.rename(leaf, path.join(root, 'previous-day'));
  await fs.mkdir(leaf);
  const newRollout = path.join(leaf, 'rollout-replacement.jsonl');
  await fs.writeFile(newRollout, '{}\n');
  await fs.utimes(leaf, stamp, stamp);
  await fs.utimes(sessionDir, stamp, stamp);
  const replacement = await fs.stat(leaf);
  expect(replacement.ino).not.toBe(original.ino);
  expect(replacement.mtimeMs).toBe(original.mtimeMs);

  expect(await listFiles()).toEqual([newRollout]);
});

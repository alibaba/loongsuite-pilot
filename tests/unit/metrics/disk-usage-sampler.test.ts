import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import type { Dir, Dirent, Stats } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DiskUsageSampler, DISK_USAGE_STALE_MS } from '../../../src/metrics/disk-usage-sampler.js';
import type { DiskUsageSamplerOptions } from '../../../src/metrics/disk-usage-sampler.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath), lstat: vi.fn(actual.lstat), opendir: vi.fn(actual.opendir) };
});
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }),
}));
// Fake timers replace the global clock, but not node:perf_hooks' export.
vi.mock('node:perf_hooks', () => ({ performance: { now: () => Date.now() } }));

type Operation = 'realpath' | 'lstat' | 'opendir' | 'read' | 'close';
const root = path.resolve(os.tmpdir(), 'pilot-disk-sampler-fixture');

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function metadata(kind: 'file' | 'directory' | 'link', size = 0, ino = 1): Stats {
  return {
    size, ino, dev: 1,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'link',
  } as Stats;
}

function installTree(files: Record<string, number> = {}, directories: string[] = []) {
  const nodes = new Map<string, Stats>([[root, metadata('directory')]]);
  const names = new Map<string, string[]>([[root, []]]);
  const opened: { path: string; closed: boolean; reads: number }[] = [];
  const calls: { operation: Operation; path: string }[] = [];
  let active = 0;
  let maxActive = 0;
  let maxHandles = 0;
  const hooks: { before?: (operation: Operation, filePath: string) => void | Promise<void> } = {};
  const addDirectory = (directory: string): void => {
    if (nodes.has(directory)) return;
    addDirectory(path.dirname(directory));
    nodes.set(directory, metadata('directory', 0, nodes.size + 1));
    names.set(directory, []);
    names.get(path.dirname(directory))!.push(path.basename(directory));
  };
  for (const directory of directories) addDirectory(path.join(root, directory));
  for (const [file, size] of Object.entries(files)) {
    const filePath = path.join(root, file);
    addDirectory(path.dirname(filePath));
    nodes.set(filePath, metadata('file', size, nodes.size + 1));
    names.get(path.dirname(filePath))!.push(path.basename(filePath));
  }
  const request = async <T>(operation: Operation, filePath: string, body: () => T): Promise<T> => {
    calls.push({ operation, path: filePath });
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await hooks.before?.(operation, filePath);
      return body();
    } finally {
      active--;
    }
  };
  vi.mocked(fs.realpath).mockImplementation(async file => request('realpath', String(file), () => String(file)));
  vi.mocked(fs.lstat).mockImplementation(async file => request('lstat', String(file), () => {
    const stat = nodes.get(String(file));
    if (!stat) throw codedError('ENOENT');
    return stat;
  }));
  vi.mocked(fs.opendir).mockImplementation(async file => request('opendir', String(file), () => {
    const state = { path: String(file), closed: false, reads: 0 };
    opened.push(state);
    maxHandles = Math.max(maxHandles, opened.filter(dir => !dir.closed).length);
    const entries = [...(names.get(String(file)) ?? [])].map(name => {
      const stat = nodes.get(path.join(String(file), name))!;
      return { name, isSymbolicLink: () => stat.isSymbolicLink() } as Dirent;
    });
    return {
      read: () => request('read', state.path, () => {
        state.reads++;
        return entries.shift() ?? null;
      }),
      close: () => request('close', state.path, () => { state.closed = true; }),
    } as unknown as Dir;
  }));
  return { nodes, opened, calls, hooks, maxActive: () => maxActive, maxHandles: () => maxHandles };
}

describe('DiskUsageSampler', () => {
  const samplers: DiskUsageSampler[] = [];
  function sampler(options: Partial<DiskUsageSamplerOptions> = {}): DiskUsageSampler {
    const instance = new DiskUsageSampler({ dataDir: root, ...options });
    samplers.push(instance);
    return instance;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T00:00:00Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const instance of samplers.splice(0)) instance.stop();
    vi.useRealTimers();
  });

  it('starts pending and counts ordinary files, hidden files and only the root logs subtree', async () => {
    const tree = installTree({ '.hidden': 3, 'logs/output/a.jsonl': 7, 'local-workers/logs/b': 11, 'versions/v/a': 13 });
    const onSample = vi.fn();
    const instance = sampler({ onSample });
    expect(instance.getSnapshot()).toEqual({ status: 'pending' });
    await instance.sample();
    expect(instance.getSnapshot()).toMatchObject({ status: 'ok', dataBytes: 34, logsBytes: 7, sampledAt: Date.now() });
    expect(tree.maxActive()).toBe(1);
    expect(tree.opened.every(dir => dir.closed)).toBe(true);
    expect(fs.opendir).toHaveBeenCalledWith(root, { bufferSize: 1 });
    instance.getSnapshot();
    instance.getSnapshot();
    expect(onSample).toHaveBeenCalledTimes(1);
  });

  it('reports a valid empty directory as zero and returns a copy of cached state', async () => {
    installTree();
    const instance = sampler();
    await instance.sample();
    const snapshot = instance.getSnapshot();
    expect(snapshot).toMatchObject({ status: 'ok', dataBytes: 0, logsBytes: 0 });
    snapshot.dataBytes = 999;
    expect(instance.getSnapshot().dataBytes).toBe(0);
  });

  it('does not follow links or junctions, including links substituted after readdir', async () => {
    const tree = installTree({ 'ordinary': 5, 'cached-link': 99, 'new-link': 88 }, ['linked-directory']);
    tree.nodes.set(path.join(root, 'cached-link'), metadata('link'));
    tree.nodes.set(path.join(root, 'linked-directory'), metadata('link'));
    tree.hooks.before = (operation, filePath) => {
      if (operation === 'lstat' && filePath === path.join(root, 'new-link')) {
        tree.nodes.set(filePath, metadata('link'));
      }
    };
    const instance = sampler();
    await instance.sample();
    expect(instance.getSnapshot()).toMatchObject({ status: 'ok', dataBytes: 5 });
    expect(tree.opened).toHaveLength(1);
  });

  it('rejects a directory replaced by a link while opening before reading its entries', async () => {
    const tree = installTree({ 'child/a': 99 });
    const child = path.join(root, 'child');
    tree.hooks.before = (operation, filePath) => {
      if (operation === 'opendir' && filePath === child) tree.nodes.set(child, metadata('link'));
    };
    const instance = sampler();
    await instance.sample();
    expect(instance.getSnapshot()).toMatchObject({ status: 'partial' });
    expect(instance.getSnapshot().dataBytes).toBeUndefined();
    expect(tree.opened.find(dir => dir.path === child)?.reads).toBe(0);
    expect(tree.opened.every(dir => dir.closed)).toBe(true);
  });

  it('rejects ancestor replacement detected at a nested open boundary', async () => {
    const tree = installTree({ 'parent/child/a': 99 });
    const child = path.join(root, 'parent', 'child');
    const original = vi.mocked(fs.realpath).getMockImplementation()!;
    vi.mocked(fs.realpath).mockImplementation(async file => String(file) === child
      ? path.resolve(root, '..', 'outside', 'child')
      : original(file));
    const instance = sampler();
    await instance.sample();
    expect(instance.getSnapshot().status).toBe('partial');
    expect(tree.opened.some(dir => dir.path === child)).toBe(false);
  });

  it('skips child files and unopened directories that vanish during lstat without spinning', async () => {
    const tree = installTree({ 'vanished': 99, 'remaining': 7 }, ['deleted-directory']);
    tree.hooks.before = (operation, filePath) => {
      if (operation === 'lstat' && filePath === path.join(root, 'vanished')) tree.nodes.delete(filePath);
      if (operation === 'lstat' && filePath === path.join(root, 'deleted-directory')) {
        tree.nodes.delete(filePath);
      }
    };
    const instance = sampler();
    await instance.sample();
    expect(instance.getSnapshot()).toMatchObject({ status: 'ok', dataBytes: 7 });
    expect(tree.opened.every(dir => dir.closed)).toBe(true);
    expect(tree.calls.length).toBeLessThan(50);
  });

  it('reports partial without values when read returns ENOENT but its directory still exists', async () => {
    const tree = installTree({ 'a': 7, 'b': 9 });
    let reads = 0;
    tree.hooks.before = operation => {
      if (operation === 'read' && ++reads === 2) throw codedError('ENOENT');
    };
    const instance = sampler();
    await instance.sample();
    expect(instance.getSnapshot()).toEqual({ status: 'partial', scanMs: expect.any(Number) });
    expect(reads).toBe(2);
    expect(tree.nodes.has(root)).toBe(true);
    expect(tree.opened.every(dir => dir.closed)).toBe(true);
  });

  it('retains the complete snapshot when a later read loses buffered entries with ENOENT', async () => {
    const tree = installTree({ 'a': 7, 'b': 9 });
    const onSample = vi.fn();
    const instance = sampler({ onSample });
    await instance.sample();
    const complete = instance.getSnapshot();
    await vi.advanceTimersByTimeAsync(100);
    let reads = 0;
    tree.hooks.before = operation => {
      if (operation === 'read' && ++reads === 2) throw codedError('ENOENT');
    };
    await instance.sample();
    expect(instance.getSnapshot()).toMatchObject({
      status: 'partial', dataBytes: 16, logsBytes: 0, sampledAt: complete.sampledAt,
    });
    expect(onSample).toHaveBeenCalledTimes(2);
    expect(onSample.mock.calls[1][0].status).toBe('partial');
    expect(reads).toBe(2);
    expect(tree.opened.every(dir => dir.closed)).toBe(true);
  });

  it('keeps complete values and timestamps on permission errors; explicit failure outranks stale', async () => {
    const tree = installTree({ 'a': 7 });
    const instance = sampler();
    await instance.sample();
    const successful = instance.getSnapshot();
    await vi.advanceTimersByTimeAsync(DISK_USAGE_STALE_MS + 1);
    expect(instance.getSnapshot().status).toBe('stale');
    tree.hooks.before = (operation, filePath) => {
      if (operation === 'lstat' && filePath === path.join(root, 'a')) throw codedError('EACCES');
    };
    await instance.sample();
    expect(instance.getSnapshot()).toMatchObject({
      status: 'partial', dataBytes: 7, sampledAt: successful.sampledAt,
    });
  });

  it('reports root failures as error without inventing zero values', async () => {
    const tree = installTree();
    tree.hooks.before = operation => {
      if (operation === 'opendir') throw codedError('EACCES');
    };
    const onSample = vi.fn();
    const instance = sampler({ onSample });
    await instance.sample();
    expect(instance.getSnapshot()).toEqual({ status: 'error', scanMs: expect.any(Number) });
    expect(onSample).toHaveBeenCalledTimes(1);
  });

  it('does not report a disappearing root as a successful empty directory', async () => {
    const tree = installTree();
    tree.hooks.before = operation => {
      if (operation === 'read') {
        tree.nodes.delete(root);
        throw codedError('ENOENT');
      }
    };
    const instance = sampler();
    await instance.sample();
    expect(instance.getSnapshot()).toMatchObject({ status: 'error' });
    expect(instance.getSnapshot().dataBytes).toBeUndefined();
    expect(tree.opened.every(dir => dir.closed)).toBe(true);
  });

  it('bounds item count and open handles, never publishing partial sums', async () => {
    const tree = installTree({ 'one': 1, 'two': 2, 'three': 3 });
    const instance = sampler({ maxEntries: 2 });
    await instance.sample();
    expect(instance.getSnapshot().status).toBe('partial');
    expect(instance.getSnapshot().dataBytes).toBeUndefined();
    expect(tree.opened[0].reads).toBe(2);
    expect(tree.opened.every(dir => dir.closed)).toBe(true);
  });

  it('never opens more than 32 directory layers', async () => {
    const tree = installTree({ [`${Array.from({ length: 35 }, (_, i) => `d${i}`).join('/')}/file`]: 9 });
    const instance = sampler();
    await instance.sample();
    expect(instance.getSnapshot().status).toBe('partial');
    expect(tree.maxHandles()).toBe(32);
    expect(tree.opened.every(dir => dir.closed)).toBe(true);
  });

  it('rests after every 100 entries and includes that rest in elapsed time', async () => {
    const tree = installTree(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, 1])));
    const onSample = vi.fn();
    const instance = sampler({ onSample });
    const pending = instance.sample();
    await vi.advanceTimersByTimeAsync(19);
    expect(onSample).not.toHaveBeenCalled();
    expect(tree.opened[0].reads).toBe(100);
    await vi.advanceTimersByTimeAsync(21);
    await pending;
    expect(instance.getSnapshot()).toMatchObject({ status: 'ok', dataBytes: 201, scanMs: 40 });
    expect(tree.maxActive()).toBe(1);
  });

  it('times out during a batch pause, closes handles and retains the last complete value', async () => {
    installTree({ 'a': 7 });
    const instance = sampler({ batchSize: 2, batchPauseMs: 20, budgetMs: 10 });
    await instance.sample();
    const successful = instance.getSnapshot();
    const tree = installTree({ 'a': 7, 'b': 9 });
    const pending = instance.sample();
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(instance.getSnapshot()).toMatchObject({ status: 'timeout', dataBytes: 7, sampledAt: successful.sampledAt });
    expect(tree.opened.every(dir => dir.closed)).toBe(true);
  });

  it('checks the budget after slow IO and closes a late-opened handle without reading it', async () => {
    const tree = installTree({ 'a': 7 });
    tree.hooks.before = async operation => {
      if (operation === 'opendir') await new Promise(resolve => setTimeout(resolve, 60));
    };
    const instance = sampler({ budgetMs: 50 });
    const pending = instance.sample();
    await vi.advanceTimersByTimeAsync(60);
    await pending;
    expect(instance.getSnapshot().status).toBe('timeout');
    expect(tree.opened[0]).toMatchObject({ closed: true, reads: 0 });
    expect(tree.calls.at(-1)?.operation).toBe('close');
  });

  it('preserves timeout when a slow directory read exceeds the budget', async () => {
    const tree = installTree({ 'a': 7 });
    tree.hooks.before = async operation => {
      if (operation === 'read') await new Promise(resolve => setTimeout(resolve, 60));
    };
    const instance = sampler({ budgetMs: 50 });
    const pending = instance.sample();
    await vi.advanceTimersByTimeAsync(60);
    await pending;
    expect(instance.getSnapshot().status).toBe('timeout');
    expect(instance.getSnapshot().dataBytes).toBeUndefined();
    expect(tree.opened[0]).toMatchObject({ closed: true, reads: 1 });
    expect(tree.calls.at(-1)?.operation).toBe('close');
  });

  it('publishes a complete sample when the final handle close crosses the budget', async () => {
    const tree = installTree({ 'a': 7 });
    tree.hooks.before = async operation => {
      if (operation === 'close') await new Promise(resolve => setTimeout(resolve, 60));
    };
    const instance = sampler({ budgetMs: 50 });
    const pending = instance.sample();
    await vi.advanceTimersByTimeAsync(60);
    await pending;
    expect(instance.getSnapshot()).toMatchObject({
      status: 'ok', dataBytes: 7, logsBytes: 0, scanMs: 60,
    });
    expect(tree.opened.every(dir => dir.closed)).toBe(true);
    expect(tree.calls.at(-1)?.operation).toBe('close');
  });

  it('does not treat a close error as a complete sample', async () => {
    const tree = installTree();
    let failures = 0;
    tree.hooks.before = operation => {
      if (operation === 'close' && failures++ === 0) throw codedError('EIO');
    };
    const instance = sampler();
    await instance.sample();
    expect(instance.getSnapshot().status).toBe('partial');
    expect(instance.getSnapshot().dataBytes).toBeUndefined();
    expect(tree.opened.every(dir => dir.closed)).toBe(true);
  });

  it('starts after 30 seconds, uses a 10-minute cadence, and ignores duplicate start', async () => {
    installTree({ 'a': 7 });
    const onSample = vi.fn();
    const instance = sampler({ onSample });
    instance.start();
    instance.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fs.realpath).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSample).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onSample).toHaveBeenCalledTimes(2);
    instance.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onSample).toHaveBeenCalledTimes(2);
  });

  it('backs off after two failures to 20/40/60 minutes and recovers to 10 minutes', async () => {
    const tree = installTree();
    let fail = true;
    tree.hooks.before = operation => {
      if (fail && operation === 'opendir') throw codedError('EACCES');
    };
    const onSample = vi.fn();
    const instance = sampler({ onSample, initialDelayMs: 0 });
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onSample).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onSample).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onSample).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3 * 600_000);
    expect(onSample).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onSample).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5 * 600_000);
    expect(onSample).toHaveBeenCalledTimes(4);
    fail = false;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onSample).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onSample).toHaveBeenCalledTimes(6);
  });

  it('does not overlap slow scans or enqueue missed attempts', async () => {
    const tree = installTree();
    let release: (() => void) | undefined;
    tree.hooks.before = operation => {
      if (operation === 'opendir') return new Promise<void>(resolve => { release = resolve; });
    };
    const onSample = vi.fn();
    const instance = sampler({ onSample, initialDelayMs: 0, intervalMs: 10, budgetMs: 1000 });
    instance.start();
    await vi.advanceTimersByTimeAsync(50);
    const sameAttempt = instance.sample();
    expect(fs.opendir).toHaveBeenCalledTimes(1);
    tree.hooks.before = undefined;
    release!();
    await sameAttempt;
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(tree.maxActive()).toBe(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(onSample).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onSample).toHaveBeenCalledTimes(2);
  });

  it('stop cancels batch waits and discards results without further reads or callbacks', async () => {
    const tree = installTree({ 'a': 7, 'b': 9 });
    const onSample = vi.fn();
    const instance = sampler({ onSample, batchSize: 1, batchPauseMs: 20 });
    const pending = instance.sample();
    await vi.advanceTimersByTimeAsync(0);
    instance.stop();
    await pending;
    expect(tree.opened[0]).toMatchObject({ reads: 1, closed: true });
    expect(instance.getSnapshot()).toEqual({ status: 'pending' });
    expect(onSample).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop waits for outstanding IO before closing its handle, and restart cannot revive old work', async () => {
    const tree = installTree();
    let release: (() => void) | undefined;
    tree.hooks.before = operation => {
      if (operation === 'read') return new Promise<void>(resolve => { release = resolve; });
    };
    const onSample = vi.fn();
    const instance = sampler({ onSample });
    const pending = instance.sample();
    await vi.advanceTimersByTimeAsync(0);
    instance.stop();
    instance.start();
    release!();
    await pending;
    expect(tree.opened[0].closed).toBe(true);
    expect(tree.maxActive()).toBe(1);
    expect(onSample).not.toHaveBeenCalled();
    tree.hooks.before = undefined;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onSample).toHaveBeenCalledTimes(1);
  });

  it('starts the new generation immediately when an old scan settles after its restart tick', async () => {
    const tree = installTree({ 'a': 7 });
    let releaseOldRead: (() => void) | undefined;
    tree.hooks.before = operation => {
      if (operation === 'read') return new Promise<void>(resolve => { releaseOldRead = resolve; });
    };
    let resolveFreshSample: (() => void) | undefined;
    const freshSample = new Promise<void>(resolve => { resolveFreshSample = resolve; });
    const onSample = vi.fn(() => resolveFreshSample!());
    const instance = sampler({ onSample });
    const oldAttempt = instance.sample();
    await vi.advanceTimersByTimeAsync(0);
    instance.stop();
    instance.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fs.opendir).toHaveBeenCalledTimes(1);
    tree.hooks.before = undefined;
    releaseOldRead!();
    await Promise.all([oldAttempt, freshSample]);
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(instance.getSnapshot()).toMatchObject({ status: 'ok', dataBytes: 7, logsBytes: 0 });
    expect(fs.opendir).toHaveBeenCalledTimes(2);
    expect(tree.maxActive()).toBe(1);
  });

  it('isolates a throwing consumer callback from later sampling', async () => {
    installTree({ 'a': 7 });
    const instance = sampler({ onSample: () => { throw new Error('consumer failed'); } });
    await expect(instance.sample()).resolves.toBeUndefined();
    await expect(instance.sample()).resolves.toBeUndefined();
    expect(instance.getSnapshot().status).toBe('ok');
  });

  it('also counts a real temporary tree through native Node directory handles', async () => {
    vi.useRealTimers();
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.realpath).mockImplementation(actual.realpath);
    vi.mocked(fs.lstat).mockImplementation(actual.lstat);
    vi.mocked(fs.opendir).mockImplementation(actual.opendir);
    const directory = syncFs.mkdtempSync(path.join(os.tmpdir(), 'pilot-disk-native-'));
    try {
      syncFs.mkdirSync(path.join(directory, 'logs'));
      syncFs.writeFileSync(path.join(directory, '.hidden'), '123');
      syncFs.writeFileSync(path.join(directory, 'logs', 'events.jsonl'), '1234567');
      syncFs.symlinkSync(path.join(directory, 'logs'), path.join(directory, 'linked-logs'), 'junction');
      const instance = sampler({ dataDir: directory });
      await instance.sample();
      expect(instance.getSnapshot()).toMatchObject({ status: 'ok', dataBytes: 10, logsBytes: 7 });
    } finally {
      syncFs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

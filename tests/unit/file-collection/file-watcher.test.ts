import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileWatcher, extractParentDirs } from '../../../src/file-collection/file-watcher.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-watcher-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FileWatcher', () => {
  it('marks files as dirty when fs.watch fires', async () => {
    const watcher = new FileWatcher();
    watcher.watch([tmpDir]);

    fs.writeFileSync(path.join(tmpDir, 'test.log'), 'hello\n');

    await new Promise((r) => setTimeout(r, 200));

    const dirty = watcher.getDirtyFiles();
    expect(dirty.length).toBeGreaterThanOrEqual(1);
    expect(dirty.some((f) => f.includes('test.log'))).toBe(true);

    watcher.close();
  });

  it('getDirtyFiles clears the set', () => {
    const watcher = new FileWatcher();
    watcher.addDirty('/tmp/a.log');
    watcher.addDirty('/tmp/b.log');

    const first = watcher.getDirtyFiles();
    expect(first).toHaveLength(2);

    const second = watcher.getDirtyFiles();
    expect(second).toHaveLength(0);

    watcher.close();
  });

  it('addDirty manually marks files', () => {
    const watcher = new FileWatcher();
    watcher.addDirty('/some/file.log');

    const dirty = watcher.getDirtyFiles();
    expect(dirty).toEqual(['/some/file.log']);

    watcher.close();
  });

  it('deduplicates directories', () => {
    const watcher = new FileWatcher();
    watcher.watch([tmpDir, tmpDir, tmpDir]);

    watcher.addDirty(path.join(tmpDir, 'x.log'));
    const dirty = watcher.getDirtyFiles();
    expect(dirty).toHaveLength(1);

    watcher.close();
  });

  it('survives watch on non-existent directory', () => {
    const watcher = new FileWatcher();
    expect(() => watcher.watch(['/nonexistent/dir/that/does/not/exist'])).not.toThrow();
    expect(watcher.getDirtyFiles()).toHaveLength(0);
    watcher.close();
  });

  it('close clears everything', () => {
    const watcher = new FileWatcher();
    watcher.watch([tmpDir]);
    watcher.addDirty('/tmp/a.log');
    watcher.close();
    expect(watcher.getDirtyFiles()).toHaveLength(0);
  });

  it('rewatch reinitializes watchers and preserves dirty files', async () => {
    const watcher = new FileWatcher();
    watcher.watch([tmpDir]);
    watcher.addDirty('/tmp/pending.log');

    watcher.rewatch();

    const preserved = watcher.getDirtyFiles();
    expect(preserved).toEqual(['/tmp/pending.log']);

    fs.writeFileSync(path.join(tmpDir, 'after-rewatch.log'), 'data\n');
    await new Promise((r) => setTimeout(r, 200));

    const dirty = watcher.getDirtyFiles();
    expect(dirty.some((f) => f.includes('after-rewatch.log'))).toBe(true);

    watcher.close();
  });

  it('rewatch on unwatched instance is a no-op', () => {
    const watcher = new FileWatcher();
    expect(() => watcher.rewatch()).not.toThrow();
    watcher.close();
  });
});

describe('extractParentDirs', () => {
  it('extracts unique parent directories from glob patterns', () => {
    const dirs = extractParentDirs([
      '/var/log/*.log',
      '/var/log/nginx/*.log',
      '/var/log/*.txt',
    ]);
    expect(dirs.sort()).toEqual(['/var/log', '/var/log/nginx']);
  });

  it('returns empty for empty input', () => {
    expect(extractParentDirs([])).toEqual([]);
  });
});

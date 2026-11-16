import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncHooksAssets } from '../../../scripts/sync-hooks-assets.mjs';

let tmpRoot;
let dataDir;
let cacheDir;
let currentFile;
let versionsDir;
let sourceRoot;
let targetRoot;

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeFile(p, content, mtimeSecsAgo = 0) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content);
  if (mtimeSecsAgo > 0) {
    const t = Date.now() / 1000 - mtimeSecsAgo;
    fs.utimesSync(p, t, t);
  }
}

function setCurrent(version) {
  mkdirp(path.dirname(currentFile));
  fs.writeFileSync(currentFile, version);
}

function buildSource(version, files) {
  // files: { relpath: content }
  const versionDir = path.join(versionsDir, version);
  for (const [rel, content] of Object.entries(files)) {
    writeFile(path.join(versionDir, 'assets', 'hooks', rel), content);
  }
}

function readTarget(rel) {
  return fs.readFileSync(path.join(targetRoot, rel), 'utf8');
}

function targetExists(rel) {
  return fs.existsSync(path.join(targetRoot, rel));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-hooks-assets-'));
  dataDir = path.join(tmpRoot, 'data');
  cacheDir = path.join(tmpRoot, 'cache');
  currentFile = path.join(cacheDir, 'current');
  versionsDir = path.join(cacheDir, 'versions');
  sourceRoot = '';
  targetRoot = path.join(dataDir, 'hooks');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('syncHooksAssets — sync data/hooks from versions/<current>/assets/hooks', () => {
  it('case A: source content differs from target → synced + backed', () => {
    setCurrent('main-aaaaaaaa-multica-attribution');
    buildSource('main-aaaaaaaa-multica-attribution', {
      'trae-cn-hook-processor.mjs': 'NEW VERSION CONTENT\n',
    });
    // Pre-existing stale target
    writeFile(path.join(targetRoot, 'trae-cn-hook-processor.mjs'), 'OLD STALE CONTENT\n');

    const r = syncHooksAssets({ dataDir, cacheDir, currentFile });

    expect(r.version).toBe('main-aaaaaaaa-multica-attribution');
    expect(r.synced).toBe(1);
    expect(r.backed).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.errors).toEqual([]);
    expect(readTarget('trae-cn-hook-processor.mjs')).toBe('NEW VERSION CONTENT\n');
    // Backup file named with short version (first 12 chars).
    const backupPath = path.join(targetRoot, 'trae-cn-hook-processor.mjs.bak.main-aaaaaaa');
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe('OLD STALE CONTENT\n');
  });

  it('case B: source content identical to target → skipped (no copy, no backup)', () => {
    setCurrent('main-bbbbbbbb-multica-attribution');
    const content = 'IDENTICAL CONTENT\n';
    buildSource('main-bbbbbbbb-multica-attribution', {
      'agent-event-normalizer.mjs': content,
    });
    writeFile(path.join(targetRoot, 'agent-event-normalizer.mjs'), content);

    const targetStatBefore = fs.statSync(path.join(targetRoot, 'agent-event-normalizer.mjs'));

    const r = syncHooksAssets({ dataDir, cacheDir, currentFile });

    expect(r.synced).toBe(0);
    expect(r.backed).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.errors).toEqual([]);

    // mtime unchanged — no rewrite happened.
    const targetStatAfter = fs.statSync(path.join(targetRoot, 'agent-event-normalizer.mjs'));
    expect(targetStatAfter.mtimeMs).toBe(targetStatBefore.mtimeMs);
    // No backup file created.
    const backups = fs.readdirSync(targetRoot).filter((f) => f.includes('.bak.'));
    expect(backups).toEqual([]);
  });

  it('case C: source older mtime but content differs → synced + backed (content gate, not mtime)', () => {
    setCurrent('main-cccccccc-multica-attribution');
    // Write source with old mtime (1000s ago).
    buildSource('main-cccccccc-multica-attribution', {
      'trae-cn-hook-processor.mjs': 'CORRECT NEW CONTENT\n',
    });
    // Force source mtime to be 1000s in the past.
    const srcPath = path.join(
      versionsDir, 'main-cccccccc-multica-attribution', 'assets', 'hooks',
      'trae-cn-hook-processor.mjs',
    );
    const oldTime = Date.now() / 1000 - 1000;
    fs.utimesSync(srcPath, oldTime, oldTime);

    // Target with newer mtime but stale content.
    writeFile(path.join(targetRoot, 'trae-cn-hook-processor.mjs'), 'STALE CONTENT\n');

    const r = syncHooksAssets({ dataDir, cacheDir, currentFile });

    expect(r.synced).toBe(1);
    expect(r.backed).toBe(1);
    expect(r.skipped).toBe(0);
    expect(readTarget('trae-cn-hook-processor.mjs')).toBe('CORRECT NEW CONTENT\n');
  });

  it('backup file naming uses short version (first 12 chars)', () => {
    setCurrent('main-verylongversionhash-multica-attribution');
    buildSource('main-verylongversionhash-multica-attribution', {
      'shared/util.mjs': 'new\n',
    });
    writeFile(path.join(targetRoot, 'shared', 'util.mjs'), 'old\n');

    const r = syncHooksAssets({ dataDir, cacheDir, currentFile });

    expect(r.backed).toBe(1);
    const backupPath = path.join(targetRoot, 'shared', 'util.mjs.bak.main-verylon');
    expect(fs.existsSync(backupPath)).toBe(true);
  });

  it('cmp byte comparison: same content different path → skipped', () => {
    setCurrent('main-dddddddd-multica-attribution');
    const content = 'SHARED IDENTICAL CONTENT\n';
    buildSource('main-dddddddd-multica-attribution', {
      'shared/agent-event-normalizer.mjs': content,
    });
    writeFile(path.join(targetRoot, 'shared', 'agent-event-normalizer.mjs'), content);

    const r = syncHooksAssets({ dataDir, cacheDir, currentFile });

    expect(r.skipped).toBe(1);
    expect(r.synced).toBe(0);
    expect(r.backed).toBe(0);
  });

  it('subdirectory shared/ synced recursively', () => {
    setCurrent('main-eeeeeeee-multica-attribution');
    buildSource('main-eeeeeeee-multica-attribution', {
      'shared/sub/deep.mjs': 'deep new\n',
      'top-level.mjs': 'top new\n',
    });

    const r = syncHooksAssets({ dataDir, cacheDir, currentFile });

    expect(r.synced).toBe(2);
    expect(targetExists('shared/sub/deep.mjs')).toBe(true);
    expect(readTarget('shared/sub/deep.mjs')).toBe('deep new\n');
    expect(readTarget('top-level.mjs')).toBe('top new\n');
  });

  it('no current pointer file → no-op (returns zeroed summary, version=null)', () => {
    // currentFile does not exist.
    const r = syncHooksAssets({ dataDir, cacheDir, currentFile });
    expect(r.version).toBeNull();
    expect(r.synced).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.backed).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('current points to nonexistent version dir → no-op', () => {
    setCurrent('main-nonexistent-multica-attribution');
    // Source root missing.
    const r = syncHooksAssets({ dataDir, cacheDir, currentFile });
    expect(r.version).toBe('main-nonexistent-multica-attribution');
    expect(r.synced).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('target dir does not exist → created and populated', () => {
    setCurrent('main-ffffffff-multica-attribution');
    buildSource('main-ffffffff-multica-attribution', {
      'trae-cn-hook-processor.mjs': 'fresh install\n',
    });
    // targetRoot intentionally absent.

    const r = syncHooksAssets({ dataDir, cacheDir, currentFile });

    expect(r.synced).toBe(1);
    expect(targetExists('trae-cn-hook-processor.mjs')).toBe(true);
    expect(readTarget('trae-cn-hook-processor.mjs')).toBe('fresh install\n');
  });

  it('multi-file sync: mixed new / changed / identical in one walk', () => {
    setCurrent('main-1122334455-multica-attribution');
    buildSource('main-1122334455-multica-attribution', {
      'trae-cn-hook-processor.mjs': 'NEW PROC\n',          // differs from target
      'agent-event-normalizer.mjs': 'SAME NORMALIZER\n',    // identical to target
      'trae-cn-loongsuite-pilot-hook.sh': 'NEW SH\n',       // missing from target
      'shared/util.mjs': 'NEW UTIL\n',                       // differs from target
    });
    writeFile(path.join(targetRoot, 'trae-cn-hook-processor.mjs'), 'OLD PROC\n');
    writeFile(path.join(targetRoot, 'agent-event-normalizer.mjs'), 'SAME NORMALIZER\n');
    writeFile(path.join(targetRoot, 'shared', 'util.mjs'), 'OLD UTIL\n');

    const r = syncHooksAssets({ dataDir, cacheDir, currentFile });

    expect(r.synced).toBe(3);   // proc + sh + util
    expect(r.skipped).toBe(1);  // normalizer
    expect(r.backed).toBe(2);   // proc + util
    expect(r.errors).toEqual([]);
    expect(readTarget('trae-cn-hook-processor.mjs')).toBe('NEW PROC\n');
    expect(readTarget('trae-cn-loongsuite-pilot-hook.sh')).toBe('NEW SH\n');
    expect(readTarget('shared/util.mjs')).toBe('NEW UTIL\n');
    expect(readTarget('agent-event-normalizer.mjs')).toBe('SAME NORMALIZER\n');
  });
});

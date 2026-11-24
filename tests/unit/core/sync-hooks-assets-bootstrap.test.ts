import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bootstrapSyncHooksAssets,
  __resetDefaultSyncFnCacheForTests,
  type SyncHooksAssetsFn,
  type SyncHooksAssetsSummary,
} from '../../../src/core/sync-hooks-assets-bootstrap.js';

let tmpRoot: string;
let dataDir: string;
let cacheDir: string;
let currentFile: string;

function mkdirp(p: string) { fs.mkdirSync(p, { recursive: true }); }

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-hooks-bootstrap-'));
  dataDir = path.join(tmpRoot, 'data');
  cacheDir = path.join(tmpRoot, 'cache');
  currentFile = path.join(cacheDir, 'current');
  mkdirp(dataDir);
  mkdirp(cacheDir);
  __resetDefaultSyncFnCacheForTests();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSummary(over: Partial<SyncHooksAssetsSummary> = {}): SyncHooksAssetsSummary {
  return {
    synced: 0,
    skipped: 0,
    backed: 0,
    errors: [],
    version: null,
    ...over,
  };
}

describe('bootstrapSyncHooksAssets', () => {
  it('invokes injected syncFn with dataDir / cacheDir / currentFile derived from opts', async () => {
    const calls: Array<{ dataDir: string; cacheDir: string; currentFile: string }> = [];
    const syncFn: SyncHooksAssetsFn = (args) => {
      calls.push({ ...args });
      return makeSummary({ version: 'main-test-multica-attribution', synced: 3 });
    };

    const r = await bootstrapSyncHooksAssets({ dataDir, cacheDir, currentFile, syncFn });

    expect(r).not.toBeNull();
    expect(r?.version).toBe('main-test-multica-attribution');
    expect(r?.synced).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].dataDir).toBe(dataDir);
    expect(calls[0].cacheDir).toBe(cacheDir);
    expect(calls[0].currentFile).toBe(currentFile);
  });

  it('defaults cacheDir to dataDir when not provided', async () => {
    const calls: Array<{ dataDir: string; cacheDir: string; currentFile: string }> = [];
    const syncFn: SyncHooksAssetsFn = (args) => {
      calls.push({ ...args });
      return makeSummary();
    };

    await bootstrapSyncHooksAssets({ dataDir, syncFn });

    expect(calls).toHaveLength(1);
    expect(calls[0].cacheDir).toBe(dataDir);
  });

  it('defaults currentFile to <cacheDir>/current when not provided', async () => {
    const calls: Array<{ dataDir: string; cacheDir: string; currentFile: string }> = [];
    const syncFn: SyncHooksAssetsFn = (args) => {
      calls.push({ ...args });
      return makeSummary();
    };

    await bootstrapSyncHooksAssets({ dataDir, cacheDir, syncFn });

    expect(calls[0].currentFile).toBe(path.join(cacheDir, 'current'));
  });

  it('returns null and does NOT throw when syncFn throws', async () => {
    const syncFn: SyncHooksAssetsFn = () => {
      throw new Error('boom');
    };

    // Must not reject.
    const r = await bootstrapSyncHooksAssets({ dataDir, syncFn });

    expect(r).toBeNull();
  });

  it('returns null when no syncFn provided and the default module fails to load', async () => {
    // No syncFn injected, and DEFAULT_SYNC_MODULE_URL points at a path that
    // does not exist in the test environment. Bootstrap must return null
    // (non-fatal) rather than throw.
    const r = await bootstrapSyncHooksAssets({ dataDir });
    expect(r).toBeNull();
  });

  it('passes through summary with errors array intact (does not swallow per-file errors)', async () => {
    const syncFn: SyncHooksAssetsFn = () => makeSummary({
      synced: 2,
      backed: 1,
      errors: [
        { rel: 'shared/util.mjs', error: 'permission denied' },
        { rel: 'shared/sub/deep.mjs', error: 'ENOENT' },
      ],
      version: 'main-abcdef-multica-attribution',
    });

    const r = await bootstrapSyncHooksAssets({ dataDir, syncFn });

    expect(r).not.toBeNull();
    expect(r?.errors).toHaveLength(2);
    expect(r?.errors[0].rel).toBe('shared/util.mjs');
    expect(r?.errors[1].error).toBe('ENOENT');
  });

  it('uses cacheDir-derived currentFile even when dataDir differs from cacheDir (production layout)', async () => {
    // Production: dataDir and cacheDir are typically the same, but config can
    // separate them. Verify currentFile comes from cacheDir, not dataDir.
    const calls: Array<{ currentFile: string }> = [];
    const syncFn: SyncHooksAssetsFn = (args) => {
      calls.push({ currentFile: args.currentFile });
      return makeSummary();
    };

    await bootstrapSyncHooksAssets({ dataDir, cacheDir, syncFn });

    expect(calls[0].currentFile).toBe(path.join(cacheDir, 'current'));
    expect(calls[0].currentFile).not.toBe(path.join(dataDir, 'current'));
  });

  it('does not cache the failing default-module lookup across bootstrap calls (retry on next call)', async () => {
    // First call: no syncFn, default module unreachable → null.
    const r1 = await bootstrapSyncHooksAssets({ dataDir });
    expect(r1).toBeNull();

    // Second call with an injected syncFn must still work (the cache of the
    // failed default lookup does not poison subsequent injected-fn calls).
    const syncFn: SyncHooksAssetsFn = () => makeSummary({ synced: 1, version: 'v2' });
    const r2 = await bootstrapSyncHooksAssets({ dataDir, syncFn });
    expect(r2).not.toBeNull();
    expect(r2?.synced).toBe(1);
    expect(r2?.version).toBe('v2');
  });
});

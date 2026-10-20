import { afterAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decideSqliteGuard, runSqliteGuard, sqliteBuiltinExpected } from '../../../src/native-deps-guard.ts';
import { NODE_SQLITE_PROBE } from '../../../src/utils/node-sqlite.ts';
import { hasNodeSqlite } from '../../helpers/sqlite-fixture.mjs';

/**
 * The guard runs before the daemon graph. A failed require('node:sqlite') is
 * fatal on every version: readable FATAL, daemon.fatal, and a thrown error
 * the daemon catch records. There is no degrade path. Node 20.20.2 used to
 * skip the require and exit 0, so an upgrade activated and later queries
 * failed. The spawn is the production check (VITEST unset). Fatal is also
 * thrown in-process so it can be asserted without killing the runner.
 */

const REPO = resolve('.');
const tmp = mkdtempSync(join(tmpdir(), 'native-deps-guard-'));
const guardPath = join(tmp, 'native-deps-guard.cjs');

buildSync({
  entryPoints: ['src/native-deps-guard.ts'],
  outfile: guardPath,
  platform: 'node',
  target: 'es2022',
  format: 'cjs',
  bundle: true,
  packages: 'external',
});

function runGuard(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // The production banner is not under vitest. Leaving VITEST set would skip
  // the top-level check inside the child and hide a Node 18/20 failure.
  delete env.VITEST;
  return spawnSync(process.execPath, [guardPath], {
    cwd: tmp,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('native-deps-guard', () => {
  it('starts only when node:sqlite actually loads', () => {
    const dataDir = join(tmp, 'data-spawn');
    const r = runGuard({ NODE_PATH: join(REPO, 'node_modules'), LOONGSUITE_PILOT_DATA_DIR: dataDir });
    if (hasNodeSqlite()) {
      expect(r.stderr).not.toContain('FATAL');
      expect(r.status).toBe(0);
      expect(() => readFileSync(join(dataDir, 'daemon.fatal'))).toThrow();
    } else {
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('FATAL');
      expect(r.stderr).toContain('node:sqlite');
      expect(readFileSync(join(dataDir, 'daemon.fatal'), 'utf8').length).toBeGreaterThan(0);
    }
  });
});

describe('decideSqliteGuard', () => {
  it('treats a loaded builtin as ok', () => {
    expect(sqliteBuiltinExpected('22.5.0')).toBe(false);
    expect(sqliteBuiltinExpected('22.12.0')).toBe(false);
    expect(sqliteBuiltinExpected('22.13.0')).toBe(true);
    expect(sqliteBuiltinExpected('23.3.0')).toBe(false);
    expect(sqliteBuiltinExpected('23.4.0')).toBe(true);
    expect(sqliteBuiltinExpected('24.0.0')).toBe(true);
    expect(sqliteBuiltinExpected('22.4.9')).toBe(false);
    expect(sqliteBuiltinExpected('18.20.0')).toBe(false);
    expect(decideSqliteGuard(null)).toBe('ok');
  });

  it('treats every failed require as fatal, including Node 20 and flagged 22/23', () => {
    const err = new Error('ERR_UNKNOWN_BUILTIN_MODULE');
    for (const version of ['18.20.8', '20.19.0', '20.20.2', '22.4.0', '22.5.0', '22.12.0', '23.3.0', '22.13.0', '23.4.0', '22.22.2']) {
      expect(sqliteBuiltinExpected(version), version).toBe(
        ['22.13.0', '23.4.0', '22.22.2'].includes(version),
      );
      expect(decideSqliteGuard(err), version).toBe('fatal');
    }
  });

  it('throws node:sqlite on the fatal path so the daemon can record the crash', () => {
    const dataDir = join(tmp, 'data-fatal');
    const prev = process.env.LOONGSUITE_PILOT_DATA_DIR;
    process.env.LOONGSUITE_PILOT_DATA_DIR = dataDir;
    try {
      expect(() => runSqliteGuard(new Error('ERR_UNKNOWN_BUILTIN_MODULE')))
        .toThrow(/node:sqlite/);
      const marker = readFileSync(join(dataDir, 'daemon.fatal'), 'utf8');
      expect(marker).toContain('ERR_UNKNOWN_BUILTIN_MODULE');
    } finally {
      if (prev === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
      else process.env.LOONGSUITE_PILOT_DATA_DIR = prev;
    }
  });

  it('probes with require and does not skip it on old Node', () => {
    // Node 20.20.2 used to make this probe exit 0: the version if was false,
    // require never ran, and the upgrade activated with SQLite unreadable.
    expect(NODE_SQLITE_PROBE).toBe("require('node:sqlite')");
    expect(NODE_SQLITE_PROBE).not.toMatch(/process\.versions|m>=|M===/);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decideSqliteGuard, runSqliteGuard, sqliteBuiltinExpected } from '../../../src/native-deps-guard.ts';
import { NODE_SQLITE_PROBE } from '../../../src/utils/node-sqlite.ts';

/**
 * The guard runs before the daemon graph. On a Node where node:sqlite is
 * unflagged (22.13+ / 23.4+), a missing builtin is fatal: readable FATAL,
 * daemon.fatal, and a thrown error the daemon catch records. On older Node,
 * including 22.5–22.12 where the module still needs --experimental-sqlite, it
 * warns and exits 0 so the collector still starts. The spawn covers the
 * success path. Fatal is thrown in-process so it can be asserted without
 * killing the runner. A missing builtin cannot be simulated on a Node that
 * has it.
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
  return spawnSync(process.execPath, [guardPath], {
    cwd: tmp,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 15000,
  });
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('native-deps-guard', () => {
  it('exits 0 and writes no fatal marker when node:sqlite loads or is still flagged', () => {
    const dataDir = join(tmp, 'data-ok');
    const r = runGuard({ NODE_PATH: join(REPO, 'node_modules'), LOONGSUITE_PILOT_DATA_DIR: dataDir });
    expect(r.stderr).not.toContain('FATAL');
    expect(r.status).toBe(0);
    expect(() => readFileSync(join(dataDir, 'daemon.fatal'))).toThrow();
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
    expect(decideSqliteGuard('22.22.2', null)).toBe('ok');
  });

  it('degrades while the builtin is flagged and is fatal once it is unflagged', () => {
    const err = new Error('ERR_UNKNOWN_BUILTIN_MODULE');
    expect(decideSqliteGuard('18.20.8', err)).toBe('degrade');
    expect(decideSqliteGuard('20.19.0', err)).toBe('degrade');
    expect(decideSqliteGuard('22.4.0', err)).toBe('degrade');
    expect(decideSqliteGuard('22.5.0', err)).toBe('degrade');
    expect(decideSqliteGuard('22.12.0', err)).toBe('degrade');
    expect(decideSqliteGuard('23.3.0', err)).toBe('degrade');
    expect(decideSqliteGuard('22.13.0', err)).toBe('fatal');
    expect(decideSqliteGuard('23.4.0', err)).toBe('fatal');
    expect(decideSqliteGuard('22.22.2', err)).toBe('fatal');
  });

  it('throws node:sqlite on the fatal path so the daemon can record the crash', () => {
    const dataDir = join(tmp, 'data-fatal');
    const prev = process.env.LOONGSUITE_PILOT_DATA_DIR;
    process.env.LOONGSUITE_PILOT_DATA_DIR = dataDir;
    try {
      expect(() => runSqliteGuard('22.13.0', new Error('ERR_UNKNOWN_BUILTIN_MODULE')))
        .toThrow(/node:sqlite/);
      const marker = readFileSync(join(dataDir, 'daemon.fatal'), 'utf8');
      expect(marker).toContain('ERR_UNKNOWN_BUILTIN_MODULE');
    } finally {
      if (prev === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
      else process.env.LOONGSUITE_PILOT_DATA_DIR = prev;
    }
  });

  it('keeps the upgrade probe on the same unflagged floor', () => {
    const condition = NODE_SQLITE_PROBE.match(/if\((.*)\)require\('node:sqlite'\)/)?.[1];
    expect(condition).toBeTruthy();
    const needsBuiltin = new Function('M', 'm', `return (${condition});`);
    for (const version of ['18.20.8', '22.5.0', '22.12.0', '22.13.0', '23.3.0', '23.4.0', '24.0.0']) {
      const [M, m] = version.split('.').map(Number);
      expect(needsBuiltin(M, m)).toBe(sqliteBuiltinExpected(version));
    }
  });
});

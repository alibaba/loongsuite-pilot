import { afterAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decideSqliteGuard, sqliteBuiltinExpected } from '../../../src/native-deps-guard.ts';

/**
 * The guard runs before the daemon graph. On Node >= 22.5 a missing node:sqlite
 * is fatal (readable FATAL, non-zero exit, daemon.fatal marker). On older Node
 * it warns and exits 0 so the collector still starts. These tests spawn the
 * real guard because process.exit + stderr are the contract — importing it
 * in-process would not show the exit code. The decision table is pure and is
 * tested here too; a missing builtin cannot be simulated on a Node that has it.
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
  it('exits 0 and writes no fatal marker on a Node that can load node:sqlite or is older than 22.5', () => {
    const dataDir = join(tmp, 'data-ok');
    const r = runGuard({ NODE_PATH: join(REPO, 'node_modules'), LOONGSUITE_PILOT_DATA_DIR: dataDir });
    expect(r.stderr).not.toContain('FATAL');
    expect(r.status).toBe(0);
    expect(() => readFileSync(join(dataDir, 'daemon.fatal'))).toThrow();
  });
});

describe('decideSqliteGuard', () => {
  it('treats a loaded builtin as ok', () => {
    expect(sqliteBuiltinExpected('22.5.0')).toBe(true);
    expect(sqliteBuiltinExpected('22.4.9')).toBe(false);
    expect(sqliteBuiltinExpected('18.20.0')).toBe(false);
    expect(decideSqliteGuard('22.22.2', null)).toBe('ok');
  });

  it('degrades below 22.5 and is fatal once the builtin should exist', () => {
    const err = new Error('ERR_UNKNOWN_BUILTIN_MODULE');
    expect(decideSqliteGuard('18.20.8', err)).toBe('degrade');
    expect(decideSqliteGuard('20.19.0', err)).toBe('degrade');
    expect(decideSqliteGuard('22.4.0', err)).toBe('degrade');
    expect(decideSqliteGuard('22.5.0', err)).toBe('fatal');
    expect(decideSqliteGuard('22.22.2', err)).toBe('fatal');
  });
});

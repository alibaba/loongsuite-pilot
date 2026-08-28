import { afterAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * On a container whose libc cannot load the payload's native addons, the daemon
 * used to die during module load with nobody watching: the crash happens before
 * its logging exists, and the spawners dropped its stderr. The guard replaces
 * that silent death with a readable FATAL and a non-zero exit. These tests run
 * the real guard as a real process, because process.exit + stderr text are the
 * contract — importing it in-process would exit the test runner instead.
 *
 * The glibc mismatch itself cannot be reproduced on the test host, so the
 * failure case stands in with a sqlite3 that throws on load: the same failure
 * class (require() throws during module load), which is all the guard reacts to.
 */

const REPO = resolve('.');
const tmp = mkdtempSync(join(tmpdir(), 'native-deps-guard-'));
const guardPath = join(tmp, 'native-deps-guard.cjs');

// Same shape as build.mjs: CJS, packages external — the sqlite3 require must
// resolve at runtime against whatever node_modules the location provides.
buildSync({
  entryPoints: ['src/native-deps-guard.ts'],
  outfile: guardPath,
  platform: 'node',
  target: 'es2022',
  format: 'cjs',
  bundle: true,
  packages: 'external',
});

function runGuard(cwd, extraEnv = {}) {
  return spawnSync(process.execPath, [cwd === tmp ? guardPath : join(cwd, 'native-deps-guard.cjs')], {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 15000,
  });
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('native-deps-guard', () => {
  it('exits 0 silently when sqlite3 loads, and writes no fatal marker', () => {
    // The tmp dir has no node_modules of its own; NODE_PATH points at the real
    // one, exactly like the payload layout where the guard resolves against the
    // shipped node_modules.
    const dataDir = join(tmp, 'data-ok');
    const r = runGuard(tmp, { NODE_PATH: join(REPO, 'node_modules'), LOONGSUITE_PILOT_DATA_DIR: dataDir });
    expect(r.stderr).not.toContain('FATAL');
    expect(r.status).toBe(0);
    // A marker left by a successful run would wrongly suppress every later spawn.
    expect(() => readFileSync(join(dataDir, 'daemon.fatal'))).toThrow();
  });

  it('prints an actionable FATAL and exits 1 when sqlite3 cannot load', () => {
    const failDir = join(tmp, 'fail');
    mkdirSync(join(failDir, 'node_modules', 'sqlite3'), { recursive: true });
    writeFileSync(
      join(failDir, 'node_modules', 'sqlite3', 'package.json'),
      JSON.stringify({ name: 'sqlite3', version: '0.0.0', main: 'index.js' }),
    );
    writeFileSync(
      join(failDir, 'node_modules', 'sqlite3', 'index.js'),
      "throw new Error(\"/lib64/libc.so.6: version `GLIBC_2.28' not found (simulated)\");\n",
    );
    copyFileSync(guardPath, join(failDir, 'native-deps-guard.cjs'));

    // NODE_PATH cleared so the fake is the only candidate, as on a container
    // with nothing but the payload.
    const dataDir = join(failDir, 'data');
    const r = runGuard(failDir, { NODE_PATH: '', LOONGSUITE_PILOT_DATA_DIR: dataDir });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[pilot] FATAL');
    expect(r.stderr).toContain('"sqlite3"');
    // The loader's own message must survive into the diagnostic — it is what
    // distinguishes "glibc too old" from "file missing" when triaging.
    expect(r.stderr).toContain('GLIBC_2.28');
    // And the reader must be told what it means and where to look next. The
    // payload's sqlite3 is the upstream prebuild (ancient glibc floor), so the
    // diagnostic points at musl/corruption rather than a build-floor story, and
    // ends with a self-contained remediation (no external file reference — the
    // guard must stay actionable from this repo alone).
    expect(r.stderr).toContain('upstream prebuilt');
    expect(r.stderr).toContain('musl');
    expect(r.stderr).toContain('glibc base image');

    // The crash-loop breaker: the failure is recorded where the preload looks,
    // with the loader's message, so the deterministic failure is not respawned.
    const marker = readFileSync(join(dataDir, 'daemon.fatal'), 'utf8');
    expect(marker.startsWith('fatal ')).toBe(true);
    expect(marker).toContain('GLIBC_2.28');
  });

  it('names the right module in the diagnostic even when the error text is empty', () => {
    const failDir = join(tmp, 'fail-empty');
    mkdirSync(join(failDir, 'node_modules', 'sqlite3'), { recursive: true });
    writeFileSync(
      join(failDir, 'node_modules', 'sqlite3', 'package.json'),
      JSON.stringify({ name: 'sqlite3', version: '0.0.0', main: 'index.js' }),
    );
    writeFileSync(join(failDir, 'node_modules', 'sqlite3', 'index.js'), 'throw new Error("");\n');
    copyFileSync(guardPath, join(failDir, 'native-deps-guard.cjs'));

    const r = runGuard(failDir, { NODE_PATH: '', LOONGSUITE_PILOT_DATA_DIR: join(failDir, 'data') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"sqlite3"');
  });
});

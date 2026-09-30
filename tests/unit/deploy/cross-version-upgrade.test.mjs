// Cross-version upgrade: the old updater validates `require('sqlite3')` in the
// candidate directory. This PR removes the native sqlite3 package in favour of
// node:sqlite, so a compat shim must be resolvable. Without it, every deployed
// updater would get MODULE_NOT_FOUND and never activate the new code.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve('.');

describe('cross-version upgrade: old updater sqlite3 probe', () => {
  it('require("sqlite3") succeeds in the project directory (compat shim)', () => {
    const r = execFileSync(process.execPath, ['-e', "require('sqlite3')"], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 10_000,
    });
    // No throw means exit 0 — old updater would proceed to write `current`.
  });

  it('the shim exports a plain object and is not the native addon', () => {
    const shimMain = resolve(REPO, 'compat/sqlite3/lib/sqlite3.js');
    const content = readFileSync(shimMain, 'utf8');
    expect(content).toContain('module.exports');
    expect(content).not.toContain('binding');
    expect(content).not.toContain('napi');
  });

  it('package.json lists the local shim as a dependency', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8'));
    expect(pkg.dependencies.sqlite3).toBe('file:compat/sqlite3');
  });

  it('compat/ is in the files field so npm pack ships the shim', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('compat/');
  });

  it('new updater uses NODE_SQLITE_PROBE which is require("node:sqlite")', () => {
    const probe = readFileSync(resolve(REPO, 'src/utils/node-sqlite.ts'), 'utf8');
    expect(probe).toContain("require('node:sqlite')");
    const updater = readFileSync(resolve(REPO, 'src/updater/updater.ts'), 'utf8');
    expect(updater).toContain('NODE_SQLITE_PROBE');
    // The updater itself must not hardcode require('sqlite3').
    const codeLines = updater.split('\n').filter(l => !l.trimStart().startsWith('//'));
    const probeCode = codeLines.join('\n');
    expect(probeCode).not.toMatch(/require\(['"]sqlite3['"]\)/);
  });
});

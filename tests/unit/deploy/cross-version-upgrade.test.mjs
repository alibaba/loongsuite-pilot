// Cross-version upgrade: updaters released before the node:sqlite migration
// validate a candidate with `node -e "require('sqlite3')"` after installing its
// dependencies, and refuse to activate it if that throws. The compat shim at
// compat/sqlite3 keeps that probe passing; these tests exercise it the way the
// old updater does, against a candidate staged the way the release packager
// stages it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve('.');
const OLD_PROBE = "require('sqlite3')";
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
const packager = readFileSync(join(REPO, 'deploy/package-opensource.sh'), 'utf8');

function fileDeps() {
  return Object.entries(pkg.dependencies)
    .filter(([, spec]) => String(spec).startsWith('file:'))
    .map(([name, spec]) => ({ name, dir: String(spec).slice('file:'.length) }));
}

// A candidate holding only what the packager ships that matters to npm: the
// manifest, .npmrc and the file: dependency directories. Registry deps are
// dropped so the install needs no network.
function stageCandidate() {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-xver-'));
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    dependencies: Object.fromEntries(fileDeps().map(({ name, dir: d }) => [name, `file:${d}`])),
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  cpSync(join(REPO, '.npmrc'), join(dir, '.npmrc'));
  for (const { dir: d } of fileDeps()) {
    cpSync(join(REPO, d), join(dir, d), { recursive: true });
  }
  return dir;
}

function npm(cwd, args) {
  execFileSync(NPM, [...args, '--no-audit', '--no-fund'], {
    cwd,
    stdio: 'pipe',
    timeout: 120_000,
    shell: process.platform === 'win32',
  });
}

function oldProbe(cwd) {
  execFileSync(process.execPath, ['-e', OLD_PROBE], { cwd, stdio: 'pipe', timeout: 10_000 });
}

describe('cross-version upgrade: packaging keeps the sqlite3 shim resolvable', () => {
  it('declares the shim as a regular (non-optional) dependency', () => {
    expect(pkg.dependencies.sqlite3).toBe('file:compat/sqlite3');
    expect(pkg.optionalDependencies?.sqlite3).toBeUndefined();
  });

  it('the release packager ships every file: dependency directory', () => {
    expect(fileDeps().length).toBeGreaterThan(0);
    for (const { dir } of fileDeps()) {
      const top = dir.split('/')[0];
      expect(packager).toMatch(new RegExp(`^cp -r ${top}\\s+"\\$PKG_DIR/${top}"`, 'm'));
    }
    expect(packager).toMatch(/^cp \.npmrc\s/m);
  });

  it('installs file: dependencies as real directories, not symlinks', () => {
    // A symlinked node_modules/sqlite3 does not survive the prebuilt
    // node_modules archive (Windows bsdtar fails on symlinks, and the link
    // target is outside node_modules).
    expect(readFileSync(join(REPO, '.npmrc'), 'utf8')).toMatch(/^install-links=true$/m);
    expect(lock.packages['node_modules/sqlite3'].link).toBeUndefined();
    expect(lock.packages['node_modules/sqlite3'].resolved).toBe('file:compat/sqlite3');
  });

  it('the shim is plain JS with no native binding', () => {
    const shim = readFileSync(join(REPO, 'compat/sqlite3/lib/sqlite3.js'), 'utf8')
      .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    expect(shim).toMatch(/module\.exports\s*=\s*\{\}/);
    expect(shim).not.toMatch(/require\(/);
  });
});

describe('cross-version upgrade: old updater sequence against a staged candidate', () => {
  let candidate;

  beforeAll(() => {
    candidate = stageCandidate();
  });

  afterAll(() => {
    if (candidate) rmSync(candidate, { recursive: true, force: true });
  });

  it('npm install fallback (--production --no-optional), then the old probe passes', () => {
    npm(candidate, ['install', '--production', '--no-optional']);
    expect(lstatSync(join(candidate, 'node_modules/sqlite3')).isSymbolicLink()).toBe(false);
    expect(() => oldProbe(candidate)).not.toThrow();
  });

  it('prebuilt path (npm ci --omit=dev --omit=optional), then the old probe passes', () => {
    rmSync(join(candidate, 'node_modules'), { recursive: true, force: true });
    npm(candidate, ['ci', '--omit=dev', '--omit=optional']);
    const shimDir = join(candidate, 'node_modules/sqlite3');
    expect(lstatSync(shimDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(shimDir, 'lib/sqlite3.js')).isFile()).toBe(true);
    expect(() => oldProbe(candidate)).not.toThrow();
  });

  it('without the shim directory the old probe fails (guards the test itself)', () => {
    rmSync(join(candidate, 'node_modules/sqlite3'), { recursive: true, force: true });
    expect(() => oldProbe(candidate)).toThrow();
  });
});

describe('cross-version upgrade: the new updater does not probe sqlite3', () => {
  it('uses NODE_SQLITE_PROBE, which loads node:sqlite', () => {
    const probeSrc = readFileSync(join(REPO, 'src/utils/node-sqlite.ts'), 'utf8');
    expect(probeSrc).toContain(`NODE_SQLITE_PROBE = "require('node:sqlite')"`);
    const updater = readFileSync(join(REPO, 'src/updater/updater.ts'), 'utf8');
    const code = updater.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    expect(code).toContain('NODE_SQLITE_PROBE');
    expect(code).not.toMatch(/require\(['"]sqlite3['"]\)/);
  });
});

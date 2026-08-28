import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const launcherSource = readFileSync(resolve('scripts/loongsuite-pilot.sh'), 'utf8');

describe('menubar shell command', () => {
  let root;
  let launcher;
  let cacheDir;
  let dataDir;
  let env;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pilot menubar launcher '));
    cacheDir = join(root, 'cache');
    dataDir = join(root, 'data');
    launcher = join(root, 'bin', 'loongsuite-pilot');
    mkdirSync(dirname(launcher), { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(launcher, launcherSource);
    writeFileSync(join(cacheDir, 'node-bin'), process.execPath);
    // Exercise platform routing on any test host without invoking a real service
    // manager, changing the user's installation, or opening a real menu bar app.
    writeFileSync(join(root, 'bin', 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
    env = {
      ...process.env,
      LOONGSUITE_PILOT_CACHE_DIR: cacheDir,
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function makeEntry(packageDir, exitCode = 0) {
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(join(packageDir, 'dist', 'index.js'), `
      console.log(JSON.stringify({
        args: process.argv.slice(2),
        config: process.env.AGENT_DATA_COLLECTION_CONFIG,
        dataDir: process.env.LOONGSUITE_PILOT_DATA_DIR,
        cacheDir: process.env.LOONGSUITE_PILOT_CACHE_DIR,
      }));
      process.exitCode = ${exitCode};
    `);
  }

  function run(args = ['menubar', 'start']) {
    return spawnSync('bash', [launcher, ...args], { cwd: root, env, encoding: 'utf8' });
  }

  it.each(['start', 'stop'])('forwards menubar %s and paths to the current installed version', command => {
    makeEntry(join(cacheDir, 'versions', 'v1'));
    writeFileSync(join(cacheDir, 'current'), 'v1\n');
    const result = run(['menubar', command]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['menubar', command],
      config: join(dataDir, 'config.json'),
      dataDir,
      cacheDir,
    });
  });

  it('supports legacy package layouts and propagates command failure', () => {
    makeEntry(join(cacheDir, 'package'), 7);
    expect(run().status).toBe(7);
  });

  it('uses the source build instead of forwarding a new command to an older installed runtime', () => {
    makeEntry(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{}');
    makeEntry(join(cacheDir, 'versions', 'old'), 7);
    writeFileSync(join(cacheDir, 'current'), 'old\n');
    const result = run(['menubar', '--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).args).toEqual(['menubar', '--help']);
  });

  it('rejects unsupported platforms before launching Node', () => {
    writeFileSync(join(root, 'bin', 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('only supported on macOS');
  });

  it('explains a missing runtime without falling through to collector startup', () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runtime entry not found');
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../..');
const sourceCli = path.join(projectRoot, 'scripts', 'loongsuite-pilot.ps1');
const monitorScript = path.join(projectRoot, 'scripts', 'monitor-loongsuite-pilot.ps1');

describe.runIf(process.platform === 'win32')('Windows loongsuite-pilot CLI', () => {
  let root;
  let profile;
  let cli;

  function writeFakeVersion(cache, name = 'test-version') {
    const version = path.join(cache, 'versions', name);
    fs.mkdirSync(path.join(version, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'current'), `${name}\n`);
    fs.writeFileSync(path.join(cache, 'node-bin'), process.execPath);
    fs.writeFileSync(
      path.join(version, 'dist', 'index.js'),
      'console.log(JSON.stringify({ args: process.argv.slice(2), config: process.env.AGENT_DATA_COLLECTION_CONFIG }));\n',
    );
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-windows-cli-用户 With Space-'));
    profile = path.join(root, 'profile');
    cli = path.join(profile, '.local', 'bin', 'loongsuite-pilot.ps1');
    const cache = path.join(profile, '.loongsuite-pilot');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.copyFileSync(sourceCli, cli);
    writeFakeVersion(cache);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(...args) {
    const env = { ...process.env, USERPROFILE: profile };
    delete env.LOONGSUITE_PILOT_DATA_DIR;
    delete env.LOONGSUITE_PILOT_CACHE_DIR;
    delete env.AGENT_DATA_COLLECTION_CONFIG;
    return spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cli, ...args],
      {
        env,
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
  }

  test.each([
    ['token-usage', 'token-usage'],
    ['tokens', 'token-usage'],
    ['worker', 'worker'],
  ])('forwards %s to the runtime CLI', (command, expectedRuntimeCommand) => {
    const result = run(command, '--example');

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      args: [expectedRuntimeCommand, '--example'],
      config: path.join(profile, '.loongsuite-pilot', 'config.json'),
    });
  });

  test('advertises monitor start and stop', () => {
    const result = run('monitor', '--help');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('loongsuite-pilot monitor <start|stop>');
  });

  test('uses installed custom data and cache directories without ambient environment variables', () => {
    const dataDir = path.join(root, '数据 With Space');
    const cacheDir = path.join(root, '缓存 With Space');
    writeFakeVersion(cacheDir, 'custom-version');
    fs.writeFileSync(
      path.join(path.dirname(cli), 'loongsuite-pilot-layout.json'),
      JSON.stringify({ dataDir, cacheDir }),
    );

    const result = run('tokens', '--example');

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      args: ['token-usage', '--example'],
      config: path.join(dataDir, 'config.json'),
    });
  });

  test('Windows monitor writes process metrics for a target PID', async () => {
    const outDir = path.join(root, 'monitor output');
    const marker = `pilot-monitor-test-${Date.now()}`;
    const target = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], {
      windowsHide: true,
    });
    const monitor = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        monitorScript,
        '-IntervalSeconds',
        '1',
        '-OutDir',
        outDir,
        '-ProcessPattern',
        marker,
      ],
      { windowsHide: true, stdio: 'ignore' },
    );

    try {
      const deadline = Date.now() + 10_000;
      let csv;
      while (Date.now() < deadline) {
        csv = fs.existsSync(outDir)
          ? fs.readdirSync(outDir).find(name => /^loongsuite-pilot-process-.*\.csv$/.test(name))
          : undefined;
        if (csv && fs.readFileSync(path.join(outDir, csv), 'utf8').trim().split(/\r?\n/).length >= 2) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      expect(csv).toBeTruthy();
      const lines = fs.readFileSync(path.join(outDir, csv), 'utf8').trim().split(/\r?\n/);
      expect(lines[0]).toContain('timestamp,pid,ppid,command,cpu_percent');
      expect(lines.length).toBeGreaterThanOrEqual(2);
    } finally {
      monitor.kill();
      target.kill();
    }
  }, 15_000);
});

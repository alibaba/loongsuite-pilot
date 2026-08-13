import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceCli = path.join(projectRoot, 'scripts', 'loongsuite-pilot.ps1');

describe('Windows token-usage CLI contract', () => {
  test('advertises and dispatches token-usage and its alias', () => {
    const script = fs.readFileSync(sourceCli, 'utf8');

    expect(script).toMatch(/function Cmd-TokenUsage\s*\{/);
    expect(script).toContain('"token-usage"        { Cmd-TokenUsage }');
    expect(script).toContain('"tokens"             { Cmd-TokenUsage }');
    expect(script).toContain('"token-usage" @SubArgs');
    expect(script).toContain('$env:AGENT_DATA_COLLECTION_CONFIG = $CONFIG_FILE');
  });
});

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;

describeOnWindows('Windows token-usage CLI runtime', () => {
  let root;
  let profile;
  let cli;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-token-usage-用户 With Space-'));
    profile = path.join(root, 'profile');
    cli = path.join(profile, '.local', 'bin', 'loongsuite-pilot.ps1');
    const cacheDir = path.join(profile, '.loongsuite-pilot');
    const versionDir = path.join(cacheDir, 'versions', 'test-version');

    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(path.join(versionDir, 'dist'), { recursive: true });
    fs.copyFileSync(sourceCli, cli);
    fs.writeFileSync(path.join(cacheDir, 'current'), 'test-version\n');
    fs.writeFileSync(path.join(cacheDir, 'node-bin'), process.execPath);
    fs.writeFileSync(
      path.join(versionDir, 'dist', 'index.js'),
      'console.log(JSON.stringify({ args: process.argv.slice(2), config: process.env.AGENT_DATA_COLLECTION_CONFIG, dataDir: process.env.LOONGSUITE_PILOT_DATA_DIR, cacheDir: process.env.LOONGSUITE_PILOT_CACHE_DIR }));\n',
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(...args) {
    return spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cli, ...args],
      {
        env: {
          ...process.env,
          USERPROFILE: profile,
          LOONGSUITE_PILOT_DATA_DIR: '',
          LOONGSUITE_PILOT_CACHE_DIR: '',
        },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
  }

  test.each([
    ['token-usage', 'token-usage'],
    ['tokens', 'token-usage'],
  ])('forwards %s and its options to the runtime CLI', (command, expectedCommand) => {
    const result = run(command, '--range', '7d', '--no-color');

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      args: [expectedCommand, '--range', '7d', '--no-color'],
      config: path.join(profile, '.loongsuite-pilot', 'config.json'),
      dataDir: path.join(profile, '.loongsuite-pilot'),
      cacheDir: path.join(profile, '.loongsuite-pilot'),
    });
  });
});

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const windows = process.platform === 'win32';
const powershell = process.env.PILOT_TEST_PWSH || (windows ? 'powershell.exe' : undefined);

async function withFixture(test) {
  const root = await mkdtemp(path.join(tmpdir(), 'pilot-npm-diagnostics-'));
  try {
    const project = path.join(root, 'deployed [version]');
    const nodeDir = path.join(root, 'node dir');
    const cache = path.join(root, 'npm cache');
    const capturedTemp = path.join(root, 'temp');
    for (const dir of [project, nodeDir, path.join(cache, '_logs'), capturedTemp]) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(path.join(cache, '_logs', 'old-debug.log'), '99 error unrelated prior npm run\n');
    const fakeNpm = path.join(root, windows ? 'npm.cmd' : 'npm');
    const launcher = windows
      ? '@echo off\r\n"%PILOT_FIXTURE_NODE%" "%PILOT_FIXTURE_SCRIPT%" %*\r\nexit /b %errorlevel%\r\n'
      : '#!/bin/sh\nexec "$PILOT_FIXTURE_NODE" "$PILOT_FIXTURE_SCRIPT" "$@"\n';
    await writeFile(fakeNpm, launcher, { mode: 0o755 });
    const script = path.join(root, 'fake-npm.cjs');
    await writeFile(script, `
      const { realpathSync } = require('node:fs');
      const args = process.argv.slice(2);
      const flag = (name, value) => args[args.indexOf(name) + 1] === value;
      if (args[0] !== 'install' || !flag('--fetch-retries', '5')
        || !flag('--fetch-retry-mintimeout', '2000') || !flag('--fetch-retry-maxtimeout', '60000')
        || realpathSync(process.cwd()) !== realpathSync(process.env.PILOT_FIXTURE_PROJECT)
        || !process.env.PATH.includes(process.env.PILOT_FIXTURE_NODE_DIR)) process.exit(92);
      for (let line = 1; line <= 45; line++) console.log('fixture output line ' + line);
      if (process.env.PILOT_FIXTURE_FAIL === '1') {
        console.error('fixture current npm failure ETEST');
        process.exitCode = 37;
      } else {
        console.log('fixture success summary');
      }
    `);
    await test(root, capturedTemp, {
      ...process.env,
      TEMP: capturedTemp,
      TMPDIR: capturedTemp,
      npm_config_cache: cache,
      PILOT_FIXTURE_NODE: process.execPath,
      PILOT_FIXTURE_NODE_DIR: nodeDir,
      PILOT_FIXTURE_NPM: fakeNpm,
      PILOT_FIXTURE_PROJECT: project,
      PILOT_FIXTURE_SCRIPT: script,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function installerBlock(source, start, end) {
  const from = source.indexOf(start);
  const through = source.indexOf(end, from);
  expect(from).toBeGreaterThan(-1);
  expect(through).toBeGreaterThan(from);
  return source.slice(from, through);
}

function checkDiagnostics(result, fail) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(fail ? 1 : 0);
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toMatch(/^fixture output line 1\r?$/m);
  expect(result.stdout).not.toContain('unrelated prior npm run');
  if (fail) {
    expect(result.stdout).toMatch(/Dependenc(?:y|ies) installation failed \(exit=37\)/);
    expect(result.stdout).toContain('fixture current npm failure ETEST');
    expect(result.stdout).toContain('fixture output line 45');
  } else {
    expect(result.stdout).toContain('fixture success summary');
    expect(result.stdout).not.toContain('fixture output line');
  }
}

describe.runIf(!windows)('shell npm fallback diagnostics', () => {
  it.each([true, false])('retains just the expected output when npm failure=%s', async fail => {
    await withFixture(async (root, capturedTemp, env) => {
      const source = await readFile('deploy/installer-opensource.sh', 'utf8');
      const fallback = installerBlock(source,
        '    if ensure_node_modules "$modules_ver"; then', '    msg "==> 部署 hook 脚本');
      const runNpm = source.match(/run_npm\(\) \{[\s\S]*?\n\}/)[0];
      const runner = path.join(root, 'check.sh');
      await writeFile(runner, `
set -euo pipefail
msg() { printf '%s\\n' "$2"; }
ensure_node_modules() { return 1; }
PERMANENT_DIR="$PILOT_FIXTURE_PROJECT"
NODE_BIN="$PILOT_FIXTURE_NODE_DIR/node"
NPM_BIN="$PILOT_FIXTURE_NPM"
${runNpm}
run_fallback() {
    local modules_ver=latest
${fallback}
}
run_fallback
`);
      const result = spawnSync('bash', [runner], {
        env: { ...env, PILOT_FIXTURE_FAIL: fail ? '1' : '0' }, encoding: 'utf8',
      });
      checkDiagnostics(result, fail);
      expect(await readdir(capturedTemp)).toEqual([]);
    });
  });
});

describe.runIf(Boolean(powershell))('PowerShell constrained npm fallback diagnostics', () => {
  it.each([true, false])('retains just the expected output when npm failure=%s', async fail => {
    await withFixture(async (root, capturedTemp, env) => {
      const source = await readFile('deploy/installer-opensource.ps1', 'utf8');
      const fallback = installerBlock(source,
        '    if (-not $modulesFromOss) {', '    # Only publish current/previous');
      const runner = path.join(root, 'check.ps1');
      await writeFile(runner, `\uFEFF
$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'
$ErrorActionPreference = 'Stop'
function Msg([string]$Zh, [string]$En) { Write-Host $En }
$script:NODE_BIN = Join-Path $env:PILOT_FIXTURE_NODE_DIR 'node.exe'
$script:NPM_BIN = $env:PILOT_FIXTURE_NPM
$script:PERMANENT_DIR = $env:PILOT_FIXTURE_PROJECT
$modulesFromOss = $false
$originalPath = $env:PATH
$originalLocation = (Get-Location).Path
try {
${fallback}
} finally {
    if ($env:PATH -cne $originalPath -or (Get-Location).Path -cne $originalLocation -or $ErrorActionPreference -ne 'Stop') { exit 91 }
    Write-Host 'fixture state restored'
}
`);
      const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', runner], {
        env: { ...env, PILOT_FIXTURE_FAIL: fail ? '1' : '0' }, encoding: 'utf8',
      });
      checkDiagnostics(result, fail);
      expect(result.stdout).toContain('fixture state restored');
      // PowerShell Core can leave its own .dotnet runtime directory.
      expect((await readdir(capturedTemp)).filter(entry => entry !== '.dotnet')).toEqual([]);
    });
  });
});

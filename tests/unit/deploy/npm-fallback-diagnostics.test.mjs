import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const windows = process.platform === 'win32';
const powershell = process.env.PILOT_TEST_PWSH || (windows ? 'powershell.exe' : undefined);
const privateMarkers = ['fixture-userinfo', 'fixture-registry-auth', 'fixture-signed-value', 'fixture-success-secret'];

async function withFixture(test) {
  const root = await mkdtemp(path.join(tmpdir(), 'pilot-npm-diagnostics-'));
  try {
    const project = path.join(root, 'deployed [version]');
    const nodeDir = path.join(root, 'node dir');
    const cache = path.join(root, 'npm cache');
    const capturedTemp = path.join(root, 'temp');
    const dataDir = path.join(root, 'private [pilot] data');
    for (const dir of [project, nodeDir, path.join(cache, '_logs'), capturedTemp, dataDir]) {
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
      const fail = process.env.PILOT_FIXTURE_FAIL === '1';
      // Keep failure lines on one stream so native stdout/stderr scheduling
      // cannot move the final line out of the tail on a busy runner.
      const emit = fail ? console.error : console.log;
      if (fail) {
        if (process.env.PILOT_FIXTURE_AUTH_ONLY !== '1') emit('npm error gyp ERR! stack Error: not found: make');
        emit('npm error E403 https://fixture-userinfo@registry.invalid/package');
      }
      for (let line = 1; line <= 45; line++) emit('fixture output line ' + line);
      if (fail) {
        emit('npm error registry response Authorization: Bearer fixture-registry-auth');
        emit('npm error https://registry.invalid/package?signature=fixture-signed-value');
        emit('npm error ' + 'x'.repeat(128 * 1024));
        process.exitCode = 37;
      } else {
        emit('fixture success summary fixture-success-secret');
      }
    `);
    await test(root, capturedTemp, {
      ...process.env,
      TEMP: capturedTemp,
      LOCALAPPDATA: capturedTemp,
      TMPDIR: capturedTemp,
      npm_config_cache: cache,
      PILOT_FIXTURE_DATA: dataDir,
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

async function checkDiagnostics(result, fail, logDir, authOnly) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(fail ? 1 : 0);
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toContain('fixture output line');
  expect(result.stdout).not.toContain('unrelated prior npm run');
  expect(result.stdout).not.toContain('registry.invalid');
  for (const marker of privateMarkers) expect(result.stdout).not.toContain(marker);
  expect(Buffer.byteLength(result.stdout)).toBeLessThan(4096);
  if (fail) {
    expect(result.stdout).toMatch(/Dependenc(?:y|ies) installation failed \(exit=37\)/);
    expect(result.stdout).toContain(authOnly
      ? 'Hint: the npm registry refused the request'
      : 'Hint: missing C/C++ build toolchain');
    expect(result.stdout.includes('npm registry refused the request')).toBe(Boolean(authOnly));
    if (logDir) {
      const log = result.stdout.match(/Full npm output: (.+)\r?$/m)?.[1].trim();
      expect(log).toBeTruthy();
      expect(path.dirname(log)).toBe(logDir);
      const data = await readFile(log);
      const text = data[0] === 0xff && data[1] === 0xfe ? data.toString('utf16le') : data.toString('utf8');
      expect(text).toMatch(/^fixture output line 1\r?$/m);
      expect(text.includes('npm error gyp ERR! stack Error: not found: make')).toBe(!authOnly);
      for (const marker of privateMarkers.slice(0, -1)) expect(text).toContain(marker);
      expect(text).not.toContain('unrelated prior npm run');
    } else {
      expect(result.stdout).not.toContain('Full npm output:');
    }
  } else {
    expect(result.stdout).toContain('Dependencies installed');
    expect(result.stdout).not.toContain('Full npm output:');
    expect(await readdir(logDir)).toEqual([]);
  }
}

describe.runIf(!windows)('shell npm fallback diagnostics', () => {
  it.each([
    { fail: true, fallbackLog: false, canLog: true }, { fail: false, fallbackLog: false, canLog: true },
    { fail: true, fallbackLog: true, canLog: true }, { fail: true, fallbackLog: true, canLog: false },
    { fail: true, fallbackLog: false, canLog: true, authOnly: true },
  ])('reports current npm outcome (failure=$fail, temporary log=$fallbackLog, can log=$canLog, auth only=$authOnly)', async ({ fail, fallbackLog, canLog, authOnly }) => {
    await withFixture(async (root, capturedTemp, env) => {
      if (fallbackLog) await writeFile(path.join(env.PILOT_FIXTURE_DATA, 'logs'), 'not a directory');
      if (!canLog) env.TMPDIR = env.PILOT_FIXTURE_SCRIPT;
      const source = await readFile('deploy/installer-opensource.sh', 'utf8');
      const fallback = installerBlock(source,
        '    if ensure_node_modules "$modules_ver"; then', '    msg "==> 部署 hook 脚本');
      const diagnosticHelpers = installerBlock(source, 'create_npm_fallback_log() {',
        '# Common: deploy package to versions/ directory');
      const runNpm = source.match(/run_npm\(\) \{[\s\S]*?\n\}/)[0];
      const runner = path.join(root, 'check.sh');
      await writeFile(runner, `
set -euo pipefail
msg() { printf '%s\\n' "$2"; }
ensure_node_modules() { return 1; }
PERMANENT_DIR="$PILOT_FIXTURE_PROJECT"
DATA_DIR="$PILOT_FIXTURE_DATA"
NODE_BIN="$PILOT_FIXTURE_NODE_DIR/node"
NPM_BIN="$PILOT_FIXTURE_NPM"
${runNpm}
${diagnosticHelpers}
run_fallback() {
    local modules_ver=latest
${fallback}
}
run_fallback
`);
      const result = spawnSync('bash', [runner], {
        env: { ...env, PILOT_FIXTURE_FAIL: fail ? '1' : '0', PILOT_FIXTURE_AUTH_ONLY: authOnly ? '1' : '0' },
        encoding: 'utf8',
      });
      const logDir = canLog ? (fallbackLog ? capturedTemp : path.join(env.PILOT_FIXTURE_DATA, 'logs')) : undefined;
      await checkDiagnostics(result, fail, logDir, authOnly);
      if (fail && logDir) {
        const [name] = await readdir(logDir);
        const file = await stat(path.join(logDir, name));
        expect(file.mode & 0o777).toBe(0o600);
      }
      if (!fallbackLog) expect(await readdir(capturedTemp)).toEqual([]);
    });
  });
});

describe.runIf(Boolean(powershell))('PowerShell constrained npm fallback diagnostics', () => {
  it.each([
    { fail: true, canLog: true }, { fail: false, canLog: true }, { fail: true, canLog: false },
    { fail: true, canLog: false, authOnly: true },
  ])('reports current npm outcome (failure=$fail, private log=$canLog, auth only=$authOnly)', async ({ fail, canLog, authOnly }) => {
    await withFixture(async (root, capturedTemp, env) => {
      if (!canLog) env.LOCALAPPDATA = env.PILOT_FIXTURE_SCRIPT;
      const source = await readFile('deploy/installer-opensource.ps1', 'utf8');
      const fallback = installerBlock(source,
        '    if (-not $modulesFromOss) {', '    # Only publish current/previous');
      const shortPathHelpers = installerBlock(source, 'function Get-PilotLongPath {', '# <<< pilot-short-path <<<');
      const diagnosticHelpers = installerBlock(source, 'function New-NpmFallbackLog {',
        '# Deploy package to versions/ directory');
      const runner = path.join(root, 'check.ps1');
      await writeFile(runner, `\uFEFF
$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'
$ErrorActionPreference = 'Stop'
function Msg([string]$Zh, [string]$En) { Write-Host $En }
${shortPathHelpers}
${diagnosticHelpers}
$script:NODE_BIN = Join-Path $env:PILOT_FIXTURE_NODE_DIR 'node.exe'
$script:NPM_BIN = $env:PILOT_FIXTURE_NPM
$script:PERMANENT_DIR = $env:PILOT_FIXTURE_PROJECT
$modulesFromOss = $false
$originalPath = $env:PATH
$originalLocation = (Get-Location).Path
try {
${fallback}
} catch {
    exit 1
} finally {
    if ($env:PATH -cne $originalPath -or (Get-Location).Path -cne $originalLocation -or $ErrorActionPreference -ne 'Stop') { exit 91 }
    Write-Host 'fixture state restored'
}
`);
      const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', runner], {
        env: { ...env, PILOT_FIXTURE_FAIL: fail ? '1' : '0', PILOT_FIXTURE_AUTH_ONLY: authOnly ? '1' : '0' },
        encoding: 'utf8',
      });
      await checkDiagnostics(result, fail, canLog ? path.join(capturedTemp, 'Temp') : undefined, authOnly);
      expect(result.stdout).toContain('fixture state restored');
      // PowerShell Core can leave its own .dotnet runtime directory.
      expect((await readdir(capturedTemp)).filter(entry => entry !== '.dotnet')).toEqual(canLog ? ['Temp'] : []);
    });
  });
});

async function prepareDeployment(root) {
  const cache = path.join(root, 'home', '.loongsuite-pilot');
  const source = path.join(root, 'package');
  await mkdir(cache, { recursive: true });
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  await writeFile(path.join(cache, 'current'), '1.0.0_existing\n');
  await writeFile(path.join(source, 'VERSION'), 'version=2.0.0\ngit_commit=candidate\n');
  await writeFile(path.join(source, 'scripts', 'collector-daemon.js'), '// synthetic bootstrap\n');
  await writeFile(path.join(source, 'scripts', 'postinstall.js'), 'console.error("Post-install failed: fixture");\n');
  return { cache, source, target: path.join(cache, 'versions', '2.0.0_candidate') };
}

describe.runIf(!windows)('shell deployment failure stages', () => {
  it.each(['files', 'dependencies', 'hooks'])('attributes and stops at the failing %s stage', async stage => {
    await withFixture(async (root, _capturedTemp, env) => {
      const { cache, source, target } = await prepareDeployment(root);
      const script = await readFile('deploy/installer-opensource.sh', 'utf8');
      const deploy = installerBlock(script, 'deploy_bootstrap_scripts() {', '# Migrate legacy single-directory layout');
      const runNpm = script.match(/run_npm\(\) \{[\s\S]*?\n\}/)[0];
      const runner = path.join(root, 'deploy.sh');
      await writeFile(runner, `
set -euo pipefail
msg() { printf '%s\\n' "$2"; }
ensure_node_modules() { [ "$PILOT_FIXTURE_STAGE" != dependencies ]; }
PERMANENT_DIR="$PILOT_FIXTURE_PROJECT"
DATA_DIR="$PILOT_FIXTURE_DATA"
NODE_BIN="$PILOT_FIXTURE_NODE"
NPM_BIN="$PILOT_FIXTURE_NPM"
${runNpm}
${deploy}
if ! deploy_package "$PILOT_FIXTURE_SRC"; then
    printf 'failed stage: %s\\n' "$(deploy_failure_label)"
    exit 1
fi
`);
      const result = spawnSync('bash', [runner], {
        env: {
          ...env, HOME: path.dirname(cache), PILOT_FIXTURE_STAGE: stage, PILOT_FIXTURE_FAIL: '1',
          PILOT_FIXTURE_NODE_DIR: path.dirname(process.execPath), PILOT_FIXTURE_PROJECT: target,
          PILOT_FIXTURE_SRC: stage === 'files' ? path.join(root, 'missing') : source,
        },
        encoding: 'utf8',
      });
      const label = stage === 'files' ? 'file deployment' : stage === 'dependencies' ? 'dependency installation' : 'hook script deployment';
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(`failed stage: ${label} failed`);
      expect(result.stdout.includes('Post-install failed: fixture')).toBe(stage === 'hooks');
      expect((await readFile(path.join(cache, 'current'), 'utf8')).trim()).toBe('1.0.0_existing');
    });
  });
});

describe.runIf(Boolean(powershell))('PowerShell deployment failure stages', () => {
  it.each(['files', 'dependencies', 'hooks', 'npm-launch'])('attributes and stops at the failing %s stage', async stage => {
    await withFixture(async (root, capturedTemp, env) => {
      const { cache, source, target } = await prepareDeployment(root);
      const script = await readFile('deploy/installer-opensource.ps1', 'utf8');
      const shortPathHelpers = installerBlock(script, 'function Get-PilotLongPath {', '# <<< pilot-short-path <<<');
      const deploy = installerBlock(script, 'function New-NpmFallbackLog {', '# Migrate legacy layout');
      const runner = path.join(root, 'deploy.ps1');
      await writeFile(runner, `\uFEFF
$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'
$ErrorActionPreference = 'Stop'
function Msg([string]$Zh, [string]$En) { Write-Host $En }
function Deploy-BootstrapScripts {}
function Ensure-NodeModules { return $env:PILOT_FIXTURE_STAGE -notin @('dependencies', 'npm-launch') }
$CACHE_DIR = $env:PILOT_FIXTURE_CACHE
$DataDir = $env:PILOT_FIXTURE_DATA
$script:PERMANENT_DIR = $env:PILOT_FIXTURE_PROJECT
$script:NODE_BIN = $env:PILOT_FIXTURE_NODE
$script:NPM_BIN = $env:PILOT_FIXTURE_NPM
${shortPathHelpers}
${deploy}
try {
    Deploy-Package $env:PILOT_FIXTURE_SRC
} catch {
    Write-DeployFailure 'install' $_.Exception.Message
    exit 1
}
if ($script:PILOT_POSTINSTALL_ERR) {
    Write-DeployFailure 'install' $script:PILOT_POSTINSTALL_ERR
    exit 1
}
`);
      const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', runner], {
        env: {
          ...env, PILOT_FIXTURE_CACHE: cache, PILOT_FIXTURE_STAGE: stage, PILOT_FIXTURE_FAIL: '1',
          PILOT_FIXTURE_NODE_DIR: path.dirname(process.execPath), PILOT_FIXTURE_PROJECT: target,
          PILOT_FIXTURE_NPM: stage === 'npm-launch' ? path.join(root, 'missing-npm.cmd') : env.PILOT_FIXTURE_NPM,
          PILOT_FIXTURE_SRC: stage === 'files' ? path.join(root, 'missing') : source,
        },
        encoding: 'utf8',
      });
      const label = stage === 'files' ? 'file deployment' : stage === 'hooks' ? 'hook script deployment' : 'dependency installation';
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(`Install aborted: ${label} failed`);
      expect(result.stdout.includes('Post-install failed: fixture')).toBe(stage === 'hooks');
      if (stage === 'npm-launch') {
        expect(result.stdout).toContain('npm executable could not be found');
        expect(result.stdout).not.toContain('missing-npm.cmd');
        expect(await readdir(path.join(capturedTemp, 'Temp'))).toEqual([]);
      }
      // Windows publishes before postinstall and its existing upgrade caller owns rollback.
      const expected = stage === 'hooks' ? '2.0.0_candidate' : '1.0.0_existing';
      expect((await readFile(path.join(cache, 'current'), 'utf8')).trim()).toBe(expected);
    });
  });
});

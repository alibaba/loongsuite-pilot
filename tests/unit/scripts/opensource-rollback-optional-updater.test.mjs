// Open-source packages strip scripts/updater-daemon.js
// (deploy/package-opensource.sh). sync_installed_scripts_from_version used to
// require that file, so loongsuite-pilot rollback always failed on every
// open-source install (issue #464). Match sync_bootstrap_scripts: collector +
// CLI are required; updater is optional, and a stale bootstrap copy is removed.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVICE_SH = path.join(projectRoot, 'scripts', 'loongsuite-pilot.sh');
const SERVICE_PS1 = path.join(projectRoot, 'scripts', 'loongsuite-pilot.ps1');
const PACKAGE_SH = path.join(projectRoot, 'deploy', 'package-opensource.sh');

const shellText = readFileSync(SERVICE_SH, 'utf-8');
const ps1Text = readFileSync(SERVICE_PS1, 'utf-8');
const packageText = readFileSync(PACKAGE_SH, 'utf-8');

const codeOf = (s) => s.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

const bodyOf = (name) => {
  const start = shellText.indexOf(`\n${name}() {`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = shellText.slice(start + `\n${name}() {`.length);
  const end = rest.search(/\n[a-z_][a-z0-9_]*\(\) \{/);
  return codeOf(end === -1 ? rest : rest.slice(0, end));
};

const temporaryRoots = [];
afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('open-source packaging still strips updater-daemon.js', () => {
  it('package-opensource.sh removes updater-daemon.js from the staged package', () => {
    expect(packageText).toMatch(/rm -f "\$PKG_DIR\/scripts\/updater-daemon\.js"/);
  });
});

describe('sync_installed_scripts_from_version treats updater as optional', () => {
  it('does not hard-require updater-daemon.js in the shell gate', () => {
    const body = bodyOf('sync_installed_scripts_from_version');
    // Required pair: collector + CLI. updater must not be ANDed into the gate.
    expect(body).toContain('collector-daemon.js');
    expect(body).toContain('loongsuite-pilot.sh');
    expect(body).not.toMatch(
      /\[\s*! -f "\$src_dir\/collector-daemon\.js"\s*\]\s*\|\|\s*\[\s*! -f "\$src_dir\/updater-daemon\.js"\s*\]/,
    );
    expect(body).toContain('rm -f "$BOOTSTRAP_DIR/updater-daemon.js"');
  });

  it('PowerShell Sync-InstalledScriptsFromVersion no longer lists updater as required', () => {
    const start = ps1Text.indexOf('function Sync-InstalledScriptsFromVersion');
    expect(start).toBeGreaterThan(-1);
    const rest = ps1Text.slice(start);
    const end = rest.search(/\nfunction /);
    const body = rest.slice(0, end === -1 ? undefined : end);
    expect(body).toContain('$required = @("collector-daemon.js")');
    expect(body).toContain('$optional = @("updater-daemon.js")');
    expect(body).toContain('Remove-Item -LiteralPath $dst -Force');
  });
});

const describeShell = process.platform === 'win32' ? describe.skip : describe;

function extractShellFunction(name) {
  const start = shellText.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const rest = shellText.slice(start + 1);
  const end = rest.search(/\n[a-z_][a-z0-9_]*\(\) \{/);
  return end === -1 ? rest : rest.slice(0, end);
}

describeShell('sync_installed_scripts_from_version behaviour', () => {
  function runSync({ withUpdater, staleUpdater, omitCollector = false }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-rollback-sync-'));
    temporaryRoots.push(root);
    const versionDir = path.join(root, 'versions', 'v1');
    const scriptsDir = path.join(versionDir, 'scripts');
    const bootstrapDir = path.join(root, 'bin');
    const pilotBin = path.join(root, 'loongsuite-pilot');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(bootstrapDir, { recursive: true });
    if (!omitCollector) {
      fs.writeFileSync(path.join(scriptsDir, 'collector-daemon.js'), 'collector-v1\n');
    }
    fs.writeFileSync(path.join(scriptsDir, 'loongsuite-pilot.sh'), '#!/bin/sh\necho cli-v1\n');
    if (withUpdater) {
      fs.writeFileSync(path.join(scriptsDir, 'updater-daemon.js'), 'updater-v1\n');
    }
    if (staleUpdater) {
      fs.writeFileSync(path.join(bootstrapDir, 'updater-daemon.js'), 'stale-updater\n');
    }
    fs.writeFileSync(path.join(bootstrapDir, 'collector-daemon.js'), 'old-collector\n');

    const functions = [
      'check_rollback_bootstrap_file',
      'publish_rollback_bootstrap_file',
      'sync_installed_scripts_from_version',
    ].map(extractShellFunction).join('\n');
    const script = `
set -euo pipefail
BOOTSTRAP_DIR=${JSON.stringify(bootstrapDir)}
LOONGSUITE_PILOT_BIN=${JSON.stringify(pilotBin)}
${functions}
sync_installed_scripts_from_version ${JSON.stringify(versionDir)}
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    return { root, bootstrapDir, pilotBin, result };
  }

  it('succeeds for an open-source version dir that lacks updater-daemon.js', () => {
    const { bootstrapDir, pilotBin, result } = runSync({ withUpdater: false, staleUpdater: true });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(path.join(bootstrapDir, 'collector-daemon.js'), 'utf8')).toBe('collector-v1\n');
    expect(fs.existsSync(path.join(bootstrapDir, 'updater-daemon.js'))).toBe(false);
    expect(fs.readFileSync(pilotBin, 'utf8')).toContain('cli-v1');
  });

  it('still copies updater-daemon.js when the version provides it', () => {
    const { bootstrapDir, result } = runSync({ withUpdater: true, staleUpdater: false });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(path.join(bootstrapDir, 'updater-daemon.js'), 'utf8')).toBe('updater-v1\n');
  });

  it('fails when collector-daemon.js is missing', () => {
    const { result } = runSync({ withUpdater: false, staleUpdater: false, omitCollector: true });
    expect(result.status).not.toBe(0);
  });
});

describe('rollback preserves version pointers until script sync succeeds', () => {
  function checkRollback(file, dispatch, replacement, interpreter, args, {
    obstruction,
    linked,
    current = ' \tactive  \r\n',
    failure = 'sync',
    updater = true,
    targetUpdater = false,
  } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-rollback-removal-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const bootstrap = path.join(root, 'bin');
    const isBash = file === SERVICE_SH;
    const installedCli = path.join(home, '.local', 'bin', 'loongsuite-pilot');
    const restart = path.join(root, 'restart');
    fs.mkdirSync(home);
    fs.mkdirSync(bootstrap);
    for (const version of ['active', 'prior']) {
      const scripts = path.join(root, 'versions', version, 'scripts');
      fs.mkdirSync(scripts, { recursive: true });
      fs.writeFileSync(path.join(scripts, 'collector-daemon.js'), version);
      fs.writeFileSync(path.join(scripts, 'loongsuite-pilot.sh'), version);
      if (version === 'active' || targetUpdater) {
        fs.writeFileSync(path.join(scripts, 'updater-daemon.js'), version);
      }
    }
    const currentPointer = path.join(root, 'current');
    const previousPointer = path.join(root, 'previous');
    const originalPrevious = ' \tprior  \r\n';
    if (current !== null) fs.writeFileSync(currentPointer, current);
    fs.writeFileSync(previousPointer, originalPrevious);
    fs.writeFileSync(path.join(bootstrap, 'collector-daemon.js'), 'installed-collector');
    if (updater) fs.writeFileSync(path.join(bootstrap, 'updater-daemon.js'), 'installed-updater');
    if (isBash) {
      fs.mkdirSync(path.dirname(installedCli), { recursive: true });
      fs.writeFileSync(installedCli, 'installed-launcher');
      fs.chmodSync(installedCli, 0o751);
    }
    const unrelated = path.join(root, 'unrelated');
    if (obstruction) {
      const blocked = path.join(root, obstruction);
      if (fs.existsSync(blocked)) fs.unlinkSync(blocked);
      if (linked) {
        fs.writeFileSync(unrelated, 'third-party');
        fs.symlinkSync(unrelated, blocked);
      } else {
        fs.mkdirSync(blocked, { recursive: true });
      }
    }
    const script = path.join(root, path.basename(file));
    const original = readFileSync(file, 'utf-8');
    expect(original).toContain(dispatch);
    fs.writeFileSync(script, original.replace(dispatch, replacement + dispatch));
    const result = spawnSync(interpreter, [...args, script, 'rollback'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOONGSUITE_PILOT_CACHE_DIR: root,
        LOONGSUITE_PILOT_DATA_DIR: root,
        PILOT_TEST_RESTART_MARKER: restart,
        PILOT_TEST_ROLLBACK_FAILURE: failure,
      },
    });

    const output = result.stdout + result.stderr;
    if (failure === 'none') {
      expect(result.status, result.error?.message ?? result.stderr).toBe(0);
      expect(output).toContain('Rolled back to version: prior');
      expect(fs.readFileSync(currentPointer, 'utf8').trim()).toBe('prior');
      expect(fs.readFileSync(previousPointer, 'utf8')).toBe(
        current ? `active${os.EOL}` : originalPrevious,
      );
      expect(fs.existsSync(restart)).toBe(true);
      expect(fs.readFileSync(path.join(bootstrap, 'collector-daemon.js'), 'utf8')).toBe('prior');
      expect(fs.existsSync(path.join(bootstrap, 'updater-daemon.js'))).toBe(false);
      return;
    }

    expect(result.status, result.error?.message ?? result.stderr).toBe(1);
    const expectedFailure = {
      publish: 'Failed to publish current version pointer',
      'publish-remove': 'Failed to publish current version pointer',
      'previous-remove': 'Failed to publish previous version pointer',
      recover: 'Failed to publish current version pointer',
    }[failure] ?? 'Failed to sync scripts for rollback target';
    expect(output).toContain(expectedFailure);
    if (obstruction) {
      expect(output).toContain('path is not a file');
      if (linked) {
        expect(fs.readFileSync(unrelated, 'utf8')).toBe('third-party');
        expect(fs.readlinkSync(path.join(root, obstruction))).toBe(unrelated);
      } else {
        expect(fs.readdirSync(path.join(root, obstruction))).toEqual([]);
      }
    }
    const actualCurrent = fs.existsSync(currentPointer) ? fs.readFileSync(currentPointer, 'utf8') : null;
    expect(actualCurrent).toBe(current);
    expect(fs.readFileSync(previousPointer, 'utf8')).toBe(originalPrevious);
    if (obstruction !== 'bin/collector-daemon.js') {
      expect(fs.readFileSync(path.join(bootstrap, 'collector-daemon.js'), 'utf8')).toBe('installed-collector');
    }
    const installedUpdater = path.join(bootstrap, 'updater-daemon.js');
    if (failure === 'recover') {
      expect(output).toContain('Failed to restore bootstrap; backups retained');
      const backup = fs.readdirSync(root).find(name => name.startsWith('.rollback-pointers'));
      expect(backup).toBeDefined();
      expect(fs.readFileSync(path.join(root, backup, 'bootstrap-1'), 'utf8')).toBe('installed-updater');
      expect(fs.existsSync(installedUpdater)).toBe(false);
    } else if (updater) {
      expect(fs.readFileSync(installedUpdater, 'utf8')).toBe('installed-updater');
    } else {
      expect(fs.existsSync(installedUpdater)).toBe(false);
    }
    if (isBash && obstruction !== 'home/.local/bin/loongsuite-pilot') {
      expect(fs.readFileSync(installedCli, 'utf8')).toBe('installed-launcher');
      expect(fs.statSync(installedCli).mode & 0o777).toBe(0o751);
    }
    expect(fs.existsSync(restart)).toBe(false);
  }

  const pointerCases = [
    {},
    { obstruction: 'bin/collector-daemon.js' },
    { obstruction: 'bin/collector-daemon.js.tmp' },
    { current: null },
    { current: '' },
    { current: null, failure: 'none' },
    { current: '', failure: 'none' },
    { failure: 'none' },
    { failure: 'publish' },
    { failure: 'collector', current: null },
    { failure: 'collector', current: '' },
    { failure: 'publish', current: null },
    { failure: 'publish', current: '' },
    { failure: 'publish', current: null, updater: false, targetUpdater: true },
    { failure: 'recover', current: '' },
    ...(process.platform === 'win32' ? [] : [{ obstruction: 'bin/collector-daemon.js.tmp', linked: true }]),
  ];

  it.skipIf(process.platform === 'win32').each([
    ...pointerCases,
    { obstruction: 'home/.local/bin/loongsuite-pilot' },
    { obstruction: 'home/.local/bin/loongsuite-pilot.tmp' },
  ])('keeps Bash artifacts and pointers consistent (%j)', (scenario) => {
    checkRollback(SERVICE_SH, '\n# ---- Dispatch ----\n', `
cmd_restart() { touch "$PILOT_TEST_RESTART_MARKER"; }
cleanup_hermes_for_rollback() { :; }
rm() {
    if [ "$PILOT_TEST_ROLLBACK_FAILURE" = sync ] && [ "\${2:-}" = "$BOOTSTRAP_DIR/updater-daemon.js" ]; then
        echo "controlled updater removal failure" >&2
        return 1
    fi
    command rm "$@"
}
mv() {
    if { [ "$PILOT_TEST_ROLLBACK_FAILURE" = publish ] || [ "$PILOT_TEST_ROLLBACK_FAILURE" = recover ]; } &&
        [ "\${3:-}" = "$CURRENT_FILE" ]; then
        echo "controlled current pointer publication failure" >&2
        return 1
    fi
    if [ "$PILOT_TEST_ROLLBACK_FAILURE" = collector ] &&
        [ "\${3:-}" = "$BOOTSTRAP_DIR/collector-daemon.js" ] && [[ "\${2:-}" == *.rollback-sync.* ]]; then
        echo "controlled collector publication failure" >&2
        return 1
    fi
    if [ "$PILOT_TEST_ROLLBACK_FAILURE" = recover ] &&
        [ "\${3:-}" = "$BOOTSTRAP_DIR/updater-daemon.js" ] && [[ "\${2:-}" == *.rollback-restore.* ]]; then
        echo "controlled updater recovery failure" >&2
        return 1
    fi
    command mv "$@"
}
`, 'bash', [], scenario);
  });

  const powershell = process.env.PILOT_TEST_PWSH ?? (process.platform === 'win32' ? 'powershell.exe' : null);
  it.skipIf(!powershell).each([
    ...pointerCases,
    { failure: 'publish-remove', current: '' },
    { failure: 'publish-remove' },
    { failure: 'previous-remove' },
  ])('keeps PowerShell artifacts and pointers consistent (%j)', (scenario) => {
    checkRollback(SERVICE_PS1, '\nswitch ($Command.ToLower()) {', `
function Cmd-Restart { Set-Content -LiteralPath $env:PILOT_TEST_RESTART_MARKER -Value restarted }
function Remove-HermesPluginForRollback {}
function Remove-Item {
    param([Alias("Path")][string]$LiteralPath, [switch]$Force, [switch]$Recurse, [object]$ErrorAction)
    if (($env:PILOT_TEST_ROLLBACK_FAILURE -eq "sync") -and
        ($LiteralPath -eq (Join-Path $BOOTSTRAP_DIR "updater-daemon.js"))) {
        throw "controlled updater removal failure"
    }
    Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Force:$Force -Recurse:$Recurse
}
function Move-Item {
    param([string]$LiteralPath, [string]$Destination, [switch]$Force, [object]$ErrorAction)
    $sourceName = Split-Path -Leaf $LiteralPath
    if (($env:PILOT_TEST_ROLLBACK_FAILURE -in @("publish", "recover")) -and
        ($Destination -eq $CURRENT_FILE) -and ($sourceName -eq "current")) {
        throw "controlled current pointer publication failure"
    }
    if ((($env:PILOT_TEST_ROLLBACK_FAILURE -eq "publish-remove") -and
        ($Destination -eq $CURRENT_FILE) -and ($sourceName -eq "current")) -or
        (($env:PILOT_TEST_ROLLBACK_FAILURE -eq "previous-remove") -and
        ($Destination -eq $PREVIOUS_FILE) -and ($sourceName -eq "previous"))) {
        Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $Destination -Force
        throw "controlled pointer publication failure after deleting destination"
    }
    if (($env:PILOT_TEST_ROLLBACK_FAILURE -eq "collector") -and
        ($Destination -eq (Join-Path $BOOTSTRAP_DIR "collector-daemon.js")) -and
        ($LiteralPath -like "*.rollback-sync-*")) {
        throw "controlled collector publication failure"
    }
    if (($env:PILOT_TEST_ROLLBACK_FAILURE -eq "recover") -and
        ($Destination -eq (Join-Path $BOOTSTRAP_DIR "updater-daemon.js")) -and
        ($LiteralPath -like "*.rollback-restore-*")) {
        throw "controlled updater recovery failure"
    }
    Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}
`, powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File'], scenario);
  });
});

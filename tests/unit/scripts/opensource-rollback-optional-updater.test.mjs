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
    expect(body).toContain('Remove-Item $dst -Force');
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

    const fn = extractShellFunction('sync_installed_scripts_from_version');
    const script = `
set -euo pipefail
BOOTSTRAP_DIR=${JSON.stringify(bootstrapDir)}
LOONGSUITE_PILOT_BIN=${JSON.stringify(pilotBin)}
${fn}
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

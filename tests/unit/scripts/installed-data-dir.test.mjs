import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const service = readFileSync(resolve('scripts/loongsuite-pilot.sh'), 'utf8');
const installer = readFileSync(resolve('deploy/installer-opensource.sh'), 'utf8');
let root;
let home;
let definitions;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pilot-installed-dir-'));
  home = join(root, 'home');
  mkdirSync(join(home, '.loongsuite-pilot'), { recursive: true });
  definitions = join(root, 'service-functions.sh');
  writeFileSync(definitions, service.split('# ---- Dispatch ----')[0]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(script, environment = {}) {
  return execFileSync('/bin/bash', ['-c', script, 'test', definitions], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, HOME: home, LOONGSUITE_PILOT_DATA_DIR: '', LOONGSUITE_PILOT_CACHE_DIR: '', ...environment },
  }).trimEnd();
}

describe.skipIf(process.platform !== 'linux')('installed data directory', () => {
  it.each([undefined, ''])('keeps the default directory without a nonempty install record (%s)', marker => {
    if (marker !== undefined) writeFileSync(join(home, '.loongsuite-pilot/data-dir'), marker);
    expect(run('source "$1"; printf "%s" "$CONFIG_FILE"')).toBe(join(home, '.loongsuite-pilot/config.json'));
  });

  it.each(['custom data', "数据 %n ' quoted \" directory"])('restores %s in a fresh CLI and installer process', name => {
    const selected = join(root, name);
    writeFileSync(join(home, '.loongsuite-pilot/data-dir'), selected + '\n');
    expect(run('source "$1"; printf "%s" "$CONFIG_FILE"')).toBe(join(selected, 'config.json'));
    const installerDefaults = installer.slice(0, installer.indexOf('# First arg is sub-command'));
    expect(run(installerDefaults + '\nprintf "%s" "$DATA_DIR"')).toBe(selected);
  });

  it('lets an explicit environment override the installed directory without rewriting it', () => {
    const marker = join(home, '.loongsuite-pilot/data-dir');
    writeFileSync(marker, join(root, 'installed') + '\n');
    const override = join(root, 'override');
    expect(run('source "$1"; printf "%s" "$CONFIG_FILE"', { LOONGSUITE_PILOT_DATA_DIR: override })).toBe(join(override, 'config.json'));
    const installerDefaults = installer.slice(0, installer.indexOf('# First arg is sub-command'));
    expect(run(installerDefaults + '\nprintf "%s" "$DATA_DIR"', { LOONGSUITE_PILOT_DATA_DIR: override })).toBe(override);
    expect(readFileSync(marker, 'utf8')).toBe(join(root, 'installed') + '\n');
  });

  it.each(['absolute', 'relative'])('persists an %s directory when installing and replacing the CLI', mode => {
    const selected = join(root, 'custom data');
    mkdirSync(selected);
    const packageDir = join(root, 'package');
    mkdirSync(join(packageDir, 'scripts'), { recursive: true });
    copyFileSync(resolve('scripts/loongsuite-pilot.sh'), join(packageDir, 'scripts/loongsuite-pilot.sh'));
    const installCommand = installer.match(/^install_loongsuite_pilot_command\(\) \{[\s\S]*?^\}/m)[0];
    for (let attempt = 0; attempt < 2; attempt++) {
      // Prevent the isolated fixture from creating a global /usr/local/bin link.
      run(`${installCommand}\nmsg() { :; }\nln() { :; }\ninstall_loongsuite_pilot_command`, {
        DATA_DIR: mode === 'relative' ? 'custom data' : selected, PERMANENT_DIR: packageDir,
      });
      expect(readFileSync(join(home, '.loongsuite-pilot/data-dir'), 'utf8')).toBe(selected + '\n');
      expect(readFileSync(join(home, '.local/bin/loongsuite-pilot'), 'utf8')).toBe(service);
      expect(run('source "$1"; printf "%s" "$DATA_DIR"')).toBe(selected);
    }
  });

  it.each([
    ['systemd-user', 'data with spaces'],
    ['systemd-system', 'data with spaces'],
    ['systemd-user', 'data "quoted" %n \\'],
    ['systemd-system', 'data "quoted" %n \\'],
  ])('%s units preserve %s for collector and updater', (kind, name) => {
    const selected = join(root, name);
    const escaped = selected.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
    mkdirSync(selected);
    run(`source "$1"
SYSTEMD_USER_UNIT_DIR="$HOME/units"
SYSTEMD_SYSTEM_UNIT_DIR="$HOME/units"
resolve_user_home() { printf '%s' "$HOME"; }
maybe_sudo() { "$@"; }
if [ "$UNIT_KIND" = systemd-user ]; then
  _write_systemd_user_unit
  _write_systemd_user_updater_unit
else
  _write_systemd_system_unit fixture
  _write_systemd_system_updater_unit fixture
fi`, { LOONGSUITE_PILOT_DATA_DIR: selected, UNIT_KIND: kind });
    for (const daemon of ['loongsuite-pilot', 'loongsuite-pilot-updater']) {
      const unitName = kind === 'systemd-user' ? `${daemon}.service` : `${daemon}-fixture.service`;
      const unit = readFileSync(join(home, 'units', unitName), 'utf8');
      expect(unit).toContain(`WorkingDirectory=${selected.replaceAll('%', '%%')}`);
      expect(unit).toContain(`Environment="LOONGSUITE_PILOT_DATA_DIR=${escaped}"`);
      expect(unit).toContain(`Environment="AGENT_DATA_COLLECTION_CONFIG=${escaped}/config.json"`);
    }
  });
});

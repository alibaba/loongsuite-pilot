import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const service = readFileSync(resolve('scripts/loongsuite-pilot.sh'), 'utf8');
const installer = readFileSync(resolve('deploy/installer-opensource.sh'), 'utf8');
let root;
let home;
let definitions;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pilot-installed-dir-')));
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

describe.skipIf(process.platform === 'win32')('installed data directory', () => {
  it.each([undefined, ''])('keeps the default directory without a nonempty install record (%s)', marker => {
    if (marker !== undefined) writeFileSync(join(home, '.loongsuite-pilot/data-dir'), marker);
    expect(run('source "$1"; printf "%s" "$CONFIG_FILE"')).toBe(join(home, '.loongsuite-pilot/config.json'));
    expect(run('source "$1"; printenv LOONGSUITE_PILOT_DATA_DIR || true')).toBe('');
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

  it('resolves the installer argument from its working directory before using it', () => {
    const marker = join(home, '.loongsuite-pilot/data-dir');
    writeFileSync(marker, join(root, 'installed') + '\n');
    const installerPrelude = installer.slice(0, installer.indexOf('# Validate current user'));
    const parse = 'set -- install --data-dir "relative override"\n' + installerPrelude + '\nprintf "%s" "$DATA_DIR"';
    expect(run(parse, { LOONGSUITE_PILOT_DATA_DIR: join(root, 'env override') })).toBe(join(root, 'relative override'));
  });

  it.each(['absolute', 'relative', 'aliased parent'])('persists the %s directory when installing and replacing the CLI', mode => {
    const selected = join(root, 'custom data');
    const nested = join(selected, 'nested');
    mkdirSync(nested, { recursive: true });
    const alias = join(root, 'link');
    symlinkSync(nested, alias);
    const packageDir = join(root, 'package');
    mkdirSync(join(packageDir, 'scripts'), { recursive: true });
    copyFileSync(resolve('scripts/loongsuite-pilot.sh'), join(packageDir, 'scripts/loongsuite-pilot.sh'));
    const cdpath = join(root, 'unrelated');
    mkdirSync(join(cdpath, 'custom data'), { recursive: true });
    const inputDir = { absolute: selected, relative: 'custom data', 'aliased parent': alias + sep + '..' }[mode];
    const installCommand = installer.match(/^install_loongsuite_pilot_command\(\) \{[\s\S]*?^\}/m)[0];
    for (let attempt = 0; attempt < 2; attempt++) {
      // Prevent the isolated fixture from creating a global /usr/local/bin link.
      run(`${installCommand}\nmsg() { :; }\nln() { :; }\ninstall_loongsuite_pilot_command`, {
        DATA_DIR: inputDir, PERMANENT_DIR: packageDir, CDPATH: cdpath,
        DEFAULT_DATA_DIR: join(home, '.loongsuite-pilot'),
        INSTALL_DATA_DIR_FILE: join(home, '.loongsuite-pilot/data-dir'),
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
      expect(unit).toContain(`WorkingDirectory=${selected.replaceAll('%', '%%')}/.\n`);
      expect(unit).toContain(`Environment="LOONGSUITE_PILOT_DATA_DIR=${escaped}"`);
      expect(unit).toContain(`Environment="AGENT_DATA_COLLECTION_CONFIG=${escaped}/config.json"`);
    }
  });

  it('writes and rereads the literal data directory in the actual config writer', () => {
    const selected = join(root, "data 'quoted' %n \\backup");
    const configFile = join(selected, 'config.json');
    mkdirSync(selected);
    writeFileSync(configFile, JSON.stringify({ userId: 'existing' }));
    const installerDefaults = installer.slice(0, installer.indexOf('# First arg is sub-command'));
    const writeConfig = installer.slice(installer.indexOf('write_config() {'), installer.indexOf('# Common: install/update'));
    run(installerDefaults + '\n' + writeConfig + '\nmsg() { :; }\nread_host_sn() { :; }\nwrite_config', {
      NODE_BIN: process.execPath, PROBE_RESULT: '[]', LOONGSUITE_PILOT_DATA_DIR: selected,
    });
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toMatchObject({ dataDir: selected, userId: 'existing' });
  });

  it.each(['run', 'run-updater'])('propagates config and data directory through the real %s entry', command => {
    const defaultDir = join(home, '.loongsuite-pilot');
    const selected = join(root, 'custom data');
    const bootstrapDir = join(defaultDir, 'bin');
    mkdirSync(bootstrapDir, { recursive: true });
    mkdirSync(selected);
    writeFileSync(join(defaultDir, 'data-dir'), selected + '\n');
    writeFileSync(join(defaultDir, 'node-bin'), process.execPath + '\n');
    const entry = command === 'run' ? 'collector-daemon.js' : 'updater-daemon.js';
    writeFileSync(join(bootstrapDir, entry), 'console.log(JSON.stringify([process.env.AGENT_DATA_COLLECTION_CONFIG, process.env.LOONGSUITE_PILOT_DATA_DIR]))');
    const launcher = join(root, 'loongsuite-pilot');
    copyFileSync(resolve('scripts/loongsuite-pilot.sh'), launcher);
    // Do not let a checkout's bootstrap assets replace the isolated fixture.
    const unrelated = join(root, 'unrelated');
    mkdirSync(unrelated);
    symlinkSync(launcher, join(unrelated, 'loongsuite-pilot'));
    const result = run('exec /bin/bash "$LAUNCHER" "$ENTRY"', { LAUNCHER: join(unrelated, 'loongsuite-pilot'), ENTRY: command });
    expect(JSON.parse(result)).toEqual([join(selected, 'config.json'), selected]);
  });
});

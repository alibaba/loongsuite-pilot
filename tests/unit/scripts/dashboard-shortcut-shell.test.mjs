import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root;
let options;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pilot-shortcut-shell-'));
  options = { configPath: join(root, "配置 ' with spaces/config.json"), cacheDir: join(root, 'pilot cache') };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('installer and shell integration', () => {
  it('dispatches to the current version with the pinned Node and exact config', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const command = join(bin, 'loongsuite-pilot');
    writeFileSync(command, readFileSync(resolve('scripts/loongsuite-pilot.sh')));
    mkdirSync(options.cacheDir);
    writeFileSync(join(options.cacheDir, 'node-bin'), process.execPath);
    for (const version of ['old', 'new']) {
      const scripts = join(options.cacheDir, 'versions', version, 'scripts');
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(scripts, 'dashboard-shortcut.mjs'),
        `console.log(JSON.stringify({version:${JSON.stringify(version)},config:process.env.AGENT_DATA_COLLECTION_CONFIG,args:process.argv.slice(2)}));`);
    }
    for (const version of ['old', 'new']) {
      writeFileSync(join(options.cacheDir, 'current'), version);
      for (const action of ['install', 'status', 'uninstall']) {
        const args = ['shortcut', action];
        const result = execFileSync('/bin/bash', [command, 'dashboard', ...args], { encoding: 'utf8', env: {
          ...process.env, PATH: '/usr/bin:/bin',
          LOONGSUITE_PILOT_CACHE_DIR: options.cacheDir,
          LOONGSUITE_PILOT_DATA_DIR: join(root, 'unused-data'),
          AGENT_DATA_COLLECTION_CONFIG: options.configPath,
        } });
        expect(JSON.parse(result)).toEqual({ version, config: options.configPath, args: [action] });
      }
    }
    expect(existsSync(join(root, 'unused-data'))).toBe(false);
  });
  it('uses a custom-directory Node pin with spaces without changing any pin', () => {
    const source = readFileSync(resolve('scripts/loongsuite-pilot.sh'), 'utf8');
    const command = source.slice(source.indexOf('cmd_dashboard()'), source.indexOf('cmd_token_usage()'));
    const configDir = join(root, 'custom data');
    const versionDir = join(root, 'version');
    const nodePath = join(root, 'managed node');
    mkdirSync(configDir);
    mkdirSync(join(versionDir, 'scripts'), { recursive: true });
    symlinkSync(process.execPath, nodePath);
    writeFileSync(join(configDir, 'node-bin'), nodePath + '\n');
    writeFileSync(join(versionDir, 'scripts/dashboard-shortcut.mjs'), 'console.log(process.env.AGENT_DATA_COLLECTION_CONFIG)');
    const result = execFileSync('/bin/bash', ['-c', `${command}
resolve_current_version() { printf '%s' "$TEST_VERSION_DIR"; }
_node_is_suitable() { [ -x "$1" ]; }
resolve_node() { echo 'fallback must not be called' >&2; return 1; }
cmd_dashboard shortcut status`], { encoding: 'utf8', env: {
      ...process.env, SCRIPT_DIR: join(root, 'bin'), TEST_VERSION_DIR: versionDir,
      CONFIG_FILE: join(configDir, 'config.json'), AGENT_DATA_COLLECTION_CONFIG: '  ' + join(configDir, 'config.json') + '  ',
      NODE_PIN_FILE: join(root, 'absent-cache/node-bin'),
    } });
    expect(result.trim()).toBe(join(configDir, 'config.json'));
    expect(readFileSync(join(configDir, 'node-bin'), 'utf8')).toBe(nodePath + '\n');
    expect(existsSync(join(root, 'absent-cache'))).toBe(false);
  });
  it('handles absent installation/runtime without starting a collector', () => {
    const source = readFileSync(resolve('scripts/loongsuite-pilot.sh'), 'utf8');
    const command = source.slice(source.indexOf('cmd_dashboard()'), source.indexOf('cmd_token_usage()'));
    expect(command).not.toMatch(/\n\s+(ensure_dirs|sync_bootstrap_scripts|cmd_start|cmd_stop|cmd_restart)\b/);
    expect(command).toContain('Dashboard shortcut command is missing');
  });
  it('keeps Node resolution read-only for dashboard while preserving other commands', () => {
    const source = readFileSync(resolve('scripts/loongsuite-pilot.sh'), 'utf8');
    const helper = source.slice(source.indexOf('resolve_node()'), source.indexOf('_detect_system_level_init()'));
    const pin = join(root, 'new-pin/node-bin');
    const script = `${helper}
_node_is_suitable() { [ "$1" = /usr/local/bin/node ]; }
_resolve_realpath() { printf '%s' "$TEST_NODE"; }
resolve_node false
[ ! -e "$NODE_PIN_FILE" ] || exit 10
resolve_node`;
    execFileSync('/bin/bash', ['-c', script], { env: {
      ...process.env, TEST_NODE: process.execPath, NODE_PIN_FILE: pin,
    } });
    expect(readFileSync(pin, 'utf8').trim()).toBe(process.execPath);
  });
  it('never installs shortcuts or edits the Dock during install/upgrade/start', () => {
    for (const file of ['deploy/installer-opensource.sh', 'src/index.ts', 'src/updater/updater.ts']) {
      if (!existsSync(resolve(file))) continue;
      const source = readFileSync(resolve(file), 'utf8');
      expect(source).not.toMatch(/install_dashboard_app|manage-dashboard-(app|shortcut)|shortcut install|com\.apple\.dock/);
    }
    const source = readFileSync(resolve('scripts/loongsuite-pilot.sh'), 'utf8');
    const start = source.slice(source.indexOf('cmd_start()'), source.indexOf('cmd_stop()'));
    expect(start).not.toMatch(/shortcut|com\.apple\.dock/);
  });
  it('ships source/icon/manager using the existing assets and scripts packaging', () => {
    const packaging = readFileSync(resolve('deploy/package-opensource.sh'), 'utf8');
    expect(packaging).toContain('cp -r assets');
    expect(packaging).toContain('cp -r scripts');
    expect(readFileSync(resolve('assets/dashboard-shortcut/AppIcon.icns')).subarray(0, 4).toString()).toBe('icns');
    const entry = readFileSync(resolve('scripts/dashboard-shortcut.mjs'), 'utf8');
    expect(entry).not.toMatch(/from ['"](?:[^n]|n(?!ode:))/);
    expect(readFileSync(resolve('build.mjs'), 'utf8')).not.toContain('dashboard-cli');
  });
  it('rejects old open/url commands before resolving a runtime or touching config', () => {
    for (const action of ['open', 'url']) {
      const result = spawnSync('/bin/bash', [resolve('scripts/loongsuite-pilot.sh'), 'dashboard', action], {
        encoding: 'utf8', env: { ...process.env, LOONGSUITE_PILOT_CACHE_DIR: options.cacheDir },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('dashboard shortcut {install|status|uninstall}');
      expect(existsSync(options.cacheDir)).toBe(false);
    }
  });
});

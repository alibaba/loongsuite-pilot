import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_NAME, installDashboardApp, uninstallDashboardApp } from '../../../scripts/manage-dashboard-app.mjs';

let root;
let options;
let appPath;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pilot-dashboard-app-'));
  options = {
    configPath: join(root, "配置 ' \" $() ;/config.json"),
    cacheDir: join(root, 'pilot cache'),
    commandPath: join(root, "bin ' \" $() ; 中文"),
    applicationsDir: join(root, 'Applications'),
  };
  writeFileSync(options.commandPath, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  appPath = join(options.applicationsDir, APP_NAME);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeTools() {
  return {
    platform: 'darwin',
    run: vi.fn((command, args) => {
      if (command === '/usr/bin/osacompile') {
        mkdirSync(join(args[1], 'Contents/Resources'), { recursive: true });
        writeFileSync(join(args[1], 'Contents/Info.plist'), '<plist/>');
      }
    }),
  };
}

describe('managed Dashboard app', () => {
  it('binds paths, not a port, and shell-quotes arbitrary installation paths', () => {
    installDashboardApp(options, fakeTools());
    const marker = JSON.parse(readFileSync(join(appPath, 'Contents/Resources/pilot-installation.json'), 'utf8'));
    expect(marker).toMatchObject({ configPath: options.configPath, cacheDir: options.cacheDir });
    const runner = join(appPath, 'Contents/Resources/open-dashboard.sh');
    expect(readFileSync(runner, 'utf8')).not.toContain('8765');
    // Exercise the real generated shell, not just a string snapshot.
    writeFileSync(options.commandPath,
      '#!/bin/bash\nprintf "%s\\n" "$AGENT_DATA_COLLECTION_CONFIG" "$LOONGSUITE_PILOT_CACHE_DIR" "${LOONGSUITE_PILOT_DATA_DIR-unset}" "$@"\n');
    const result = execFileSync('/bin/bash', [runner], { encoding: 'utf8' });
    expect(result.split('\n')).toEqual([options.configPath, options.cacheDir, 'unset', 'dashboard', 'open', '']);
    expect(readdirSync(options.applicationsDir)).toEqual([APP_NAME]);
  });
  it('updates only its managed app and removes it only for the matching config', () => {
    const tools = fakeTools();
    installDashboardApp(options, tools);
    const next = { ...options, configPath: join(root, 'new-config.json') };
    expect(installDashboardApp(next, tools).status).toBe('installed');
    expect(uninstallDashboardApp(options, tools).status).toBe('preserved');
    expect(uninstallDashboardApp(next, tools).status).toBe('removed');
    expect(uninstallDashboardApp(next, tools).status).toBe('absent');
  });
  it('preserves unrelated apps and symlinks on install and uninstall', () => {
    mkdirSync(appPath, { recursive: true });
    writeFileSync(join(appPath, 'user-file'), 'keep');
    expect(() => installDashboardApp(options, fakeTools())).toThrow('unmanaged');
    expect(uninstallDashboardApp(options, fakeTools()).status).toBe('preserved');
    expect(readFileSync(join(appPath, 'user-file'), 'utf8')).toBe('keep');
    // Replace only this test's fixture directory with a symlink to another fixture.
    rmSync(appPath, { recursive: true });
    const target = join(root, 'another-app');
    mkdirSync(target);
    symlinkSync(target, appPath);
    expect(() => installDashboardApp(options, fakeTools())).toThrow('unmanaged');
    expect(uninstallDashboardApp(options, fakeTools()).status).toBe('preserved');
    expect(existsSync(target)).toBe(true);
  });
  it('does not replace another cache installation', () => {
    installDashboardApp(options, fakeTools());
    const other = { ...options, cacheDir: join(root, 'other-cache') };
    expect(() => installDashboardApp(other, fakeTools())).toThrow('another Pilot');
    expect(uninstallDashboardApp(other, fakeTools()).status).toBe('preserved');
  });
  it.each(['/usr/bin/osacompile', '/usr/bin/codesign'])('keeps the previous app after %s failure', failedTool => {
    installDashboardApp(options, fakeTools());
    const original = readFileSync(join(appPath, 'Contents/Resources/pilot-installation.json'), 'utf8');
    const tools = fakeTools();
    const run = tools.run;
    tools.run = (command, args) => {
      if (command === failedTool) throw new Error('simulated tool failure');
      run(command, args);
    };
    expect(() => installDashboardApp(options, tools)).toThrow('simulated');
    expect(readFileSync(join(appPath, 'Contents/Resources/pilot-installation.json'), 'utf8')).toBe(original);
    expect(readdirSync(options.applicationsDir)).toEqual([APP_NAME]);
  });
  it('skips non-macOS without writing files or invoking tools', () => {
    const tools = { ...fakeTools(), platform: 'linux' };
    expect(installDashboardApp(options, tools).status).toBe('unsupported');
    expect(uninstallDashboardApp(options, tools).status).toBe('unsupported');
    expect(tools.run).not.toHaveBeenCalled();
    expect(existsSync(options.applicationsDir)).toBe(false);
  });
  it.skipIf(process.platform !== 'darwin')('compiles a real signed universal app with system tools', () => {
    expect(installDashboardApp(options).status).toBe('installed');
    const plist = join(appPath, 'Contents/Info.plist');
    for (const key of ['LSRequiresCarbon', 'CFBundleAllowMixedLocalizations', 'LSUIElement']) {
      expect(execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim()).toBe('true');
    }
    const binary = execFileSync('/usr/bin/file', [join(appPath, 'Contents/MacOS/applet')], { encoding: 'utf8' });
    expect(binary).toContain('arm64');
    expect(binary).toContain('x86_64');
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', appPath]);
    const source = execFileSync('/usr/bin/osadecompile', [join(appPath, 'Contents/Resources/Scripts/main.scpt')], { encoding: 'utf8' });
    expect(source).toContain('open-dashboard.sh');
    expect(source).not.toContain('8765');
  }, 60_000);
});

describe('installer and shell integration', () => {
  it('dispatches to the current version with the pinned Node and exact config', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const command = join(bin, 'loongsuite-pilot');
    writeFileSync(command, readFileSync(resolve('scripts/loongsuite-pilot.sh')));
    mkdirSync(options.cacheDir);
    writeFileSync(join(options.cacheDir, 'node-bin'), process.execPath);
    for (const version of ['old', 'new']) {
      const dist = join(options.cacheDir, 'versions', version, 'dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'dashboard-cli.cjs'),
        `console.log(JSON.stringify({version:${JSON.stringify(version)},config:process.env.AGENT_DATA_COLLECTION_CONFIG,args:process.argv.slice(2)}));`);
    }
    for (const version of ['old', 'new']) {
      writeFileSync(join(options.cacheDir, 'current'), version);
      const result = execFileSync('/bin/bash', [command, 'dashboard', 'url'], { encoding: 'utf8', env: {
        ...process.env, PATH: '/usr/bin:/bin',
        LOONGSUITE_PILOT_CACHE_DIR: options.cacheDir,
        LOONGSUITE_PILOT_DATA_DIR: join(root, 'unused-data'),
        AGENT_DATA_COLLECTION_CONFIG: options.configPath,
      } });
      expect(JSON.parse(result)).toEqual({ version, config: options.configPath, args: ['url'] });
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
    mkdirSync(join(versionDir, 'dist'), { recursive: true });
    symlinkSync(process.execPath, nodePath);
    writeFileSync(join(configDir, 'node-bin'), nodePath + '\n');
    writeFileSync(join(versionDir, 'dist/dashboard-cli.cjs'), 'console.log(process.env.AGENT_DATA_COLLECTION_CONFIG)');
    const result = execFileSync('/bin/bash', ['-c', `${command}
resolve_current_version() { printf '%s' "$TEST_VERSION_DIR"; }
_node_is_suitable() { [ -x "$1" ]; }
resolve_node() { echo 'fallback must not be called' >&2; return 1; }
cmd_dashboard url`], { encoding: 'utf8', env: {
      ...process.env, SCRIPT_DIR: join(root, 'bin'), TEST_VERSION_DIR: versionDir,
      CONFIG_FILE: join(configDir, 'config.json'), AGENT_DATA_COLLECTION_CONFIG: join(configDir, 'config.json'),
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
    expect(command).toContain('Dashboard launcher is missing');
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
  it('installs on install/successful upgrade and removes before deleting runtime', () => {
    const source = readFileSync(resolve('deploy/installer-opensource.sh'), 'utf8');
    const install = source.slice(source.indexOf('cmd_install()'), source.indexOf('cmd_upgrade()'));
    const upgrade = source.slice(source.indexOf('cmd_upgrade()'), source.indexOf('gc_old_versions()'));
    const uninstall = source.slice(source.indexOf('cmd_uninstall()'));
    expect(install.indexOf('install_dashboard_app')).toBeGreaterThan(install.indexOf('write_config'));
    expect(upgrade).toContain('install_dashboard_app');
    expect(uninstall.indexOf('remove_dashboard_app')).toBeLessThan(uninstall.indexOf('# Remove installation artifacts'));
    const helper = source.slice(source.indexOf('install_dashboard_app()'), source.indexOf('remove_dashboard_app()'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/manage-dashboard-app.mjs'), '// fixture: /usr/bin/false simulates failure');
    const result = execFileSync('/bin/bash', ['-c', `${helper}\nuname() { echo Darwin; }\nmsg() { :; }\ndashboard_app_manager() { printf '%s' "$PERMANENT_DIR/scripts/manage-dashboard-app.mjs"; }\ninstall_dashboard_app\nprintf success`], {
      encoding: 'utf8', env: { ...process.env, PERMANENT_DIR: root, DATA_DIR: root, NODE_BIN: '/usr/bin/false' },
    });
    expect(result).toContain('success');
  });
  it('locates the current installed manager for uninstall and upgrade repair', () => {
    const source = readFileSync(resolve('deploy/installer-opensource.sh'), 'utf8');
    const helper = source.slice(source.indexOf('dashboard_app_manager()'), source.indexOf('install_dashboard_app()'));
    const current = join(root, 'versions/current-version/scripts/manage-dashboard-app.mjs');
    mkdirSync(join(root, 'versions/current-version/scripts'), { recursive: true });
    writeFileSync(current, '// fixture');
    writeFileSync(join(root, 'current'), 'current-version\n');
    const result = execFileSync('/bin/bash', ['-c', `${helper}\ndashboard_app_manager "$1"`, 'test', root], {
      encoding: 'utf8', env: { ...process.env, PERMANENT_DIR: join(root, 'missing-legacy-package') },
    });
    expect(result.trim()).toBe(current);
  });
  it('ships source/icon/manager using the existing assets and scripts packaging', () => {
    const packaging = readFileSync(resolve('deploy/package-opensource.sh'), 'utf8');
    expect(packaging).toContain('cp -r assets');
    expect(packaging).toContain('cp -r scripts');
    expect(readFileSync(resolve('build.mjs'), 'utf8')).toContain("outfile: 'dist/dashboard-cli.cjs'");
    expect(readFileSync(resolve('assets/dashboard-launcher/AppIcon.icns')).subarray(0, 4).toString()).toBe('icns');
  });
});

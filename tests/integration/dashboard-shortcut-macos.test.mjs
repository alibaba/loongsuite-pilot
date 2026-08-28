import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Real Foundation/AppKit/defaults, but a disposable preferences domain and home.
// Never edits com.apple.dock, refreshes the user's Dock, or opens their browser.
describe.skipIf(process.platform !== 'darwin')('native macOS shortcut adapter', () => {
  let root;
  let domain;
  let harness;
  let request;
  let shortcut;
  let initial;
  const defaults = args => execFileSync('/usr/bin/defaults', args, { encoding: 'utf8' });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pilot-shortcut-native-')));
    domain = 'com.loongsuite-pilot.shortcut-test-' + randomUUID();
    const fixture = join(root, 'dock.plist');
    writeFileSync(fixture, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
      <key>persistent-apps</key><array><dict><key>bookmark</key><data>AQIDBA==</data><key>GUID</key><integer>123</integer></dict></array>
      <key>persistent-others</key><array><dict><key>tile-type</key><string>directory-tile</string><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file:///Users/test/Downloads/</string><key>bookmark</key><data>BQYHCA==</data></dict></dict></dict></array>
      <key>autohide</key><true/><key>tilesize</key><integer>44</integer></dict></plist>`);
    defaults(['import', domain, fixture]);
    initial = defaults(['export', domain, '-']);
    const source = readFileSync(resolve('scripts/manage-dashboard-shortcut.js'), 'utf8');
    harness = join(root, 'native-test.js');
    writeFileSync(harness, source + `
function run(argv) {
  try {
    const input = JSON.parse(argv[0]);
    const system = createMacSystem(input.domain);
    system.homePath = input.home;
    system.refreshDock = function () { return true; };
    // Keep the test's removed file in its temporary home, not in the user's Trash.
    system.trashShortcut = function (path) {
      if (!$.NSFileManager.defaultManager.moveItemAtPathToPathError(path, input.home + '/trashed.webloc', null)) throw new Error('fixture trash failed');
    };
    return JSON.stringify({ ok: true, result: manageShortcut(input.request, system) });
  } catch (error) { return JSON.stringify({ ok: false, error: String(error.message) }); }
}`);
    request = { action: 'install', configPath: join(root, "配置 ' $() ;/config.json"), url: 'http://127.0.0.1:9123/',
      iconPath: resolve('assets/dashboard-shortcut/AppIcon.icns'), iconVersion: 'a'.repeat(64) };
    shortcut = join(root, 'Library/Application Support/LoongSuite Pilot/Shortcuts/LoongSuite Pilot Dashboard.webloc');
  });
  afterEach(() => {
    if (domain) defaults(['delete', domain]);
    if (root) rmSync(root, { recursive: true, force: true });
  });
  function run(overrides = {}) {
    return JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', harness,
      JSON.stringify({ domain, home: root, request: { ...request, ...overrides } })], { encoding: 'utf8' }));
  }
  it('round-trips native plist data, installs a real custom icon, updates port and uninstalls', () => {
    const first = run();
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, result: { iconApplied: true, changed: true, dockMatches: 1 } });
    expect(statSync(shortcut).mode & 0o777).toBe(0o600);
    expect(statSync(first.result.backupPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(first.result.backupPath, 'utf8')).toContain('AQIDBA==');
    expect(execFileSync('/usr/bin/xattr', [shortcut], { encoding: 'utf8' })).toContain('com.apple.ResourceFork');
    const snapshot = defaults(['export', domain, '-']);
    expect(snapshot).toContain('BQYHCA==');
    expect(run().result.changed).toBe(false);
    expect(defaults(['export', domain, '-'])).toBe(snapshot);
    const status = run({ action: 'status', url: undefined });
    expect(status.result.url).toBe(request.url);
    expect(defaults(['export', domain, '-'])).toBe(snapshot);
    expect(run({ url: 'http://127.0.0.1:9124/', iconVersion: 'b'.repeat(64) }).result.changed).toBe(true);
    expect(run({ action: 'status' }).result.url).toBe('http://127.0.0.1:9124/');
    expect(defaults(['export', domain, '-'])).toBe(snapshot);
    const uninstall = run({ action: 'uninstall' });
    expect(uninstall, JSON.stringify(uninstall)).toMatchObject({ ok: true, result: { exists: false, dockMatches: 0 } });
    expect(existsSync(shortcut)).toBe(false);
    expect(existsSync(join(root, 'trashed.webloc'))).toBe(true);
    expect(defaults(['export', domain, '-'])).toBe(initial);
    expect(readdirSync(join(root, 'Library/Application Support/LoongSuite Pilot/Shortcuts/Backups'))).toHaveLength(2);
    expect(run({ action: 'uninstall' }).result.changed).toBe(false);
  }, 30_000);
  it('preserves unrelated files and symbolic-link parent directories', () => {
    const parent = join(root, 'Library/Application Support/LoongSuite Pilot/Shortcuts');
    mkdirSync(parent, { recursive: true });
    writeFileSync(shortcut, 'user content');
    expect(run()).toMatchObject({ ok: false });
    expect(readFileSync(shortcut, 'utf8')).toBe('user content');
    expect(defaults(['export', domain, '-'])).toBe(initial);
    rmSync(parent, { recursive: true });
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, parent);
    expect(run()).toMatchObject({ ok: false });
    expect(readdirSync(outside)).toEqual([]);
    expect(defaults(['export', domain, '-'])).toBe(initial);
  });
  it('allows read-only status but refuses mutations on a locked Dock', () => {
    defaults(['write', domain, 'contents-immutable', '-bool', 'true']);
    expect(run({ action: 'status' })).toMatchObject({ ok: true, result: { dockLocked: true, exists: false } });
    expect(run()).toMatchObject({ ok: false });
    expect(existsSync(shortcut)).toBe(false);
  });
  it('runs the shipped scripts without build output or dependencies and updates the stored port only on install', () => {
    const pkg = join(root, 'package with spaces');
    for (const dir of ['scripts', 'assets/dashboard-shortcut']) mkdirSync(join(pkg, dir), { recursive: true });
    const entry = join(pkg, 'scripts/dashboard-shortcut.mjs');
    copyFileSync(resolve('scripts/dashboard-shortcut.mjs'), entry);
    copyFileSync(request.iconPath, join(pkg, 'assets/dashboard-shortcut/AppIcon.icns'));
    const source = readFileSync(resolve('scripts/manage-dashboard-shortcut.js'), 'utf8');
    writeFileSync(join(pkg, 'scripts/manage-dashboard-shortcut.js'), source + `
function run(argv) {
  try {
    const system = createMacSystem(${JSON.stringify(domain)});
    system.homePath = ${JSON.stringify(root)};
    system.refreshDock = function () { return true; };
    system.trashShortcut = function (path) {
      if (!$.NSFileManager.defaultManager.moveItemAtPathToPathError(path, ${JSON.stringify(root + '/trashed.webloc')}, null)) throw new Error('fixture trash failed');
    };
    return JSON.stringify({ ok: true, result: manageShortcut(JSON.parse(argv[0]), system) });
  } catch (error) { return JSON.stringify({ ok: false, error: String(error.message) }); }
}`);
    const config = join(root, "配置 ' & spaces.json");
    const cli = action => execFileSync(process.execPath, [entry, action], { encoding: 'utf8', env: {
      ...process.env, AGENT_DATA_COLLECTION_CONFIG: config, LOONGSUITE_PILOT_LANG: 'en', NODE_PATH: '',
    } });
    writeFileSync(config, '\uFEFF' + JSON.stringify({ dashboard: { port: 9130 }, dataDir: root }));
    expect(cli('install')).toContain('http://127.0.0.1:9130/');
    const snapshot = defaults(['export', domain, '-']);
    writeFileSync(config, JSON.stringify({ dashboard: { port: 9131 }, dataDir: root }));
    expect(cli('status')).toContain('http://127.0.0.1:9130/');
    expect(cli('install')).toContain('http://127.0.0.1:9131/');
    expect(defaults(['export', domain, '-'])).toBe(snapshot);
    rmSync(config);
    rmSync(join(pkg, 'assets/dashboard-shortcut/AppIcon.icns'));
    expect(cli('status')).toContain('http://127.0.0.1:9131/');
    expect(cli('uninstall')).toContain('Shortcut: not installed');
    expect(defaults(['export', domain, '-'])).toBe(initial);
    expect(existsSync(join(pkg, 'node_modules'))).toBe(false);
    expect(existsSync(join(pkg, 'dist'))).toBe(false);
    expect(existsSync(join(pkg, 'src'))).toBe(false);
  }, 30_000);
  it('refuses an existing operation lock without touching the shortcut or Dock', () => {
    const base = join(root, 'Library/Application Support/LoongSuite Pilot/Shortcuts');
    mkdirSync(join(base, 'Operation.lock'), { recursive: true });
    const result = run();
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('Another shortcut command');
    expect(existsSync(shortcut)).toBe(false);
    expect(existsSync(join(base, 'Operation.lock'))).toBe(true);
    expect(defaults(['export', domain, '-'])).toBe(initial);
  });
});

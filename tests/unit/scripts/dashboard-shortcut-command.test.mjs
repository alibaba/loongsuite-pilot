import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadShortcutUrl, runShortcutCommand, shortcutConfigPath } from '../../../scripts/dashboard-shortcut.mjs';
import { loadConfig } from '../../../src/core/config-loader.ts';
import { configJsonPath } from '../../../src/utils/data-dir.ts';

vi.mock('../../../src/utils/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let root;
let config;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pilot-shortcut-command-'));
  config = join(root, 'config.json');
  vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', config);
  vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('configuration parity with the unchanged collector', () => {
  it.each([undefined, null, 0, -1, 65536, 1.5, '9000', '', [], {}, NaN, Infinity, 1, 80, 9000, 65535])('matches dashboard.port=%j', async port => {
    await writeFile(config, JSON.stringify({ dashboard: { port }, dataDir: root }));
    expect(await loadShortcutUrl(config)).toBe(`http://127.0.0.1:${(await loadConfig()).dashboard.port}/`);
  });
  it.each([undefined, '', '  ', '~', '~/pilot config/config.json', './relative config.json', "/tmp/配置 ' & file.json"])
  ('matches config path resolution for %j', value => {
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', value);
    expect(shortcutConfigPath()).toBe(resolve(configJsonPath()));
  });
  it('reads a BOM-prefixed custom config and picks up port changes', async () => {
    config = join(root, "配置 ' $() ;.json");
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', '  ' + config + '  ');
    await writeFile(config, '\uFEFF' + JSON.stringify({ dashboard: { port: 9101 }, dataDir: root }));
    expect(shortcutConfigPath()).toBe(resolve(configJsonPath()));
    expect(await loadShortcutUrl(shortcutConfigPath())).toBe(`http://127.0.0.1:${(await loadConfig()).dashboard.port}/`);
    await writeFile(config, JSON.stringify({ dashboard: { port: 9102 }, dataDir: root }));
    expect(await loadShortcutUrl(shortcutConfigPath())).toBe('http://127.0.0.1:9102/');
  });
  it.each([undefined, '{"secret":"do-not-print"', 'null', '[]'])('matches the collector for missing/malformed config %j', async content => {
    if (content !== undefined) await writeFile(config, content);
    expect(await loadShortcutUrl(config)).toBe(`http://127.0.0.1:${(await loadConfig()).dashboard.port}/`);
  });
});

describe('shortcut command only', () => {
  function dependencies() {
    return {
      platform: 'darwin', language: 'zh_CN', stdout: vi.fn(), stderr: vi.fn(),
      configPath: vi.fn(() => config), loadUrl: vi.fn().mockResolvedValue('http://127.0.0.1:9001/'),
      shortcut: vi.fn().mockResolvedValue({ shortcutPath: '/Users/test/Pilot.webloc', exists: true,
        managed: true, url: 'http://127.0.0.1:9001/', dockMatches: 1, dockLocked: false,
        changed: false, backupPath: null, warnings: [] }),
    };
  }
  it('installs with the configured URL', async () => {
    const deps = dependencies();
    expect(await runShortcutCommand(['install'], deps)).toBe(0);
    expect(deps.shortcut).toHaveBeenCalledWith('install', config, 'http://127.0.0.1:9001/');
    expect(deps.stdout.mock.calls.flat().join('')).toContain('端口变更');
  });
  it.each(['status', 'uninstall'])('%s does not read the config contents', async action => {
    const deps = dependencies();
    deps.loadUrl.mockRejectedValue(new Error('config missing'));
    expect(await runShortcutCommand([action], deps)).toBe(0);
    expect(deps.loadUrl).not.toHaveBeenCalled();
    expect(deps.shortcut).toHaveBeenCalledWith(action, config, undefined);
    expect(deps.stdout.mock.calls.flat().join('')).toContain('目标网址: http://127.0.0.1:9001/');
  });
  it.each(['linux', 'win32'])('rejects platform %s before reading config or invoking native code', async platform => {
    const deps = dependencies();
    expect(await runShortcutCommand(['install'], { ...deps, platform })).toBe(1);
    expect(deps.shortcut).not.toHaveBeenCalled();
    expect(deps.configPath).not.toHaveBeenCalled();
  });
  it('rejects legacy and invalid commands without touching installation state', async () => {
    const deps = dependencies();
    expect(await runShortcutCommand(['--help'], deps)).toBe(0);
    for (const args of [[], ['open'], ['url'], ['install', '--port', '9000']]) {
      expect(await runShortcutCommand(args, deps)).toBe(2);
    }
    expect(deps.shortcut).not.toHaveBeenCalled();
    expect(deps.configPath).not.toHaveBeenCalled();
  });
  it('does not leak configuration or process output on errors', async () => {
    const deps = dependencies();
    deps.shortcut.mockRejectedValue(new Error('secret child output'));
    expect(await runShortcutCommand(['install'], deps)).toBe(1);
    expect(deps.stderr.mock.calls.flat().join('')).not.toContain('secret');
  });
});

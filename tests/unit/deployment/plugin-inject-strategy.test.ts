import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PluginInjectStrategy } from '../../../src/deployment/plugin-inject-strategy.js';
import type { AgentDefinition } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('PluginInjectStrategy', () => {
  let tmpDir: string;
  let dataDir: string;
  let settingsPath: string;
  let strategy: PluginInjectStrategy;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-inject-'));
    dataDir = path.join(tmpDir, 'pilot-data');
    settingsPath = path.join(tmpDir, '.pi', 'agent', 'settings.json');
    strategy = new PluginInjectStrategy(dataDir, tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function piDefinition(overrides: Partial<AgentDefinition['pluginInject']> = {}): AgentDefinition {
    return {
      id: 'pi-coding-agent',
      displayName: 'Pi Coding Agent',
      deployMode: 'plugin-inject',
      detection: { paths: [], commands: [] },
      pluginInject: {
        configPaths: [settingsPath],
        pluginSpec: '$PILOT_DATA/plugins/pi-coding-agent/index.mjs',
        pluginId: 'loongsuite-pilot-pi-coding-agent',
        configKey: 'extensions',
        createIfMissing: true,
        ...overrides,
      },
    };
  }

  it('injects an extension path into a configured array field', async () => {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({ theme: 'dark', extensions: ['/other.mjs'] }));

    const result = await strategy.deploy(piDefinition());

    expect(result.success).toBe(true);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(settings.theme).toBe('dark');
    expect(settings.extensions).toEqual([
      '/other.mjs',
      path.join(dataDir, 'plugins', 'pi-coding-agent', 'index.mjs'),
    ]);
    expect(await strategy.needsDeploy(piDefinition())).toBe(false);
  });

  it('creates the first config path when createIfMissing is enabled', async () => {
    const result = await strategy.deploy(piDefinition());

    expect(result.success).toBe(true);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(settings.extensions).toEqual([
      path.join(dataDir, 'plugins', 'pi-coding-agent', 'index.mjs'),
    ]);
    if (process.platform !== 'win32') {
      expect((await fs.stat(settingsPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('does not create a missing config during a read-only health check', async () => {
    expect(await strategy.needsDeploy(piDefinition())).toBe(true);
    await expect(fs.access(settingsPath)).rejects.toThrow();
  });

  it('does not create a missing config when createIfMissing is disabled', async () => {
    const result = await strategy.deploy(piDefinition({ createIfMissing: false }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('no config file found');
    await expect(fs.access(settingsPath)).rejects.toThrow();
  });

  it('is idempotent and removes the injected extension on undeploy', async () => {
    await strategy.deploy(piDefinition());
    await strategy.deploy(piDefinition());

    const before = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(before.extensions).toHaveLength(1);

    expect(await strategy.undeploy(piDefinition())).toBe(true);
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(after.extensions).toEqual([]);
  });

  it('keeps the existing OpenCode plugin/plugins auto-detection behavior', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    await fs.writeFile(configPath, JSON.stringify({ plugins: ['existing'] }));
    const def = piDefinition({
      configPaths: [configPath],
      pluginSpec: 'file://$PILOT_DATA/plugins/opencode/plugin.mjs',
      pluginId: 'loongsuite-pilot-opencode',
      configKey: undefined,
      createIfMissing: false,
    });

    await strategy.deploy(def);

    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(config.plugins).toEqual([
      'existing',
      `file://${path.join(dataDir, 'plugins', 'opencode', 'plugin.mjs')}`,
    ]);
    expect(config.plugin).toBeUndefined();
  });
});

describe('PluginInjectStrategy — openclaw-nested shape', () => {
  let tmpDir: string;
  let dataDir: string;
  let configPath: string;
  let strategy: PluginInjectStrategy;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-inject-openclaw-'));
    dataDir = path.join(tmpDir, 'pilot-data');
    configPath = path.join(tmpDir, '.openclaw', 'openclaw.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    strategy = new PluginInjectStrategy(dataDir, tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function openclawDef(overrides: Partial<AgentDefinition['pluginInject']> = {}): AgentDefinition {
    return {
      id: 'openclaw',
      displayName: 'OpenClaw',
      deployMode: 'plugin-inject',
      detection: { paths: [], commands: [] },
      pluginInject: {
        configPaths: [configPath],
        pluginSpec: 'file://$PILOT_DATA/plugins/openclaw',
        pluginId: 'loongsuite-pilot-openclaw',
        replaceSpecs: [
          'loongsuite-pilot-openclaw',
          'loongsuite-pilot-openclaw-smoke',
          'plugins/openclaw/plugin.mjs',
        ],
        configShape: 'openclaw-nested',
        createIfMissing: true,
        ...overrides,
      },
    };
  }

  async function readConfig(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(configPath, 'utf8'));
  }

  it('writes plugins.load.paths + plugins.entries.<id> with enabled+hooks', async () => {
    await strategy.deploy(openclawDef());
    const cfg = await readConfig();
    const plugins = cfg.plugins as { load: { paths: unknown[] }; entries: Record<string, unknown> };
    expect(Array.isArray(plugins.load.paths)).toBe(true);
    expect(plugins.load.paths).toContain(`${dataDir}/plugins/openclaw`);
    expect(plugins.load.paths).not.toContain(`file://${dataDir}/plugins/openclaw`);
    expect(plugins.entries['loongsuite-pilot-openclaw']).toEqual({
      enabled: true,
      hooks: { allowConversationAccess: true },
    });
    // Must NOT write the legacy flat-array shape.
    expect(Array.isArray(cfg.plugin)).toBe(false);
    expect(Array.isArray(cfg.plugins)).toBe(false);
  });

  it('needsDeploy returns true when only path is present (entry missing)', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      plugins: { load: { paths: [`file://${dataDir}/plugins/openclaw`] }, entries: {} },
    }));
    expect(await strategy.needsDeploy(openclawDef())).toBe(true);
  });

  it('needsDeploy returns true when entry enabled but path missing', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      plugins: { load: { paths: [] }, entries: { 'loongsuite-pilot-openclaw': { enabled: true, hooks: { allowConversationAccess: true } } } },
    }));
    expect(await strategy.needsDeploy(openclawDef())).toBe(true);
  });

  it('needsDeploy returns true when required conversation hook access is disabled', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      plugins: {
        load: { paths: [`${dataDir}/plugins/openclaw`] },
        entries: {
          'loongsuite-pilot-openclaw': {
            enabled: true,
            hooks: { allowConversationAccess: false },
          },
        },
      },
    }));

    expect(await strategy.needsDeploy(openclawDef())).toBe(true);
  });

  it('needsDeploy returns false once both path + entry are in place', async () => {
    await strategy.deploy(openclawDef());
    expect(await strategy.needsDeploy(openclawDef())).toBe(false);
  });

  it('validates a supplied entryConfig as a required deep subset', async () => {
    const desired = {
      enabled: true,
      hooks: { allowConversationAccess: true },
      config: { captureMessageContent: false },
    };
    await strategy.deploy(openclawDef());
    expect(await strategy.needsDeploy(openclawDef({ entryConfig: desired }))).toBe(true);

    await strategy.deploy(openclawDef({ entryConfig: desired }));
    expect(await strategy.needsDeploy(openclawDef({ entryConfig: desired }))).toBe(false);
    const cfg = await readConfig();
    const plugins = cfg.plugins as { entries: Record<string, unknown> };
    expect(plugins.entries['loongsuite-pilot-openclaw']).toEqual(desired);
  });

  it('preserves existing plugins.load.paths entries and unrelated entries', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      plugins: {
        load: { paths: ['file:///other/plugin.mjs'] },
        entries: { 'other-plugin': { enabled: true } },
      },
    }));
    await strategy.deploy(openclawDef());
    const cfg = await readConfig();
    const plugins = cfg.plugins as { load: { paths: string[] }; entries: Record<string, unknown> };
    expect(plugins.load.paths).toContain('file:///other/plugin.mjs');
    expect(plugins.entries['other-plugin']).toEqual({ enabled: true });
  });

  it('deep-merges the required entry config without deleting unrelated settings', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      plugins: {
        load: { paths: [`${dataDir}/plugins/openclaw`] },
        entries: {
          'loongsuite-pilot-openclaw': {
            enabled: true,
            hooks: { allowConversationAccess: false, customHookSetting: 'keep-me' },
            config: { captureMessageContent: false },
          },
        },
      },
    }));

    await strategy.deploy(openclawDef());
    const cfg = await readConfig();
    const plugins = cfg.plugins as { entries: Record<string, Record<string, unknown>> };
    expect(plugins.entries['loongsuite-pilot-openclaw']).toEqual({
      enabled: true,
      hooks: { allowConversationAccess: true, customHookSetting: 'keep-me' },
      config: { captureMessageContent: false },
    });
  });

  it('undeploy removes both the path and the entry', async () => {
    await strategy.deploy(openclawDef());
    await strategy.undeploy(openclawDef());
    const cfg = await readConfig();
    const plugins = cfg.plugins as { load: { paths: unknown[] }; entries: Record<string, unknown> };
    expect(plugins.load.paths).not.toContain(`${dataDir}/plugins/openclaw`);
    expect(plugins.entries['loongsuite-pilot-openclaw']).toBeUndefined();
  });

  it('replaceSpecs removes legacy paths but preserves unrelated entries', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      plugins: {
        load: {
          paths: [
            'file:///old/loongsuite-pilot-openclaw-smoke/plugin.mjs',
            'file:///other/plugin.mjs',
          ],
        },
        entries: { 'other-plugin': { enabled: true } },
      },
    }));
    await strategy.deploy(openclawDef({ replaceSpecs: ['loongsuite-pilot-openclaw-smoke'] }));
    const cfg = await readConfig();
    const plugins = cfg.plugins as { load: { paths: string[] }; entries: Record<string, unknown> };
    expect(plugins.load.paths).not.toContain('file:///old/loongsuite-pilot-openclaw-smoke/plugin.mjs');
    expect(plugins.load.paths).toContain('file:///other/plugin.mjs');
    expect(plugins.entries['other-plugin']).toEqual({ enabled: true });
  });

  it('migrates the previous managed single-file path to the package directory', async () => {
    const oldPath = `${dataDir}/plugins/openclaw/plugin.mjs`;
    await fs.writeFile(configPath, JSON.stringify({
      plugins: {
        load: { paths: [oldPath, '/other/plugin.mjs'] },
        entries: {
          'loongsuite-pilot-openclaw': {
            enabled: true,
            hooks: { allowConversationAccess: true },
          },
        },
      },
    }));

    expect(await strategy.needsDeploy(openclawDef())).toBe(true);
    await strategy.deploy(openclawDef());

    const cfg = await readConfig();
    const plugins = cfg.plugins as { load: { paths: string[] } };
    expect(plugins.load.paths).toContain(`${dataDir}/plugins/openclaw`);
    expect(plugins.load.paths).not.toContain(oldPath);
    expect(plugins.load.paths).toContain('/other/plugin.mjs');
  });

  it('is idempotent on repeated deploys', async () => {
    await strategy.deploy(openclawDef());
    const after1 = await readConfig();
    await strategy.deploy(openclawDef());
    const after2 = await readConfig();
    expect(after2).toEqual(after1);
  });

  it('migrates legacy arrays without dropping unrelated plugin paths and creates a backup', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      plugin: ['file:///old/loongsuite-pilot-openclaw/plugin.mjs'],
      plugins: ['file:///legacy/plugin.mjs'],
    }));
    expect(await strategy.needsDeploy(openclawDef())).toBe(true);
    await strategy.deploy(openclawDef());
    const cfg = await readConfig();
    expect(Array.isArray(cfg.plugin)).toBe(false);
    expect(Array.isArray(cfg.plugins)).toBe(false);
    const plugins = cfg.plugins as { load: { paths: string[] }; entries: Record<string, unknown> };
    expect(plugins.load.paths).toContain(`${dataDir}/plugins/openclaw`);
    expect(plugins.load.paths).toContain('/legacy/plugin.mjs');
    expect(plugins.entries['loongsuite-pilot-openclaw']).toEqual({
      enabled: true,
      hooks: { allowConversationAccess: true },
    });
    const backup = JSON.parse(await fs.readFile(`${configPath}.bak`, 'utf8'));
    expect(backup.plugins).toEqual(['file:///legacy/plugin.mjs']);
    if (process.platform !== 'win32') {
      expect((await fs.stat(`${configPath}.bak`)).mode & 0o777).toBe(0o600);
    }
  });
});

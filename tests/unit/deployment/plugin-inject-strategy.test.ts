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

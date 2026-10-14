import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginInjectStrategy } from '../../../src/deployment/plugin-inject-strategy.js';
import type { AgentDefinition } from '../../../src/types/index.js';

describe('OpenCode V1/V2 directory plugin migration', () => {
  let root: string, configPath: string, dataDir: string, strategy: PluginInjectStrategy, def: AgentDefinition;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-v2-config-'));
    dataDir = path.join(root, 'pilot data'); configPath = path.join(root, 'opencode.json');
    strategy = new PluginInjectStrategy(dataDir, root);
    def = JSON.parse(await fs.readFile(new URL('../../../agents.d/opencode.json', import.meta.url), 'utf8'));
    def.pluginInject!.configPaths = [configPath];
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('migrates old file URIs and object entries across both config keys without touching other plugins', async () => {
    const legacy = pathToFileURL(path.join(dataDir, 'plugins/opencode/plugin.mjs')).href;
    await fs.writeFile(configPath, JSON.stringify({
      plugin: [legacy, 'third-party-v1'],
      plugins: [{ package: legacy, options: {} }, { package: '/other/plugins/opencode-extra', options: { keep: true } }],
    }));
    expect(await strategy.needsDeploy(def)).toBe(true);
    expect((await strategy.deploy(def)).success).toBe(true);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(config.plugin).toEqual(['third-party-v1']);
    expect(config.plugins).toEqual([{ package: '/other/plugins/opencode-extra', options: { keep: true } }, `file://${dataDir}/plugins/opencode`]);
    expect(await strategy.needsDeploy(def)).toBe(false);
    await strategy.deploy(def);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual(config);
    expect(await strategy.undeploy(def)).toBe(true);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).plugins).toEqual([{ package: '/other/plugins/opencode-extra', options: { keep: true } }]);
  });

  it('removes both legacy and current entries on uninstall, even before migration', async () => {
    await fs.writeFile(configPath, JSON.stringify({ plugin: [`file://${dataDir}/plugins/opencode/plugin.mjs`], plugins: [`file://${dataDir}/plugins/opencode`, 'third-party'] }));
    expect(await strategy.undeploy(def)).toBe(true);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual({ plugin: [], plugins: ['third-party'] });
  });

  it('detects a reintroduced old spec and repairs it to exactly one directory reference', async () => {
    await fs.writeFile(configPath, '{}'); await strategy.deploy(def);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.plugin.push(`file://${dataDir}/plugins/opencode/plugin.mjs`);
    await fs.writeFile(configPath, JSON.stringify(config));
    expect(await strategy.needsDeploy(def)).toBe(true);
    await strategy.deploy(def);
    expect(await strategy.needsDeploy(def)).toBe(false);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).plugin).toHaveLength(1);
  });
});

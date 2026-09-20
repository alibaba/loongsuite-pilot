import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CopilotPluginStrategy,
  buildPluginManifest,
  buildPluginHooksJson,
} from '../../../src/deployment/copilot-plugin-strategy.js';
import type {
  AgentDefinition,
  CopilotPluginHookConfig,
} from '../../../src/types/index.js';

const HOOK_COMMAND = '/tmp/pilot-data/hooks/copilot-loongsuite-pilot-hook.sh';
const EVENTS = [
  'sessionStart',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'sessionEnd',
  'agentStop',
];

function buildCfg(pluginRoot: string, settingsPath: string, configPath: string): CopilotPluginHookConfig {
  return {
    pluginRoot,
    pluginId: 'loongsuite-pilot',
    settingsPath,
    configPath,
    events: EVENTS,
    hookCommand: HOOK_COMMAND,
    format: 'nested',
    eventSubcommand: 'kebab-case',
    timeoutSec: 5,
  };
}

function buildDef(pluginRoot: string, settingsPath: string, configPath: string): AgentDefinition {
  return {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    deployMode: 'copilot-plugin',
    detection: { paths: [pluginRoot], commands: ['copilot'] },
    copilotPlugin: buildCfg(pluginRoot, settingsPath, configPath),
  };
}

describe('CopilotPluginStrategy — manifest + hooks generation', () => {
  it('buildPluginManifest produces Agent Plugins 1.0 shape', () => {
    const m = buildPluginManifest();
    expect(m.name).toBe('loongsuite-pilot');
    expect(m.version).toBe('0.1.0');
    expect(m.hooks).toBe('hooks/hooks.json');
    expect(m.author.name).toBe('loongsuite-pilot');
    expect(m.license).toBe('Apache-2.0');
  });

  it('buildPluginHooksJson contains all 7 events in camelCase', () => {
    const cfg = buildCfg('/tmp/x', '/tmp/s.json', '/tmp/c.json');
    const h = buildPluginHooksJson(cfg);
    expect(h.version).toBe(1);
    expect(Object.keys(h.hooks).sort()).toEqual([...EVENTS].sort());
    for (const event of EVENTS) {
      expect(Array.isArray(h.hooks[event])).toBe(true);
      expect(h.hooks[event][0].type).toBe('command');
      expect(h.hooks[event][0].timeoutSec).toBe(5);
    }
  });

  it('kebab-case eventSubcommand appends subcommand to hookCommand per event', () => {
    const cfg = buildCfg('/tmp/x', '/tmp/s.json', '/tmp/c.json');
    const h = buildPluginHooksJson(cfg);
    expect(h.hooks['sessionStart'][0].command).toBe(`${HOOK_COMMAND} session-start`);
    expect(h.hooks['userPromptSubmitted'][0].command).toBe(`${HOOK_COMMAND} user-prompt-submitted`);
    expect(h.hooks['postToolUseFailure'][0].command).toBe(`${HOOK_COMMAND} post-tool-use-failure`);
  });

  it('undefined eventSubcommand uses bare hookCommand for all events', () => {
    const cfg: CopilotPluginHookConfig = {
      ...buildCfg('/tmp/x', '/tmp/s.json', '/tmp/c.json'),
      eventSubcommand: undefined,
    };
    const h = buildPluginHooksJson(cfg);
    for (const event of EVENTS) {
      expect(h.hooks[event][0].command).toBe(HOOK_COMMAND);
    }
  });
});

describe('CopilotPluginStrategy — deploy / needsDeploy / undeploy', () => {
  let tmpDir: string;
  let strategy: CopilotPluginStrategy;
  let pluginRoot: string;
  let settingsPath: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-plugin-'));
    strategy = new CopilotPluginStrategy({ homeDir: tmpDir, dataDir: path.join(tmpDir, 'pilot data') });
    pluginRoot = path.join(tmpDir, 'installed-plugins', 'loongsuite-pilot', 'loongsuite-pilot');
    settingsPath = path.join(tmpDir, '.copilot', 'settings.json');
    configPath = path.join(tmpDir, '.copilot', 'config.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('deploy writes plugin.json + hooks/hooks.json and registers in settings.json + config.json', async () => {
    const def = buildDef(pluginRoot, settingsPath, configPath);
    const result = await strategy.deploy(def);
    expect(result.success).toBe(true);
    expect(result.deployMode).toBe('copilot-plugin');

    const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'plugin.json'), 'utf-8'));
    expect(manifest.name).toBe('loongsuite-pilot');
    expect(manifest.hooks).toBe('hooks/hooks.json');

    const hooksFile = JSON.parse(await fs.readFile(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf-8'));
    expect(hooksFile.version).toBe(1);
    expect(Object.keys(hooksFile.hooks).sort()).toEqual([...EVENTS].sort());
    expect(hooksFile.hooks['sessionStart'][0].command).toBe(`${HOOK_COMMAND} session-start`);

    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
    expect(settings.enabledPlugins).toEqual({ 'loongsuite-pilot@loongsuite-pilot': true });

    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(Array.isArray(config.installedPlugins)).toBe(true);
    const entry = config.installedPlugins.find((e: any) => e.name === 'loongsuite-pilot');
    expect(entry).toBeDefined();
    expect(entry.enabled).toBe(true);
    expect(entry.cache_path).toBe(pluginRoot);
  });

  it('needsDeploy returns false after a successful deploy', async () => {
    const def = buildDef(pluginRoot, settingsPath, configPath);
    await strategy.deploy(def);
    const needs = await strategy.needsDeploy(def);
    expect(needs).toBe(false);
  });

  it('needsDeploy returns true when manifest is missing', async () => {
    const def = buildDef(pluginRoot, settingsPath, configPath);
    const needs = await strategy.needsDeploy(def);
    expect(needs).toBe(true);
  });

  it('needsDeploy returns true when settings.json lacks enabledPlugins entry', async () => {
    const def = buildDef(pluginRoot, settingsPath, configPath);
    await strategy.deploy(def);
    const raw = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
    delete raw.enabledPlugins;
    await fs.writeFile(settingsPath, JSON.stringify(raw), 'utf-8');
    const needs = await strategy.needsDeploy(def);
    expect(needs).toBe(true);
  });

  it('undeploy removes plugin package and unregisters from settings.json + config.json', async () => {
    const def = buildDef(pluginRoot, settingsPath, configPath);
    await strategy.deploy(def);
    const ok = await strategy.undeploy(def);
    expect(ok).toBe(true);
    expect(fsSync.existsSync(pluginRoot)).toBe(false);

    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
    expect(settings.enabledPlugins?.['loongsuite-pilot@loongsuite-pilot'] ?? false).toBe(false);

    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const stillThere = (config.installedPlugins ?? []).find((e: any) => e.name === 'loongsuite-pilot');
    expect(stillThere).toBeUndefined();
  });

  it('deploy is idempotent — second deploy does not duplicate enabledPlugins', async () => {
    const def = buildDef(pluginRoot, settingsPath, configPath);
    await strategy.deploy(def);
    await strategy.deploy(def);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
    const count = Object.keys(settings.enabledPlugins ?? {})
      .filter(k => k === 'loongsuite-pilot@loongsuite-pilot').length;
    expect(count).toBe(1);

    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const countCfg = (config.installedPlugins as any[])
      .filter((e: any) => e.name === 'loongsuite-pilot' && e.marketplace === 'loongsuite-pilot').length;
    expect(countCfg).toBe(1);
  });

  it('deploy preserves existing enabledPlugins entries (e.g. spark@copilot-plugins)', async () => {
    const def = buildDef(pluginRoot, settingsPath, configPath);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ enabledPlugins: { 'spark@copilot-plugins': true } }, null, 2),
      'utf-8',
    );
    const result = await strategy.deploy(def);
    expect(result.success).toBe(true);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
    expect(settings.enabledPlugins['spark@copilot-plugins']).toBe(true);
    expect(settings.enabledPlugins['loongsuite-pilot@loongsuite-pilot']).toBe(true);
  });

  it('deploy handles JSONC comments in existing settings.json', async () => {
    const def = buildDef(pluginRoot, settingsPath, configPath);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      `{
  // user comment
  "enabledPlugins": {
    "spark@copilot-plugins": true
  }
}`,
      'utf-8',
    );
    const result = await strategy.deploy(def);
    expect(result.success).toBe(true);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
    expect(settings.enabledPlugins['spark@copilot-plugins']).toBe(true);
    expect(settings.enabledPlugins['loongsuite-pilot@loongsuite-pilot']).toBe(true);
  });

  it('deploy with missing copilotPlugin config fails cleanly', async () => {
    const def: AgentDefinition = {
      id: 'copilot',
      displayName: 'X',
      deployMode: 'copilot-plugin',
      detection: { paths: [tmpDir], commands: [] },
    };
    const result = await strategy.deploy(def);
    expect(result.success).toBe(false);
    expect(result.error).toContain('missing copilotPlugin');
  });
});

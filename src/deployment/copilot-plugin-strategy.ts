import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type {
  AgentDefinition,
  CopilotPluginHookConfig,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
} from '../types/index.js';
import { ensureDir, resolveHome, fileExists } from '../utils/fs-utils.js';
import { detectAgent } from './detect-utils.js';
import { createLogger } from '../utils/logger.js';

import { installCopilotShellIntegration, needsCopilotShellIntegration, removeCopilotShellIntegration } from './copilot-shell-integration.js';

const logger = createLogger('CopilotPluginStrategy');

const DEFAULT_PLUGIN_NAME = 'loongsuite-pilot';
const DEFAULT_PLUGIN_PUBLISHER = 'loongsuite-pilot';
const DEFAULT_PLUGIN_VERSION = '0.1.0';
const DEFAULT_PLUGIN_DESCRIPTION = 'Loongsuite Pilot observability hooks for GitHub Copilot CLI';
const DEFAULT_PLUGIN_AUTHOR_NAME = 'loongsuite-pilot';
const DEFAULT_PLUGIN_LICENSE = 'Apache-2.0';
const DEFAULT_TIMEOUT_SEC = 5;
const SETTINGS_ENABLED_PLUGINS_KEY = 'enabledPlugins';
const CONFIG_INSTALLED_PLUGINS_KEY = 'installedPlugins';

/**
 * `~/.copilot/config.json` is "managed automatically" by Copilot CLI, but the
 * `installedPlugins` array entries it contains are what makes a plugin load
 * at startup (the `cache_path` field is the on-disk plugin package root).
 * We mirror this entry so the plugin loads even on first launch, before the
 * CLI has a chance to discover and write it itself.
 */
interface CopilotInstalledPluginEntry {
  name: string;
  marketplace: string;
  installed_at: string;
  enabled: boolean;
  version: string;
  cache_path: string;
  source_sha?: string;
}

function eventToSubcommand(event: string): string {
  return event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function formatHookCommand(
  hookCommand: string,
  event: string,
  style: CopilotPluginHookConfig['eventSubcommand'],
): string {
  if (style === 'kebab-case') {
    return `${hookCommand} ${eventToSubcommand(event)}`;
  }
  return hookCommand;
}

/**
 * Strip single-line (//) and multi-line comments from JSONC text
 * so that standard JSON.parse can handle it. Same algorithm as
 * PluginInjectStrategy.stripJsoncComments — duplicated here to keep
 * the Copilot-plugin strategy isolated (no cross-strategy imports).
 */
function stripJsoncComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let escape = false;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      result += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    if (ch === '/' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === '/') {
        i += 2;
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (next === '*') {
        i += 2;
        while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
}

function readJsoncSync<T>(filePath: string): T | null {
  try {
    const raw = fsSync.readFileSync(filePath, 'utf-8');
    return JSON.parse(stripJsoncComments(raw)) as T;
  } catch {
    return null;
  }
}

export interface CopilotPluginManifest {
  name: string;
  version: string;
  description: string;
  author: { name: string };
  license: string;
  hooks: string;
}

export interface CopilotPluginHooksFile {
  version: 1;
  hooks: Record<string, Array<{ type: 'command'; command: string; timeoutSec?: number }>>;
}

/**
 * Build the Agent Plugins 1.0 plugin.json manifest for the Copilot plugin.
 */
export function buildPluginManifest(): CopilotPluginManifest {
  return {
    name: DEFAULT_PLUGIN_NAME,
    version: DEFAULT_PLUGIN_VERSION,
    description: DEFAULT_PLUGIN_DESCRIPTION,
    author: { name: DEFAULT_PLUGIN_AUTHOR_NAME },
    license: DEFAULT_PLUGIN_LICENSE,
    hooks: 'hooks/hooks.json',
  };
}

/**
 * Build the Agent Plugins 1.0 hooks/hooks.json payload — one entry per event
 * under `hooks.<eventName>`, each entry `{ type:"command", command, timeoutSec }`.
 */
export function buildPluginHooksJson(
  cfg: CopilotPluginHookConfig,
): CopilotPluginHooksFile {
  const timeout = cfg.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const hooks: CopilotPluginHooksFile['hooks'] = {};
  for (const event of cfg.events) {
    hooks[event] = [{
      type: 'command',
      command: formatHookCommand(cfg.hookCommand, event, cfg.eventSubcommand),
      timeoutSec: timeout,
    }];
  }
  return { version: 1, hooks };
}

/**
 * Strategy for `deployMode: "copilot-plugin"`. Writes an Agent Plugins 1.0
 * plugin package under `~/.copilot/plugins/<pluginId>/com.github.copilot/`
 * (plugin.json + hooks/hooks.json) and registers the plugin id in
 * `~/.copilot/settings.json` `enabledPlugins` (JSONC-aware via
 * stripJsoncComments on read, plain JSON on write — matches the existing
 * PluginInjectStrategy pattern; JSONC comments are stripped on write, which
 * is acceptable for the JSONC settings file because the file is generated
 * by Copilot itself without user-authored comments).
 */
export class CopilotPluginStrategy implements DeployStrategy {
  constructor(private readonly options: { homeDir?: string; dataDir?: string } = {}) {}
  private dataDir(cfg: CopilotPluginHookConfig): string { return this.options.dataDir || path.dirname(path.dirname(cfg.hookCommand)); }
  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  async needsDeploy(def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    const cfg = def.copilotPlugin;
    if (!cfg) return true;

    const manifestPath = path.join(resolveHome(cfg.pluginRoot), 'plugin.json');
    const hooksPath = path.join(resolveHome(cfg.pluginRoot), 'hooks', 'hooks.json');
    if (!(await fileExists(manifestPath)) || !(await fileExists(hooksPath))) return true;

    const expectedManifest = buildPluginManifest();
    const existingManifest = await fs.readFile(manifestPath, 'utf-8')
      .then(raw => JSON.parse(raw) as CopilotPluginManifest)
      .catch(() => null);
    if (!existingManifest
      || existingManifest.name !== expectedManifest.name
      || existingManifest.hooks !== expectedManifest.hooks) {
      return true;
    }

    const existingHooks = await fs.readFile(hooksPath, 'utf-8')
      .then(raw => JSON.parse(raw) as CopilotPluginHooksFile)
      .catch(() => null);
    if (!existingHooks || existingHooks.version !== 1) return true;

    const expectedHooks = buildPluginHooksJson(cfg);
    for (const event of cfg.events) {
      const entries = existingHooks.hooks[event];
      if (!Array.isArray(entries) || entries.length === 0) return true;
      const expectedCmd = expectedHooks.hooks[event][0].command;
      if (entries[0].command !== expectedCmd) return true;
    }

    if (await needsCopilotShellIntegration(this.dataDir(cfg), this.options.homeDir)) return true;

    // settings.json enabledPlugins must contain the plugin id (object map form)
    const settingsPath = resolveHome(cfg.settingsPath);
    const settings = readJsoncSync<Record<string, unknown>>(settingsPath);
    if (!settings) return true;
    const enabled = settings[SETTINGS_ENABLED_PLUGINS_KEY];
    const pluginKey = `${cfg.pluginId}@${cfg.pluginId}`;
    if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return true;
    if ((enabled as Record<string, unknown>)[pluginKey] !== true) return true;

    return false;
  }

  async deploy(def: AgentDefinition): Promise<DeployResult> {
    const cfg = def.copilotPlugin;
    if (!cfg) {
      return { success: false, agentId: def.id, deployMode: 'copilot-plugin', error: 'missing copilotPlugin config' };
    }

    try {
      const pluginRoot = resolveHome(cfg.pluginRoot);
      const hooksDir = path.join(pluginRoot, 'hooks');
      await ensureDir(pluginRoot);
      await ensureDir(hooksDir);

      const manifestPath = path.join(pluginRoot, 'plugin.json');
      const hooksPath = path.join(hooksDir, 'hooks.json');
      await fs.writeFile(manifestPath, JSON.stringify(buildPluginManifest(), null, 2) + '\n', 'utf-8');
      await fs.writeFile(hooksPath, JSON.stringify(buildPluginHooksJson(cfg), null, 2) + '\n', 'utf-8');

      await this.registerInSettings(cfg);
      await this.registerInConfig(cfg);
      await installCopilotShellIntegration(this.dataDir(cfg), this.options.homeDir);

      logger.info('copilot plugin deployed', {
        agentId: def.id,
        pluginRoot,
        events: cfg.events.length,
      });
      return { success: true, agentId: def.id, deployMode: 'copilot-plugin' };
    } catch (err) {
      return { success: false, agentId: def.id, deployMode: 'copilot-plugin', error: String(err) };
    }
  }

  async undeploy(def: AgentDefinition): Promise<boolean> {
    const cfg = def.copilotPlugin;
    if (!cfg) return true;

    let ok = true;
    try { await removeCopilotShellIntegration(this.dataDir(cfg), this.options.homeDir); } catch { ok = false; }
    try {
      const pluginRoot = resolveHome(cfg.pluginRoot);
      await fs.rm(pluginRoot, { recursive: true, force: true });
    } catch (err) {
      logger.warn('plugin package cleanup failed (non-blocking)', { error: String(err) });
      ok = false;
    }

    try {
      await this.unregisterFromSettings(cfg);
      await this.unregisterFromConfig(cfg);
    } catch (err) {
      logger.warn('settings/config cleanup failed (non-blocking)', { error: String(err) });
      ok = false;
    }

    return ok;
  }

  private pluginKey(cfg: CopilotPluginHookConfig): string {
    return `${cfg.pluginId}@${cfg.pluginId}`;
  }

  private async registerInSettings(cfg: CopilotPluginHookConfig): Promise<void> {
    const settingsPath = resolveHome(cfg.settingsPath);
    await ensureDir(path.dirname(settingsPath));

    const existing = readJsoncSync<Record<string, unknown>>(settingsPath) ?? {};
    const enabled = (existing[SETTINGS_ENABLED_PLUGINS_KEY] && typeof existing[SETTINGS_ENABLED_PLUGINS_KEY] === 'object' && !Array.isArray(existing[SETTINGS_ENABLED_PLUGINS_KEY]))
      ? (existing[SETTINGS_ENABLED_PLUGINS_KEY] as Record<string, unknown>)
      : {};
    enabled[this.pluginKey(cfg)] = true;
    existing[SETTINGS_ENABLED_PLUGINS_KEY] = enabled;
    await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  }

  private async unregisterFromSettings(cfg: CopilotPluginHookConfig): Promise<void> {
    const settingsPath = resolveHome(cfg.settingsPath);
    const existing = readJsoncSync<Record<string, unknown>>(settingsPath);
    if (!existing) return;
    const enabled = existing[SETTINGS_ENABLED_PLUGINS_KEY];
    if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return;
    const map = enabled as Record<string, unknown>;
    if (!(this.pluginKey(cfg) in map)) return;
    delete map[this.pluginKey(cfg)];
    if (Object.keys(map).length === 0) {
      delete existing[SETTINGS_ENABLED_PLUGINS_KEY];
    } else {
      existing[SETTINGS_ENABLED_PLUGINS_KEY] = map;
    }
    await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  }

  private async registerInConfig(cfg: CopilotPluginHookConfig): Promise<void> {
    const configPath = resolveHome(cfg.configPath);
    await ensureDir(path.dirname(configPath));

    const existing = readJsoncSync<Record<string, unknown>>(configPath) ?? {};
    const arr = Array.isArray(existing[CONFIG_INSTALLED_PLUGINS_KEY])
      ? (existing[CONFIG_INSTALLED_PLUGINS_KEY] as unknown[])
      : [];
    const key = this.pluginKey(cfg);
    const filtered = arr.filter((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const e = entry as CopilotInstalledPluginEntry;
      return !(e.name === cfg.pluginId && e.marketplace === cfg.pluginId);
    });
    const entry: CopilotInstalledPluginEntry = {
      name: cfg.pluginId,
      marketplace: cfg.pluginId,
      installed_at: new Date().toISOString(),
      enabled: true,
      version: DEFAULT_PLUGIN_VERSION,
      cache_path: resolveHome(cfg.pluginRoot),
    };
    filtered.push(entry);
    existing[CONFIG_INSTALLED_PLUGINS_KEY] = filtered;
    await fs.writeFile(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    void key;
  }

  private async unregisterFromConfig(cfg: CopilotPluginHookConfig): Promise<void> {
    const configPath = resolveHome(cfg.configPath);
    const existing = readJsoncSync<Record<string, unknown>>(configPath);
    if (!existing) return;
    const arr = existing[CONFIG_INSTALLED_PLUGINS_KEY];
    if (!Array.isArray(arr)) return;
    const filtered = (arr as unknown[]).filter((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return true;
      const e = entry as CopilotInstalledPluginEntry;
      return !(e.name === cfg.pluginId && e.marketplace === cfg.pluginId);
    });
    if (filtered.length === (arr as unknown[]).length) return;
    if (filtered.length === 0) {
      delete existing[CONFIG_INSTALLED_PLUGINS_KEY];
    } else {
      existing[CONFIG_INSTALLED_PLUGINS_KEY] = filtered;
    }
    await fs.writeFile(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  }
}

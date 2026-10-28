import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { removeCopilotRegistrations } from './copilot-config-cleanup.js';
import { readCopilotFile, writeCopilotFile } from './copilot-config-file.js';
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

/** Missing files may be created; malformed or unreadable files must never be overwritten. */
function readJsoncSync<T>(filePath: string): T | null {
  let raw: string;
  try { raw = fsSync.readFileSync(filePath, 'utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
  return parseConfig(raw) as T;
}
function parseConfig(raw: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(raw.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Copilot JSONC configuration; original file preserved');
  }
  return value;
}
async function updateConfig(file: string, update: (data: Record<string, unknown>) => void): Promise<void> {
  const snapshot = await readCopilotFile(file);
  const original = snapshot.exists ? parseConfig(snapshot.content) : {};
  const next = structuredClone(original);
  update(next);
  let text = snapshot.exists ? snapshot.content : '{}\n';
  for (const key of new Set([...Object.keys(original), ...Object.keys(next)])) {
    if (JSON.stringify(original[key]) === JSON.stringify(next[key])) continue;
    text = applyEdits(text, modify(text, [key], next[key], { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  if (!snapshot.exists && text === '{}\n') return;
  await writeCopilotFile(snapshot, text);
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

/** Deploy a native plugin under ~/.copilot/installed-plugins/<id>/<id>.
 * Preserve user JSONC fields/comments; enabledPlugins is an object map.
 */
export class CopilotPluginStrategy implements DeployStrategy {
  constructor(private readonly options: { homeDir?: string; dataDir?: string } = {}) {}
  private dataDir(cfg: CopilotPluginHookConfig): string { return this.options.dataDir || path.dirname(path.dirname(cfg.hookCommand)); }
  async detect(def: AgentDefinition): Promise<boolean> {
    return process.platform !== 'win32' && detectAgent(def.detection);
  }

  async needsDeploy(def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    const cfg = def.copilotPlugin;
    if (!cfg || _record?.cleanupRequired) return true;

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
      const entries = existingHooks.hooks?.[event];
      if (!Array.isArray(entries) || entries.length === 0) return true;
      const expectedCmd = expectedHooks.hooks[event][0].command;
      if (entries[0].command !== expectedCmd) return true;
    }

    if (await needsCopilotShellIntegration(this.dataDir(cfg), this.options.homeDir)) return true;

    // settings.json enabledPlugins must contain the plugin id (object map form)
    const settingsPath = resolveHome(cfg.settingsPath);
    let settings: Record<string, unknown> | null;
    try { settings = readJsoncSync(settingsPath); } catch { return true; }
    if (!settings) return true;
    const enabled = settings[SETTINGS_ENABLED_PLUGINS_KEY];
    const pluginKey = `${cfg.pluginId}@${cfg.pluginId}`;
    if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return true;
    if ((enabled as Record<string, unknown>)[pluginKey] !== true) return true;

    try {
      const config = readJsoncSync<Record<string, unknown>>(resolveHome(cfg.configPath ?? '~/.copilot/config.json'));
      const installed = config?.[CONFIG_INSTALLED_PLUGINS_KEY];
      if (!Array.isArray(installed) || !installed.some((e: CopilotInstalledPluginEntry) => e?.name === cfg.pluginId
        && e.marketplace === cfg.pluginId && e.enabled === true && e.cache_path === resolveHome(cfg.pluginRoot))) return true;
    } catch { return true; }
    return false;
  }

  async deploy(def: AgentDefinition): Promise<DeployResult> {
    const cfg = def.copilotPlugin;
    if (!cfg) {
      return { success: false, agentId: def.id, deployMode: 'copilot-plugin', error: 'missing copilotPlugin config' };
    }

    let mutated = false;
    try {
      if (process.platform === 'win32') throw new Error('Copilot automatic deployment currently supports Unix shells only');
      // Validate both user files before changing either one.
      const settings = readJsoncSync<Record<string, unknown>>(resolveHome(cfg.settingsPath));
      const config = readJsoncSync<Record<string, unknown>>(resolveHome(cfg.configPath ?? '~/.copilot/config.json'));
      const enabled = settings?.[SETTINGS_ENABLED_PLUGINS_KEY];
      if (enabled !== undefined && (!enabled || typeof enabled !== 'object' || Array.isArray(enabled))) throw new Error('Invalid Copilot enabledPlugins map');
      if (config?.[CONFIG_INSTALLED_PLUGINS_KEY] !== undefined && !Array.isArray(config[CONFIG_INSTALLED_PLUGINS_KEY])) throw new Error('Invalid Copilot installedPlugins array');
      const pluginRoot = resolveHome(cfg.pluginRoot);
      const hooksDir = path.join(pluginRoot, 'hooks');
      mutated = true; // Even an interrupted mkdir/write may leave owned assets.
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
      return { success: false, agentId: def.id, deployMode: 'copilot-plugin', error: String(err), cleanupRequired: mutated };
    }
  }

  async undeploy(def: AgentDefinition): Promise<boolean> {
    const cfg = def.copilotPlugin;
    if (!cfg) return true;

    // Unregister before deleting assets; retain assets and the deployment record on error.
    try {
      const settings = readJsoncSync<Record<string, unknown>>(resolveHome(cfg.settingsPath));
      const config = readJsoncSync<Record<string, unknown>>(resolveHome(cfg.configPath ?? '~/.copilot/config.json'));
      const enabled = settings?.[SETTINGS_ENABLED_PLUGINS_KEY];
      if (enabled !== undefined && (!enabled || typeof enabled !== 'object' || Array.isArray(enabled))) throw new Error('Invalid Copilot enabledPlugins map');
      if (config?.[CONFIG_INSTALLED_PLUGINS_KEY] !== undefined && !Array.isArray(config[CONFIG_INSTALLED_PLUGINS_KEY])) throw new Error('Invalid Copilot installedPlugins array');
      await removeCopilotRegistrations(resolveHome(cfg.settingsPath), resolveHome(cfg.configPath ?? '~/.copilot/config.json'), cfg.pluginId);
      await removeCopilotShellIntegration(this.dataDir(cfg), this.options.homeDir);
      await fs.rm(resolveHome(cfg.pluginRoot), { recursive: true, force: true });
      return true;
    } catch (err) {
      logger.warn('Copilot cleanup incomplete; retaining assets for retry', { error: String(err) });
      return false;
    }
  }

  private pluginKey(cfg: CopilotPluginHookConfig): string {
    return `${cfg.pluginId}@${cfg.pluginId}`;
  }

  private async registerInSettings(cfg: CopilotPluginHookConfig): Promise<void> {
    await updateConfig(resolveHome(cfg.settingsPath), data => {
      const enabled = data[SETTINGS_ENABLED_PLUGINS_KEY];
      if (enabled !== undefined && (!enabled || typeof enabled !== 'object' || Array.isArray(enabled))) {
        throw new Error('Invalid Copilot enabledPlugins map; original file preserved');
      }
      data[SETTINGS_ENABLED_PLUGINS_KEY] = { ...(enabled as object ?? {}), [this.pluginKey(cfg)]: true };
    });
  }
  private async registerInConfig(cfg: CopilotPluginHookConfig): Promise<void> {
    await updateConfig(resolveHome(cfg.configPath ?? '~/.copilot/config.json'), data => {
      const installed = data[CONFIG_INSTALLED_PLUGINS_KEY];
      if (installed !== undefined && !Array.isArray(installed)) throw new Error('Invalid Copilot installedPlugins array');
      const entries = (installed as CopilotInstalledPluginEntry[] ?? []).filter(e => !(e?.name === cfg.pluginId && e.marketplace === cfg.pluginId));
      entries.push({ name: cfg.pluginId, marketplace: cfg.pluginId, installed_at: new Date().toISOString(),
        enabled: true, version: DEFAULT_PLUGIN_VERSION, cache_path: resolveHome(cfg.pluginRoot) });
      data[CONFIG_INSTALLED_PLUGINS_KEY] = entries;
    });
  }
}

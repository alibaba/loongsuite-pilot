import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
  PluginInjectConfig,
} from '../types/index.js';
import { fileExists, resolveHome } from '../utils/fs-utils.js';
import { detectAgent } from './detect-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginInjectStrategy');

const DEFAULT_OPENCLAW_ENTRY_CONFIG = {
  enabled: true,
  hooks: { allowConversationAccess: true },
};

/**
 * Strip single-line (//) and multi-line comments from JSONC text
 * so that standard JSON.parse can handle it.
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
        // single-line comment — skip until newline
        i += 2;
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (next === '*') {
        // multi-line comment — skip until */
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

export class PluginInjectStrategy implements DeployStrategy {
  private readonly dataDir: string;

  constructor(dataDir: string, _pilotDir: string) {
    this.dataDir = dataDir;
  }

  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  async needsDeploy(def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    const config = def.pluginInject;
    if (!config) return true;

    const configPath = await this.findConfigFile(config, false);
    if (!configPath) return true;

    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw)) as Record<string, unknown>;
      const resolvedSpec = this.resolveSpec(config.pluginSpec);

      if (this.isOpenclawNested(config)) {
        if (Array.isArray(json.plugin) || Array.isArray(json.plugins)) return true;
        const desiredEntry = config.entryConfig ?? DEFAULT_OPENCLAW_ENTRY_CONFIG;
        return !this.openclawHasPlugin(json, resolvedSpec, config.pluginId, desiredEntry);
      }
      const pluginKey = this.resolvePluginKey(json, config);
      const plugins: unknown[] = (json[pluginKey] as unknown[]) ?? [];
      if (!Array.isArray(plugins)) return true;
      return !plugins.some((entry) => this.matchesSpec(entry, resolvedSpec, config.pluginId));
    } catch (err) {
      logger.warn('failed to read config file', { configPath, error: String(err) });
      return true;
    }
  }

  async deploy(def: AgentDefinition): Promise<DeployResult> {
    const config = def.pluginInject;
    if (!config) {
      return { success: false, agentId: def.id, deployMode: 'plugin-inject', error: 'missing pluginInject config' };
    }

    try {
      const configPath = await this.findConfigFile(config, config.createIfMissing === true);
      if (!configPath) {
        return {
          success: false,
          agentId: def.id,
          deployMode: 'plugin-inject',
          error: `no config file found in: ${config.configPaths.join(', ')}`,
        };
      }

      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw)) as Record<string, unknown>;
      const resolvedSpec = this.resolveSpec(config.pluginSpec);
      const migratingLegacyOpenclawSchema = this.isOpenclawNested(config)
        && (Array.isArray(json.plugin) || Array.isArray(json.plugins));

      let mutated: boolean;
      if (this.isOpenclawNested(config)) {
        mutated = this.openclawInject(json, resolvedSpec, config);
      } else {
        mutated = this.flatArrayInject(json, resolvedSpec, config);
      }

      if (mutated) {
        const hasComments = raw !== JSON.stringify(JSON.parse(stripJsoncComments(raw)), null, 2) + '\n';
        if (hasComments || migratingLegacyOpenclawSchema) {
          if (hasComments) {
            logger.warn('config will be rewritten as JSON; JSONC comments in the original file will be removed', { configPath });
          }
          await this.writePrivateBackup(configPath + '.bak', raw);
        }
        await fs.writeFile(configPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
        logger.info('plugin injected', { agentId: def.id, configPath, spec: resolvedSpec });
      } else {
        logger.info('plugin already injected', { agentId: def.id, configPath, spec: resolvedSpec });
      }
      return { success: true, agentId: def.id, deployMode: 'plugin-inject' };
    } catch (err) {
      return { success: false, agentId: def.id, deployMode: 'plugin-inject', error: String(err) };
    }
  }

  async undeploy(def: AgentDefinition): Promise<boolean> {
    const config = def.pluginInject;
    if (!config) return false;

    try {
      const configPath = await this.findConfigFile(config, false);
      // Idempotent cleanup: a removed Agent/config directory means there is no
      // remaining Pilot spec to clean up.
      if (!configPath) return true;

      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw)) as Record<string, unknown>;
      const resolvedSpec = this.resolveSpec(config.pluginSpec);

      let mutated: boolean;
      if (this.isOpenclawNested(config)) {
        mutated = this.openclawRemove(json, resolvedSpec, config);
      } else {
        const pluginKey = this.resolvePluginKey(json, config);
        if (!Array.isArray(json[pluginKey])) return true;
        const before = (json[pluginKey] as unknown[]).length;
        json[pluginKey] = (json[pluginKey] as unknown[]).filter(
          (entry) => !this.matchesSpec(entry, resolvedSpec, config.pluginId),
        );
        mutated = (json[pluginKey] as unknown[]).length < before;
      }

      if (mutated) {
        const hasComments = raw !== JSON.stringify(JSON.parse(stripJsoncComments(raw)), null, 2) + '\n';
        if (hasComments) {
          logger.warn('config will be rewritten as JSON; JSONC comments in the original file will be removed', { configPath });
          await this.writePrivateBackup(configPath + '.bak', raw);
        }
        await fs.writeFile(configPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
        logger.info('plugin removed', { agentId: def.id, configPath });
      }

      return true;
    } catch (err) {
      logger.error('undeploy failed', { agentId: def.id, error: String(err) });
      return false;
    }
  }

  private async findConfigFile(
    config: PluginInjectConfig,
    createIfMissing: boolean,
  ): Promise<string | null> {
    for (const p of config.configPaths) {
      const resolved = resolveHome(p);
      if (await fileExists(resolved)) return resolved;
    }

    if (createIfMissing && config.configPaths.length > 0) {
      const resolved = resolveHome(config.configPaths[0]);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, '{}\n', {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      }).catch(async (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      });
      return resolved;
    }
    return null;
  }

  private isOpenclawNested(config: PluginInjectConfig): boolean {
    return config.configShape === 'openclaw-nested';
  }

  private async writePrivateBackup(backupPath: string, raw: string): Promise<void> {
    await fs.writeFile(backupPath, raw, { encoding: 'utf-8', mode: 0o600 });
    if (process.platform !== 'win32') await fs.chmod(backupPath, 0o600);
  }

  private resolvePluginKey(
    json: Record<string, unknown>,
    config: PluginInjectConfig,
  ): string {
    if (config.configKey) return config.configKey;
    if (Array.isArray(json.plugins)) return 'plugins';
    return 'plugin';
  }

  private resolveSpec(spec: string): string {
    return this.normalizeSpecForComparison(spec.replace(/\$PILOT_DATA/g, this.dataDir));
  }

  private matchesSpec(entry: unknown, resolvedSpec: string, pluginId: string): boolean {
    const entryStr = typeof entry === 'string'
      ? entry
      : Array.isArray(entry)
        ? String(entry[0])
        : '';

    return this.normalizeSpecForComparison(entryStr) === this.normalizeSpecForComparison(resolvedSpec)
      || entryStr.includes(pluginId);
  }

  private normalizeSpecForComparison(spec: string): string {
    return process.platform === 'win32' ? spec.replace(/\\/g, '/') : spec;
  }

  private flatArrayInject(
    json: Record<string, unknown>,
    resolvedSpec: string,
    config: PluginInjectConfig,
  ): boolean {
    const pluginKey = this.resolvePluginKey(json, config);
    if (!Array.isArray(json[pluginKey])) {
      json[pluginKey] = [];
    }

    if (config.replaceSpecs?.length) {
      json[pluginKey] = (json[pluginKey] as unknown[]).filter((entry) => {
        const entryStr = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : '';
        return !config.replaceSpecs!.some((old) =>
          typeof entryStr === 'string' && entryStr.includes(old),
        );
      });
    }

    const before = (json[pluginKey] as unknown[]).length;
    json[pluginKey] = (json[pluginKey] as unknown[]).filter(
      (entry) => !this.matchesSpec(entry, resolvedSpec, config.pluginId),
    );
    let mutated = (json[pluginKey] as unknown[]).length < before;

    if (!(json[pluginKey] as unknown[]).some((entry) => this.matchesSpec(entry, resolvedSpec, config.pluginId))) {
      (json[pluginKey] as unknown[]).push(resolvedSpec);
      mutated = true;
    }
    return mutated;
  }

  private ensurePluginsObject(json: Record<string, unknown>): Record<string, unknown> {
    if (typeof json.plugins !== 'object' || json.plugins === null || Array.isArray(json.plugins)) {
      json.plugins = {};
    }
    return json.plugins as Record<string, unknown>;
  }

  private ensureLoadObject(plugins: Record<string, unknown>): Record<string, unknown> {
    if (typeof plugins.load !== 'object' || plugins.load === null || Array.isArray(plugins.load)) {
      plugins.load = {};
    }
    return plugins.load as Record<string, unknown>;
  }

  private ensureEntriesObject(plugins: Record<string, unknown>): Record<string, unknown> {
    if (typeof plugins.entries !== 'object' || plugins.entries === null || Array.isArray(plugins.entries)) {
      plugins.entries = {};
    }
    return plugins.entries as Record<string, unknown>;
  }

  private ensurePathsArray(load: Record<string, unknown>): unknown[] {
    if (!Array.isArray(load.paths)) {
      load.paths = [];
    }
    return load.paths as unknown[];
  }

  /**
   * OpenClaw's `plugins.load.paths` expects plain filesystem paths (not
   * `file://` URLs like OpenCode's flat-array shape). Strip the URL scheme
   * before writing so `openclaw config validate` finds the plugin on disk.
   */
  private toOpenclawPath(spec: string): string {
    if (spec.startsWith('file://')) return spec.slice('file://'.length);
    return spec;
  }

  private pathMatches(entry: unknown, resolvedSpec: string, pluginId: string): boolean {
    if (typeof entry !== 'string') return false;
    if (entry === resolvedSpec || entry === this.toOpenclawPath(resolvedSpec)) return true;
    return entry.includes(pluginId);
  }

  private openclawReplacementMatches(entry: string, replacementSpec: string): boolean {
    const resolvedReplacement = this.resolveSpec(replacementSpec);
    const isPathReplacement = replacementSpec.includes('$PILOT_DATA')
      || resolvedReplacement.startsWith('file://')
      || path.isAbsolute(resolvedReplacement);

    if (!isPathReplacement) return entry.includes(replacementSpec);

    return path.normalize(this.toOpenclawPath(entry))
      === path.normalize(this.toOpenclawPath(resolvedReplacement));
  }

  private openclawRemovalMatches(
    entry: unknown,
    resolvedSpec: string,
    config: PluginInjectConfig,
  ): boolean {
    if (this.pathMatches(entry, resolvedSpec, config.pluginId)) return true;
    if (typeof entry !== 'string') return false;

    return config.replaceSpecs?.some(
      (old) => this.openclawReplacementMatches(entry, old),
    ) ?? false;
  }

  private openclawHasPlugin(
    json: Record<string, unknown>,
    resolvedSpec: string,
    pluginId: string,
    desiredEntry: Record<string, unknown>,
  ): boolean {
    const plugins = typeof json.plugins === 'object' && json.plugins !== null && !Array.isArray(json.plugins)
      ? (json.plugins as Record<string, unknown>)
      : null;
    if (!plugins) return false;

    const load = typeof plugins.load === 'object' && plugins.load !== null && !Array.isArray(plugins.load)
      ? (plugins.load as Record<string, unknown>)
      : null;
    const paths = load && Array.isArray(load.paths) ? (load.paths as unknown[]) : [];
    const hasPath = paths.some((entry) => this.pathMatches(entry, resolvedSpec, pluginId));

    const entries = typeof plugins.entries === 'object' && plugins.entries !== null && !Array.isArray(plugins.entries)
      ? (plugins.entries as Record<string, unknown>)
      : null;
    const entry = entries ? entries[pluginId] : null;
    const entryConfigured = typeof entry === 'object'
      && entry !== null
      && !Array.isArray(entry)
      && this.isDeepSubset(entry as Record<string, unknown>, desiredEntry);

    return hasPath && entryConfigured;
  }

  private openclawInject(
    json: Record<string, unknown>,
    resolvedSpec: string,
    config: PluginInjectConfig,
  ): boolean {
    let mutated = false;
    const legacyEntries: unknown[] = [];

    if (Array.isArray(json.plugin)) {
      legacyEntries.push(...json.plugin);
      delete json.plugin;
      mutated = true;
    }
    if (Array.isArray(json.plugins)) {
      legacyEntries.push(...json.plugins);
      delete json.plugins;
      mutated = true;
    }

    const plugins = this.ensurePluginsObject(json);
    const load = this.ensureLoadObject(plugins);
    let paths = this.ensurePathsArray(load);
    const entries = this.ensureEntriesObject(plugins);

    for (const legacyEntry of legacyEntries) {
      const legacySpec = typeof legacyEntry === 'string'
        ? legacyEntry
        : Array.isArray(legacyEntry) && typeof legacyEntry[0] === 'string'
          ? legacyEntry[0]
          : null;
      if (!legacySpec) continue;
      if (this.pathMatches(legacySpec, resolvedSpec, config.pluginId)) continue;
      if (config.replaceSpecs?.some((old) => this.openclawReplacementMatches(legacySpec, old))) continue;
      const migratedPath = this.toOpenclawPath(legacySpec);
      if (!paths.includes(migratedPath)) paths.push(migratedPath);
    }

    if (config.replaceSpecs?.length) {
      const before = paths.length;
      const filtered = paths.filter((entry) => {
        if (typeof entry !== 'string') return true;
        return !config.replaceSpecs!.some((old) => this.openclawReplacementMatches(entry, old));
      });
      if (filtered.length !== before) {
        load.paths = filtered;
        paths = filtered;
        mutated = true;
      }
    }

    if (paths.some((entry) => this.pathMatches(entry, resolvedSpec, config.pluginId))) {
      const before = paths.length;
      load.paths = paths.filter((entry) => !this.pathMatches(entry, resolvedSpec, config.pluginId));
      paths = load.paths as unknown[];
      if ((load.paths as unknown[]).length !== before) mutated = true;
    }

    if (!paths.some((entry) => this.pathMatches(entry, resolvedSpec, config.pluginId))) {
      paths.push(this.toOpenclawPath(resolvedSpec));
      mutated = true;
    }

    const desiredEntry = config.entryConfig ?? DEFAULT_OPENCLAW_ENTRY_CONFIG;
    const existing = entries[config.pluginId];
    if (
      typeof existing !== 'object' ||
      existing === null ||
      Array.isArray(existing) ||
      !this.isDeepSubset(existing as Record<string, unknown>, desiredEntry)
    ) {
      entries[config.pluginId] = this.deepMerge(
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? existing as Record<string, unknown>
          : {},
        desiredEntry,
      );
      mutated = true;
    }

    return mutated;
  }

  private openclawRemove(
    json: Record<string, unknown>,
    resolvedSpec: string,
    config: PluginInjectConfig,
  ): boolean {
    const plugins = typeof json.plugins === 'object' && json.plugins !== null && !Array.isArray(json.plugins)
      ? (json.plugins as Record<string, unknown>)
      : null;
    if (!plugins) return false;

    let mutated = false;

    const load = typeof plugins.load === 'object' && plugins.load !== null && !Array.isArray(plugins.load)
      ? (plugins.load as Record<string, unknown>)
      : null;
    if (load && Array.isArray(load.paths)) {
      const before = (load.paths as unknown[]).length;
      const filtered = (load.paths as unknown[]).filter(
        (entry) => !this.openclawRemovalMatches(entry, resolvedSpec, config),
      );
      if (filtered.length !== before) {
        load.paths = filtered;
        mutated = true;
      }
    }

    const entries = typeof plugins.entries === 'object' && plugins.entries !== null && !Array.isArray(plugins.entries)
      ? (plugins.entries as Record<string, unknown>)
      : null;
    if (entries && entries[config.pluginId] !== undefined) {
      delete entries[config.pluginId];
      mutated = true;
    }

    return mutated;
  }

  private isDeepSubset(actual: Record<string, unknown>, desired: Record<string, unknown>): boolean {
    for (const [key, desiredValue] of Object.entries(desired)) {
      if (!Object.prototype.hasOwnProperty.call(actual, key)) return false;
      const actualValue = actual[key];
      if (Array.isArray(desiredValue)) {
        if (!Array.isArray(actualValue) || !this.configValuesEqual(actualValue, desiredValue)) {
          return false;
        }
      } else if (
        typeof actualValue === 'object' && actualValue !== null && !Array.isArray(actualValue)
        && typeof desiredValue === 'object' && desiredValue !== null && !Array.isArray(desiredValue)
      ) {
        if (!this.isDeepSubset(
          actualValue as Record<string, unknown>,
          desiredValue as Record<string, unknown>,
        )) return false;
      } else if (actualValue !== desiredValue) {
        return false;
      }
    }
    return true;
  }

  private configValuesEqual(actual: unknown, desired: unknown): boolean {
    if (Array.isArray(actual) || Array.isArray(desired)) {
      if (!Array.isArray(actual) || !Array.isArray(desired) || actual.length !== desired.length) {
        return false;
      }
      return desired.every((value, index) => this.configValuesEqual(actual[index], value));
    }
    if (
      typeof actual === 'object' && actual !== null
      && typeof desired === 'object' && desired !== null
    ) {
      const actualRecord = actual as Record<string, unknown>;
      const desiredRecord = desired as Record<string, unknown>;
      const actualKeys = Object.keys(actualRecord);
      const desiredKeys = Object.keys(desiredRecord);
      return actualKeys.length === desiredKeys.length
        && desiredKeys.every(key => Object.prototype.hasOwnProperty.call(actualRecord, key)
          && this.configValuesEqual(actualRecord[key], desiredRecord[key]));
    }
    return actual === desired;
  }

  private deepMerge(
    existing: Record<string, unknown>,
    desired: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged = { ...existing };
    for (const [key, desiredValue] of Object.entries(desired)) {
      const existingValue = existing[key];
      if (
        typeof existingValue === 'object' && existingValue !== null && !Array.isArray(existingValue)
        && typeof desiredValue === 'object' && desiredValue !== null && !Array.isArray(desiredValue)
      ) {
        merged[key] = this.deepMerge(
          existingValue as Record<string, unknown>,
          desiredValue as Record<string, unknown>,
        );
      } else {
        merged[key] = desiredValue;
      }
    }
    return merged;
  }
}

import * as fs from 'node:fs/promises';
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

    const configPath = await this.findConfigFile(config);
    if (!configPath) return true;

    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw));
      const pluginKey = this.resolvePluginKey(json);
      const plugins: unknown[] = json[pluginKey] ?? [];
      if (!Array.isArray(plugins)) return true;

      const resolvedSpec = this.resolveSpec(config.pluginSpec);
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
      const configPath = await this.findConfigFile(config);
      if (!configPath) {
        return {
          success: false,
          agentId: def.id,
          deployMode: 'plugin-inject',
          error: `no config file found in: ${config.configPaths.join(', ')}`,
        };
      }

      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw));
      const pluginKey = this.resolvePluginKey(json);

      if (!Array.isArray(json[pluginKey])) {
        json[pluginKey] = [];
      }

      const resolvedSpec = this.resolveSpec(config.pluginSpec);

      // Remove old/replaced specs
      if (config.replaceSpecs?.length) {
        json[pluginKey] = (json[pluginKey] as unknown[]).filter((entry) => {
          const entryStr = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : '';
          return !config.replaceSpecs!.some((old) =>
            typeof entryStr === 'string' && entryStr.includes(old),
          );
        });
      }

      // Remove existing matching spec to avoid duplicates
      json[pluginKey] = (json[pluginKey] as unknown[]).filter(
        (entry) => !this.matchesSpec(entry, resolvedSpec, config.pluginId),
      );

      json[pluginKey].push(resolvedSpec);

      const hasComments = raw !== JSON.stringify(JSON.parse(stripJsoncComments(raw)), null, 2) + '\n';
      if (hasComments) {
        logger.warn('config will be rewritten as JSON; JSONC comments in the original file will be removed', { configPath });
        await fs.writeFile(configPath + '.bak', raw, 'utf-8');
      }

      await fs.writeFile(configPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
      logger.info('plugin injected', { agentId: def.id, configPath, spec: resolvedSpec });
      return { success: true, agentId: def.id, deployMode: 'plugin-inject' };
    } catch (err) {
      return { success: false, agentId: def.id, deployMode: 'plugin-inject', error: String(err) };
    }
  }

  async undeploy(def: AgentDefinition): Promise<boolean> {
    const config = def.pluginInject;
    if (!config) return false;

    try {
      const configPath = await this.findConfigFile(config);
      if (!configPath) return false;

      const raw = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(stripJsoncComments(raw));
      const pluginKey = this.resolvePluginKey(json);

      if (!Array.isArray(json[pluginKey])) return true;

      const resolvedSpec = this.resolveSpec(config.pluginSpec);
      const before = (json[pluginKey] as unknown[]).length;
      json[pluginKey] = (json[pluginKey] as unknown[]).filter(
        (entry) => !this.matchesSpec(entry, resolvedSpec, config.pluginId),
      );

      if ((json[pluginKey] as unknown[]).length < before) {
        const hasComments = raw !== JSON.stringify(JSON.parse(stripJsoncComments(raw)), null, 2) + '\n';
        if (hasComments) {
          logger.warn('config will be rewritten as JSON; JSONC comments in the original file will be removed', { configPath });
          await fs.writeFile(configPath + '.bak', raw, 'utf-8');
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

  private async findConfigFile(config: PluginInjectConfig): Promise<string | null> {
    for (const p of config.configPaths) {
      const resolved = resolveHome(p);
      if (await fileExists(resolved)) return resolved;
    }
    return null;
  }

  private resolvePluginKey(json: Record<string, unknown>): string {
    if (Array.isArray(json.plugins)) return 'plugins';
    return 'plugin';
  }

  private resolveSpec(spec: string): string {
    return spec.replace(/\$PILOT_DATA/g, this.dataDir);
  }

  private matchesSpec(entry: unknown, resolvedSpec: string, pluginId: string): boolean {
    const entryStr = typeof entry === 'string'
      ? entry
      : Array.isArray(entry)
        ? String(entry[0])
        : '';

    return entryStr === resolvedSpec || entryStr.includes(pluginId);
  }
}

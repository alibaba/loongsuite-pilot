import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
} from '../types/index.js';
import { HookManager, type HookDefinition } from '../hooks/hook-manager.js';
import { readJsonFile, writeJsonFile, resolveHome } from '../utils/fs-utils.js';
import { detectAgent } from './detect-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HookStrategy');

export class HookStrategy implements DeployStrategy {
  private readonly hookManager: HookManager;

  constructor(hookManager: HookManager) {
    this.hookManager = hookManager;
  }

  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  async needsDeploy(def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    const hookDefs = this.buildHookDefinitions(def);
    for (const hookDef of hookDefs) {
      if (!(await this.hookManager.isHookInstalled(hookDef))) {
        return true;
      }
    }
    return false;
  }

  async deploy(def: AgentDefinition): Promise<DeployResult> {
    const hookConfig = def.hook;
    if (!hookConfig) {
      return { success: false, agentId: def.id, deployMode: 'hook', error: 'missing hook config' };
    }

    try {
      await this.ensureSettingsFile(hookConfig.settingsPath);

      const hookDefs = this.buildHookDefinitions(def);
      for (const hookDef of hookDefs) {
        const installed = await this.hookManager.isHookInstalled(hookDef);
        if (!installed) {
          const ok = await this.hookManager.installHook(hookDef);
          if (!ok) {
            return { success: false, agentId: def.id, deployMode: 'hook', error: `failed to install hook for event` };
          }
        }
      }

      logger.info('hooks deployed', { agentId: def.id, events: hookConfig.events.length });
      return { success: true, agentId: def.id, deployMode: 'hook' };
    } catch (err) {
      return { success: false, agentId: def.id, deployMode: 'hook', error: String(err) };
    }
  }

  async undeploy(def: AgentDefinition): Promise<boolean> {
    const hookDefs = this.buildHookDefinitions(def);
    let allOk = true;
    for (const hookDef of hookDefs) {
      const ok = await this.hookManager.uninstallHook(hookDef);
      if (!ok) allOk = false;
    }
    return allOk;
  }

  private buildHookDefinitions(def: AgentDefinition): HookDefinition[] {
    const hookConfig = def.hook;
    if (!hookConfig) return [];

    return hookConfig.events.map(event => ({
      agentId: def.id,
      settingsPath: hookConfig.settingsPath,
      hookJsonPath: ['hooks', event],
      hookCommand: hookConfig.hookCommand,
      matcher: hookConfig.matcher,
      useNestedFormat: hookConfig.format === 'nested',
      replaceHookCommands: hookConfig.replaceHookCommands,
    }));
  }

  /**
   * Ensure the settings file exists with a valid structure.
   * Handles Cursor's hooks.json which needs a `version` field.
   */
  private async ensureSettingsFile(settingsPath: string): Promise<void> {
    const existing = await readJsonFile<Record<string, unknown>>(settingsPath);
    if (!existing) {
      if (settingsPath.endsWith('hooks.json')) {
        await writeJsonFile(settingsPath, { version: 1, hooks: {} });
      }
    } else if (settingsPath.endsWith('hooks.json') && existing.version === undefined) {
      existing.version = 1;
      await writeJsonFile(settingsPath, existing);
    }
  }
}

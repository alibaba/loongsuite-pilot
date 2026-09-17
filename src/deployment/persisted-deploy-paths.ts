import * as path from 'node:path';
import type { AgentDefinition, DeployedAgentRecord } from '../types/index.js';

function absolutePath(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) return undefined;
  return path.isAbsolute(value) ? path.resolve(value) : undefined;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const key = path.resolve(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

/**
 * Grok stores hooks at `$GROK_HOME/hooks/<file>`; most other hook agents
 * store settings directly under the Agent home. Pi settings live at
 * `$PI_CODING_AGENT_DIR/settings.json`.
 */
export function homeFromConfigFile(configPath: string): string {
  const parent = path.dirname(configPath);
  return path.basename(parent) === 'hooks' ? path.dirname(parent) : parent;
}

/** Absolute paths written during deploy so uninstall can find them after env drift. */
export function lifecycleFieldsForDeploy(
  def: AgentDefinition,
): Pick<DeployedAgentRecord, 'hookSettingsPath' | 'pluginInjectConfigPath'> {
  const fields: Pick<DeployedAgentRecord, 'hookSettingsPath' | 'pluginInjectConfigPath'> = {};
  if (def.id === 'grok-build' && def.hook?.settingsPath) {
    const resolved = path.resolve(def.hook.settingsPath);
    if (path.isAbsolute(resolved)) fields.hookSettingsPath = resolved;
  }
  if (def.id === 'pi-coding-agent' && def.pluginInject?.configPaths?.[0]) {
    const resolved = path.resolve(def.pluginInject.configPaths[0]);
    if (path.isAbsolute(resolved)) fields.pluginInjectConfigPath = resolved;
  }
  return fields;
}

export function backfillLifecycleFields(
  record: DeployedAgentRecord,
  def: AgentDefinition,
): void {
  const fields = lifecycleFieldsForDeploy(def);
  if (!record.hookSettingsPath && fields.hookSettingsPath) {
    record.hookSettingsPath = fields.hookSettingsPath;
  }
  if (!record.pluginInjectConfigPath && fields.pluginInjectConfigPath) {
    record.pluginInjectConfigPath = fields.pluginInjectConfigPath;
  }
}

/**
 * Prefer the home Pilot actually wrote last time. Without this, a collector
 * or uninstaller that no longer has GROK_HOME / PI_CODING_AGENT_DIR would
 * repair or clean the documented default and leave the custom home dirty.
 */
export function applyPersistedDeployTargets(
  def: AgentDefinition,
  record?: DeployedAgentRecord,
): AgentDefinition {
  if (!record) return def;

  let next = def;
  const hookSettingsPath = absolutePath(record.hookSettingsPath);
  if (hookSettingsPath && def.hook) {
    next = {
      ...next,
      detection: {
        ...next.detection,
        paths: uniquePaths([homeFromConfigFile(hookSettingsPath), ...next.detection.paths]),
      },
      hook: { ...def.hook, settingsPath: hookSettingsPath },
    };
  }

  const pluginInjectConfigPath = absolutePath(record.pluginInjectConfigPath);
  if (pluginInjectConfigPath && def.pluginInject) {
    const rest = (def.pluginInject.configPaths ?? [])
      .filter(candidate => path.resolve(candidate) !== pluginInjectConfigPath);
    next = {
      ...next,
      detection: {
        ...next.detection,
        paths: uniquePaths([homeFromConfigFile(pluginInjectConfigPath), ...next.detection.paths]),
      },
      pluginInject: {
        ...def.pluginInject,
        configPaths: [pluginInjectConfigPath, ...rest],
      },
    };
  }

  return next;
}

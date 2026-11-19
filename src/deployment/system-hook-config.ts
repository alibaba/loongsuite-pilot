import * as path from 'node:path';
import type { AgentDefinition } from '../types/deployment.js';
import { SYSTEM_TOML_HOOK_PATHS, systemTomlHooksInstalled, updateSystemTomlHooks } from './system-toml-hooks.js';
import { cursorSystemHooksInstalled, updateCursorSystemHooks } from './cursor-system-hooks.js';

const SYSTEM_HOOK_PATHS: Record<string, string> = {
  ...SYSTEM_TOML_HOOK_PATHS,
  cursor: '/etc/cursor/hooks.json',
};

export function supportsSystemHooks(id: string): boolean {
  return Object.hasOwn(SYSTEM_HOOK_PATHS, id);
}

export function systemHookDefinition(def: AgentDefinition, configPath?: string): AgentDefinition {
  if (!supportsSystemHooks(def.id) || !def.hook) throw new Error(`System hooks are not supported for ${def.id}`);
  const settingsPath = configPath ?? def.hook.systemSettingsPath ?? SYSTEM_HOOK_PATHS[def.id];
  if (!path.isAbsolute(settingsPath)) throw new Error('Managed system config path must be absolute');
  return {
    ...def,
    hook: {
      ...def.hook,
      userSettingsPath: def.hook.userSettingsPath ?? def.hook.settingsPath,
      scope: 'system',
      settingsPath,
    },
  };
}

export function systemHooksInstalled(def: AgentDefinition): Promise<boolean> {
  return def.id === 'cursor' ? cursorSystemHooksInstalled(def) : systemTomlHooksInstalled(def);
}

export function updateSystemHooks(def: AgentDefinition, install: boolean): Promise<void> {
  return def.id === 'cursor' ? updateCursorSystemHooks(def, install) : updateSystemTomlHooks(def, install);
}

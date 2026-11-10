import type { AgentDefinition } from '../types/deployment.js';
import { supportsSystemTomlHooks, systemTomlDefinition, systemTomlHooksInstalled, updateSystemTomlHooks } from './system-toml-hooks.js';
import { supportsSystemJsonHooks, systemJsonDefinition, systemJsonHooksInstalled, updateSystemJsonHooks } from './system-json-hooks.js';

export function supportsSystemHooks(id: string): boolean {
  return supportsSystemTomlHooks(id) || supportsSystemJsonHooks(id);
}

export function systemHookDefinition(def: AgentDefinition, configPath?: string): AgentDefinition {
  return supportsSystemJsonHooks(def.id) ? systemJsonDefinition(def, configPath) : systemTomlDefinition(def, configPath);
}

export function systemHooksInstalled(def: AgentDefinition): Promise<boolean> {
  return supportsSystemJsonHooks(def.id) ? systemJsonHooksInstalled(def) : systemTomlHooksInstalled(def);
}

export function updateSystemHooks(def: AgentDefinition, install: boolean): Promise<void> {
  return supportsSystemJsonHooks(def.id) ? updateSystemJsonHooks(def, install) : updateSystemTomlHooks(def, install);
}

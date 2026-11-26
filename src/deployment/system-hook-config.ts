import * as path from 'node:path';
import type { AgentDefinition } from '../types/deployment.js';
import { SYSTEM_TOML_HOOK_PATHS, systemTomlHooksInstalled, updateSystemTomlHooks } from './system-toml-hooks.js';
import { cursorSystemHooksInstalled, updateCursorSystemHooks } from './cursor-system-hooks.js';
import { assertTrustedCursorSystemFile, CURSOR_SYSTEM_HOOK_SCRIPT, cursorSystemCompanionDir, cursorSystemRuntimeDir } from './cursor-system-paths.js';

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

function managedCursorCommand(dataDir: string): string {
  return path.resolve(dataDir, 'hooks', CURSOR_SYSTEM_HOOK_SCRIPT);
}

export function assertManagedCursorSystemCommand(def: AgentDefinition, dataDir: string): void {
  if (!def.hook || path.normalize(def.hook.hookCommand) !== managedCursorCommand(dataDir)) {
    throw new Error('Cursor system hooks must reference the managed Pilot wrapper');
  }
}

function managedCursorDefinition(def: AgentDefinition, dataDir: string | undefined, install: boolean): AgentDefinition {
  if (!dataDir || !def.hook) throw new Error('Cursor system hooks require the managed Pilot data directory');
  if (install) assertManagedCursorSystemCommand(def, dataDir);
  // A local definition override must still let uninstall remove the
  // registered command that belongs to this Pilot installation.
  return { ...def, hook: { ...def.hook, hookCommand: managedCursorCommand(cursorSystemRuntimeDir(dataDir)) } };
}

export async function systemHooksInstalled(def: AgentDefinition, dataDir?: string): Promise<boolean> {
  if (def.id !== 'cursor') return systemTomlHooksInstalled(def);
  const managed = managedCursorDefinition(def, dataDir, true);
  return cursorSystemHooksInstalled(managed, otherManagedCursorCommand(managed, dataDir!));
}

export async function updateSystemHooks(def: AgentDefinition, install: boolean, dataDir?: string): Promise<void> {
  if (def.id !== 'cursor') return updateSystemTomlHooks(def, install);
  const managed = managedCursorDefinition(def, dataDir, install);
  if (install && managed.hook!.hookCommand !== managedCursorCommand(dataDir!)) {
    await assertTrustedCursorSystemFile(managed.hook!.hookCommand);
  }
  return updateCursorSystemHooks(managed, install, otherManagedCursorCommand(managed, dataDir!));
}

function otherManagedCursorCommand(managed: AgentDefinition, dataDir: string): string {
  const initial = managedCursorCommand(dataDir);
  return managed.hook!.hookCommand === initial
    ? managedCursorCommand(cursorSystemCompanionDir(dataDir))
    : initial;
}

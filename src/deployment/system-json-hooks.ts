import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentDefinition } from '../types/deployment.js';
import { editJsonc, parseJsonDocument } from '../utils/json-document.js';
import { writeTextFileAtomic } from '../utils/fs-utils.js';
import { withDeployedStateLock } from './deployed-state-merge.js';

/** Claude Code 2.1.83+ reads independent policy fragments from this directory. */
export const SYSTEM_JSON_HOOK_PATHS: Record<string, string> = {
  'claude-code': '/etc/claude-code/managed-settings.d/50-loongsuite-pilot.json',
  cursor: '/etc/cursor/hooks.json',
};

export function supportsSystemJsonHooks(id: string): boolean {
  return Object.hasOwn(SYSTEM_JSON_HOOK_PATHS, id);
}

export function systemJsonDefinition(def: AgentDefinition, configPath?: string): AgentDefinition {
  if (!supportsSystemJsonHooks(def.id) || !def.hook) throw new Error(`System JSON hooks are not supported for ${def.id}`);
  configPath ??= def.hook.systemSettingsPath ?? SYSTEM_JSON_HOOK_PATHS[def.id];
  if (!path.isAbsolute(configPath)) throw new Error('Managed system config path must be absolute');
  return { ...def, hook: { ...def.hook, userSettingsPath: def.hook.userSettingsPath ?? def.hook.settingsPath,
    scope: 'system', settingsPath: configPath } };
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commandPrefix(def: AgentDefinition): string {
  const script = def.hook?.hookCommand;
  if (!script || !path.isAbsolute(script) || /[\r\n\0]/.test(script)) {
    throw new Error('Managed system hooks require an absolute shell script path');
  }
  return `/bin/bash '${script.replace(/'/g, `'\\''`)}'`;
}

function ownsCommand(command: unknown, prefix: string): boolean {
  return typeof command === 'string' && (command === prefix
    || (command.startsWith(`${prefix} `) && /^[A-Za-z][A-Za-z0-9-]*$/.test(command.slice(prefix.length + 1))));
}

function withoutOwned(row: unknown, prefix: string): unknown | undefined {
  if (!object(row)) return row;
  if (ownsCommand(row.command, prefix)) return undefined;
  if (!Array.isArray(row.hooks)) return row;
  const hooks = row.hooks.filter(handler => !object(handler) || !ownsCommand(handler.command, prefix));
  if (hooks.length === row.hooks.length) return row;
  return hooks.length ? { ...row, hooks } : undefined;
}

function containsForeignRuntime(row: unknown, prefix: string, scriptName: string): boolean {
  if (!object(row)) return false;
  if (typeof row.command === 'string' && row.command.includes(scriptName) && !ownsCommand(row.command, prefix)) return true;
  return Array.isArray(row.hooks) && row.hooks.some(handler => containsForeignRuntime(handler, prefix, scriptName));
}

function renderEntry(def: AgentDefinition, event: string, prefix: string): JsonObject {
  const hook = def.hook!;
  const subcommand = hook.eventSubcommand === 'kebab-case'
    ? event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
    : hook.eventSubcommand === 'as-is' ? event : undefined;
  const handler = { type: 'command', command: prefix + (subcommand ? ` ${subcommand}` : '') };
  return hook.format === 'nested'
    ? { matcher: hook.eventMatchers?.[event] ?? hook.matcher ?? '', hooks: [handler] }
    : handler;
}

function updatedText(def: AgentDefinition, raw: string, install: boolean): string {
  const text = raw.trim() ? raw : `${raw.startsWith('\uFEFF') ? '\uFEFF' : ''}{}\n`;
  const parsed = parseJsonDocument<unknown>(text, def.hook?.settingsSyntax);
  if (!parsed.ok || !object(parsed.data)) throw new Error('Invalid JSON in system config; original file preserved');
  const document = parsed.data;
  if (document.hooks !== undefined && !object(document.hooks)) throw new Error('Invalid JSON hooks object; original file preserved');
  const hooks: JsonObject = object(document.hooks) ? document.hooks : {};
  const prefix = commandPrefix(def);
  let next = text;
  if (def.id === 'cursor' && install) {
    if (document.version !== undefined && document.version !== 1) {
      throw new Error('Invalid JSON hook version; expected Cursor hooks version 1; original file preserved');
    }
    if (document.version === undefined) next = editJsonc(next, ['version'], 1);
  }
  const nextHooks = { ...hooks };
  for (const event of new Set([...Object.keys(hooks), ...(install ? def.hook!.events : [])])) {
    const rows = hooks[event];
    if (rows !== undefined && !Array.isArray(rows)) throw new Error('Invalid JSON hook event list; original file preserved');
    if (install && (rows as unknown[] | undefined)?.some(row => containsForeignRuntime(row, prefix, path.basename(def.hook!.hookCommand)))) {
      throw new Error('Managed system hook belongs to another Pilot runtime; original file preserved');
    }
    const kept = ((rows ?? []) as unknown[]).map(row => withoutOwned(row, prefix)).filter(row => row !== undefined);
    if (install && def.hook!.events.includes(event)) kept.push(renderEntry(def, event, prefix));
    // Unrelated empty event lists belong to the customer too.
    const value = kept.length ? kept : Array.isArray(rows) && rows.length === 0 ? rows : undefined;
    if (value === undefined) delete nextHooks[event];
    else nextHooks[event] = value;
    if (JSON.stringify(rows) !== JSON.stringify(value)) next = editJsonc(next, ['hooks', event], value);
  }
  // An empty hooks key is still a managed policy key. Remove it so an empty
  // Pilot fragment cannot shadow an embedding host's policy after uninstall.
  if (!Object.keys(nextHooks).length && Object.keys(hooks).length) next = editJsonc(next, ['hooks'], undefined);
  const validated = parseJsonDocument(next, def.hook?.settingsSyntax);
  if (!validated.ok) throw new Error('Invalid JSON after system hook update; original file preserved');
  return next;
}

async function read(file: string): Promise<{ raw: string; exists: boolean; mode: number; symlink: boolean }> {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: '', exists: false, mode: 0o644, symlink: false };
    throw error;
  }
  return { raw: await fs.readFile(file, 'utf8'), exists: true, mode: stat.mode & 0o777, symlink: stat.isSymbolicLink() };
}

export async function systemJsonHooksInstalled(def: AgentDefinition): Promise<boolean> {
  const current = await read(def.hook!.settingsPath);
  return current.exists && updatedText(def, current.raw, true) === current.raw;
}

/** One validated atomic transaction for every event; preserve third-party keys. */
export async function updateSystemJsonHooks(def: AgentDefinition, install: boolean): Promise<void> {
  const file = def.hook!.settingsPath;
  if (!install && !(await read(file)).exists) return;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  await withDeployedStateLock(`${file}.pilot-lock`, async () => {
    const current = await read(file);
    if (!install && !current.exists) return;
    const next = updatedText(def, current.raw, install);
    if (next === current.raw || (!install && !current.raw.trim())) return;
    if (current.symlink || (current.exists && !(current.mode & 0o222))) {
      throw new Error('System config is read-only or externally mounted; update its deployment source');
    }
    await writeTextFileAtomic(file, next, { mode: current.mode, preserveMode: true,
      expected: current.exists ? { exists: true, content: current.raw } : { exists: false } });
    if (await fs.readFile(file, 'utf8') !== next) throw new Error('System config changed after write');
  });
}

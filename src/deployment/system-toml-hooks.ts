import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import type { AgentDefinition } from '../types/deployment.js';
import { writeTextFileAtomic } from '../utils/fs-utils.js';
import { withDeployedStateLock } from './deployed-state-merge.js';

export const SYSTEM_TOML_HOOK_PATHS: Record<string, string> = {
  'grok-build': '/etc/grok/managed_config.toml',
};

export function supportsSystemTomlHooks(id: string): boolean {
  return Object.hasOwn(SYSTEM_TOML_HOOK_PATHS, id);
}
const BEGIN = (def: AgentDefinition) => `# BEGIN loongsuite-pilot:${def.id}`;
const END = (def: AgentDefinition) => `# END loongsuite-pilot:${def.id}`;
const OWNER = '# pilot-hook: ';

export function systemTomlDefinition(def: AgentDefinition, configPath?: string): AgentDefinition {
  if (!supportsSystemTomlHooks(def.id) || !def.hook) throw new Error(`System TOML hooks are not supported for ${def.id}`);
  configPath ??= def.hook.systemSettingsPath ?? SYSTEM_TOML_HOOK_PATHS[def.id];
  if (!path.isAbsolute(configPath)) throw new Error('Managed system config path must be absolute');
  return { ...def, hook: { ...def.hook, userSettingsPath: def.hook.userSettingsPath ?? def.hook.settingsPath, scope: 'system', settingsPath: configPath } };
}
function scriptPath(def: AgentDefinition): string {
  const script = def.hook?.hookCommand;
  if (!script || !path.isAbsolute(script) || /[\r\n\0]/.test(script)) {
    throw new Error('Managed system hooks require an absolute shell script path');
  }
  return script;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderSystemTomlHooks(def: AgentDefinition): string {
  const script = scriptPath(def);
  const lines = [BEGIN(def), OWNER + JSON.stringify(script)];
  for (const event of def.hook!.events) {
    if (!/^[A-Za-z_]+$/.test(event)) throw new Error('Invalid system hook event');
    const subcommand = def.hook!.eventSubcommand === 'kebab-case'
      ? event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() : event;
    lines.push(`[[hooks.${event}]]`, 'matcher = ""',
      `hooks = [{ type = "command", command = ${JSON.stringify(`/bin/bash ${quote(script)} ${subcommand}`)} }]`, '');
  }
  return [...lines, END(def), ''].join('\n');
}

/** Remove only a block whose marker and runtime owner are unambiguous. */
function splitOwned(text: string, def: AgentDefinition): { before: string; block: string; after: string } {
  const lines = text.split(/(?<=\n)/);
  const starts = lines.flatMap((line, i) => line.trim() === BEGIN(def) ? [i] : []);
  const ends = lines.flatMap((line, i) => line.trim() === END(def) ? [i] : []);
  if (starts.length === 0 && ends.length === 0) return { before: text, block: '', after: '' };
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    throw new Error('Conflicting System Pilot markers; repair the managed config before retrying');
  }
  const block = lines.slice(starts[0], ends[0] + 1).join('');
  const owner = block.split(/\r?\n/).filter(line => line.startsWith(OWNER));
  if (owner.length !== 1 || owner[0] !== OWNER + JSON.stringify(scriptPath(def))) {
    throw new Error('Managed system hook belongs to another Pilot runtime; refusing to overwrite it');
  }
  return { before: lines.slice(0, starts[0]).join(''), block, after: lines.slice(ends[0] + 1).join('') };
}

function validate(text: string): void {
  try { parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid TOML in system config; original file preserved'); }
}

/** END is only a comment: bare suffix keys still belong to our last table. */
function assertSuffixTableOwnership(text: string, after: string): void {
  if (!after.trim()) return;
  const current = parse(text.replace(/^\uFEFF/, ''));
  let key = '__loongsuite_pilot_tail__';
  while (Object.hasOwn(current, key)) key += '_';
  const probe = parse(`[${JSON.stringify(key)}]\n${after}`);
  if (Object.keys(probe[key] as object).length) {
    throw new Error('Keys after the Pilot block would change table ownership; move them to their intended table before retrying. Original preserved.');
  }
}

async function read(file: string): Promise<{ text: string; exists: boolean; mode: number; symlink: boolean }> {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', exists: false, mode: 0o644, symlink: false };
    throw error;
  }
  // A dangling mount symlink still exists. Do not classify a missing target as
  // an absent file and atomically replace the platform's symlink on install.
  return { text: await fs.readFile(file, 'utf8'), exists: true, mode: stat.mode & 0o777, symlink: stat.isSymbolicLink() };
}

export async function systemTomlHooksInstalled(def: AgentDefinition): Promise<boolean> {
  const current = await read(def.hook!.settingsPath);
  validate(current.text);
  const owned = splitOwned(current.text, def);
  return owned.block.replace(/\r\n/g, '\n') === renderSystemTomlHooks(def);
}

export async function updateSystemTomlHooks(def: AgentDefinition, install: boolean): Promise<void> {
  const file = def.hook!.settingsPath;
  // A missing file on uninstall is a no-op, including a missing parent directory.
  if (!install && !(await read(file)).exists) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await withDeployedStateLock(`${file}.pilot-lock`, async () => {
    const current = await read(file);
    validate(current.text);
    const owned = splitOwned(current.text, def);
    const outside = owned.before + owned.after;
    if (!owned.block && !install) return;
    if (install && outside.includes(path.basename(scriptPath(def)))) {
      throw new Error('Unmarked System Pilot hook already exists; reconcile its ownership before installing');
    }
    const next = install
      ? owned.block
        ? owned.before + renderSystemTomlHooks(def) + owned.after
        : current.text + (current.text && !current.text.endsWith('\n') ? '\n' : '') + renderSystemTomlHooks(def)
      : outside;
    if (next === current.text) return;
    if (owned.block) assertSuffixTableOwnership(current.text, owned.after);
    if (current.symlink || (current.exists && !(current.mode & 0o222))) {
      throw new Error('system config is read-only or externally mounted; update its deployment source');
    }
    validate(next);
    await writeTextFileAtomic(file, next, {
      mode: current.mode, preserveMode: true,
      expected: current.exists ? { exists: true, content: current.text } : { exists: false },
    });
    if (await fs.readFile(file, 'utf8') !== next) throw new Error('system config changed after write');
  });
}

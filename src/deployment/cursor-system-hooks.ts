import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { findNodeAtLocation, parseTree, type Node as JsonNode } from 'jsonc-parser';
import type { AgentDefinition } from '../types/deployment.js';
import { writeTextFileAtomic } from '../utils/fs-utils.js';
import { editJsonc, parseJsonDocument } from '../utils/json-document.js';
import { withDeployedStateLock } from './deployed-state-merge.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hookCommand(def: AgentDefinition): string {
  const script = def.hook!.hookCommand;
  if (!path.isAbsolute(script) || /[\r\n\0]/.test(script)) {
    throw new Error('Cursor system hooks require an absolute shell script path');
  }
  return `/bin/bash '${script.replace(/'/g, `'\\''`)}' --system-scope`;
}

/** JSON.parse and the editor select different values for duplicate properties. */
function hasDuplicateProperties(node: JsonNode | undefined): boolean {
  const keys = node?.children?.map(property => property.children?.[0]?.value) ?? [];
  return keys.length !== new Set(keys).size;
}

function withPilotHooks(def: AgentDefinition, raw: string, install: boolean): string {
  if (!install && !raw.trim()) return raw;
  const text = raw.trim() ? raw : '{}\n';
  const parsed = parseJsonDocument<JsonObject>(text);
  if (!parsed.ok || !isObject(parsed.data)) throw new Error('Invalid JSON in Cursor system config; original preserved');
  const tree = parseTree(text.replace(/^\uFEFF/, ''));
  if (hasDuplicateProperties(tree) || (tree && hasDuplicateProperties(findNodeAtLocation(tree, ['hooks'])))) {
    throw new Error('Invalid JSON with duplicate properties in Cursor system config; original preserved');
  }
  const document = parsed.data;
  if (document.version !== undefined && document.version !== 1) {
    throw new Error('Invalid JSON hook version; expected Cursor hooks version 1; original preserved');
  }
  if (document.hooks !== undefined && !isObject(document.hooks)) {
    throw new Error('Invalid JSON hooks object; original preserved');
  }
  const hooks = document.hooks ?? {};
  const command = hookCommand(def);
  const scriptName = path.basename(def.hook!.hookCommand);
  const events = new Set(install ? def.hook!.events : []);
  let next = install && document.version === undefined ? editJsonc(text, ['version'], 1) : text;
  for (const event of new Set([...Object.keys(hooks), ...events])) {
    const rows: unknown = Object.hasOwn(hooks, event) ? hooks[event] : [];
    if (!Array.isArray(rows) || !rows.every(isObject)) {
      throw new Error('Invalid JSON hook event list; original preserved');
    }
    if (install && rows.some(row =>
      typeof row.command === 'string' && row.command !== command && row.command.includes(scriptName))) {
      throw new Error('Cursor system config already references another Pilot command; original preserved');
    }
    const kept = rows.filter(row => row.command !== command);
    if (events.has(event)) kept.push({ command, failClosed: false });
    if (JSON.stringify(kept) !== JSON.stringify(rows)) {
      next = editJsonc(next, ['hooks', event], kept.length ? kept : undefined);
    }
  }
  if (!parseJsonDocument(next).ok) throw new Error('Invalid JSON after Cursor system hook update; original preserved');
  return next;
}

async function read(file: string): Promise<{ raw: string; mode: number } | undefined> {
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile()) throw new Error('Cursor system config must be a regular file; original preserved');
  return { raw: await fs.readFile(file, 'utf8'), mode: info.mode & 0o777 };
}

export async function cursorSystemHooksInstalled(def: AgentDefinition): Promise<boolean> {
  const current = await read(def.hook!.settingsPath);
  return Boolean(current && withPilotHooks(def, current.raw, true) === current.raw);
}

export async function updateCursorSystemHooks(def: AgentDefinition, install: boolean): Promise<void> {
  const file = def.hook!.settingsPath;
  if (!install && !(await read(file))) return;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  await withDeployedStateLock(`${file}.pilot-lock`, async () => {
    const current = await read(file);
    if (!install && !current) return;
    const next = withPilotHooks(def, current?.raw ?? '', install);
    if (next === current?.raw) return;
    if (current && !(current.mode & 0o222)) {
      throw new Error('Cursor system config is read-only; update its deployment source');
    }
    await writeTextFileAtomic(file, next, {
      mode: current?.mode ?? 0o644,
      preserveMode: true,
      expected: current ? { exists: true, content: current.raw } : { exists: false },
    });
  });
}

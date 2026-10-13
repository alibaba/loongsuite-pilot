import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODEX_HOOK_EVENT_KEYS, remapCodexTrust } from './codex-trust-writer.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isPilotCodexCommand(value: unknown): boolean {
  return typeof value === 'string'
    && /(?:^|[\\/"'\s])codex-loongsuite-pilot-hook\.(?:mjs|sh|ps1)(?:["'\s]|$)/i.test(value);
}

export function planCodexHookCleanup(
  data: RecordValue,
  hooksPath: string,
  owned: (command: unknown) => boolean = isPilotCodexCommand,
): { data: RecordValue; moves: Map<string, string | null>; changed: boolean } {
  const next = structuredClone(data);
  const moves = new Map<string, string | null>();
  let changed = false;
  if (!record(next.hooks)) return { data: next, moves, changed };
  const isOwned = (handler: unknown): boolean => {
    if (!record(handler)) return false;
    const commands = [handler.command, handler.commandWindows].filter(c => typeof c === 'string');
    if (!commands.some(owned)) return false;
    if (!commands.every(owned)) throw new Error('Mixed ownership in Codex handler; files left unchanged');
    return true;
  };
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    const eventKey = CODEX_HOOK_EVENT_KEYS[event];
    const retained: unknown[] = [];
    let eventChanged = false;
    groups.forEach((group, groupIndex) => {
      const handlers = record(group) && Array.isArray(group.hooks) ? group.hooks : [group];
      const survivors: unknown[] = [];
      handlers.forEach((handler, handlerIndex) => {
        const key = `${hooksPath}:${eventKey}:${groupIndex}:${handlerIndex}`;
        if (isOwned(handler)) {
          moves.set(key, null);
          eventChanged = true;
        } else {
          moves.set(key, `${hooksPath}:${eventKey}:${retained.length}:${survivors.length}`);
          survivors.push(handler);
        }
      });
      if (handlers.length > 0 && survivors.length === 0) return;
      if (record(group) && Array.isArray(group.hooks)) group.hooks = survivors;
      retained.push(group);
    });
    if (!eventChanged) continue;
    if (!eventKey) throw new Error('Unknown Codex hook event; files left unchanged');
    changed = true;
    if (retained.length) next.hooks[event] = retained;
    else delete next.hooks[event];
  }
  return { data: next, moves, changed };
}

function atomicWrite(file: string, content: string): void {
  const temp = `${file}.pilot-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: fs.statSync(file).mode & 0o777 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

/** Shared by the uninstall CLI and runtime undeploy. Never recompute third-party hashes. */
export function cleanupCodexHooks(
  hooksPath: string,
  configPath: string,
  owned?: (command: unknown) => boolean,
): boolean {
  if (!fs.existsSync(hooksPath)) return false;
  const originalHooks = fs.readFileSync(hooksPath, 'utf8');
  const data: unknown = JSON.parse(originalHooks.replace(/^\uFEFF/, ''));
  if (!record(data)) throw new Error('Invalid Codex hooks.json; files left unchanged');
  const plan = planCodexHookCleanup(data, path.resolve(hooksPath), owned);
  if (!plan.changed) return false;
  const configExists = fs.existsSync(configPath);
  const originalConfig = configExists ? fs.readFileSync(configPath, 'utf8') : '';
  const nextConfig = remapCodexTrust(originalConfig, plan.moves);
  const nextHooks = JSON.stringify(plan.data, null, 2) + '\n';
  // Respect user symlinks rather than replacing them with ordinary files.
  const hooksTarget = fs.realpathSync(hooksPath);
  const configTarget = configExists ? fs.realpathSync(configPath) : configPath;
  if (fs.readFileSync(hooksPath, 'utf8') !== originalHooks
    || fs.existsSync(configPath) !== configExists
    || (configExists && fs.readFileSync(configPath, 'utf8') !== originalConfig)) {
    throw new Error('Codex config changed during cleanup; retry');
  }
  if (nextConfig !== originalConfig) atomicWrite(configTarget, nextConfig);
  try {
    atomicWrite(hooksTarget, nextHooks);
  } catch (err) {
    // A synchronous failure must not leave trust referring to the new layout.
    if (nextConfig !== originalConfig && fs.readFileSync(configTarget, 'utf8') === nextConfig) {
      atomicWrite(configTarget, originalConfig);
    }
    throw err;
  }
  return true;
}

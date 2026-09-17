import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentDefLoader } from './agent-def-loader.js';
import { isAgentGatedEnabled, resolvePilotDir } from './deploy-command.js';
import { loadConfig } from '../core/config-loader.js';
import { resolveHome, writeTextFileAtomic } from '../utils/fs-utils.js';
import { acquireSingleInstanceLock } from '../utils/single-instance-lock.js';
import { redirectRootLoggerToStderr } from '../utils/logger.js';
import type { AgentHookConfig } from '../types/deployment.js';

type ObjectValue = Record<string, any>;
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as ObjectValue;
}

export function parseInjectCommandArgs(argv: string[]) {
  const opts = { configDir: undefined as string | undefined, json: false, help: false };
  let agents: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    const [key] = arg.split('=');
    if (key !== '--agents' && key !== '--config-dir') throw new Error(`Unknown option: ${arg}`);
    const value = arg.includes('=') ? arg.slice(key.length + 1) : argv[++i];
    if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--agents') agents = value;
    else opts.configDir = value;
  }
  if (!opts.help && agents !== 'claude-code') throw new Error('Specify --agents=claude-code; other agents are not supported');
  return opts;
}

// Only adopt direct invocations of our installed entrypoint, not commands that
// merely mention the filename (for example a customer's logging script).
function isPilotCommand(command: unknown, expected: Set<string>): boolean {
  if (typeof command !== 'string') return false;
  if (expected.has(command)) return true;
  return /^(?:"[^"\n]*[\\/]claude-code-loongsuite-pilot-hook\.sh"|'[^'\n]*[\\/]claude-code-loongsuite-pilot-hook\.sh'|[^\s'";|&]+[\\/]claude-code-loongsuite-pilot-hook\.sh)\s+(?:pre-tool-use|stop|stop-failure|subagent-start|subagent-stop)$/.test(command);
}

export function mergeClaudeHooks(settings: ObjectValue, hook: AgentHookConfig, dataDir: string) {
  if (settings.disableAllHooks === true || settings.allowManagedHooksOnly === true) {
    throw new Error('Settings disable user hooks; refusing to change the policy');
  }
  const result = structuredClone(settings);
  const hooks = result.hooks === undefined ? {} : object(result.hooks, 'hooks');
  result.hooks = hooks;
  const env = result.env === undefined ? {} : object(result.env, 'env');
  result.env = env;
  env.LOONGSUITE_PILOT_DATA_DIR = dataDir;
  // Quote the installed path as one shell word, including spaces and apostrophes.
  const quoted = `'${hook.hookCommand.replace(/'/g, `'"'"'`)}'`;
  const commands = new Map(hook.events.map(event => [event,
    `${quoted} ${event.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`]));
  const expected = new Set(commands.values());
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
    hooks[event] = groups.flatMap((group: unknown) => {
      const entry = object(group, `hooks.${event} entry`);
      if (!Array.isArray(entry.hooks)) throw new Error(`hooks.${event} entry.hooks must be an array`);
      const remaining = entry.hooks.filter((handler: unknown) => !isPilotCommand(object(handler, 'hook handler').command, expected));
      if (remaining.length === entry.hooks.length) return [entry];
      return remaining.length ? [{ ...entry, hooks: remaining }] : [];
    });
  }
  for (const [event, command] of commands) {
    hooks[event] ??= [];
    hooks[event].push({ matcher: hook.eventMatchers?.[event] ?? hook.matcher ?? '*', hooks: [{ type: 'command', command }] });
  }
  return result;
}

export async function injectClaudeDirectory(configDir: string, dataDir: string, hook: AgentHookConfig, lockTimeoutMs = 10_000) {
  if (process.platform === 'win32') throw new Error('Session hook injection currently supports Linux and macOS only');
  if (hook.format !== 'nested' || hook.eventSubcommand !== 'kebab-case') throw new Error('Unsupported Claude hook definition');
  await fs.access(hook.hookCommand, 1);
  await fs.access(path.join(path.dirname(hook.hookCommand), 'claude-code-hook-processor.mjs'));
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const realDir = await fs.realpath(configDir);
  const settingsPath = path.join(realDir, 'settings.json');
  const deadline = Date.now() + lockTimeoutMs;
  let lock;
  while (!(lock = acquireSingleInstanceLock(path.join(realDir, '.loongsuite-pilot-inject.lock')).lock)) {
    if (Date.now() >= deadline) throw new Error('Cannot acquire configuration lock (busy or not writable)');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  try {
    let raw: string | undefined;
    let mode = 0o600;
    try {
      const stat = await fs.lstat(settingsPath);
      if (!stat.isFile() || stat.nlink > 1) throw new Error('settings.json must be a regular, non-linked file');
      mode = stat.mode & 0o777;
      raw = await fs.readFile(settingsPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const settings = raw === undefined ? {} : object(JSON.parse(raw.replace(/^\uFEFF/, '')), 'settings.json');
    const next = mergeClaudeHooks(settings, hook, dataDir);
    const status = isDeepStrictEqual(settings, next) ? 'unchanged' : 'updated';
    if (status === 'updated') await writeTextFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`, {
      mode, expected: raw === undefined ? { exists: false } : { exists: true, content: raw },
    });
    return { status, agentId: 'claude-code', settingsPath };
  } finally { lock.release(); }
}

export async function runInjectCommand(argv: string[]): Promise<number> {
  redirectRootLoggerToStderr();
  try {
    const opts = parseInjectCommandArgs(argv);
    if (opts.help) {
      console.log('Usage: loongsuite-pilot inject --agents=claude-code [--config-dir PATH] [--json]');
      return 0;
    }
    const config = await loadConfig();
    if (!config.enabled || !isAgentGatedEnabled(config, 'claude-code') || config.listeners?.['claude-code-log']?.enabled === false) throw new Error('Claude Code collection is disabled');
    const dataDir = path.resolve(resolveHome(config.dataDir));
    const pilotDir = resolvePilotDir(dataDir, import.meta.url);
    const loader = new AgentDefLoader({ pilotDir, dataDir, builtinDir: path.join(pilotDir, 'agents.d'), localDir: path.join(dataDir, 'agents.d.local') });
    const def = (await loader.load()).find(def => def.id === 'claude-code');
    if (!def?.hook) throw new Error('Claude Code hook definition not found');
    const configDir = path.resolve(resolveHome(opts.configDir ?? (process.env.CLAUDE_CONFIG_DIR || '~/.claude')));
    const result = await injectClaudeDirectory(configDir, dataDir, def.hook);
    console.log(opts.json ? JSON.stringify(result) : `${result.status}: ${result.settingsPath}`);
    return 0;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (argv.includes('--json')) console.log(JSON.stringify({ status: 'failed', error }));
    else console.error(`loongsuite-pilot inject: ${error}`);
    return 1;
  }
}

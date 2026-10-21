import * as path from 'node:path';
import { loadConfig } from '../core/config-loader.js';
import { resolveHome } from '../utils/fs-utils.js';
import { redirectRootLoggerToStderr } from '../utils/logger.js';
import { isAgentGatedEnabled, resolvePilotDir } from './deploy-command.js';
import {
  runHookInstall,
  toPublicReport,
  type HookInstallRunResult,
} from './hook-install-service.js';

export interface ParsedHookArgs {
  subcommand: 'install' | 'status' | 'help';
  agents?: string;
  homes: Record<string, string>;
  configDir?: string;
  json: boolean;
  pilotDir?: string;
  help: boolean;
}

export function parseHookArgs(argv: string[]): ParsedHookArgs {
  const out: ParsedHookArgs = { subcommand: 'help', homes: {}, json: false, help: false };
  const rest = [...argv];
  const first = rest[0];
  if (first === 'install' || first === 'status') {
    out.subcommand = first;
    rest.shift();
  } else if (first === '--help' || first === '-h' || first === undefined) {
    out.help = true;
    return out;
  } else {
    throw new Error(`Unknown hook command: ${first ?? ''}`);
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (key !== '--agents' && key !== '--home' && key !== '--config-dir' && key !== '--pilot-dir') {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = inline !== undefined ? inline : rest[++i];
    if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--agents') out.agents = value;
    else if (key === '--config-dir') out.configDir = value;
    else if (key === '--pilot-dir') out.pilotDir = value;
    else {
      const splitAt = value.indexOf('=');
      if (splitAt <= 0 || splitAt === value.length - 1) {
        throw new Error(`--home must be <agent-id>=<dir>, got ${value}`);
      }
      out.homes[value.slice(0, splitAt)] = value.slice(splitAt + 1);
    }
  }
  return out;
}

function printUsage(): void {
  console.log([
    'Usage: loongsuite-pilot hook install [--agents <ids>] [--home <id>=<dir>]... [--config-dir PATH] [--json]',
    '       loongsuite-pilot hook status [--agents <ids>] [--json]',
    '',
    'Detects every agent when --agents and LOONGSUITE_PILOT_AGENTS are unset.',
    'The exact value none skips injection. The literal null is treated as unset.',
  ].join('\n'));
}

function printResult(result: HookInstallRunResult, json: boolean): void {
  for (const warning of result.warnings) {
    console.warn(`[hook-install] ${warning}`);
  }
  if (json) {
    console.log(JSON.stringify(toPublicReport(result.report)));
    return;
  }
  if (result.report.agents.length === 0) {
    console.log('[hook-install] skipped');
    return;
  }
  for (const agent of result.report.agents) {
    const reason = agent.reason ? ` reason=${agent.reason}` : '';
    const hint = agent.hint ? ` hint=${agent.hint}` : '';
    console.log(`${agent.id}=${agent.status}${reason}${hint}`);
  }
}

export async function runHookCommand(argv: string[]): Promise<number> {
  redirectRootLoggerToStderr();
  try {
    const parsed = parseHookArgs(argv);
    if (parsed.help || parsed.subcommand === 'help') {
      printUsage();
      return 0;
    }
    const config = await loadConfig();
    const dataDir = path.resolve(resolveHome(config.dataDir));
    const pilotDir = parsed.pilotDir
      ? path.resolve(resolveHome(parsed.pilotDir))
      : resolvePilotDir(dataDir, import.meta.url);
    const homes = { ...parsed.homes };
    if (parsed.configDir && !homes['claude-code']) homes['claude-code'] = parsed.configDir;
    const result = await runHookInstall({
      dataDir,
      pilotDir,
      agentsFlag: parsed.agents,
      envAgents: parsed.agents === undefined ? process.env.LOONGSUITE_PILOT_AGENTS : undefined,
      homes,
      writeResult: parsed.subcommand === 'install',
      enabled: id => isAgentGatedEnabled(config, id),
      mode: parsed.subcommand,
    });
    printResult(result, parsed.json);
    return result.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (argv.includes('--json')) console.log(JSON.stringify({ status: 'failed', error: message }));
    else console.error(`loongsuite-pilot hook: ${message}`);
    return 2;
  }
}

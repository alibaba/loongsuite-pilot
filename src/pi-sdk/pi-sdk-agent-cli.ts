import type { AgentDefinition } from '../types/index.js';
import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { redirectRootLoggerToStderr } from '../utils/logger.js';
import {
  doctorPiSdkAgent,
  listRegisteredPiSdkAgents,
  registerPiSdkAgent,
  unregisterPiSdkAgent,
} from './pi-sdk-agent-registry.js';

interface ParsedArgs {
  flags: Map<string, string[]>;
  positional: string[];
}

export async function handlePiSdkAgentCli(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'agent') return false;
  if (argv.some(arg => arg === '--json' || arg.startsWith('--json='))) {
    redirectRootLoggerToStderr();
  }

  const command = argv[1] ?? '';
  try {
    const dataDir = await resolveAgentCliDataDir();
    switch (command) {
      case 'register':
        await registerCommand(dataDir, argv.slice(2));
        break;
      case 'list':
        await listCommand(dataDir, argv.slice(2));
        break;
      case 'doctor':
      case 'status':
        await doctorCommand(dataDir, argv.slice(2));
        break;
      case 'unregister':
        await unregisterCommand(dataDir, argv.slice(2));
        break;
      default:
        printUsage();
        process.exitCode = command ? 1 : 0;
    }
  } catch (err) {
    console.error(`loongsuite-pilot agent: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  return true;
}

async function registerCommand(dataDir: string, argv: string[]): Promise<void> {
  if (argv[0] !== 'pi-sdk') {
    throw new Error('register currently supports only: pi-sdk');
  }
  const args = parseArgs(argv.slice(1));
  validateFlags(args, ['id', 'name', 'agent-dir', 'detect-path', 'detect-command', 'json']);
  if (args.positional.length > 0) throw new Error(`unexpected argument: ${args.positional[0]}`);

  const result = await registerPiSdkAgent({
    dataDir,
    id: requiredSingle(args, 'id'),
    name: requiredSingle(args, 'name'),
    agentDir: requiredSingle(args, 'agent-dir'),
    detectionPaths: values(args, 'detect-path'),
    detectionCommands: values(args, 'detect-command'),
  });

  if (hasFlag(args, 'json')) {
    console.log(JSON.stringify({
      id: result.definition.id,
      name: result.definition.displayName,
      agentDir: result.definition.piSdk?.agentDir,
      settingsPath: result.settingsPath,
      definitionPath: result.definitionPath,
      wrapperPath: result.wrapperPath,
      warnings: result.warnings,
      collectorRestartRecommended: true,
    }, null, 2));
    return;
  }

  console.log(`registered PI SDK Agent: ${result.definition.id}`);
  console.log(`name:       ${result.definition.displayName}`);
  console.log(`agentDir:   ${result.definition.piSdk?.agentDir}`);
  console.log(`settings:   ${result.settingsPath}`);
  console.log(`definition: ${result.definitionPath}`);
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  console.log('Restart the custom Agent (or reload its AgentSession) if it is already running.');
}

async function listCommand(dataDir: string, argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  validateFlags(args, ['json']);
  if (args.positional.length > 0) throw new Error(`unexpected argument: ${args.positional[0]}`);
  const definitions = await listRegisteredPiSdkAgents(dataDir);
  if (hasFlag(args, 'json')) {
    console.log(JSON.stringify(definitions.map(toListRecord), null, 2));
    return;
  }
  if (definitions.length === 0) {
    console.log('No registered PI SDK Agents.');
    return;
  }
  printTable([
    ['ID', 'NAME', 'AGENT DIR'],
    ...definitions.map(definition => [
      definition.id,
      definition.displayName,
      definition.piSdk?.agentDir ?? '-',
    ]),
  ]);
}

async function doctorCommand(dataDir: string, argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  validateFlags(args, ['json']);
  const id = args.positional[0];
  if (!id) throw new Error('agent id is required');
  if (args.positional.length > 1) throw new Error(`unexpected argument: ${args.positional[1]}`);
  const result = await doctorPiSdkAgent(dataDir, id);
  if (hasFlag(args, 'json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`ID:        ${result.id}`);
  console.log(`Name:      ${result.name}`);
  console.log(`Agent dir: ${result.agentDir}`);
  console.log(`Detected:  ${yesNo(result.detected)}`);
  console.log(`Runtime:   ${yesNo(result.runtimePresent)}`);
  console.log(`Wrapper:   ${yesNo(result.wrapperPresent)}`);
  console.log(`Injected:  ${yesNo(result.injectionPresent)}`);
  console.log(`Healthy:   ${yesNo(result.healthy)}`);
}

async function unregisterCommand(dataDir: string, argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  validateFlags(args, ['json']);
  const id = args.positional[0];
  if (!id) throw new Error('agent id is required');
  if (args.positional.length > 1) throw new Error(`unexpected argument: ${args.positional[1]}`);
  const result = await unregisterPiSdkAgent(dataDir, id);
  if (hasFlag(args, 'json')) {
    console.log(JSON.stringify({ ...result, collectorRestartRecommended: true }, null, 2));
    return;
  }
  console.log(`unregistered PI SDK Agent: ${result.id}`);
}

async function resolveAgentCliDataDir(): Promise<string> {
  const envDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
  if (envDataDir?.trim()) return resolveHome(envDataDir);
  const configPath = resolveHome(process.env.AGENT_DATA_COLLECTION_CONFIG ?? '~/.loongsuite-pilot/config.json');
  const config = await readJsonFile<{ dataDir?: string }>(configPath);
  return resolveHome(config?.dataDir ?? '~/.loongsuite-pilot');
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    if (equals > 2) {
      pushFlag(flags, arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      pushFlag(flags, name, next);
      index += 1;
    } else {
      pushFlag(flags, name, 'true');
    }
  }
  return { flags, positional };
}

function pushFlag(flags: Map<string, string[]>, name: string, value: string): void {
  const current = flags.get(name) ?? [];
  current.push(value);
  flags.set(name, current);
}

function validateFlags(args: ParsedArgs, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of args.flags.keys()) {
    if (!allowedSet.has(name)) throw new Error(`unknown option --${name}`);
  }
}

function requiredSingle(args: ParsedArgs, name: string): string {
  const all = values(args, name);
  if (all.length === 0 || !all[0].trim()) throw new Error(`--${name} is required`);
  if (all.length > 1) throw new Error(`--${name} may only be provided once`);
  return all[0];
}

function values(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

function toListRecord(definition: AgentDefinition): Record<string, unknown> {
  return {
    id: definition.id,
    name: definition.displayName,
    agentDir: definition.piSdk?.agentDir,
    detection: definition.detection,
  };
}

function printTable(rows: string[][]): void {
  const widths = rows[0].map((_, index) => Math.max(...rows.map(row => row[index].length)));
  for (const row of rows) {
    console.log(row.map((cell, index) => cell.padEnd(widths[index])).join('  '));
  }
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function printUsage(): void {
  console.log(`Usage:
  loongsuite-pilot agent register pi-sdk --id <id> --name <name> --agent-dir <dir> \\
    [--detect-path <path> ...] [--detect-command <command> ...]
  loongsuite-pilot agent list [--json]
  loongsuite-pilot agent doctor <id> [--json]
  loongsuite-pilot agent unregister <id> [--json]

The registered Agent must use @earendil-works/pi-coding-agent's high-level SDK
and load extensions from the supplied agentDir.`);
}

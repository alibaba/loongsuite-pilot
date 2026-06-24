import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import {
  connectLocalWorker,
  deleteLocalWorkerInstance,
  listLocalWorkerViews,
  readLocalWorkerInstance,
  readLocalWorkerView,
  reconnectLocalWorker,
  setLocalWorkerEnabled,
  type RuntimeOptions,
} from './instance-store.js';

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
  passthrough: string[];
  passthroughProvided: boolean;
}

export async function handleWorkerCli(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'worker') return false;

  const command = argv[1] ?? '';
  try {
    const dataDir = await resolveWorkerDataDir();

    switch (command) {
      case 'connect':
        await connectCommand(dataDir, parseArgs(argv.slice(2)));
        return true;
      case 'list':
        await listCommand(dataDir, parseArgs(argv.slice(2)));
        return true;
      case 'status':
        await statusCommand(dataDir, parseArgs(argv.slice(2)));
        return true;
      case 'disconnect':
        await disconnectCommand(dataDir, parseArgs(argv.slice(2)));
        return true;
      case 'delete':
        await deleteCommand(dataDir, parseArgs(argv.slice(2)));
        return true;
      default:
        printUsage();
        process.exitCode = command ? 1 : 0;
        return true;
    }
  } catch (err) {
    console.error(`loongsuite-pilot worker: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return true;
  }
}

async function resolveWorkerDataDir(): Promise<string> {
  const envDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
  if (envDataDir && envDataDir.trim() !== '') {
    return resolveHome(envDataDir);
  }

  const configPath = resolveHome(process.env.AGENT_DATA_COLLECTION_CONFIG ?? '~/.loongsuite-pilot/config.json');
  const file = await readJsonFile<{ dataDir?: string }>(configPath);
  return resolveHome(file?.dataDir ?? '~/.loongsuite-pilot');
}

async function connectCommand(dataDir: string, args: ParsedArgs): Promise<void> {
  validateFlags(args, ['runtime', 'bootstrap-token', 'work-dir', 'json'], { allowRuntimeOptions: true });
  const existingId = args.positional[0];
  if (existingId) {
    if (optionalString(args, 'runtime')) {
      throw new Error('--runtime is only valid when creating a new local worker');
    }
    const instance = await reconnectLocalWorker({
      dataDir,
      instanceId: existingId,
      bootstrapToken: optionalString(args, 'bootstrap-token'),
      workDir: optionalString(args, 'work-dir'),
      runtimeOptions: args.passthroughProvided ? parseRuntimeOptions(args.passthrough) : undefined,
    });
    if (args.flags.json) {
      console.log(JSON.stringify(instance, null, 2));
      return;
    }
    console.log(`reconnected ${instance.id}`);
    console.log(`runtime: ${instance.runtime}`);
    console.log(`workDir: ${instance.workDir}`);
    return;
  }

  const runtime = requiredString(args, 'runtime');
  const bootstrapToken = requiredString(args, 'bootstrap-token');
  const instance = await connectLocalWorker({
    dataDir,
    runtime,
    bootstrapToken,
    workDir: optionalString(args, 'work-dir'),
    runtimeOptions: parseRuntimeOptions(args.passthrough),
  });

  if (args.flags.json) {
    console.log(JSON.stringify(instance, null, 2));
    return;
  }

  console.log(`connected ${instance.id}`);
  console.log(`runtime: ${instance.runtime}`);
  console.log(`workDir: ${instance.workDir}`);
}

async function listCommand(dataDir: string, args: ParsedArgs): Promise<void> {
  validateFlags(args, ['json']);
  const views = await listLocalWorkerViews(dataDir);
  if (args.flags.json) {
    console.log(JSON.stringify(views, null, 2));
    return;
  }
  if (views.length === 0) {
    console.log('No local workers.');
    return;
  }

  const rows = [
    ['ID', 'RUNTIME', 'STATE', 'WORKDIR', 'WORKER', 'UPDATED'],
    ...views.map(view => [
      view.id,
      view.runtime,
      view.state,
      view.workDir,
      view.workerName ?? '-',
      view.updatedAt,
    ]),
  ];
  printTable(rows);
}

async function statusCommand(dataDir: string, args: ParsedArgs): Promise<void> {
  validateFlags(args, ['json']);
  const id = args.positional[0];
  if (!id) {
    await listCommand(dataDir, args);
    return;
  }

  const instance = await readLocalWorkerInstance(dataDir, id);
  if (!instance) throw new Error(`local worker not found: ${id}`);
  const view = await readLocalWorkerView(dataDir, instance);
  if (args.flags.json) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  console.log(`ID:          ${view.id}`);
  console.log(`Runtime:     ${view.runtime}`);
  console.log(`State:       ${view.state}`);
  if (view.pid) console.log(`PID:         ${view.pid}`);
  console.log(`WorkDir:     ${view.workDir}`);
  console.log(`Worker:      ${view.workerName ?? '-'}`);
  console.log(`Team:        ${view.teamName ?? '-'}`);
  console.log(`Matrix:      ${view.matrix ?? '-'}`);
  console.log(`Room:        ${view.roomId ?? '-'}`);
  console.log(`Heartbeat:   ${view.heartbeat ?? '-'}`);
  console.log(`Log:         ${view.logPath}`);
}

async function disconnectCommand(dataDir: string, args: ParsedArgs): Promise<void> {
  validateFlags(args, ['json']);
  const id = args.positional[0];
  if (!id) throw new Error('instance id is required');
  const instance = await setLocalWorkerEnabled(dataDir, id, false);
  if (args.flags.json) {
    console.log(JSON.stringify(instance, null, 2));
    return;
  }
  console.log(`disconnect requested ${instance.id}`);
}

async function deleteCommand(dataDir: string, args: ParsedArgs): Promise<void> {
  validateFlags(args, ['json']);
  const id = args.positional[0];
  if (!id) throw new Error('instance id is required');
  await deleteLocalWorkerInstance(dataDir, id);
  if (args.flags.json) {
    console.log(JSON.stringify({ id, deleted: true }, null, 2));
    return;
  }
  console.log(`deleted ${id}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const passthrough: string[] = [];
  let passthroughProvided = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (passthroughProvided) {
      passthrough.push(arg);
      continue;
    }
    if (arg === '--') {
      passthroughProvided = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional, passthrough, passthroughProvided };
}

function validateFlags(
  args: ParsedArgs,
  allowed: string[],
  opts: { allowRuntimeOptions?: boolean } = {},
): void {
  const allowedSet = new Set(allowed);
  for (const name of Object.keys(args.flags)) {
    if (allowedSet.has(name)) continue;
    throw new Error(`unknown option --${name}; pass runtime worker arguments after "--"`);
  }
  if (!opts.allowRuntimeOptions && args.passthroughProvided) {
    throw new Error('runtime worker arguments are only supported by connect');
  }
}

function parseRuntimeOptions(argv: string[]): RuntimeOptions {
  const options: RuntimeOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--') || arg === '--') {
      throw new Error(`runtime worker argument must be an option: ${arg}`);
    }

    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      const key = body.slice(0, eq);
      if (!key) throw new Error(`runtime worker argument has empty name: ${arg}`);
      options[key] = body.slice(eq + 1);
      continue;
    }

    if (!body) throw new Error(`runtime worker argument has empty name: ${arg}`);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      options[body] = next;
      i += 1;
    } else {
      options[body] = true;
    }
  }
  return options;
}

function requiredString(args: ParsedArgs, name: string): string {
  const value = optionalString(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function optionalString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function printTable(rows: string[][]): void {
  const widths = rows[0].map((_, index) => Math.max(...rows.map(row => row[index].length)));
  for (const row of rows) {
    console.log(row.map((cell, index) => cell.padEnd(widths[index])).join('  '));
  }
}

function printUsage(): void {
  console.log(`Usage:
  loongsuite-pilot worker connect --runtime claude-code --bootstrap-token <token> [--work-dir <dir>] [-- <runtime-options...>]
  loongsuite-pilot worker connect <instanceId> [--bootstrap-token <token>] [--work-dir <dir>] [-- <runtime-options...>]
  loongsuite-pilot worker list [--json]
  loongsuite-pilot worker status [instanceId] [--json]
  loongsuite-pilot worker disconnect <instanceId>
  loongsuite-pilot worker delete <instanceId>

Notes:
  connect <instanceId> reconnects an existing disconnected worker without
  requiring the bootstrap token again. Pass --bootstrap-token to rotate the
  saved token file for that instance. Options after "--" are stored as runtime
  options and expanded by worker.manifest.json instance placeholders.`);
}

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const exec = promisify(execFile);
const require = createRequire(path.join(process.cwd(), 'package.json'));
let bundles: string;
let root: string;
let dataDir: string;
let pilotDir: string;
let settings: string;
let configPath: string;

beforeAll(async () => {
  bundles = await mkdtemp(path.join(tmpdir(), 'interceptor-entrypoints-'));
  const externalPackages = {
    name: 'absolute-external-packages',
    setup(builder: import('esbuild').PluginBuild) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({
        path: args.path.startsWith('node:') ? args.path : require.resolve(args.path), external: true,
      }));
    },
  };
  const common = { bundle: true, platform: 'node' as const, format: 'cjs' as const,
    plugins: [externalPackages], logLevel: 'silent' as const };
  await build({ ...common, entryPoints: ['src/inject-hooks.ts'], outfile: path.join(bundles, 'inject.cjs') });
  await build({ ...common, stdin: {
    contents: "import { runDeployCommand } from './src/deployment/deploy-command.ts'; runDeployCommand(process.argv.slice(2)).then(code => process.exit(code));",
    resolveDir: process.cwd(), loader: 'ts',
  }, outfile: path.join(bundles, 'deploy.cjs') });
});

afterAll(async () => { await rm(bundles, { recursive: true, force: true }); });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'interceptor-deployment-'));
  dataDir = path.join(root, 'data');
  pilotDir = path.join(dataDir, 'versions', 'fixture');
  settings = path.join(root, 'agent', 'settings.json');
  configPath = path.join(root, 'source-config.json');
  await mkdir(path.join(pilotDir, 'agents.d'), { recursive: true });
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(path.join(dataDir, 'current'), 'fixture\n');
  await writeFile(path.join(pilotDir, 'agents.d', 'sample-agent.json'), JSON.stringify({
    id: 'sample-agent', displayName: 'Sample Agent', deployMode: 'hook',
    detection: { paths: [path.dirname(settings)], commands: [] },
    hook: {
      settingsPath: settings, events: ['Stop'], format: 'nested', matcher: '*',
      hookCommand: '$PILOT_DATA/hooks/collect.sh',
      interceptor: { events: ['UserPromptSubmit'], format: 'nested', matcher: '*',
        timeout: 15, hookCommand: '$PILOT_DATA/hooks/interceptor.sh' },
    },
  }));
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function seed(mode: string): Promise<void> {
  await writeFile(configPath, JSON.stringify({ dataDir, interceptor: { mode } }));
  await writeFile(settings, JSON.stringify({ hooks: {
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: path.join(dataDir, 'hooks', 'collect.sh') }] }],
    UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: path.join(dataDir, 'hooks', 'interceptor.sh'), timeout: 15 }] }],
  } }));
}

async function run(entry: 'inject' | 'deploy', modeEnv?: string, explicitDataDir = false, agent = 'sample-agent'): Promise<void> {
  const env = { ...process.env, HOME: root, USERPROFILE: root,
    AGENT_DATA_COLLECTION_CONFIG: configPath, LOONGSUITE_PILOT_DATA_DIR: '',
    LOONGSUITE_PILOT_INTERCEPTOR_MODE: modeEnv ?? '', LOONGSUITE_PILOT_STDOUT: '0' };
  const args = entry === 'inject'
    ? [`--pilot-dir=${pilotDir}`, `--agents=${agent}`, ...(explicitDataDir ? [`--data-dir=${dataDir}`] : [])]
    : ['--json', '--require', agent];
  await exec(process.execPath, [path.join(bundles, `${entry}.cjs`), ...args], { env, timeout: 15_000 });
}

async function assertHooks(enabled: boolean): Promise<void> {
  const result = JSON.parse(await readFile(settings, 'utf8'));
  const commands = (event: string) => (result.hooks?.[event] ?? [])
    .flatMap((group: { hooks?: Array<{ command?: string }> }) => (group.hooks ?? []).map(hook => hook.command));
  expect(commands('Stop')).toEqual([path.join(dataDir, 'hooks', 'collect.sh')]);
  expect(commands('UserPromptSubmit')).toEqual(enabled ? [path.join(dataDir, 'hooks', 'interceptor.sh')] : []);
}

describe.each(['inject', 'deploy'] as const)('%s interceptor deployment entrypoint', entry => {
  it.each(['all', 'none', 'custom'])('honors file mode %s and retains collection hooks', async mode => {
    await seed(mode);
    await run(entry);
    await assertHooks(mode === 'all');
    if (mode === 'all') {
      // A clean install and a repeated deployment must agree with preservation.
      await writeFile(settings, '{}');
      await run(entry);
      await run(entry);
      await assertHooks(true);
    }
  });

  it.each([['none', 'all', true], ['all', 'none', false]] as const)(
    'honors mode env %s -> %s', async (fileMode, modeEnv, enabled) => {
      await seed(fileMode);
      await run(entry, modeEnv);
      await assertHooks(enabled);
    },
  );
});

it('inject uses an explicit install data directory config instead of another daemon config', async () => {
  await seed('none');
  await writeFile(configPath, JSON.stringify({ dataDir: path.join(root, 'other-install'), interceptor: { mode: 'none' } }));
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ interceptor: { mode: 'all' } }));
  await run('inject', undefined, true);
  await assertHooks(true);
});

it('adds and removes WorkBuddy interceptor hooks alongside existing hooks', async () => {
  dataDir = path.join(root, 'pilot data');
  pilotDir = path.join(dataDir, 'versions', 'fixture');
  await mkdir(path.join(pilotDir, 'agents.d'), { recursive: true });
  await writeFile(path.join(dataDir, 'current'), 'fixture\n');
  const workbuddy = JSON.parse(await readFile('agents.d/workbuddy.json', 'utf8'));
  workbuddy.detection.paths = [path.dirname(settings)];
  workbuddy.hook.settingsPath = settings;
  await writeFile(path.join(pilotDir, 'agents.d', 'workbuddy.json'), JSON.stringify(workbuddy));
  await writeFile(configPath, JSON.stringify({ dataDir, interceptor: { mode: 'none' } }));
  const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] };
  await writeFile(settings, JSON.stringify({ hooks: { PreToolUse: [userHook] } }));

  await run('inject', 'none', false, 'workbuddy');
  const original = JSON.parse(await readFile(settings, 'utf8'));
  expect(original.hooks.PreToolUse[0]).toEqual(userHook);
  expect(original.hooks.PreToolUse[1].hooks[0].command).toMatch(/workbuddy-loongsuite-pilot-hook\.(sh|ps1).*pre-tool-use$/);

  await run('inject', 'all', false, 'workbuddy');
  await run('inject', 'all', false, 'workbuddy');
  const enabled = JSON.parse(await readFile(settings, 'utf8'));
  const scriptPath = path.join(dataDir, 'hooks', 'interceptor-hook').replace(/\\/g, '/');
  const launcher = process.platform === 'win32'
    ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}.ps1"`
    : `'${scriptPath}.sh'`;
  for (const [event, subcommand, timeout] of [
    ['UserPromptSubmit', 'user-prompt-submit', 15],
    ['PreToolUse', 'pre-tool-use', 10],
    ['PostToolUse', 'post-tool-use', 10],
  ] as const) {
    const [interceptor, ...otherHooks] = enabled.hooks[event];
    expect(interceptor.hooks).toEqual([{
      type: 'command',
      command: `${launcher} --agent workbuddy --event ${subcommand}`,
      timeout,
    }]);
    if (event !== 'UserPromptSubmit') expect(interceptor.matcher).toBe('.*');
    expect(otherHooks).toEqual(original.hooks[event]);
  }

  await run('deploy', 'none', false, 'workbuddy');
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual(original);
});

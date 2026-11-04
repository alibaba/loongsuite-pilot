import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { AgentDefinition } from '../../../src/types/deployment.js';
import { DeploymentManager } from '../../../src/deployment/deployment-manager.js';
import { planSystemLauncher } from '../../../src/deployment/system-launcher.js';
import { runHookInstall } from '../../../src/deployment/hook-install-service.js';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';

vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
let root: string, dataDir: string, entry: string, original: string;
let def: AgentDefinition, manager: DeploymentManager;
let restoreHome: () => void;
let previousPath: string | undefined;
async function packageAt(suffix: string) {
  const pkg = path.join(root, suffix);
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', bin: { pi: 'cli.mjs' } }));
  const cli = path.join(pkg, 'cli.mjs');
  await fs.writeFile(cli, '#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),data:process.env.LOONGSUITE_PILOT_DATA_DIR,home:process.env.PI_CODING_AGENT_DIR}));process.exit(37);\n', { mode: 0o755 });
  return cli;
}
function business(args = ['--print', 'a prompt with spaces']) {
  const result = spawnSync(entry, args, { encoding: 'utf8', env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, 'new-identity') } });
  expect(result.status, result.stderr).toBe(37);
  return JSON.parse(result.stdout);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi scope's "));
  restoreHome = isolateAgentHome(root);
  dataDir = path.join(root, 'pilot');
  await fs.mkdir(path.join(root, 'bin'));
  await fs.mkdir(dataDir);
  entry = path.join(root, 'bin/pi');
  original = await packageAt('package');
  await fs.symlink(original, entry);
  previousPath = process.env.PATH;
  process.env.PATH = path.dirname(entry) + path.delimiter + previousPath;
  def = {
    id: 'pi-coding-agent', displayName: 'Pi', deployMode: 'plugin-inject',
    detection: { paths: [], commands: ['pi'] },
    pluginInject: { configPaths: [path.join(root, 'base/settings.json')], pluginId: 'pilot',
      pluginSpec: path.join(dataDir, 'plugins/pi-coding-agent/index.mjs'), configKey: 'extensions', createIfMissing: true },
    systemLauncher: { command: 'pi', packageNames: ['@earendil-works/pi-coding-agent'], argument: '--extension',
      assetPath: path.join(dataDir, 'plugins/pi-coding-agent/index.mjs'),
      assetFiles: ['pi-coding-agent/index.mjs', 'shared/resource-context.mjs'] },
  };
  manager = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
});
afterEach(async () => { restoreHome(); process.env.PATH = previousPath; await fs.rm(root, { recursive: true, force: true }); });

describe('public system CLI launcher lifecycle', () => {
  it('injects once for later homes, forwards arguments and exit codes, and restores the original link', async () => {
    expect((await manager.deployLauncherScope(def, 'system')).success).toBe(true);
    const output = business();
    expect(output.args).toEqual(['--extension', def.systemLauncher!.assetPath, '--print', 'a prompt with spaces']);
    expect(output.data).toBe(dataDir);
    expect(output.home).toBe(path.join(root, 'new-identity'));
    expect(await fs.readFile(path.join(root, 'new-identity/settings.json')).catch(() => null)).toBeNull();
    expect(await manager.needsRedeploy(def)).toBe(false);
    expect(await manager.undeployAgent(def)).toBe(true);
    expect(await fs.readlink(entry)).toBe(original);
    expect(business().args).toEqual(['--print', 'a prompt with spaces']);
  });

  it('fails open on missing/corrupt assets and repairs through the normal restart path', async () => {
    await manager.deployLauncherScope(def, 'system');
    const asset = def.systemLauncher!.assetPath;
    await fs.writeFile(asset, 'corrupt');
    expect(business().args).toEqual(['--print', 'a prompt with spaces']);
    expect(await manager.needsRedeploy(def)).toBe(true);
    expect((await manager.deploySingle(def)).success).toBe(true);
    expect(business().args[0]).toBe('--extension');
    await fs.unlink(path.join(dataDir, 'plugins/shared/resource-context.mjs'));
    expect(business().args[0]).toBe('--print');
  });

  it('rejects unrecognized or regular executables before changing the command', async () => {
    await fs.unlink(entry);
    await fs.writeFile(entry, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await expect(planSystemLauncher(def, dataDir)).rejects.toThrow('npm bin symlink');
    expect(await fs.readFile(entry, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    await fs.unlink(entry);
    await fs.symlink(original, entry);
    await fs.writeFile(path.join(root, 'package/package.json'), JSON.stringify({ name: 'unrecognized', bin: { pi: 'cli.mjs' } }));
    await expect(planSystemLauncher(def, dataDir)).rejects.toThrow('Unrecognized');
    expect(await fs.readlink(entry)).toBe(original);
  });

  it('adopts an official npm upgrade and preserves an independently replaced command on uninstall', async () => {
    await manager.deployLauncherScope(def, 'system');
    const upgraded = await packageAt('package-v2');
    await fs.unlink(entry);
    await fs.symlink(upgraded, entry);
    expect(await manager.needsRedeploy(def)).toBe(true);
    expect((await manager.deploySingle(def)).success).toBe(true);
    let state = JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf8'));
    expect(state[def.id].systemLauncher.originalTarget).toBe(await fs.realpath(upgraded));
    await fs.unlink(entry);
    await fs.writeFile(entry, '#!/bin/sh\nexit 5\n', { mode: 0o755 });
    expect(await manager.undeployAgent(def)).toBe(true);
    expect(await fs.readFile(entry, 'utf8')).toBe('#!/bin/sh\nexit 5\n');
  });

  it('records cleanup intent before binding and retains it after a failed final commit', async () => {
    const save = (manager as any).saveState.bind(manager);
    let calls = 0;
    vi.spyOn(manager as any, 'saveState').mockImplementation(async () => {
      if (++calls === 2) throw new Error('final commit failed');
      await save();
    });
    await expect(manager.deployLauncherScope(def, 'system')).rejects.toThrow('final commit failed');
    const restarted = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    expect((await restarted.deploySingle(def)).success).toBe(false);
    expect(await restarted.undeployAgent(def)).toBe(true);
    expect(await fs.readlink(entry)).toBe(original);
  });

  it('does not mutate the CLI when the first journal write fails', async () => {
    vi.spyOn(manager as any, 'saveState').mockRejectedValue(new Error('state unavailable'));
    await expect(manager.deployLauncherScope(def, 'system')).rejects.toThrow('state unavailable');
    expect(await fs.readlink(entry)).toBe(original);
  });

  it('migrates a recorded home and can explicitly roll back to it while keeping third-party extensions', async () => {
    await fs.mkdir(path.dirname(def.pluginInject!.configPaths[0]), { recursive: true });
    await fs.writeFile(def.pluginInject!.configPaths[0], '{"extensions":["third-party"]}');
    expect((await manager.deployPrepared(def, true)).success).toBe(true);
    expect((await manager.deployLauncherScope(def, 'system')).success).toBe(true);
    expect(JSON.parse(await fs.readFile(def.pluginInject!.configPaths[0], 'utf8')).extensions).toEqual(['third-party']);
    expect((await manager.deployLauncherScope(def, 'user')).success).toBe(true);
    expect(await fs.readlink(entry)).toBe(original);
    expect(JSON.parse(await fs.readFile(def.pluginInject!.configPaths[0], 'utf8')).extensions).toContain(def.pluginInject!.pluginSpec);
  });

  it('uses persisted scope for status and disables the shared binding', async () => {
    const builtin = path.join(root, 'agents.d');
    await fs.mkdir(builtin);
    await fs.writeFile(path.join(builtin, 'pi.json'), JSON.stringify(def));
    const opts = { dataDir, pilotDir: path.resolve('.'), builtinAgentsDir: builtin };
    expect((await runHookInstall({ ...opts, deploymentScope: 'system' })).exitCode).toBe(0);
    const status = await runHookInstall({ ...opts, mode: 'status' });
    expect(status.report.agents[0]).toMatchObject({ status: 'ok', hookScope: 'system', runtimeHealthy: true, settingsPath: entry });
    const loader = new DeploymentManager(opts);
    await loader.loadDefinitions();
    expect((await loader.deployAll(() => false))[0].success).toBe(true);
    expect(await fs.readlink(entry)).toBe(original);
  });

  it('installs a DSH patch and marker, retires the recorded home, and repairs a missing marker', async () => {
    const dshEntry = path.join(root, 'bin/dsh');
    await fs.symlink(original, dshEntry);
    await fs.writeFile(path.join(root, 'package/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'cli.mjs' } }));
    const pluginSource = path.join(dataDir, 'plugins/dsh/plugin.mjs');
    await fs.mkdir(path.dirname(pluginSource), { recursive: true });
    await fs.copyFile(path.resolve('assets/plugins/dsh/plugin.mjs'), pluginSource);
    const patchPath = path.join(root, 'base/cordis.patch.yml');
    await fs.mkdir(path.dirname(patchPath), { recursive: true });
    await fs.writeFile(patchPath, '# preserve organization patch\n');
    def = { id: 'dsh', displayName: 'DSH', deployMode: 'dsh-yaml-patch',
      detection: { paths: [], commands: ['dsh'] },
      dshYamlPatch: { pluginSource, patchPath, entryId: 'loongsuite-pilot-observability', marker: 'PILOT-OBSERVABILITY-MANAGED' },
      systemLauncher: { command: 'dsh', packageNames: ['@deepseek-ai/dsh'], argument: '--patch',
        assetPath: path.join(dataDir, 'system-launchers/dsh/pilot.patch.yml'),
        assetFiles: ['dsh/plugin.mjs', 'shared/resource-context.mjs'] } };
    expect((await manager.deployPrepared(def, true)).success).toBe(true);
    const builtin = path.join(root, 'agents.d');
    await fs.mkdir(builtin);
    await fs.writeFile(path.join(builtin, 'dsh.json'), JSON.stringify(def));
    expect((await runHookInstall({ dataDir, pilotDir: path.resolve('.'), builtinAgentsDir: builtin,
      deploymentScope: 'system', writeResult: true })).exitCode).toBe(0);
    expect(await fs.readFile(patchPath, 'utf8')).toBe('# preserve organization patch\n');
    const patch = await fs.readFile(def.systemLauncher!.assetPath, 'utf8');
    expect(patch).toContain('- insert:');
    expect(patch).toContain('loongsuite-pilot-observability');
    expect(patch).toContain('file://');
    const marker = path.join(path.dirname(pluginSource), '.collection-enabled');
    expect(await manager.needsRedeploy(def)).toBe(false);
    await fs.unlink(marker);
    entry = dshEntry;
    expect(business().args[0]).toBe('--print');
    expect(await manager.needsRedeploy(def)).toBe(true);
    expect((await manager.deploySingle(def)).success).toBe(true);
    expect(business().args.slice(0, 2)).toEqual(['--patch', def.systemLauncher!.assetPath]);
    expect(await manager.undeployAgent(def)).toBe(true);
    expect(await fs.readFile(marker).catch(() => null)).toBeNull();
    expect(await fs.readlink(dshEntry)).toBe(original);
  });
});

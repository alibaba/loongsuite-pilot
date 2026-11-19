import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { AgentDefinition } from '../../../src/types/deployment.js';
import { systemHookDefinition } from '../../../src/deployment/system-hook-config.js';
import { cursorSystemHooksInstalled, updateCursorSystemHooks } from '../../../src/deployment/cursor-system-hooks.js';
import { runHookInstall } from '../../../src/deployment/hook-install-service.js';
import { DeploymentManager } from '../../../src/deployment/deployment-manager.js';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';

vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let root: string;
let dataDir: string;
let def: AgentDefinition;
let restore: () => void;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-system-'));
  restore = isolateAgentHome(root);
  dataDir = path.join(root, "pilot's data");
  await fs.mkdir(dataDir);
  def = { id: 'cursor', displayName: 'Cursor', deployMode: 'hook',
    detection: { paths: [path.join(root, 'user/.cursor')], commands: [] },
    hook: { settingsPath: path.join(root, 'user/.cursor/hooks.json'),
      systemSettingsPath: path.join(root, 'etc/cursor/hooks.json'),
      hookCommand: path.join(dataDir, 'hooks/cursor-loongsuite-pilot-hook.sh'),
      events: ['beforeSubmitPrompt', 'postToolUse', 'stop'], format: 'flat' } };
});
afterEach(async () => { restore(); await fs.rm(root, { recursive: true, force: true }); });
async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

describe('Cursor enterprise system registration', () => {
  it('writes versioned flat hooks and preserves customer configuration during upgrade and removal', async () => {
    const target = systemHookDefinition(def);
    const customer = { version: 1, hooks: { stop: [{ command: 'customer-audit', timeout: 2 }], workspaceOpen: [] } };
    await write(target.hook!.settingsPath, JSON.stringify(customer));
    await updateCursorSystemHooks(target, true);
    const once = await fs.readFile(target.hook!.settingsPath, 'utf8');
    const value = JSON.parse(once);
    expect(value.version).toBe(1);
    expect(value.hooks.stop[0]).toEqual(customer.hooks.stop[0]);
    expect(value.hooks.stop[1]).toMatchObject({ failClosed: false });
    expect(value.hooks.stop[1]).not.toHaveProperty('hooks');
    expect(await cursorSystemHooksInstalled(target)).toBe(true);
    await updateCursorSystemHooks(target, true);
    expect(await fs.readFile(target.hook!.settingsPath, 'utf8')).toBe(once);
    await updateCursorSystemHooks(target, false);
    expect(JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8'))).toEqual(customer);
  });

  it('initializes a missing version and refuses an incompatible version unchanged', async () => {
    const target = systemHookDefinition(def);
    await updateCursorSystemHooks(target, true);
    expect(JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8')).version).toBe(1);
    for (const version of [0, 2, '1']) {
      const text = JSON.stringify({ version, hooks: {} });
      await write(target.hook!.settingsPath, text);
      await expect(updateCursorSystemHooks(target, true)).rejects.toThrow('version 1');
      expect(await fs.readFile(target.hook!.settingsPath, 'utf8')).toBe(text);
    }
  });

  it('refuses malformed, conflicting, read-only, and symlinked policies without a write', async () => {
    const target = systemHookDefinition(def);
    const file = target.hook!.settingsPath;
    for (const policy of [
      '{"version":1,"hooks":',
      '{"version":1,"hooks":{},"hooks":{}}',
      '{"version":1,"hooks":{"stop":{}}}',
      '{"version":1,"hooks":{"stop":[{"command":"/somewhere/else/cursor-loongsuite-pilot-hook.sh"}]}}',
    ]) {
      await write(file, policy);
      await expect(updateCursorSystemHooks(target, true)).rejects.toThrow('original preserved');
      expect(await fs.readFile(file, 'utf8')).toBe(policy);
    }
    const policy = '{"version":1,"hooks":{}}';
    await write(file, policy);
    await fs.chmod(file, 0o444);
    await expect(updateCursorSystemHooks(target, true)).rejects.toThrow('read-only');
    expect(await fs.readFile(file, 'utf8')).toBe(policy);
    await fs.rename(file, file + '.original');
    await fs.symlink(file + '.original', file);
    await expect(updateCursorSystemHooks(target, true)).rejects.toThrow('regular file');
    expect(await fs.readlink(file)).toBe(file + '.original');
    expect(await fs.readFile(file, 'utf8')).toBe(policy);
  });

  it('does not mistake an unrelated agent command or an IDE home for the CLI', async () => {
    const builtin = path.join(root, 'agents.d');
    const bin = path.join(root, 'bin');
    const agent = path.join(bin, 'agent');
    await write(path.join(builtin, 'cursor.json'), JSON.stringify(def));
    await write(path.join(builtin, 'cursor-cli.json'), JSON.stringify({ ...def, id: 'cursor-cli',
      detection: { paths: [], commands: ['cursor-agent'] }, hook: { ...def.hook, events: [], hookCommand: '' } }));
    await fs.mkdir(path.dirname(def.hook!.settingsPath), { recursive: true });
    await write(agent, '#!/bin/sh\nexit 99\n');
    await fs.chmod(agent, 0o755);
    vi.stubEnv('PATH', bin + path.delimiter + '/usr/bin:/bin');
    try {
      const opts = { dataDir, pilotDir: path.resolve('.'), builtinAgentsDir: builtin, deploymentScope: 'system' as const };
      const ide = await runHookInstall(opts);
      expect(ide.report.agents[0]).toMatchObject({ id: 'cursor', settingsPath: def.hook!.settingsPath });
      expect(ide.report.agents[0]).not.toHaveProperty('hookScope');
      await expect(fs.stat(def.hook!.systemSettingsPath!)).rejects.toMatchObject({ code: 'ENOENT' });

      const vendor = path.join(root, 'vendor', 'cursor-agent');
      await fs.mkdir(path.dirname(vendor));
      await fs.rename(agent, vendor);
      await fs.symlink(vendor, agent);
      const cli = await runHookInstall(opts);
      expect(cli.exitCode).toBe(0);
      expect(cli.report.agents).toHaveLength(1);
      expect(cli.report.agents[0]).toMatchObject({ id: 'cursor', hookScope: 'system' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  for (const agentsFlag of [undefined, 'cursor-cli', 'cursor,cursor-cli']) {
    it(`registers one shared target when only the CLI is detected (${agentsFlag ?? 'automatic'})`, async () => {
      const builtin = path.join(root, 'agents.d');
      await write(path.join(builtin, 'cursor.json'), JSON.stringify(def));
      const cli = { id: 'cursor-cli', displayName: 'Cursor CLI', deployMode: 'hook',
        detection: { paths: [path.join(root, 'cli-installed')], commands: [] },
        hook: { ...def.hook, systemSettingsPath: undefined, hookCommand: '', events: [] } };
      await write(path.join(builtin, 'cursor-cli.json'), JSON.stringify(cli));
      await fs.mkdir(path.join(root, 'cli-installed'));
      const opts = { dataDir, pilotDir: path.resolve('.'), builtinAgentsDir: builtin, agentsFlag };
      const result = await runHookInstall({ ...opts, deploymentScope: 'system' });
      expect(result.exitCode).toBe(0);
      expect((await fs.stat(path.join(dataDir, 'logs/cursor/history'))).isDirectory()).toBe(true);
      expect(result.report.agents).toHaveLength(1);
      expect(result.report.agents[0]).toMatchObject({ id: 'cursor', hookScope: 'system', runtimeHealthy: true, collectionStatus: 'not-verified' });
      expect(result.report.agents[0].hint).toContain('Enterprise');
      const state = JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf8'));
      expect(Object.keys(state)).toEqual(['cursor']);
      expect(await fs.stat(def.hook!.settingsPath).catch(() => null)).toBeNull();
      const status = await runHookInstall({ ...opts, mode: 'status' });
      expect(status.report.agents).toHaveLength(1);
      expect(status.report.agents[0].hookScope).toBe('system');
      const manager = new DeploymentManager(opts);
      const [loaded] = (await manager.loadDefinitions()).filter(item => item.id === 'cursor');
      await fs.unlink(path.join(dataDir, 'hooks/cursor/source-event.mjs'));
      expect(await manager.needsRedeploy(loaded)).toBe(true);
      expect((await manager.repairHookSettings(loaded)).success).toBe(true);
      expect(await manager.needsRedeploy(loaded)).toBe(false);
      expect(await manager.undeployAgent(loaded)).toBe(true);
      expect(JSON.parse(await fs.readFile(def.hook!.systemSettingsPath!, 'utf8'))).toEqual({ version: 1, hooks: {} });
    });
  }

  it('retains default home behavior and supports migrating the CLI alias back to home', async () => {
    const builtin = path.join(root, 'agents.d');
    await write(path.join(builtin, 'cursor.json'), JSON.stringify(def));
    await write(path.join(builtin, 'cursor-cli.json'), JSON.stringify({ ...def, id: 'cursor-cli', hook: { ...def.hook, events: [], hookCommand: '' } }));
    await fs.mkdir(path.join(root, 'user/.cursor'), { recursive: true });
    const opts = { dataDir, pilotDir: path.resolve('.'), builtinAgentsDir: builtin };
    expect((await runHookInstall({ ...opts, agentsFlag: 'cursor' })).exitCode).toBe(0);
    expect(await fs.stat(def.hook!.systemSettingsPath!).catch(() => null)).toBeNull();
    expect((await runHookInstall({ ...opts, agentsFlag: 'cursor-cli', deploymentScope: 'system' })).exitCode).toBe(0);
    expect(await fs.readFile(def.hook!.settingsPath, 'utf8')).not.toContain('cursor-loongsuite-pilot-hook');
    expect((await runHookInstall({ ...opts, agentsFlag: 'cursor-cli', deploymentScope: 'user' })).exitCode).toBe(0);
    expect(await fs.readFile(def.hook!.systemSettingsPath!, 'utf8')).not.toContain('cursor-loongsuite-pilot-hook');
    expect(await fs.readFile(def.hook!.settingsPath, 'utf8')).toContain('cursor-loongsuite-pilot-hook');
  });

  it('does not bypass a disabled CLI alias or the canonical Cursor admission gate', async () => {
    const builtin = path.join(root, 'agents.d');
    await write(path.join(builtin, 'cursor.json'), JSON.stringify(def));
    const cliHome = path.join(root, 'cli-only');
    await fs.mkdir(cliHome);
    await write(path.join(builtin, 'cursor-cli.json'), JSON.stringify({ ...def, id: 'cursor-cli',
      detection: { paths: [cliHome], commands: [] }, hook: { ...def.hook, events: [], hookCommand: '' } }));
    const opts = { dataDir, pilotDir: path.resolve('.'), builtinAgentsDir: builtin, agentsFlag: 'cursor-cli', deploymentScope: 'system' as const };
    const cliDisabled = await runHookInstall({ ...opts, enabled: id => id !== 'cursor-cli' });
    expect(cliDisabled.report.agents[0]).toMatchObject({ id: 'cursor-cli', reason: 'disabled' });
    const cursorDisabled = await runHookInstall({ ...opts, enabled: id => id !== 'cursor' });
    expect(cursorDisabled.report.agents[0]).toMatchObject({ id: 'cursor', reason: 'disabled' });
    const autoDisabled = await runHookInstall({ ...opts, agentsFlag: undefined, enabled: id => id !== 'cursor-cli' });
    expect(autoDisabled.report.agents).toEqual([]);
    expect(await fs.stat(def.hook!.systemSettingsPath!).catch(() => null)).toBeNull();
  });

  it('writes three independent identities to the common journal without inherited Pilot variables', async () => {
    const homes = ['a', 'b', 'created-after-install'].map(identity => path.join(root, identity));
    await Promise.all(homes.slice(0, 2).map(home => fs.mkdir(home)));
    const manager = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    const target = systemHookDefinition(def);
    expect((await manager.deployHookScope(target)).success).toBe(true);
    const { hooks } = JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8'));
    const command = hooks.beforeSubmitPrompt[0].command;
    await write(path.join(dataDir, 'node-bin'), process.execPath + '\n');
    await fs.mkdir(homes[2]);
    for (const home of homes) {
      const identity = path.basename(home);
      const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin' };
      delete env.LOONGSUITE_PILOT_DATA_DIR;
      delete env.PILOT_DATA;
      const result = spawnSync('/bin/bash', ['-c', command], { env, encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', conversation_id: identity, generation_id: identity,
          cursor_version: '2026.11.10', prompt: 'test', workspace_roots: [home] }) });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({});
      expect(await fs.stat(path.join(home, '.loongsuite-pilot')).catch(() => null)).toBeNull();
    }
    const journal = (await fs.readFile(path.join(dataDir, 'state/cursor/event-journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(journal.map(event => event.conversation_id)).toEqual(['a', 'b', 'created-after-install']);
    await fs.unlink(path.join(dataDir, 'hooks/cursor/source-event.mjs'));
    const missing = spawnSync('/bin/bash', ['-c', command], { input: '{}', encoding: 'utf8', timeout: 10000 });
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout)).toEqual({});
  });
});

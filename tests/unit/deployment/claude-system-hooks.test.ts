import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { AgentDefinition } from '../../../src/types/deployment.js';
import { systemHookDefinition } from '../../../src/deployment/system-hook-config.js';
import { systemJsonHooksInstalled, updateSystemJsonHooks } from '../../../src/deployment/system-json-hooks.js';
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-system-'));
  restore = isolateAgentHome(root);
  dataDir = path.join(root, "pilot's data");
  await fs.mkdir(dataDir);
  def = {
    id: 'claude-code', displayName: 'Claude Code', deployMode: 'hook',
    detection: { paths: [path.join(root, 'user')], commands: [] },
    hook: { settingsPath: path.join(root, 'user/settings.json'),
      systemSettingsPath: path.join(root, 'etc/claude-code/managed-settings.d/50-loongsuite-pilot.json'),
      hookCommand: path.join(dataDir, 'hooks/claude-code-loongsuite-pilot-hook.sh'),
      events: ['PreToolUse', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop'],
      format: 'nested', matcher: '*', eventMatchers: { PreToolUse: 'Bash' }, eventSubcommand: 'kebab-case' },
  };
});
afterEach(async () => { vi.restoreAllMocks(); restore(); await fs.rm(root, { recursive: true, force: true }); });

async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

describe('Claude native system JSON registration', () => {
  it('writes only the independent policy fragment, preserves other hooks, and is idempotent', async () => {
    const target = systemHookDefinition(def);
    const policy = { permissions: { deny: ['Bash(rm *)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'customer-audit' }] }], CustomEvent: [] } };
    await write(target.hook!.settingsPath, '\uFEFF' + JSON.stringify(policy, null, 4).replace(/\n/g, '\r\n'));
    await updateSystemJsonHooks(target, true);
    const installed = await fs.readFile(target.hook!.settingsPath, 'utf8');
    const json = JSON.parse(installed.replace(/^\uFEFF/, ''));
    expect(installed.startsWith('\uFEFF')).toBe(true);
    expect(installed).toContain('\r\n');
    expect(json.permissions).toEqual(policy.permissions);
    expect(json.hooks.Stop[0]).toEqual(policy.hooks.Stop[0]);
    expect(json.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(json.hooks.Stop[1].hooks[0].command).toContain(' stop');
    expect(json.hooks.SubagentStop[0].hooks[0].command).toContain(' subagent-stop');
    expect(await systemJsonHooksInstalled(target)).toBe(true);
    await updateSystemJsonHooks(target, true);
    expect(await fs.readFile(target.hook!.settingsPath, 'utf8')).toBe(installed);
    expect(await fs.stat(def.hook!.settingsPath).catch(() => null)).toBeNull();
    await updateSystemJsonHooks(target, false);
    expect(JSON.parse((await fs.readFile(target.hook!.settingsPath, 'utf8')).replace(/^\uFEFF/, ''))).toEqual(policy);
  });

  it('removes the empty hooks key after uninstall so a fragment cannot keep shadowing host policy', async () => {
    const target = systemHookDefinition(def);
    await updateSystemJsonHooks(target, true);
    await updateSystemJsonHooks(target, false);
    expect(JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8'))).toEqual({});
    expect(await systemJsonHooksInstalled(target)).toBe(false);
  });

  it('preserves nested customer handlers when an administrator groups them with a Pilot handler', async () => {
    const target = systemHookDefinition(def);
    await updateSystemJsonHooks(target, true);
    const settings = JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8'));
    settings.hooks.Stop[0].hooks.push({ type: 'command', command: 'customer-audit' });
    await write(target.hook!.settingsPath, JSON.stringify(settings));
    await updateSystemJsonHooks(target, false);
    expect(JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8')).hooks.Stop).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'customer-audit' }] },
    ]);
  });

  for (const text of ['{"hooks":', '[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}']) {
    it(`rejects invalid system settings unchanged: ${text}`, async () => {
      const target = systemHookDefinition(def);
      await write(target.hook!.settingsPath, text);
      await expect(updateSystemJsonHooks(target, true)).rejects.toThrow('Invalid JSON');
      await expect(updateSystemJsonHooks(target, false)).rejects.toThrow('Invalid JSON');
      expect(await fs.readFile(target.hook!.settingsPath, 'utf8')).toBe(text);
    });
  }

  it('refuses to replace a foreign Pilot installation or a deployment-owned symlink', async () => {
    const target = systemHookDefinition(def);
    const foreign = '{"hooks":{"Stop":[{"hooks":[{"command":"/other/claude-code-loongsuite-pilot-hook.sh stop"}]}]}}';
    await write(target.hook!.settingsPath, foreign);
    await expect(updateSystemJsonHooks(target, true)).rejects.toThrow('another Pilot runtime');
    expect(await fs.readFile(target.hook!.settingsPath, 'utf8')).toBe(foreign);
    await fs.unlink(target.hook!.settingsPath);
    const source = path.join(root, 'deployment.json');
    await write(source, '{}');
    await fs.symlink(source, target.hook!.settingsPath);
    await expect(updateSystemJsonHooks(target, true)).rejects.toThrow('externally mounted');
    expect(await fs.readFile(source, 'utf8')).toBe('{}');
  });
});

describe('Claude system install lifecycle', () => {
  it('auto-detects, restores the full runtime after restart, and uninstalls from the persisted system target', async () => {
    const builtin = path.join(root, 'agents.d');
    await fs.mkdir(builtin);
    await fs.mkdir(path.join(root, 'user'));
    await write(path.join(builtin, 'claude-code.json'), JSON.stringify(def));
    const opts = { dataDir, pilotDir: path.resolve('.'), builtinAgentsDir: builtin };
    expect((await runHookInstall({ ...opts, deploymentScope: 'system' })).exitCode).toBe(0);
    const manager = new DeploymentManager(opts);
    const [loaded] = await manager.loadDefinitions();
    expect(manager.effectiveDefinition(loaded).hook?.settingsPath).toBe(def.hook!.systemSettingsPath);
    const report = await runHookInstall({ ...opts, mode: 'status' });
    expect(report.report.agents[0]).toMatchObject({ status: 'ok', hookScope: 'system', runtimeHealthy: true, collectionStatus: 'not-verified' });
    await fs.unlink(path.join(dataDir, 'hooks/claude-code/transcript-parser.mjs'));
    expect(await manager.needsRedeploy(loaded)).toBe(true);
    expect((await manager.repairHookSettings(loaded)).success).toBe(true);
    expect(await manager.needsRedeploy(loaded)).toBe(false);
    expect(await fs.stat(def.hook!.settingsPath).catch(() => null)).toBeNull();
    expect(await manager.undeployAgent(loaded)).toBe(true);
    expect(JSON.parse(await fs.readFile(def.hook!.systemSettingsPath!, 'utf8'))).toEqual({});
  });

  it('keeps default home installs and migrates only recorded registrations in both directions', async () => {
    const manager = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    await write(def.hook!.settingsPath, '{"model":"customer-model"}');
    expect((await manager.deployPrepared(def, true)).success).toBe(true);
    expect(await fs.stat(def.hook!.systemSettingsPath!).catch(() => null)).toBeNull();
    // Simulate an older home install without scope metadata.
    await write(path.join(dataDir, 'deployed-agents.json'), JSON.stringify({ 'claude-code': { deployMode: 'hook', deployedAt: new Date().toISOString() } }));
    expect((await manager.deployHookScope(systemHookDefinition(def))).success).toBe(true);
    expect(JSON.parse(await fs.readFile(def.hook!.settingsPath, 'utf8')).model).toBe('customer-model');
    expect(await fs.readFile(def.hook!.settingsPath, 'utf8')).not.toContain('claude-code-loongsuite-pilot-hook');
    expect((await manager.deployHookScope({ ...def, hook: { ...def.hook!, scope: 'user' } })).success).toBe(true);
    expect(JSON.parse(await fs.readFile(def.hook!.systemSettingsPath!, 'utf8'))).toEqual({});
    expect(await fs.readFile(def.hook!.settingsPath, 'utf8')).toContain('claude-code-loongsuite-pilot-hook');
  });

  it('retains cleanup intent after a final state failure and never repairs into a new HOME', async () => {
    const manager = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    const save = (manager as any).saveState.bind(manager);
    let calls = 0;
    vi.spyOn(manager as any, 'saveState').mockImplementation(async () => {
      if (++calls === 2) throw new Error('state commit failed');
      await save();
    });
    await expect(manager.deployHookScope(systemHookDefinition(def))).rejects.toThrow('state commit failed');
    const restarted = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    expect((await restarted.repairHookSettings(def)).success).toBe(false);
    expect(await restarted.undeployAgent(def)).toBe(true);
    expect(await fs.stat(def.hook!.settingsPath).catch(() => null)).toBeNull();
    expect(JSON.parse(await fs.readFile(def.hook!.systemSettingsPath!, 'utf8'))).toEqual({});
  });

  it('uses the installed data root and pinned Node from three new homes without inherited Pilot variables', async () => {
    const manager = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    expect((await manager.deployHookScope(systemHookDefinition(def))).success).toBe(true);
    await write(path.join(dataDir, 'node-bin'), process.execPath);
    for (const identity of ['a', 'b', 'created-after-install']) {
      const home = path.join(root, identity);
      await fs.mkdir(home);
      const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin' };
      delete env.LOONGSUITE_PILOT_DATA_DIR;
      delete env.PILOT_DATA;
      const result = spawnSync('/bin/bash', [def.hook!.hookCommand, 'subagent-start'], {
        env, encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ session_id: identity, cwd: home, agent_id: 'child', agent_type: 'test' }),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('{}');
      const state = JSON.parse(await fs.readFile(path.join(dataDir, 'state/claude-code/sessions', `${identity}.json`), 'utf8'));
      expect(state.events[0].type).toBe('subagent_start');
      expect(await fs.stat(path.join(home, '.loongsuite-pilot')).catch(() => null)).toBeNull();
    }
    // Telemetry dependency loss must not fail the hook command.
    await fs.unlink(path.join(dataDir, 'hooks/claude-code/state.mjs'));
    const failed = spawnSync('/bin/bash', [def.hook!.hookCommand, 'subagent-start'], {
      encoding: 'utf8', timeout: 10000, input: '{}', env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
    });
    expect(failed.status).toBe(0);
    expect(failed.stdout.trim()).toBe('{}');
  });
});

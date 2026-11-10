import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse } from 'smol-toml';
import { spawnSync } from 'node:child_process';
import type { AgentDefinition } from '../../../src/types/deployment.js';
import { systemTomlDefinition, systemTomlHooksInstalled, renderSystemTomlHooks, updateSystemTomlHooks } from '../../../src/deployment/system-toml-hooks.js';
import { runHookInstall } from '../../../src/deployment/hook-install-service.js';
import { DeploymentManager } from '../../../src/deployment/deployment-manager.js';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';
import { parseHookArgs } from '../../../src/deployment/hook-command.js';

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let root: string;
let def: AgentDefinition;
let restoreHome: () => void;
const unrelated = '# organization policy must remain byte-identical\n[models]\ndefault = "hub"\n[[hooks.stop]]\nmatcher = ""\nhooks = [{ type = "command", command = "echo third-party" }]\n';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-system-'));
  restoreHome = isolateAgentHome(root);
  def = systemTomlDefinition({
    id: 'grok-build', displayName: 'Grok Build', deployMode: 'hook', detection: { paths: [], commands: [] },
    hook: { settingsPath: '', hookCommand: path.join(root, "pilot's data", 'hooks/grok-build-loongsuite-pilot-hook.sh'),
      events: ['user_prompt_submit', 'stop', 'stop_failure', 'session_end'], format: 'nested' },
  }, path.join(root, 'etc/grok/managed_config.toml'));
});
afterEach(async () => { restoreHome(); await fs.rm(root, { recursive: true, force: true }); });

describe('Grok system managed configuration', () => {
  it('accepts automatic or mixed selection and rejects ambiguous targets before any writes', () => {
    expect(parseHookArgs(['install', '--agents', 'grok-build', '--scope', 'user']).deploymentScope).toBe('user');
    expect(parseHookArgs(['install', '--scope', 'system']).agents).toBeUndefined();
    expect(parseHookArgs(['install', '--agents', 'grok-build,claude-code', '--scope', 'system']).agents).toBe('grok-build,claude-code');
    expect(() => parseHookArgs(['install', '--agents', 'grok-build', '--scope', 'system', '--home', 'grok-build=/tmp/example'])).toThrow('cannot be combined');
    expect(() => parseHookArgs(['install', '--agents', 'grok-build', '--scope', 'auto'])).toThrow('user or system');
  });
  it('preserves unrelated bytes across concurrent install, repair, and removal', async () => {
    const file = def.hook!.settingsPath;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, unrelated, { mode: 0o640 });
    await Promise.all([updateSystemTomlHooks(def, true), updateSystemTomlHooks(def, true)]);
    const text = await fs.readFile(file, 'utf8');
    expect(text.startsWith(unrelated)).toBe(true);
    expect(await systemTomlHooksInstalled(def)).toBe(true);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
    const parsed = parse(text) as any;
    expect(parsed.hooks.stop).toHaveLength(2);
    expect(parsed.models.default).toBe('hub');
    await fs.writeFile(file, text.replace('session_end', 'wrong_event'));
    expect(await systemTomlHooksInstalled(def)).toBe(false);
    await updateSystemTomlHooks(def, true);
    expect(await systemTomlHooksInstalled(def)).toBe(true);
    await updateSystemTomlHooks(def, false);
    expect(await fs.readFile(file, 'utf8')).toBe(unrelated);
    await updateSystemTomlHooks(def, false);
    expect(await fs.readFile(file, 'utf8')).toBe(unrelated);
  });

  it('quotes a runtime path containing spaces and apostrophes for the real shell', async () => {
    const script = def.hook!.hookCommand;
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(script, '#!/bin/bash\nprintf "%s" "$1"\n');
    const config = parse(renderSystemTomlHooks(def)) as any;
    const result = spawnSync('/bin/bash', ['-c', config.hooks.stop[0].hooks[0].command], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('stop');
  });

  it.each(['sandbox_mode = "read-only"\n', 'note = """\n[not.a.table]\n"""\n'])('refuses removal that would reparent keys after the owned block', async suffix => {
    const file = def.hook!.settingsPath;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '[projects."/work"]\ntrust_level = "trusted"\n');
    await updateSystemTomlHooks(def, true);
    const installed = await fs.readFile(file, 'utf8') + suffix;
    await fs.writeFile(file, installed);
    expect(() => parse(installed)).not.toThrow();
    await expect(updateSystemTomlHooks(def, false)).rejects.toThrow('table');
    expect(await fs.readFile(file, 'utf8')).toBe(installed);
  });

  it.each(['[projects."/other"]\ntrust_level = "untrusted"\n', '[[hooks.stop]]\nmatcher = "third-party"\nhooks = []\n'])('preserves later explicit tables and comments when removing the owned block', async table => {
    const file = def.hook!.settingsPath;
    const prefix = '["__loongsuite_pilot_tail__"]\nkeep = true\n';
    const suffix = '# [this is a comment]\n' + table;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, prefix);
    await updateSystemTomlHooks(def, true);
    await fs.appendFile(file, suffix);
    await updateSystemTomlHooks(def, false);
    expect(await fs.readFile(file, 'utf8')).toBe(prefix + suffix);
    expect(parse(await fs.readFile(file, 'utf8'))).toEqual(parse(prefix + suffix));
  });

  it('preserves malformed, foreign-owned, unmarked, and read-only files on failure', async () => {
    const file = def.hook!.settingsPath;
    await fs.mkdir(path.dirname(file), { recursive: true });
    for (const text of ['[invalid', renderSystemTomlHooks(def).replace("pilot's data", 'other-pilot'),
      '[[hooks.stop]]\nhooks = [{command = "grok-build-loongsuite-pilot-hook.sh stop"}]\n']) {
      await fs.writeFile(file, text);
      await expect(updateSystemTomlHooks(def, true)).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe(text);
    }
    await fs.writeFile(file, unrelated, { mode: 0o644 });
    await fs.chmod(file, 0o444);
    await expect(updateSystemTomlHooks(def, true)).rejects.toThrow('read-only');
    expect(await fs.readFile(file, 'utf8')).toBe(unrelated);
  });

  it('does not replace externally mounted symlinks', async () => {
    const file = def.hook!.settingsPath;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const target = path.join(root, 'configmap.toml');
    await fs.writeFile(target, unrelated);
    await fs.symlink(target, file);
    await expect(updateSystemTomlHooks(def, true)).rejects.toThrow('externally mounted');
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe(unrelated);
    await fs.unlink(target);
    await expect(updateSystemTomlHooks(def, true)).rejects.toThrow();
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
  });
});

describe('Grok system installation lifecycle', () => {
  for (const agentsFlag of [undefined, 'grok-build,sample-agent']) {
    it(`uses system/home routes in a mixed ${agentsFlag ? 'named' : 'automatic'} installation`, async () => {
      const dataDir = path.join(root, 'data');
      const builtin = path.join(root, 'agents.d');
      const home = path.join(root, 'base-home');
      await fs.mkdir(builtin);
      await fs.mkdir(home);
      const grok = { ...def, detection: { paths: [home], commands: [] },
        hook: { ...def.hook!, scope: undefined, systemSettingsPath: def.hook!.settingsPath,
          settingsPath: path.join(home, 'hooks/loongsuite-pilot.json') } };
      const settings = path.join(home, 'sample-settings.json');
      await fs.writeFile(settings, '{"theme":"keep-me"}');
      await fs.writeFile(path.join(builtin, 'grok.json'), JSON.stringify(grok));
      await fs.writeFile(path.join(builtin, 'sample.json'), JSON.stringify({
        id: 'sample-agent', displayName: 'Sample', deployMode: 'hook', detection: { paths: [home], commands: [] },
        hook: { settingsPath: settings, hookCommand: path.join(dataDir, 'hooks/sample-agent-hook.sh'), events: ['Stop'], format: 'nested' },
      }));
      const opts = { dataDir, pilotDir: path.resolve('.'), builtinAgentsDir: builtin, agentsFlag,
        deploymentScope: 'system' as const, writeResult: true };
      const result = await runHookInstall(opts);
      expect(result.exitCode).toBe(0);
      expect(result.report.agents).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'grok-build', hookScope: 'system', runtimeHealthy: true }),
        expect.objectContaining({ id: 'sample-agent', status: 'ok', settingsPath: settings }),
      ]));
      expect(result.report.agents.find(agent => agent.id === 'sample-agent')).not.toHaveProperty('hookScope');
      expect(await fs.readFile(def.hook!.settingsPath, 'utf8')).toContain('# BEGIN loongsuite-pilot:grok-build');
      expect(await fs.readFile(grok.hook.settingsPath, 'utf8').catch(() => null)).toBeNull();
      const claude = JSON.parse(await fs.readFile(settings, 'utf8'));
      expect(claude.theme).toBe('keep-me');
      expect(claude.hooks.Stop[0].hooks[0].command).toContain('sample-agent-hook.sh');
      expect((await runHookInstall(opts)).exitCode).toBe(0);
      expect(JSON.parse(await fs.readFile(settings, 'utf8')).hooks.Stop).toHaveLength(1);
    });
  }

  it('does not create a system registration for an undetected or disabled Agent', async () => {
    const builtin = path.join(root, 'agents.d');
    await fs.mkdir(builtin);
    const home = path.join(root, 'not-installed');
    await fs.writeFile(path.join(builtin, 'grok.json'), JSON.stringify({
      ...def, detection: { paths: [home], commands: [] },
      hook: { ...def.hook!, scope: undefined, systemSettingsPath: def.hook!.settingsPath,
        settingsPath: path.join(home, 'hooks/loongsuite-pilot.json') },
    }));
    const opts = { dataDir: path.join(root, 'data'), pilotDir: path.resolve('.'), builtinAgentsDir: builtin,
      deploymentScope: 'system' as const, writeResult: true };
    expect((await runHookInstall(opts)).report.agents).toEqual([]);
    await fs.mkdir(home);
    expect((await runHookInstall({ ...opts, enabled: () => false })).report.agents).toEqual([]);
    expect(await fs.readFile(def.hook!.settingsPath, 'utf8').catch(() => null)).toBeNull();
    expect((await runHookInstall({ ...opts, agentsFlag: 'none' })).wroteResult).toBe(false);
  });

  it('does not register a first system hook when its recovery intent cannot be saved', async () => {
    const dataDir = path.join(root, 'data');
    await fs.mkdir(dataDir);
    const target = { ...def, hook: { ...def.hook!, hookCommand: path.join(dataDir, 'hooks/grok-build-loongsuite-pilot-hook.sh') } };
    const manager = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    vi.spyOn(manager as any, 'saveState').mockRejectedValueOnce(new Error('lock-timeout'));
    await expect(manager.deployHookScope(target)).rejects.toThrow('lock-timeout');
    expect(await fs.readFile(target.hook.settingsPath, 'utf8').catch(() => null)).toBeNull();
  });

  it('keeps a durable first-install intent for cleanup when the final state commit fails', async () => {
    const dataDir = path.join(root, 'data');
    await fs.mkdir(dataDir);
    const target = { ...def, hook: { ...def.hook!, hookCommand: path.join(dataDir, 'hooks/grok-build-loongsuite-pilot-hook.sh') } };
    await fs.mkdir(path.dirname(target.hook.settingsPath), { recursive: true });
    await fs.writeFile(target.hook.settingsPath, unrelated);
    const manager = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    const save = (manager as any).saveState.bind(manager);
    let commits = 0;
    vi.spyOn(manager as any, 'saveState').mockImplementation(async () => {
      if (++commits === 2) throw new Error('state commit failed');
      await save();
    });
    await expect(manager.deployHookScope(target)).rejects.toThrow('state commit failed');
    const state = JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf8'));
    expect(state['grok-build'].hookPendingMigration).toEqual({ scope: 'system', settingsPath: target.hook.settingsPath });
    expect(await fs.readFile(target.hook.settingsPath, 'utf8')).toContain('# BEGIN loongsuite-pilot:grok-build');
    const home = path.join(root, 'base-home');
    await fs.mkdir(home);
    const user = { ...target, detection: { paths: [home], commands: [] },
      hook: { ...target.hook, scope: undefined, settingsPath: path.join(home, 'hooks/loongsuite-pilot.json') } };
    const restarted = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    expect((await restarted.deploySingle(user)).success).toBe(false);
    expect((await restarted.repairHookSettings(user)).success).toBe(false);
    expect(await fs.readFile(user.hook.settingsPath, 'utf8').catch(() => null)).toBeNull();
    expect(await fs.readFile(target.hook.settingsPath, 'utf8')).toContain('# BEGIN loongsuite-pilot:grok-build');
    const cleanup = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    expect(await cleanup.undeployAgent(target)).toBe(true);
    expect(await fs.readFile(target.hook.settingsPath, 'utf8')).toBe(unrelated);
    expect(JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf8'))['grok-build']).toBeUndefined();
  });

  it('migrates recorded homes, survives restart/repair, and disables only owned system hooks', async () => {
    const pilotDir = path.resolve('.');
    const dataDir = path.join(root, 'data');
    const builtin = path.join(root, 'agents.d');
    await fs.mkdir(builtin);
    await fs.writeFile(path.join(builtin, 'grok-build.json'), JSON.stringify({
      ...def, hook: { ...def.hook, scope: undefined, settingsPath: '$GROK_HOME/hooks/loongsuite-pilot.json',
        hookCommand: '$PILOT_DATA/hooks/grok-build-loongsuite-pilot-hook.sh' },
      detection: { paths: ['$GROK_HOME'], commands: [] },
    }));
    const common = { dataDir, pilotDir, builtinAgentsDir: builtin, agentsFlag: 'grok-build', writeResult: true,
      identity: { identity: 'f'.repeat(64), source: 'cgroup' as const } };
    const homes = [path.join(root, 'identity-a'), path.join(root, 'identity-b')];
    for (const home of homes) expect((await runHookInstall({ ...common, homes: { 'grok-build': home } })).exitCode).toBe(0);
    await fs.mkdir(path.dirname(def.hook!.settingsPath), { recursive: true });
    await fs.writeFile(def.hook!.settingsPath, unrelated);
    const system = { ...common, deploymentScope: 'system' as const, systemConfigPath: def.hook!.settingsPath };
    expect((await runHookInstall(system)).exitCode).toBe(0);
    const state = JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf8'));
    expect(state['grok-build'].hookScope).toBe('system');
    expect(state['grok-build'].hookSettingsPaths).toEqual([def.hook!.settingsPath]);
    for (const home of homes) {
      const text = await fs.readFile(path.join(home, 'hooks/loongsuite-pilot.json'), 'utf8');
      expect(text).not.toContain('grok-build-loongsuite-pilot-hook.sh');
    }
    const status = await runHookInstall({ ...common, writeResult: false, mode: 'status' });
    expect(status.exitCode).toBe(0);
    expect(status.report.agents[0]).toMatchObject({ hookScope: 'system', runtimeHealthy: true, collectionStatus: 'not-verified' });
    const manager = new DeploymentManager({ dataDir, pilotDir, builtinAgentsDir: builtin });
    const [loaded] = await manager.loadDefinitions();
    expect(await manager.isAgentDetected(loaded)).toBe(true);
    await fs.unlink(path.join(dataDir, 'hooks/shared/decode-payload.mjs'));
    expect(await manager.needsRedeploy(loaded)).toBe(true);
    expect((await manager.repairHookSettings(loaded)).success).toBe(true);
    expect(await manager.needsRedeploy(loaded)).toBe(false);
    const text = await fs.readFile(def.hook!.settingsPath, 'utf8');
    await fs.writeFile(def.hook!.settingsPath, text.replace('session_end', 'wrong_event'));
    expect(await manager.needsRedeploy(loaded)).toBe(true);
    expect((await manager.repairHookSettings(loaded)).success).toBe(true);
    expect(await manager.needsRedeploy(loaded)).toBe(false);
    expect((await manager.deployAll(() => false))[0].success).toBe(true);
    expect(await fs.readFile(def.hook!.settingsPath, 'utf8')).toBe(unrelated);
    for (const home of homes) expect(await fs.readFile(path.join(home, 'hooks/loongsuite-pilot.json'), 'utf8')).not.toContain('grok-build-loongsuite-pilot-hook.sh');
  });
});

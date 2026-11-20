import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse } from 'smol-toml';
import type { AgentDefinition } from '../../../src/types/deployment.js';
import { systemTomlDefinition, updateSystemTomlHooks } from '../../../src/deployment/system-toml-hooks.js';
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
let restore: () => void;
let def: AgentDefinition;
let dataDir: string;
const policy = '# organization policy\nmodel = "existing"\n[[hooks.SessionStart]]\nhooks = [{type="command",command="echo external"}]\n';
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-system-'));
  restore = isolateAgentHome(root);
  dataDir = path.join(root, 'pilot');
  await fs.mkdir(dataDir);
  def = {
    id: 'codex', displayName: 'Codex', deployMode: 'hook', detection: { paths: [path.join(root, 'user')], commands: [] },
    hook: { settingsPath: path.join(root, 'user/hooks.json'),
      systemSettingsPath: path.join(root, 'etc/codex/config.toml'),
      hookCommand: path.join(dataDir, 'hooks/codex-loongsuite-pilot-hook.sh'),
      events: ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop'],
      format: 'nested', eventSubcommand: 'kebab-case',
      trustToml: { configPath: path.join(root, 'user/config.toml'), trustAlgo: 'v1', marker: 'otel-codex-hook' } },
  };
});
afterEach(async () => { restore(); await fs.rm(root, { recursive: true, force: true }); });

describe('Codex native system hooks', () => {
  it('uses PascalCase event tables with kebab-case handler arguments and preserves policy/trust state', async () => {
    const target = systemTomlDefinition(def);
    await fs.mkdir(path.dirname(target.hook!.settingsPath), { recursive: true });
    await fs.writeFile(target.hook!.settingsPath, policy);
    await updateSystemTomlHooks(target, true);
    const text = await fs.readFile(target.hook!.settingsPath, 'utf8');
    expect(text.startsWith(policy)).toBe(true);
    const config = parse(text) as any;
    expect(config.hooks.SessionStart).toHaveLength(2);
    expect(config.hooks.SessionStart[1].hooks[0].command).toContain(' session-start');
    expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toContain(' user-prompt-submit');
    expect(config.features).toBeUndefined();
    expect(await fs.readdir(root)).not.toContain('user');
    await updateSystemTomlHooks(target, false);
    expect(await fs.readFile(target.hook!.settingsPath, 'utf8')).toBe(policy);
  });

  it('retains the selected system target through restart, missing assets, repair, and uninstall', async () => {
    const builtin = path.join(root, 'agents.d');
    await fs.mkdir(builtin);
    await fs.mkdir(path.join(root, 'user'));
    await fs.writeFile(path.join(builtin, 'codex.json'), JSON.stringify(def));
    const opts = { dataDir, pilotDir: path.resolve('.'), builtinAgentsDir: builtin };
    expect((await runHookInstall({ ...opts, deploymentScope: 'system' })).exitCode).toBe(0);
    const manager = new DeploymentManager(opts);
    const [loaded] = await manager.loadDefinitions();
    expect(await manager.isAgentDetected(loaded)).toBe(true);
    expect(manager.effectiveDefinition(loaded).hook?.settingsPath).toBe(def.hook?.systemSettingsPath);
    const report = await runHookInstall({ ...opts, mode: 'status' });
    expect(report.report.agents[0]).toMatchObject({ status: 'ok', hookScope: 'system', runtimeHealthy: true, collectionStatus: 'not-verified' });
    await fs.unlink(path.join(dataDir, 'hooks/shared/decode-payload.mjs'));
    expect(await manager.needsRedeploy(loaded)).toBe(true);
    expect((await manager.repairHookSettings(loaded)).success).toBe(true);
    expect(await manager.needsRedeploy(loaded)).toBe(false);
    expect(await fs.readFile(def.hook!.settingsPath, 'utf8').catch(() => null)).toBeNull();
    expect(await manager.undeployAgent(loaded)).toBe(true);
    expect(await fs.readFile(def.hook!.systemSettingsPath!, 'utf8')).not.toContain('loongsuite-pilot');
  });

  it('retires a known legacy user registration when explicitly migrating to system', async () => {
    const manager = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    await fs.mkdir(path.dirname(def.hook!.settingsPath), { recursive: true });
    expect((await manager.deployPrepared(def, true)).success).toBe(true);
    // Releases before scope tracking have a record without a persisted path.
    await fs.writeFile(path.join(dataDir, 'deployed-agents.json'),
      JSON.stringify({ codex: { deployMode: 'hook', deployedAt: new Date().toISOString() } }));
    expect((await manager.deployHookScope(systemTomlDefinition(def))).success).toBe(true);
    expect(await fs.readFile(def.hook!.settingsPath, 'utf8')).not.toContain('codex-loongsuite-pilot-hook');
    const state = JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf8')).codex;
    expect(state.hookScope).toBe('system');
    expect(state.hookSettingsPaths).toEqual([def.hook!.systemSettingsPath]);
    expect((await manager.deployHookScope({ ...def, hook: { ...def.hook!, scope: 'user' } })).success).toBe(true);
    expect(await fs.readFile(def.hook!.systemSettingsPath!, 'utf8')).not.toContain('loongsuite-pilot');
  });

  it('keeps a durable cleanup target when the final commit fails and refuses an implicit user fallback', async () => {
    const manager = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    const save = (manager as any).saveState.bind(manager);
    let calls = 0;
    vi.spyOn(manager as any, 'saveState').mockImplementation(async () => {
      if (++calls === 2) throw new Error('state commit failed');
      await save();
    });
    await expect(manager.deployHookScope(systemTomlDefinition(def))).rejects.toThrow('state commit failed');
    const state = JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf8')).codex;
    expect(state.hookPendingMigration).toEqual({ scope: 'system', settingsPath: def.hook!.systemSettingsPath });
    const restarted = new DeploymentManager({ dataDir, pilotDir: path.resolve('.') });
    expect((await restarted.deploySingle(def)).success).toBe(false);
    expect((await restarted.repairHookSettings(def)).success).toBe(false);
    expect(await restarted.undeployAgent(def)).toBe(true);
    expect(await fs.readFile(def.hook!.settingsPath, 'utf8').catch(() => null)).toBeNull();
    expect(await fs.readFile(def.hook!.systemSettingsPath!, 'utf8')).not.toContain('loongsuite-pilot');
  });
});

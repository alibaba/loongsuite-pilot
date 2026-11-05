import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '../../../src/types/index.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('../../../src/core/build-constants.js', () => ({
  PROPRIETARY_BUILD: false,
}));

vi.mock('../../../src/deployment/system-hook-assets.js', () => ({
  areSystemHookAssetsHealthy: vi.fn(),
  restoreSystemHookAssets: vi.fn(),
}));

import { Orchestrator } from '../../../src/core/orchestrator.js';
import { HookWatchdog } from '../../../src/core/hook-watchdog.js';
import { hookInstallSignalPath } from '../../../src/deployment/hook-install-service.js';
import {
  areSystemHookAssetsHealthy,
  restoreSystemHookAssets,
} from '../../../src/deployment/system-hook-assets.js';

const DATA_DIR = '/tmp/orchestrator-grok-watchdog';

function grokDefinition(): AgentDefinition {
  return {
    id: 'grok-build',
    displayName: 'Grok Build',
    deployMode: 'hook',
    detection: { paths: ['~/.grok'], commands: [] },
    hook: {
      settingsPath: '~/.grok/hooks/loongsuite-pilot.json',
      events: ['stop', 'stop_failure', 'user_prompt_submit', 'session_end'],
      hookCommand: '$PILOT_DATA/hooks/grok-build-loongsuite-pilot-hook.sh',
      format: 'nested',
      matcher: '',
      eventSubcommand: 'as-is',
    },
  };
}

function targets(orchestrator: Orchestrator) {
  return (orchestrator as unknown as {
    buildGrokBuildInterceptTargets: () => Array<{
      id: string;
      enabled?: () => boolean;
      precondition: () => Promise<boolean>;
      check: () => Promise<boolean>;
      repair: () => Promise<void>;
      cleanup?: () => Promise<void>;
    }>;
  }).buildGrokBuildInterceptTargets();
}

describe('Grok Build watchdog target', () => {
  let isAgentDetected: ReturnType<typeof vi.fn>;
  let needsRedeploy: ReturnType<typeof vi.fn>;
  let repairHookSettings: ReturnType<typeof vi.fn>;
  let undeployAgent: ReturnType<typeof vi.fn>;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    isAgentDetected = vi.fn().mockResolvedValue(true);
    needsRedeploy = vi.fn().mockResolvedValue(false);
    repairHookSettings = vi.fn().mockResolvedValue({
      success: true,
      agentId: 'grok-build',
      deployMode: 'hook',
    });
    undeployAgent = vi.fn().mockResolvedValue(true);
    orchestrator = new Orchestrator({ dataDir: DATA_DIR } as never);
    (orchestrator as unknown as { deploymentManager: unknown }).deploymentManager = {
      getDefinitions: () => [grokDefinition()],
      effectiveDefinition: (def: AgentDefinition) => def,
      isAgentDetected,
      needsRedeploy,
      repairHookSettings,
      undeployAgent,
    };
  });

  it('checks live detection, exact Hook config, and every Grok runtime asset', async () => {
    vi.mocked(areSystemHookAssetsHealthy).mockResolvedValue(true);
    const [target] = targets(orchestrator);

    expect(target.id).toBe('hook:grok-build');
    expect(target.enabled?.()).toBe(true);
    await expect(target.precondition()).resolves.toBe(true);
    await expect(target.check()).resolves.toBe(true);
    expect(isAgentDetected).toHaveBeenCalledWith(expect.objectContaining({ id: 'grok-build' }));
    expect(needsRedeploy).toHaveBeenCalledWith(expect.objectContaining({ id: 'grok-build' }));
    expect(areSystemHookAssetsHealthy).toHaveBeenCalledWith('grok-build', expect.any(String), DATA_DIR);
  });

  it('restores assets and a missing settings directory, then verifies health again', async () => {
    needsRedeploy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(areSystemHookAssetsHealthy).mockResolvedValue(true);
    const [target] = targets(orchestrator);

    await expect(target.check()).resolves.toBe(false);
    await expect(target.repair()).resolves.toBeUndefined();
    expect(restoreSystemHookAssets).toHaveBeenCalledWith('grok-build', expect.any(String), DATA_DIR);
    expect(repairHookSettings).toHaveBeenCalledWith(expect.objectContaining({ id: 'grok-build' }));
    expect(needsRedeploy).toHaveBeenCalledTimes(2);
  });

  it('routes Codex system TOML through scoped checks and keeps it out of JSON repair', async () => {
    const definition = { ...grokDefinition(), id: 'codex', hook: {
      ...grokDefinition().hook!, settingsPath: '/home/base/.codex/hooks.json', events: ['SessionStart'],
    } };
    const manager = (orchestrator as any).deploymentManager;
    manager.getDefinitions = () => [definition];
    manager.effectiveDefinition = () => ({ ...definition, hook: { ...definition.hook, scope: 'system' } });
    vi.mocked(areSystemHookAssetsHealthy).mockResolvedValue(true);
    expect((orchestrator as any).buildHookWatchdogTargets()).toEqual([]);
    const [target] = targets(orchestrator);
    expect(target.id).toBe('hook:codex');
    await expect(target.check()).resolves.toBe(true);
    expect(areSystemHookAssetsHealthy).toHaveBeenCalledWith('codex', expect.any(String), DATA_DIR);
    await expect(target.repair()).resolves.toBeUndefined();
  });

  it('follows live Codex user/system migrations without restarting the collector', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-live-scope-'));
    const defaults = vi.spyOn(HookWatchdog, 'defaultInterceptTargets').mockReturnValue([]);
    const o = new Orchestrator({ dataDir: root, hookWatchdog: { enabled: true, intervalMs: 1000, repairCooldownMs: 0 } } as never) as any;
    try {
      const userPath = path.join(root, 'user/hooks.json');
      await fs.mkdir(path.dirname(userPath));
      const definition = { ...grokDefinition(), id: 'codex', hook: {
        ...grokDefinition().hook!, settingsPath: userPath, events: ['SessionStart'], hookCommand: '/opt/pilot/codex-hook.sh',
      } };
      let scope = 'user';
      let requestedScope = 'system';
      const deploySingle = vi.fn().mockResolvedValue({ success: true });
      const manager = {
        getDefinitions: () => [definition],
        effectiveDefinition: () => ({ ...definition, hook: { ...definition.hook, scope,
          settingsPath: scope === 'system' ? path.join(root, 'etc/config.toml') : userPath } }),
        reloadState: vi.fn(async () => { scope = requestedScope; }),
        isAgentDetected, needsRedeploy, repairHookSettings, undeployAgent, deploySingle,
      };
      o.deploymentManager = manager;
      vi.spyOn(o, 'refreshDeploymentScope').mockResolvedValue(undefined);
      vi.spyOn(o, 'reconcileRecordedAgents').mockResolvedValue(undefined);
      vi.mocked(areSystemHookAssetsHealthy).mockResolvedValue(true);
      const userConfig = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: '/opt/pilot/codex-hook.sh' }] }] } });
      await fs.writeFile(userPath, userConfig);
      o.hookWatchdog = new HookWatchdog(o.config.hookWatchdog, o.buildHookWatchdogTargets(), o.buildGrokBuildInterceptTargets());
      await o.hookWatchdog.runCheck();

      // A separate hook install migrates registration and signals the live collector.
      await fs.unlink(userPath);
      const signal = hookInstallSignalPath(root);
      await fs.writeFile(signal, 'system');
      await o.pollHookInstallSignal(signal);
      expect((await o.hookWatchdog.runCheck()).repaired).toBe(0);
      expect(deploySingle).not.toHaveBeenCalled();

      needsRedeploy.mockResolvedValueOnce(true).mockResolvedValue(false);
      expect((await o.hookWatchdog.runCheck()).repaired).toBe(1);
      expect(repairHookSettings).toHaveBeenCalledTimes(1);
      expect(deploySingle).not.toHaveBeenCalled();

      for (let i = 0; i < 2; i++) {
        needsRedeploy.mockResolvedValueOnce(true).mockResolvedValue(false);
        expect((await o.hookWatchdog.runCheck()).repaired).toBe(1);
      }
      // An unrelated install signal must not reset the daily repair budget.
      await fs.utimes(signal, new Date(), new Date(Date.now() + 1000));
      await o.pollHookInstallSignal(signal);
      needsRedeploy.mockResolvedValueOnce(true).mockResolvedValue(false);
      expect((await o.hookWatchdog.runCheck()).repaired).toBe(0);
      expect(repairHookSettings).toHaveBeenCalledTimes(3);

      requestedScope = 'user';
      await fs.writeFile(userPath, userConfig);
      await fs.utimes(signal, new Date(), new Date(Date.now() + 2000));
      await o.pollHookInstallSignal(signal);
      await fs.unlink(userPath);
      expect((await o.hookWatchdog.runCheck()).repaired).toBe(1);
      expect(deploySingle).toHaveBeenCalledTimes(1);
    } finally {
      o.hookWatchdog?.stop();
      defaults.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces failed repair and removes only the Grok definition on cleanup', async () => {
    repairHookSettings.mockResolvedValue({
      success: false,
      agentId: 'grok-build',
      deployMode: 'hook',
      error: 'cannot write hook settings',
    });
    const [target] = targets(orchestrator);

    await expect(target.repair()).rejects.toThrow('cannot write hook settings');
    await expect(target.cleanup?.()).resolves.toBeUndefined();
    expect(undeployAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'grok-build' }));
  });
});

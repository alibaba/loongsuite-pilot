import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('../../../src/core/build-constants.js', () => ({
  PROPRIETARY_BUILD: false,
}));

vi.mock('../../../src/deployment/grok-build-assets.js', () => ({
  areGrokBuildHookAssetsHealthy: vi.fn(),
  restoreGrokBuildHookAssets: vi.fn(),
}));

import { Orchestrator } from '../../../src/core/orchestrator.js';
import {
  areGrokBuildHookAssetsHealthy,
  restoreGrokBuildHookAssets,
} from '../../../src/deployment/grok-build-assets.js';

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
  let deploySingle: ReturnType<typeof vi.fn>;
  let undeployAgent: ReturnType<typeof vi.fn>;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    isAgentDetected = vi.fn().mockResolvedValue(true);
    needsRedeploy = vi.fn().mockResolvedValue(false);
    deploySingle = vi.fn().mockResolvedValue({
      success: true,
      agentId: 'grok-build',
      deployMode: 'hook',
    });
    undeployAgent = vi.fn().mockResolvedValue(true);
    orchestrator = new Orchestrator({ dataDir: DATA_DIR } as never);
    (orchestrator as unknown as { deploymentManager: unknown }).deploymentManager = {
      getDefinitions: () => [grokDefinition()],
      isAgentDetected,
      needsRedeploy,
      deploySingle,
      undeployAgent,
    };
  });

  it('checks live detection, exact Hook config, and every Grok runtime asset', async () => {
    vi.mocked(areGrokBuildHookAssetsHealthy).mockResolvedValue(true);
    const [target] = targets(orchestrator);

    expect(target.id).toBe('hook:grok-build');
    expect(target.enabled?.()).toBe(true);
    await expect(target.precondition()).resolves.toBe(true);
    await expect(target.check()).resolves.toBe(true);
    expect(isAgentDetected).toHaveBeenCalledWith(expect.objectContaining({ id: 'grok-build' }));
    expect(needsRedeploy).toHaveBeenCalledWith(expect.objectContaining({ id: 'grok-build' }));
    expect(areGrokBuildHookAssetsHealthy).toHaveBeenCalledWith(expect.any(String), DATA_DIR);
  });

  it('restores assets and a missing settings directory, then verifies health again', async () => {
    needsRedeploy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(areGrokBuildHookAssetsHealthy).mockResolvedValue(true);
    const [target] = targets(orchestrator);

    await expect(target.check()).resolves.toBe(false);
    await expect(target.repair()).resolves.toBeUndefined();
    expect(restoreGrokBuildHookAssets).toHaveBeenCalledWith(expect.any(String), DATA_DIR);
    expect(deploySingle).toHaveBeenCalledWith(expect.objectContaining({ id: 'grok-build' }));
    expect(needsRedeploy).toHaveBeenCalledTimes(2);
  });

  it('surfaces failed repair and removes only the Grok definition on cleanup', async () => {
    deploySingle.mockResolvedValue({
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

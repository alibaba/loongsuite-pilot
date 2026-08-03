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

vi.mock('../../../src/deployment/detect-utils.js', () => ({
  detectAgent: vi.fn(),
}));

vi.mock('../../../src/utils/fs-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/fs-utils.js')>();
  return { ...actual, directoryExists: vi.fn() };
});

import { Orchestrator } from '../../../src/core/orchestrator.js';
import { detectAgent } from '../../../src/deployment/detect-utils.js';
import { directoryExists } from '../../../src/utils/fs-utils.js';

const DATA_DIR = '/tmp/orch-directory-plugin-test';

function directoryPluginDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'hermes-agent',
    displayName: 'Hermes Agent',
    deployMode: 'directory-plugin',
    detection: { paths: ['~/.hermes'], commands: ['hermes'] },
    directoryPlugin: {
      sourceDir: '/opt/pilot/assets/plugins/hermes-agent/loongsuite-pilot',
      targetDir: '~/.hermes/plugins/loongsuite-pilot',
    },
    ...overrides,
  };
}

function makeOrchestrator(
  deploymentManager: unknown,
  enabled: boolean | undefined = undefined,
): Orchestrator {
  const agents = enabled === undefined
    ? undefined
    : { 'hermes-agent': { enabled } };
  const orchestrator = new Orchestrator({ dataDir: DATA_DIR, agents } as never);
  (orchestrator as unknown as { deploymentManager: unknown }).deploymentManager =
    deploymentManager;
  return orchestrator;
}

function buildTargets(orchestrator: Orchestrator) {
  return (orchestrator as unknown as {
    buildDirectoryPluginInterceptTargets: () => Array<{
      id: string;
      enabled?: () => boolean;
      precondition: () => Promise<boolean>;
      check: () => Promise<boolean>;
      repair: () => Promise<void>;
    }>;
  }).buildDirectoryPluginInterceptTargets();
}

describe('Orchestrator.buildDirectoryPluginInterceptTargets', () => {
  let getDefinitions: ReturnType<typeof vi.fn>;
  let needsRedeploy: ReturnType<typeof vi.fn>;
  let deploySingle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getDefinitions = vi.fn().mockReturnValue([directoryPluginDef()]);
    needsRedeploy = vi.fn();
    deploySingle = vi.fn();
  });

  it('builds watchdog targets only for configured directory plugins', () => {
    getDefinitions.mockReturnValue([
      directoryPluginDef(),
      directoryPluginDef({ id: 'missing-config', directoryPlugin: undefined }),
      {
        id: 'hook-agent',
        displayName: 'Hook Agent',
        deployMode: 'hook',
        detection: { paths: [], commands: [] },
      },
    ]);

    const targets = buildTargets(makeOrchestrator({
      getDefinitions,
      needsRedeploy,
      deploySingle,
    }));

    expect(targets.map(target => target.id)).toEqual([
      'directory-plugin:hermes-agent',
    ]);
  });

  it('disables self-healing when Hermes is disabled by agent control', () => {
    const [target] = buildTargets(makeOrchestrator({
      getDefinitions,
      needsRedeploy,
      deploySingle,
    }, false));

    expect(target.enabled?.()).toBe(false);
  });

  it('checks source, detection, health, and repair through DeploymentManager', async () => {
    vi.mocked(directoryExists).mockResolvedValue(true);
    vi.mocked(detectAgent).mockResolvedValue(true);
    needsRedeploy.mockResolvedValue(true);
    deploySingle.mockResolvedValue({
      success: true,
      agentId: 'hermes-agent',
      deployMode: 'directory-plugin',
    });
    const [target] = buildTargets(makeOrchestrator({
      getDefinitions,
      needsRedeploy,
      deploySingle,
    }));

    expect(target.enabled?.()).toBe(true);
    await expect(target.precondition()).resolves.toBe(true);
    await expect(target.check()).resolves.toBe(false);
    await expect(target.repair()).resolves.toBeUndefined();
    expect(deploySingle).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'hermes-agent' }),
    );
  });
});

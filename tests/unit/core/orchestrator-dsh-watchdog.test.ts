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
  return { ...actual, fileExists: vi.fn() };
});

import { Orchestrator } from '../../../src/core/orchestrator.js';
import { detectAgent } from '../../../src/deployment/detect-utils.js';
import { fileExists } from '../../../src/utils/fs-utils.js';

const DATA_DIR = '/tmp/orchestrator-dsh-watchdog';

function dshDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'dsh',
    displayName: 'DeepSeek Harness',
    deployMode: 'dsh-yaml-patch',
    detection: { paths: ['~/.dsh'], commands: ['dsh'] },
    dshYamlPatch: {
      pluginSource: `${DATA_DIR}/plugins/dsh/plugin.mjs`,
      entryId: 'loongsuite-pilot-observability',
      marker: 'PILOT-OBSERVABILITY-MANAGED',
    },
    ...overrides,
  };
}

function makeOrchestrator(deploymentManager: unknown, enabled?: boolean): Orchestrator {
  const config = enabled === undefined ? {} : { agents: { dsh: { enabled } } };
  const orchestrator = new Orchestrator({ dataDir: DATA_DIR, ...config } as never);
  (orchestrator as unknown as { deploymentManager: unknown }).deploymentManager = deploymentManager;
  return orchestrator;
}

function buildTargets(orchestrator: Orchestrator) {
  return (orchestrator as unknown as {
    buildDshYamlPatchInterceptTargets: () => Array<{
      id: string;
      enabled?: () => boolean;
      precondition: () => Promise<boolean>;
      check: () => Promise<boolean>;
      repair: () => Promise<void>;
      cleanup?: () => Promise<void>;
    }>;
  }).buildDshYamlPatchInterceptTargets();
}

describe('Orchestrator.buildDshYamlPatchInterceptTargets', () => {
  let getDefinitions: ReturnType<typeof vi.fn>;
  let needsRedeploy: ReturnType<typeof vi.fn>;
  let deploySingle: ReturnType<typeof vi.fn>;
  let undeployAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getDefinitions = vi.fn().mockReturnValue([dshDef()]);
    needsRedeploy = vi.fn();
    deploySingle = vi.fn();
    undeployAgent = vi.fn();
  });

  it('only builds targets for complete dsh-yaml-patch definitions', () => {
    getDefinitions.mockReturnValue([
      dshDef(),
      dshDef({ id: 'missing-config', dshYamlPatch: undefined }),
      { id: 'other', displayName: 'Other', deployMode: 'detection-only', detection: { paths: [], commands: [] } },
    ]);
    const targets = buildTargets(makeOrchestrator({
      getDefinitions, needsRedeploy, deploySingle, undeployAgent,
    }));
    expect(targets.map(target => target.id)).toEqual(['dsh-yaml-patch:dsh']);
  });

  it('checks asset, detection, health, repair, cleanup, and enabled gate', async () => {
    vi.mocked(fileExists).mockResolvedValue(true);
    vi.mocked(detectAgent).mockResolvedValue(true);
    needsRedeploy.mockResolvedValue(true);
    deploySingle.mockResolvedValue({ success: true, agentId: 'dsh', deployMode: 'dsh-yaml-patch' });
    undeployAgent.mockResolvedValue(true);
    const manager = { getDefinitions, needsRedeploy, deploySingle, undeployAgent };
    const [target] = buildTargets(makeOrchestrator(manager, true));

    expect(target.enabled?.()).toBe(true);
    await expect(target.precondition()).resolves.toBe(true);
    await expect(target.check()).resolves.toBe(false);
    await expect(target.repair()).resolves.toBeUndefined();
    await expect(target.cleanup?.()).resolves.toBeUndefined();
    expect(deploySingle).toHaveBeenCalledWith(expect.objectContaining({ id: 'dsh' }));
    expect(undeployAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'dsh' }));

    const [disabled] = buildTargets(makeOrchestrator(manager, false));
    expect(disabled.enabled?.()).toBe(false);
  });

  it('surfaces deployment and cleanup failures to the watchdog', async () => {
    deploySingle.mockResolvedValue({
      success: false,
      agentId: 'dsh',
      deployMode: 'dsh-yaml-patch',
      error: 'repair failed',
    });
    undeployAgent.mockResolvedValue(false);
    const [target] = buildTargets(makeOrchestrator({
      getDefinitions, needsRedeploy, deploySingle, undeployAgent,
    }));
    await expect(target.repair()).rejects.toThrow('repair failed');
    await expect(target.cleanup?.()).rejects.toThrow('failed to remove DSH YAML patch');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentDefinition } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

// Orchestrator transitively imports build-constants, which reads a build-time
// global (__PROPRIETARY_BUILD__) that vitest does not define. Stub it out.
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

const DATA_DIR = '/tmp/orch-plugin-inject-test';

function makeOrchestrator(mockDeploymentManager: unknown): Orchestrator {
  const orch = new Orchestrator({ dataDir: DATA_DIR } as never);
  (orch as unknown as { deploymentManager: unknown }).deploymentManager = mockDeploymentManager;
  return orch;
}

function callBuild(orch: Orchestrator) {
  return (orch as unknown as {
    buildPluginInjectInterceptTargets: () => Array<{
      id: string;
      precondition: () => Promise<boolean>;
      check: () => Promise<boolean>;
      repair: () => Promise<void>;
    }>;
  }).buildPluginInjectInterceptTargets();
}

function pluginInjectDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'opencode',
    displayName: 'OpenCode',
    deployMode: 'plugin-inject',
    detection: { paths: ['~/.config/opencode'], commands: ['opencode'] },
    pluginInject: {
      configPaths: ['~/.config/opencode/opencode.json'],
      pluginSpec: 'file://$PILOT_DATA/plugins/opencode/plugin.mjs',
      pluginId: 'loongsuite-pilot-opencode',
    },
    ...overrides,
  };
}

function hookDef(): AgentDefinition {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    deployMode: 'hook',
    detection: { paths: [], commands: [] },
    hook: {
      settingsPath: '/tmp/settings.json',
      events: ['Stop'],
      hookCommand: '/opt/hook.sh',
      format: 'flat',
    },
  };
}

describe('Orchestrator.buildPluginInjectInterceptTargets', () => {
  let getDefinitions: ReturnType<typeof vi.fn>;
  let needsRedeploy: ReturnType<typeof vi.fn>;
  let deploySingle: ReturnType<typeof vi.fn>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    getDefinitions = vi.fn();
    needsRedeploy = vi.fn();
    deploySingle = vi.fn();
    orch = makeOrchestrator({ getDefinitions, needsRedeploy, deploySingle });
  });

  it('only builds targets for plugin-inject agents', () => {
    getDefinitions.mockReturnValue([hookDef(), pluginInjectDef(), pluginInjectDef({ id: 'qwen-code-cli' })]);

    const targets = callBuild(orch);

    expect(targets.map(t => t.id)).toEqual([
      'plugin-inject:opencode',
      'plugin-inject:qwen-code-cli',
    ]);
  });

  it('skips plugin-inject defs missing pluginInject config', () => {
    getDefinitions.mockReturnValue([
      { id: 'broken', displayName: 'Broken', deployMode: 'plugin-inject', detection: { paths: [], commands: [] } },
    ]);

    expect(callBuild(orch)).toHaveLength(0);
  });

  describe('precondition (double gate)', () => {
    it('returns false when the plugin file does not exist', async () => {
      getDefinitions.mockReturnValue([pluginInjectDef()]);
      vi.mocked(fileExists).mockResolvedValue(false);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const [target] = callBuild(orch);
      expect(await target.precondition()).toBe(false);
      // agent detection must not even be consulted once the file gate fails
      expect(detectAgent).not.toHaveBeenCalled();
    });

    it('returns false when the file exists but the agent is not detected', async () => {
      getDefinitions.mockReturnValue([pluginInjectDef()]);
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(detectAgent).mockResolvedValue(false);

      const [target] = callBuild(orch);
      expect(await target.precondition()).toBe(false);
    });

    it('returns true only when the file exists AND the agent is detected', async () => {
      getDefinitions.mockReturnValue([pluginInjectDef()]);
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const [target] = callBuild(orch);
      expect(await target.precondition()).toBe(true);
      // file gate is resolved against $PILOT_DATA → dataDir
      expect(fileExists).toHaveBeenCalledWith(`${DATA_DIR}/plugins/opencode/plugin.mjs`);
    });

    it('skips the file gate for non-file specs (e.g. npm package)', async () => {
      getDefinitions.mockReturnValue([
        pluginInjectDef({
          pluginInject: {
            configPaths: ['~/.config/opencode/opencode.json'],
            pluginSpec: 'loongsuite-pilot-opencode',
            pluginId: 'loongsuite-pilot-opencode',
          },
        }),
      ]);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const [target] = callBuild(orch);
      expect(await target.precondition()).toBe(true);
      expect(fileExists).not.toHaveBeenCalled();
    });
  });

  describe('check (healthy when spec present)', () => {
    it('is healthy when needsRedeploy is false', async () => {
      getDefinitions.mockReturnValue([pluginInjectDef()]);
      needsRedeploy.mockResolvedValue(false);

      const [target] = callBuild(orch);
      expect(await target.check()).toBe(true);
      expect(needsRedeploy).toHaveBeenCalledWith(expect.objectContaining({ id: 'opencode' }));
    });

    it('is unhealthy when needsRedeploy is true', async () => {
      getDefinitions.mockReturnValue([pluginInjectDef()]);
      needsRedeploy.mockResolvedValue(true);

      const [target] = callBuild(orch);
      expect(await target.check()).toBe(false);
    });
  });

  describe('repair (re-inject via deploySingle)', () => {
    it('calls deploySingle on repair', async () => {
      getDefinitions.mockReturnValue([pluginInjectDef()]);
      deploySingle.mockResolvedValue({ success: true, agentId: 'opencode', deployMode: 'plugin-inject' });

      const [target] = callBuild(orch);
      await target.repair();
      expect(deploySingle).toHaveBeenCalledWith(expect.objectContaining({ id: 'opencode' }));
    });

    it('throws when deploySingle fails so the watchdog records the failure', async () => {
      getDefinitions.mockReturnValue([pluginInjectDef()]);
      deploySingle.mockResolvedValue({ success: false, agentId: 'opencode', deployMode: 'plugin-inject', error: 'no config file' });

      const [target] = callBuild(orch);
      await expect(target.repair()).rejects.toThrow('no config file');
    });
  });
});

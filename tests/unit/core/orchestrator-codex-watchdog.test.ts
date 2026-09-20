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

vi.mock('sqlite3', () => ({
  default: {
    Database: vi.fn(),
    OPEN_READONLY: 1,
  },
}));

import { Orchestrator } from '../../../src/core/orchestrator.js';
import type { PluginCheckTarget } from '../../../src/core/hook-watchdog.js';

function hookDefinition(id: string, trust = false): AgentDefinition {
  return {
    id,
    displayName: id,
    deployMode: 'hook',
    detection: { paths: [`~/.${id}`], commands: [] },
    hook: {
      settingsPath: `~/.${id}/hooks.json`,
      events: ['Stop'],
      hookCommand: `/opt/pilot/${id}-hook.sh`,
      format: 'nested',
      ...(trust ? {
        trustToml: {
          configPath: '~/.codex/config.toml',
          trustAlgo: 'v1',
          marker: 'otel-codex-hook',
        },
      } : {}),
    },
  };
}

function buildTargets(orchestrator: Orchestrator): PluginCheckTarget[] {
  return (orchestrator as unknown as {
    buildHookWatchdogTargets: () => PluginCheckTarget[];
  }).buildHookWatchdogTargets();
}

describe('Orchestrator Codex trust watchdog target', () => {
  let needsRedeploy: ReturnType<typeof vi.fn>;
  let deploySingle: ReturnType<typeof vi.fn>;
  let targets: PluginCheckTarget[];

  beforeEach(() => {
    needsRedeploy = vi.fn().mockResolvedValue(true);
    deploySingle = vi.fn().mockResolvedValue({
      success: true,
      agentId: 'codex',
      deployMode: 'hook',
    });
    const orchestrator = new Orchestrator({ dataDir: '/tmp/codex-watchdog' } as never);
    (orchestrator as unknown as { deploymentManager: unknown }).deploymentManager = {
      getDefinitions: () => [hookDefinition('codex', true), hookDefinition('claude-code')],
      needsRedeploy,
      deploySingle,
    };
    targets = buildTargets(orchestrator);
  });

  it('wires config.toml change checks only for Codex trust targets', async () => {
    const codex = targets.find(target => target.agentId === 'codex')!;
    const claude = targets.find(target => target.agentId === 'claude-code')!;

    expect(codex.changeWatchPath).toMatch(/\.codex\/config\.toml$/);
    expect(codex.needsRepairOnChange).toBeTypeOf('function');
    expect(claude.changeWatchPath).toBeUndefined();
    expect(claude.needsRepairOnChange).toBeUndefined();

    await expect(codex.needsRepairOnChange!()).resolves.toBe(true);
    expect(needsRedeploy).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }));

    await expect(codex.repairFn!()).resolves.toBe(true);
    expect(deploySingle).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }));
  });
});

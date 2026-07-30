/**
 * End-to-end self-heal test for plugin-inject agents (opencode).
 *
 * Uses REAL components — DeploymentManager, PluginInjectStrategy, HookWatchdog,
 * and the orchestrator's target builder — against a throwaway sandbox. No logic
 * is mocked (only the build-time global and logger noise). It proves the full
 * loop: deploy → spec overwritten by a 3rd party → watchdog re-injects it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentDefinition, HookWatchdogConfig } from '../../src/types/index.js';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Orchestrator transitively imports build-constants (build-time global).
vi.mock('../../src/core/build-constants.js', () => ({ PROPRIETARY_BUILD: false }));

import { DeploymentManager } from '../../src/deployment/deployment-manager.js';
import { HookWatchdog, type InterceptCheckTarget } from '../../src/core/hook-watchdog.js';
import { Orchestrator } from '../../src/core/orchestrator.js';

function buildTargets(orch: Orchestrator, mgr: DeploymentManager): InterceptCheckTarget[] {
  (orch as unknown as { deploymentManager: DeploymentManager }).deploymentManager = mgr;
  return (orch as unknown as {
    buildPluginInjectInterceptTargets: () => InterceptCheckTarget[];
  }).buildPluginInjectInterceptTargets();
}

const watchdogConfig: HookWatchdogConfig = {
  enabled: true,
  intervalMs: 1_000_000, // we drive runCheck() manually
  repairCooldownMs: 0,   // no cooldown so the test can repair immediately
};

describe('E2E: opencode plugin-inject watchdog self-heal', () => {
  let tmpDir: string;
  let dataDir: string;
  let configDir: string;
  let configFile: string;
  let pluginFile: string;
  let resolvedSpec: string;
  let def: AgentDefinition;
  let mgr: DeploymentManager;

  async function readPlugins(): Promise<unknown[]> {
    const json = JSON.parse(await fs.readFile(configFile, 'utf-8'));
    return json.plugin ?? json.plugins ?? [];
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-selfheal-'));
    dataDir = path.join(tmpDir, 'pilot-data');
    configDir = path.join(tmpDir, 'opencode-config'); // exists → detectAgent() passes
    configFile = path.join(configDir, 'opencode.json');
    pluginFile = path.join(dataDir, 'plugins', 'opencode', 'plugin.mjs');
    resolvedSpec = `file://${pluginFile}`;

    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(path.dirname(pluginFile), { recursive: true });
    await fs.writeFile(pluginFile, '// fake opencode plugin');
    await fs.writeFile(configFile, JSON.stringify({}, null, 2)); // no plugin yet

    def = {
      id: 'opencode',
      displayName: 'OpenCode',
      deployMode: 'plugin-inject',
      detection: { paths: [configDir], commands: [] },
      pluginInject: {
        configPaths: [configFile],
        pluginSpec: 'file://$PILOT_DATA/plugins/opencode/plugin.mjs',
        pluginId: 'loongsuite-pilot-opencode',
      },
    };

    mgr = new DeploymentManager({ dataDir, pilotDir: tmpDir, builtinAgentsDir: path.join(tmpDir, 'agents.d') });
    // Populate definitions without invoking deployAll() (which would run the
    // real plugin-migration against the real $HOME).
    (mgr as unknown as { definitions: AgentDefinition[] }).definitions = [def];
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('re-injects the plugin spec after it is overwritten by a third party', async () => {
    // 1. Initial deploy — real PluginInjectStrategy writes the spec.
    const deployResult = await mgr.deploySingle(def);
    expect(deployResult.success).toBe(true);
    expect(await readPlugins()).toContain(resolvedSpec);

    // 2. Simulate another tool rewriting the config and dropping our spec.
    await fs.writeFile(configFile, JSON.stringify({ plugin: [] }, null, 2));
    expect(await readPlugins()).not.toContain(resolvedSpec);

    // 3. Build the REAL watchdog target exactly as the orchestrator does.
    const targets = buildTargets(new Orchestrator({ dataDir } as never), mgr);
    expect(targets).toHaveLength(1);

    // 4. Run the watchdog once → it should detect the missing spec and repair.
    const wd = new HookWatchdog(watchdogConfig, [], targets);
    const result = await wd.runCheck();

    expect(result.repaired).toBe(1);
    expect(await readPlugins()).toContain(resolvedSpec);
  });

  it('does not rewrite the config when the spec is already healthy', async () => {
    await mgr.deploySingle(def);
    expect(await readPlugins()).toContain(resolvedSpec);

    const targets = buildTargets(new Orchestrator({ dataDir } as never), mgr);

    const wd = new HookWatchdog(watchdogConfig, [], targets);
    const before = await fs.readFile(configFile, 'utf-8');
    const result = await wd.runCheck();

    expect(result.repaired).toBe(0);
    expect(result.checked).toBe(1);
    expect(await fs.readFile(configFile, 'utf-8')).toBe(before); // untouched
  });

  it('skips repair when the plugin asset is missing (precondition gate)', async () => {
    await mgr.deploySingle(def);
    // Remove the deployed plugin file AND the spec → unhealthy but not repairable.
    await fs.rm(pluginFile);
    await fs.writeFile(configFile, JSON.stringify({ plugin: [] }, null, 2));

    const targets = buildTargets(new Orchestrator({ dataDir } as never), mgr);

    const wd = new HookWatchdog(watchdogConfig, [], targets);
    const result = await wd.runCheck();

    // precondition fails → skipped, no repair attempt, spec stays absent.
    expect(result.skipped).toBe(1);
    expect(result.repaired).toBe(0);
    expect(await readPlugins()).not.toContain(resolvedSpec);
  });
});

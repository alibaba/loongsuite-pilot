import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentDefLoader } from '../../../src/deployment/agent-def-loader.js';
import { DeploymentManager } from '../../../src/deployment/deployment-manager.js';
import { HookManager } from '../../../src/hooks/hook-manager.js';
import { HookStrategy } from '../../../src/deployment/hook-strategy.js';
import { planEagerDeploys } from '../../../src/inject-hooks.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/deployment/detect-utils.js', () => ({
  detectAgent: vi.fn().mockResolvedValue(true),
  commandExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../src/deployment/deploy-notification.js', () => ({
  writeDeployNotification: vi.fn().mockResolvedValue(undefined),
}));

/**
 * The load-bearing invariant of eager injection.
 *
 * inject-hooks (spawned by k8s-preload before the workload starts) and the
 * daemon's deployAll both write hooks into the agent's settings, and they must
 * produce the *same* hookCommand string. If they diverge by even one character,
 * the daemon's isHookInstalled() check reads "not installed" and appends a
 * second entry — so every event fires twice, silently. That is a worse failure
 * than the startup race eager injection exists to fix, so it gets a test that
 * compares the actual bytes rather than trusting that both paths call the same
 * function.
 *
 * The two share HookStrategy/HookManager deliberately; what this pins is that
 * they are also *constructed* with the same dataDir/pilotDir, which is the part
 * a refactor can quietly break.
 *
 * Scope, established by mutating each input and checking this test fails:
 *  - the `dataDir` given to AgentDefLoader IS caught — it resolves $PILOT_DATA
 *    inside hookCommand, and is therefore the actual divergence risk.
 *  - HookManager's hookScriptDir argument is NOT caught, because it does not
 *    reach the written command at all (HookManager only ever writes to the
 *    agent's own settings file). Do not add coverage for it expecting to guard
 *    the command string; guard dataDir/pilotDir resolution instead.
 */
describe('eager injection vs daemon deployAll parity', () => {
  let tmp: string;
  let dataDir: string;
  let pilotDir: string;
  let builtinDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-parity-'));
    dataDir = path.join(tmp, 'data');
    pilotDir = path.join(tmp, 'pilot');
    builtinDir = path.join(pilotDir, 'agents.d');
    settingsPath = path.join(tmp, 'agent-home', 'settings.json');
    await fs.mkdir(builtinDir, { recursive: true });
    await fs.mkdir(path.join(dataDir, 'agents.d.local'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'agent-home'), { recursive: true });

    // A hook agent whose settings live inside the temp tree. $PILOT_DATA in the
    // hookCommand is what both paths must resolve identically.
    await fs.writeFile(
      path.join(builtinDir, 'test-agent.json'),
      JSON.stringify({
        id: 'test-agent',
        displayName: 'Test Agent',
        deployMode: 'hook',
        detection: { paths: [tmp], commands: [] },
        hook: {
          settingsPath,
          events: ['Stop'],
          hookCommand: '$PILOT_DATA/hooks/test-agent-hook.sh',
          format: 'nested',
          matcher: '*',
        },
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /**
   * Deploys exactly as src/inject-hooks.ts does: same classes, same args, and the
   * same plan. The plan is built with an empty id list on purpose — that is the
   * default path now, since the id list comes from an optional K8s label, so it
   * is the selection this parity guarantee has to hold for.
   */
  async function runEagerInjection(): Promise<void> {
    const loader = new AgentDefLoader({
      builtinDir,
      localDir: path.join(dataDir, 'agents.d.local'),
      pilotDir,
      dataDir,
    });
    const hookManager = new HookManager(path.join(dataDir, 'hooks'), path.join(dataDir, 'logs'));
    const strategy = new HookStrategy(hookManager);
    const defs = await loader.load();
    const plan = planEagerDeploys(defs, []);
    const entry = plan.find(p => p.agentId === 'test-agent');
    expect(entry?.action, 'sweep must select the fixture agent for eager deploy').toBe('deploy');
    await strategy.deploy(defs.find(d => d.id === entry!.agentId)!);
  }

  function countHookEntries(settings: Record<string, any>): number {
    let n = 0;
    for (const event of Object.keys(settings.hooks ?? {})) {
      for (const group of settings.hooks[event] ?? []) {
        n += (group.hooks ?? []).length;
      }
    }
    return n;
  }

  it('leaves the settings file byte-identical when the daemon runs afterwards', async () => {
    await runEagerInjection();
    const afterEager = await fs.readFile(settingsPath, 'utf8');
    expect(countHookEntries(JSON.parse(afterEager))).toBe(1);

    const manager = new DeploymentManager({ dataDir, pilotDir, builtinAgentsDir: builtinDir });
    const results = await manager.deployAll();

    const afterDaemon = await fs.readFile(settingsPath, 'utf8');
    // Byte equality, not just "still one entry": a divergent-but-same-count
    // rewrite would mean the two paths disagree about the command string.
    expect(afterDaemon).toBe(afterEager);
    expect(countHookEntries(JSON.parse(afterDaemon))).toBe(1);

    const result = results.find(r => r.agentId === 'test-agent');
    expect(result?.skipped).toBe(true);
    expect(result?.reason).toBe('up-to-date');
  });

  it('is itself idempotent, so a repeated preload cannot double the hooks', async () => {
    await runEagerInjection();
    const first = await fs.readFile(settingsPath, 'utf8');
    await runEagerInjection();
    const second = await fs.readFile(settingsPath, 'utf8');
    expect(second).toBe(first);
    expect(countHookEntries(JSON.parse(second))).toBe(1);
  });

  it('deploys the agent when eager injection never ran (the control)', async () => {
    const manager = new DeploymentManager({ dataDir, pilotDir, builtinAgentsDir: builtinDir });
    const results = await manager.deployAll();
    const result = results.find(r => r.agentId === 'test-agent');
    // Without this, the test above could pass simply because nothing ever
    // deployed anything.
    expect(result?.skipped).toBeFalsy();
    expect(result?.success).toBe(true);
  });
});

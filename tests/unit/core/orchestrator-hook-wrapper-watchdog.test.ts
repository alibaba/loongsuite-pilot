import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Orchestrator } from '../../../src/core/orchestrator.js';
import type { AgentDefinition } from '../../../src/types/index.js';
import type { PluginCheckTarget } from '../../../src/core/hook-watchdog.js';

describe('Orchestrator hook wrapper watchdog wiring', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('repairs the Pilot-owned wrapper before reconciling settings', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-wrapper-watchdog-'));
    const scriptName = 'claude-code-loongsuite-pilot-hook.sh';
    const targetPath = path.join(tmpDir, 'hooks', scriptName);
    const def: AgentDefinition = {
      id: 'claude-code',
      displayName: 'Claude Code',
      deployMode: 'hook',
      detection: { paths: [], commands: [] },
      hook: {
        settingsPath: path.join(tmpDir, '.claude', 'settings.json'),
        events: ['Stop'],
        hookCommand: targetPath,
        format: 'nested',
      },
    };
    const deploySingle = vi.fn().mockResolvedValue({ success: true });
    const orchestrator = new Orchestrator({ dataDir: tmpDir } as never);
    (orchestrator as unknown as { deploymentManager: unknown }).deploymentManager = {
      getDefinitions: () => [def],
      deploySingle,
    };
    const [target] = (orchestrator as unknown as {
      buildHookWatchdogTargets: () => PluginCheckTarget[];
    }).buildHookWatchdogTargets();

    expect(target.wrapperAsset?.targetPath).toBe(targetPath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, 'damaged wrapper\n');
    await expect(target.repairFn?.()).resolves.toBe(true);
    expect(await fs.readFile(targetPath)).toEqual(await fs.readFile(target.wrapperAsset!.sourcePath));
    expect(deploySingle).toHaveBeenCalledWith(def);

    // A wrapper that cannot be replaced must not prevent settings repair.
    await fs.rm(targetPath);
    await fs.mkdir(targetPath);
    await expect(target.repairFn?.()).resolves.toBe(true);
    expect(deploySingle).toHaveBeenCalledTimes(2);
    await fs.rm(targetPath, { recursive: true });

    const newerPackage = path.join(tmpDir, 'versions', 'newer');
    await fs.mkdir(newerPackage, { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'current'), 'newer\n');
    expect(target.wrapperAsset?.isApplicable?.()).toBe(false);
    await fs.writeFile(targetPath, 'new package wrapper\n');
    await expect(target.repairFn?.()).resolves.toBe(true);
    expect(await fs.readFile(targetPath, 'utf8')).toBe('new package wrapper\n');
  });
});

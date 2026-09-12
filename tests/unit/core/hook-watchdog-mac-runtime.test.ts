import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { HookWatchdog } from '../../../src/core/hook-watchdog.js';

vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof os>(), homedir: vi.fn() }));
vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: unknown[]) => new Promise((resolve, reject) => {
      execFile(...args, (error: Error | null, stdout: string, stderr: string) => {
        error ? reject(error) : resolve({ stdout, stderr });
      });
    }),
  });
  return { spawn: vi.fn(), execFile };
});
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('macOS runtime override cleanup', () => {
  let root: string;
  let wrapper: string;
  let values: Map<string, string>;
  let calls: string[][];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-mac-runtime-'));
    wrapper = path.join(root, 'data', 'hooks', 'qoderwork-runtime-wrapper.mjs');
    values = new Map();
    calls = [];
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.mocked(os.homedir).mockReturnValue(root);
    vi.mocked(execFile).mockImplementation(((command: string, args: string[], callback: Function) => {
      expect(command).toBe('launchctl');
      calls.push(args);
      const [operation, key] = args;
      if (operation === 'unsetenv') values.delete(key);
      callback(null, operation === 'getenv' ? values.get(key) ?? '' : '', '');
    }) as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(HookWatchdog.macRuntimeInterceptDefs())('cleans missing wrapper for $id without repairing it', async def => {
    values.set(def.envName, wrapper);
    const plist = path.join(root, 'Library', 'LaunchAgents', `${def.plistLabel}.plist`);
    await fs.mkdir(path.dirname(plist), { recursive: true });
    await fs.writeFile(plist, `<plist><string>${wrapper}</string></plist>`);
    const target = HookWatchdog.defaultInterceptTargets(path.join(root, 'data')).find(t => t.id === def.id)!;
    const watchdog = new HookWatchdog({ enabled: true, intervalMs: 1000, repairCooldownMs: 1000 }, [], [target]);
    const result = await watchdog.runCheck();
    expect(result.skipped).toBe(1);
    expect(values.has(def.envName)).toBe(false);
    await expect(fs.stat(plist)).rejects.toThrow();
    expect(calls).toContainEqual(['unload', plist]);
    expect(calls.some(c => c[0] === 'setenv' || c[0] === 'load')).toBe(false);
  });

  it('preserves foreign overrides and plists even with the Pilot label', async () => {
    const def = HookWatchdog.macRuntimeInterceptDefs()[0];
    const foreign = '/custom/loongsuite-pilot/another-wrapper.mjs';
    values.set(def.envName, foreign);
    const plist = path.join(root, 'Library', 'LaunchAgents', `${def.plistLabel}.plist`);
    await fs.mkdir(path.dirname(plist), { recursive: true });
    await fs.writeFile(plist, `<plist><string>${foreign}</string></plist>`);
    const target = HookWatchdog.defaultInterceptTargets(path.join(root, 'data')).find(t => t.id === def.id)!;
    expect(await target.precondition()).toBe(false);
    expect(values.get(def.envName)).toBe(foreign);
    expect(await fs.readFile(plist, 'utf8')).toContain(foreign);
    expect(calls.every(c => c[0] === 'getenv')).toBe(true);
  });
});

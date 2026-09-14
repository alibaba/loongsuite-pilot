import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsUtils from '../../../src/utils/fs-utils.js';
import {
  HookWatchdog,
  parseWindowsUserEnv,
  stripMarkerBlock,
  extractMarkerBlock,
  type InterceptCheckTarget,
} from '../../../src/core/hook-watchdog.js';
import type { HookWatchdogConfig } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: vi.fn(),
  }),
}));

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const defaultConfig: HookWatchdogConfig = {
  enabled: true,
  intervalMs: 300_000,
  repairCooldownMs: 600_000,
};

function makeTarget(overrides: Partial<InterceptCheckTarget> = {}): InterceptCheckTarget {
  return {
    id: 'test-target',
    check: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    repair: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    precondition: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

describe('HookWatchdog intercept targets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips intercept target when precondition fails', async () => {
    const target = makeTarget({ precondition: vi.fn().mockResolvedValue(false) });
    const wd = new HookWatchdog(defaultConfig, [], [target]);
    const result = await wd.runCheck();

    expect(target.precondition).toHaveBeenCalled();
    expect(target.check).not.toHaveBeenCalled();
    expect(target.repair).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('marks healthy when check returns true', async () => {
    const target = makeTarget({ check: vi.fn().mockResolvedValue(true) });
    const wd = new HookWatchdog(defaultConfig, [], [target]);
    const result = await wd.runCheck();

    expect(target.check).toHaveBeenCalled();
    expect(target.repair).not.toHaveBeenCalled();
    expect(result.checked).toBe(1);
  });

  it('calls repair when check returns false', async () => {
    const target = makeTarget({ check: vi.fn().mockResolvedValue(false) });
    const wd = new HookWatchdog(defaultConfig, [], [target]);
    const result = await wd.runCheck();

    expect(target.repair).toHaveBeenCalledTimes(1);
    expect(result.repaired).toBe(1);
  });

  it('respects repair cooldown', async () => {
    const target = makeTarget({ check: vi.fn().mockResolvedValue(false) });
    const wd = new HookWatchdog(defaultConfig, [], [target]);

    await wd.runCheck(); // first repair
    expect(target.repair).toHaveBeenCalledTimes(1);

    await wd.runCheck(); // within cooldown → skip
    expect(target.repair).toHaveBeenCalledTimes(1);
  });

  it('enforces daily repair limit', async () => {
    const config = { ...defaultConfig, repairCooldownMs: 0 }; // no cooldown for this test
    const target = makeTarget({ check: vi.fn().mockResolvedValue(false) });
    const wd = new HookWatchdog(config, [], [target]);

    for (let i = 0; i < 5; i++) {
      await wd.runCheck();
    }

    // MAX_INTERCEPT_REPAIRS_PER_DAY = 3, so only 3 repairs
    expect(target.repair).toHaveBeenCalledTimes(3);
  });

  it('does not crash when repair throws', async () => {
    const target = makeTarget({
      check: vi.fn().mockResolvedValue(false),
      repair: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    const wd = new HookWatchdog(defaultConfig, [], [target]);
    const result = await wd.runCheck();

    expect(target.repair).toHaveBeenCalled();
    // repair failed but watchdog didn't throw
    expect(result.repaired).toBe(0);
  });

  it('does not apply cooldown or daily budget after repair throws', async () => {
    const repair = vi.fn().mockRejectedValue(new Error('transient target disappeared'));
    const target = makeTarget({
      check: vi.fn().mockResolvedValue(false),
      repair,
    });
    const wd = new HookWatchdog(defaultConfig, [], [target]);

    const first = await wd.runCheck();
    const second = await wd.runCheck();

    expect(first.repaired).toBe(0);
    expect(second.repaired).toBe(0);
    expect(repair).toHaveBeenCalledTimes(2);
  });

  it('handles multiple intercept targets independently', async () => {
    const healthy = makeTarget({ id: 'ok', check: vi.fn().mockResolvedValue(true) });
    const broken = makeTarget({ id: 'broken', check: vi.fn().mockResolvedValue(false) });
    const disabled = makeTarget({ id: 'off', precondition: vi.fn().mockResolvedValue(false) });

    const wd = new HookWatchdog(defaultConfig, [], [healthy, broken, disabled]);
    const result = await wd.runCheck();

    expect(result.checked).toBe(1);
    expect(result.repaired).toBe(1);
    expect(result.skipped).toBe(1);
    expect(healthy.repair).not.toHaveBeenCalled();
    expect(broken.repair).toHaveBeenCalledTimes(1);
    expect(disabled.check).not.toHaveBeenCalled();
  });

  it('does not repair again once check returns healthy after prior repair', async () => {
    const config = { ...defaultConfig, repairCooldownMs: 0 };
    let healthy = false;
    const target = makeTarget({
      check: vi.fn(async () => healthy),
      repair: vi.fn(async () => { healthy = true; }), // repair makes check pass
    });
    const wd = new HookWatchdog(config, [], [target]);

    // First run: check false → repair → sets healthy=true
    await wd.runCheck();
    expect(target.repair).toHaveBeenCalledTimes(1);

    // Second run: check now returns true → no repair
    await wd.runCheck();
    expect(target.repair).toHaveBeenCalledTimes(1); // still 1, not called again
  });

  it('resets daily counter on date change', async () => {
    const config = { ...defaultConfig, repairCooldownMs: 0 };
    const target = makeTarget({ check: vi.fn().mockResolvedValue(false) });
    const wd = new HookWatchdog(config, [], [target]);

    // Exhaust daily limit
    for (let i = 0; i < 3; i++) await wd.runCheck();
    expect(target.repair).toHaveBeenCalledTimes(3);

    // Simulate date rollover by clearing the internal state
    (wd as any).dailyRepairResetDate = '1970-01-01';

    await wd.runCheck();
    expect(target.repair).toHaveBeenCalledTimes(4); // counter reset, new repair allowed
  });

  it('skips target entirely when enabled() returns false (before precondition)', async () => {
    const target = makeTarget({
      enabled: vi.fn<[], boolean>().mockReturnValue(false),
      check: vi.fn().mockResolvedValue(false), // would repair if reached
    });
    const wd = new HookWatchdog(defaultConfig, [], [target]);
    const result = await wd.runCheck();

    expect(target.enabled).toHaveBeenCalled();
    expect(target.precondition).not.toHaveBeenCalled();
    expect(target.check).not.toHaveBeenCalled();
    expect(target.repair).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('proceeds normally when enabled() returns true', async () => {
    const target = makeTarget({
      enabled: vi.fn<[], boolean>().mockReturnValue(true),
      check: vi.fn().mockResolvedValue(false),
    });
    const wd = new HookWatchdog(defaultConfig, [], [target]);
    const result = await wd.runCheck();

    expect(target.enabled).toHaveBeenCalled();
    expect(target.repair).toHaveBeenCalledTimes(1);
    expect(result.repaired).toBe(1);
  });

  it('runs cleanup() (not check/repair) when disabled', async () => {
    const cleanup = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
    const target = makeTarget({
      enabled: vi.fn<[], boolean>().mockReturnValue(false),
      cleanup,
      check: vi.fn().mockResolvedValue(false),
    });
    const wd = new HookWatchdog(defaultConfig, [], [target]);
    const result = await wd.runCheck();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(target.precondition).not.toHaveBeenCalled();
    expect(target.check).not.toHaveBeenCalled();
    expect(target.repair).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('does not crash when cleanup() throws while disabled', async () => {
    const target = makeTarget({
      enabled: vi.fn<[], boolean>().mockReturnValue(false),
      cleanup: vi.fn<[], Promise<void>>().mockRejectedValue(new Error('rc read-only')),
    });
    const wd = new HookWatchdog(defaultConfig, [], [target]);
    const result = await wd.runCheck();
    expect(result.skipped).toBe(1);
  });

  it('skips cleanly when disabled and no cleanup() is provided', async () => {
    const target = makeTarget({ enabled: vi.fn<[], boolean>().mockReturnValue(false) });
    const wd = new HookWatchdog(defaultConfig, [], [target]);
    const result = await wd.runCheck();
    expect(target.check).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('does not interfere with plugin check targets', async () => {
    // Plugin target with repairFn
    const pluginRepair = vi.fn().mockResolvedValue(true);
    const pluginTarget = {
      agentId: 'plugin-agent',
      settingsPath: '/nonexistent/settings.json',
      expectedHooks: ['Stop'],
      markers: ['test-marker'],
      repairFn: pluginRepair,
    };

    const interceptTarget = makeTarget({ check: vi.fn().mockResolvedValue(false) });
    const wd = new HookWatchdog(defaultConfig, [pluginTarget], [interceptTarget]);
    await wd.runCheck();

    // Plugin target skipped (settings dir doesn't exist), intercept target repaired
    expect(pluginRepair).not.toHaveBeenCalled();
    expect(interceptTarget.repair).toHaveBeenCalledTimes(1);
  });
});

describe('HookWatchdog.defaultInterceptTargets', () => {
  it('returns targets array (structure test only, no real exec)', () => {
    const targets = HookWatchdog.defaultInterceptTargets('/tmp/test-pilot');
    expect(targets.length).toBeGreaterThanOrEqual(2); // rc targets always; runtime env targets only on macOS
    for (const t of targets) {
      expect(t.id).toBeDefined();
      expect(typeof t.check).toBe('function');
      expect(typeof t.repair).toBe('function');
      expect(typeof t.precondition).toBe('function');
    }

    const ids = targets.map(t => t.id);
    expect(ids).toContain('qodercli-rc');
    expect(ids).toContain('claude-code-rc');
    if (process.platform === 'darwin') {
      expect(ids).toContain('qwenworkcn-env');
      expect(ids).toContain('qoderwork-env'); // retired: present for cleanup only
    }
  });

  it('keeps macOS runtime targets aligned with installer product families', () => {
    const defs = HookWatchdog.macRuntimeInterceptDefs();
    expect(defs).toEqual([
      {
        id: 'qwenworkcn-env',
        envName: 'QW_QODER_WORKER_RUNTIME_PATH',
        plistLabel: 'com.loongsuite-pilot.qwenworkcn-env',
        agentIds: ['qwen-work-cn'],
        appNames: ['QwenWorkCN.app'],
      },
    ]);

    const installer = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf-8');
    for (const def of defs) {
      expect(installer).toContain(def.envName);
      expect(installer).toContain(def.plistLabel);
      for (const appName of def.appNames) expect(installer).toContain(appName);
    }
  });

  it('keeps retired runtime overrides cleaned up by the installer too', () => {
    const retired = HookWatchdog.macRetiredRuntimeInterceptDefs();
    expect(retired).toEqual([
      {
        id: 'qoderwork-env',
        envName: 'QODER_WORKER_RUNTIME_PATH',
        plistLabel: 'com.loongsuite-pilot.qoderwork-env',
      },
    ]);

    // A retired id must not also be injected by an active definition.
    const activeIds = new Set(HookWatchdog.macRuntimeInterceptDefs().map(d => d.id));
    const installer = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf-8');
    for (const def of retired) {
      expect(activeIds.has(def.id)).toBe(false);
      expect(installer).toContain(`launchctl unsetenv ${def.envName}`);
      expect(installer).toContain(def.plistLabel);
    }
  });

  it('injects only the QwenWorkCN runtime target on Windows', () => {
    expect(HookWatchdog.winRuntimeInterceptDefs()).toEqual([
      expect.objectContaining({
        id: 'qwenworkcn-win-env',
        envName: 'QW_QODER_WORKER_RUNTIME_PATH',
        agentIds: ['qwen-work-cn'],
      }),
    ]);
  });

  it('retires the QoderWork override on Windows through the installer too', () => {
    const retired = HookWatchdog.winRetiredRuntimeInterceptDefs();
    expect(retired).toEqual([
      { id: 'qoderwork-win-env', envName: 'QODER_WORKER_RUNTIME_PATH' },
    ]);

    const activeIds = new Set(HookWatchdog.winRuntimeInterceptDefs().map(d => d.id));
    const installer = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf-8');
    for (const def of retired) {
      expect(activeIds.has(def.id)).toBe(false);
      expect(installer).toContain(def.envName);
    }
  });

  it.each(['REG_SZ', 'REG_EXPAND_SZ'])('parses a Windows %s User environment value', (registryType) => {
    const output = [
      '',
      'HKEY_CURRENT_USER\\Environment',
      `    QW_QODER_WORKER_RUNTIME_PATH    ${registryType}    C:\\Pilot Data\\hooks\\qoderwork-runtime-wrapper.mjs`,
      '',
    ].join('\r\n');
    expect(parseWindowsUserEnv(output, 'QW_QODER_WORKER_RUNTIME_PATH')).toBe(
      'C:\\Pilot Data\\hooks\\qoderwork-runtime-wrapper.mjs',
    );
  });

  it('returns an empty value when the Windows User environment override is absent', () => {
    expect(parseWindowsUserEnv('', 'QW_QODER_WORKER_RUNTIME_PATH')).toBe('');
    expect(parseWindowsUserEnv(
      '    UNRELATED_RUNTIME_PATH    REG_SZ    C:\\vendor\\runtime.mjs',
      'QW_QODER_WORKER_RUNTIME_PATH',
    )).toBe('');
  });

  it('keeps Windows runtime cleanup failures observable', () => {
    const source = readFileSync(resolve('src/core/hook-watchdog.ts'), 'utf-8');
    const windowsSection = source.slice(
      source.indexOf('// ── QoderWork-family Windows User env vars'),
      source.indexOf('// ── Shell rc intercept targets'),
    );
    expect(windowsSection).toContain("logger.debug('windows runtime override cleanup failed'");
    expect(windowsSection).toContain("reason: 'wrapper-missing'");
    expect(windowsSection).toContain("reason: 'app-missing'");
    expect(windowsSection).not.toContain('cleanupOwnedWindowsUserEnv(def.envName, wrapperPath).catch');
  });

  it('defaults every non-retired target to enabled when no gate is passed', () => {
    const retired = new Set([
      ...HookWatchdog.macRetiredRuntimeInterceptDefs(),
      ...HookWatchdog.winRetiredRuntimeInterceptDefs(),
    ].map(d => d.id));
    const targets = HookWatchdog.defaultInterceptTargets('/tmp/test-pilot');
    for (const t of targets) {
      // enabled is optional; when present it must report true under the default
      // gate — except retired targets, which stay disabled so they only clean up.
      expect(t.enabled?.() ?? true).toBe(!retired.has(t.id));
    }
  });

  it('wires the isAgentEnabled gate to the right agent id per target', () => {
    const disabled = new Set([
      'claude-code',
      'qoder',
      'qoder-work',
      'qoder-work-cn',
      'qwen-work-cn',
    ]);
    const targets = HookWatchdog.defaultInterceptTargets(
      '/tmp/test-pilot',
      (id) => !disabled.has(id),
    );
    const byId = Object.fromEntries(targets.map(t => [t.id, t]));

    expect(byId['claude-code-rc'].enabled?.()).toBe(false); // → claude-code
    expect(byId['qodercli-rc'].enabled?.()).toBe(false);    // → qoder
    if (process.platform === 'darwin') {
      expect(byId['qwenworkcn-env'].enabled?.()).toBe(false); // → qwen-work-cn
    }
  });

  it.runIf(process.platform === 'darwin')('never enables the retired QoderWork override, whichever agent is on', () => {
    for (const agentId of ['qoder-work', 'qoder-work-cn', 'qwen-work-cn']) {
      const byId = Object.fromEntries(HookWatchdog.defaultInterceptTargets(
        '/tmp/test-pilot',
        id => id === agentId,
      ).map(t => [t.id, t]));

      expect(byId['qoderwork-env'].enabled?.()).toBe(false);
      expect(byId['qwenworkcn-env'].enabled?.()).toBe(agentId === 'qwen-work-cn');
    }
  });
});

describe('macOS runtime intercept lifecycle (mock launchctl and temporary HOME)', () => {
  const exec = vi.mocked(promisify(execFile));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const qoderEnv = 'QODER_WORKER_RUNTIME_PATH';
  const qwenEnv = 'QW_QODER_WORKER_RUNTIME_PATH';
  let tmp: string;
  let dataDir: string;
  let wrapper: string;
  let env: Map<string, string>;

  function plist(id: string): string {
    return join(tmp, 'Library', 'LaunchAgents', `com.loongsuite-pilot.${id}.plist`);
  }

  function targets(enabled: string[]) {
    return HookWatchdog.defaultInterceptTargets(dataDir, id => enabled.includes(id), [])
      .filter(t => t.id.endsWith('-env'));
  }

  function installWrapper(app: string) {
    mkdirSync(join(dataDir, 'hooks'), { recursive: true });
    writeFileSync(wrapper, '// shared wrapper\n');
    mkdirSync(join(tmp, 'Applications', app), { recursive: true });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(os.tmpdir(), 'runtime-intercept-'));
    dataDir = join(tmp, 'custom data'); // No loongsuite-pilot substring.
    wrapper = join(dataDir, 'hooks', 'qoderwork-runtime-wrapper.mjs');
    env = new Map();
    mkdirSync(join(tmp, 'Library', 'LaunchAgents'), { recursive: true });
    vi.mocked(os.homedir).mockReturnValue(tmp);
    // Never consult the host's /Applications; all app fixtures live in tmp.
    vi.spyOn(fsUtils, 'directoryExists').mockImplementation(async p =>
      p.startsWith(`${tmp}/`) && existsSync(p));
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    exec.mockReset();
    exec.mockImplementation(async (command, args) => {
      expect(command).toBe('launchctl');
      const [op, key, value] = args as string[];
      if (op === 'getenv') return { stdout: `${env.get(key) ?? ''}\n`, stderr: '' };
      if (op === 'setenv') env.set(key, value);
      else if (op === 'unsetenv') env.delete(key);
      else {
        expect(['load', 'unload']).toContain(op);
        expect(key.startsWith(`${tmp}/`)).toBe(true);
      }
      return { stdout: '', stderr: '' };
    });
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', platform);
    vi.restoreAllMocks();
    const actualOs = await vi.importActual<typeof import('node:os')>('node:os');
    vi.mocked(os.homedir).mockImplementation(actualOs.homedir);
    exec.mockReset();
    rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    ['default-enabled agents', undefined],
    ['qoder-work only', ['qoder-work']],
    ['qoder-work-cn enabled', ['qoder-work-cn']],
  ] as [string, string[] | undefined][])('retires the QoderWork override every cycle with %s', async (_label, enabled) => {
    installWrapper('QoderWorkCN.app'); // An installed CN app must not resurrect it.
    env.set(qoderEnv, wrapper);
    writeFileSync(plist('qoderwork-env'), 'legacy Pilot plist');
    const target = HookWatchdog.defaultInterceptTargets(
      dataDir,
      enabled && (id => enabled.includes(id)),
      [],
    ).find(t => t.id === 'qoderwork-env')!;
    expect(target.enabled!()).toBe(false);
    const precondition = vi.spyOn(target, 'precondition');
    const wd = new HookWatchdog(defaultConfig, [], [target]);

    expect(await wd.runCheck()).toEqual({ checked: 0, repaired: 0, skipped: 1 });
    expect(await wd.runCheck()).toEqual({ checked: 0, repaired: 0, skipped: 1 });
    expect(precondition).not.toHaveBeenCalled();
    expect(env.has(qoderEnv)).toBe(false);
    expect(existsSync(plist('qoderwork-env'))).toBe(false);
    expect(exec.mock.calls.some(([, args]) => args?.[0] === 'setenv')).toBe(false);
    expect(existsSync(wrapper)).toBe(true);
  });

  it('preserves Qwen under default-enabled agents while retiring the QoderWork override', async () => {
    installWrapper('QwenWorkCN.app');
    env.set(qoderEnv, wrapper);
    env.set(qwenEnv, wrapper);
    writeFileSync(plist('qoderwork-env'), 'legacy Pilot plist');
    writeFileSync(plist('qwenworkcn-env'), 'active Pilot plist');
    const envTargets = HookWatchdog.defaultInterceptTargets(dataDir, undefined, [])
      .filter(t => t.id.endsWith('-env'));

    expect(await new HookWatchdog(defaultConfig, [], envTargets).runCheck())
      .toEqual({ checked: 1, repaired: 0, skipped: 1 });
    expect(env.has(qoderEnv)).toBe(false);
    expect(env.get(qwenEnv)).toBe(wrapper);
    expect(existsSync(plist('qoderwork-env'))).toBe(false);
    expect(readFileSync(plist('qwenworkcn-env'), 'utf8')).toBe('active Pilot plist');
    expect(existsSync(wrapper)).toBe(true);
  });

  it('preserves a third-party override while retiring the QoderWork injection', async () => {
    env.set(qoderEnv, '/third-party/runtime.mjs');
    const target = HookWatchdog.defaultInterceptTargets(dataDir, undefined, [])
      .find(t => t.id === 'qoderwork-env')!;
    await new HookWatchdog(defaultConfig, [], [target]).runCheck();
    expect(env.get(qoderEnv)).toBe('/third-party/runtime.mjs');
    expect(exec.mock.calls.some(([, args]) => args?.[0] === 'unsetenv')).toBe(false);
  });

  it('repairs enabled QwenWorkCN and stays healthy', async () => {
    installWrapper('QwenWorkCN.app');
    const wd = new HookWatchdog(defaultConfig, [], targets(['qwen-work-cn']));
    expect((await wd.runCheck()).repaired).toBe(1);
    expect(env.get(qwenEnv)).toBe(wrapper);
    expect(readFileSync(plist('qwenworkcn-env'), 'utf8')).toContain(wrapper);
    expect((await wd.runCheck()).checked).toBe(1);
    expect(env.has(qoderEnv)).toBe(false);
  });

  it.each(['QoderWork.app', 'QoderWorkCN.app'])('does not use %s to satisfy the Qwen precondition', async app => {
    installWrapper(app);
    const result = await new HookWatchdog(defaultConfig, [], targets(['qwen-work-cn'])).runCheck();
    expect(result.repaired).toBe(0);
    expect(env.has(qwenEnv)).toBe(false);
  });

  it('preserves the active Qwen injection while cleaning the retired product', async () => {
    installWrapper('QwenWorkCN.app');
    env.set(qwenEnv, wrapper);
    env.set(qoderEnv, wrapper);
    writeFileSync(plist('qwenworkcn-env'), 'active Pilot plist');
    writeFileSync(plist('qoderwork-env'), 'stale Pilot plist');
    const wd = new HookWatchdog(defaultConfig, [], targets(['qoder-work', 'qwen-work-cn']));
    expect(await wd.runCheck()).toEqual({ checked: 1, repaired: 0, skipped: 1 });
    expect(env.get(qwenEnv)).toBe(wrapper);
    expect(env.has(qoderEnv)).toBe(false);
    expect(readFileSync(plist('qwenworkcn-env'), 'utf8')).toBe('active Pilot plist');
    expect(existsSync(plist('qoderwork-env'))).toBe(false);
    expect(existsSync(wrapper)).toBe(true);

    // Missing active env must still be repaired independently.
    env.delete(qwenEnv);
    expect((await wd.runCheck()).repaired).toBe(1);
    expect(env.get(qwenEnv)).toBe(wrapper);
  });

  it('does not unset third-party runtime paths when cleaning disabled products', async () => {
    for (const key of [qoderEnv, qwenEnv]) env.set(key, '/third-party/runtime.mjs');
    await new HookWatchdog(defaultConfig, [], targets(['qoder-work'])).runCheck();
    expect([...env.values()]).toEqual(['/third-party/runtime.mjs', '/third-party/runtime.mjs']);
    expect(exec.mock.calls.some(([, args]) => args?.[0] === 'unsetenv')).toBe(false);
  });
});

describe('intercept rc target check/repair/cleanup against a temp rc (real closures)', () => {
  // rcPaths is injected (3rd arg) so these exercise the ACTUAL closures the
  // daemon runs — reading/writing real files in a temp dir, no HOME stubbing.
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');

  const SCRIPT = 'claude-code-fetch-intercept.mjs';
  const WRAPPER = 'qodercli-runtime-wrapper.sh';
  const SIG = 'if ! alias claude >/dev/null 2>&1';
  const OLD_BARE_BLOCK = [
    '# loongsuite-pilot BEGIN claude-code-intercept',
    'claude() { BUN_OPTIONS="--preload=/old ${BUN_OPTIONS}" command claude "$@"; }',
    '# loongsuite-pilot END claude-code-intercept',
  ].join('\n');

  let tmp: string;
  let zshrc: string;
  let bashrc: string;

  function claudeTarget(enabled = true) {
    const isEnabled = (id: string) => (id === 'claude-code' ? enabled : true);
    return HookWatchdog
      .defaultInterceptTargets(tmp, isEnabled, [zshrc, bashrc])
      .find(t => t.id === 'claude-code-rc')!;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-rc-real-'));
    fs.mkdirSync(path.join(tmp, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'hooks', SCRIPT), '// stub\n');
    fs.writeFileSync(path.join(tmp, 'hooks', WRAPPER), '# stub\n');
    zshrc = path.join(tmp, '.zshrc');
    bashrc = path.join(tmp, '.bashrc');
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('repair() appends a guarded, eval-deferred block when none exists', async () => {
    fs.writeFileSync(zshrc, '# pre-existing\n');
    fs.writeFileSync(bashrc, '# pre-existing\n');
    const t = claudeTarget();
    expect(await t.check()).toBe(false); // no block yet → needs repair
    await t.repair();

    for (const rcFile of [zshrc, bashrc]) {
      const rc = fs.readFileSync(rcFile, 'utf-8');
      expect(rc).toContain(SIG);
      expect(rc).toContain(`eval 'claude() { BUN_OPTIONS="--preload=`);
      expect(rc).toContain('${BUN_OPTIONS}');
      expect(rc).not.toMatch(/^\s*claude\(\)/m); // no bare def token
    }
    expect(await t.check()).toBe(true); // healthy after repair
  });

  it('check() flags an OLD bare block as stale and repair() migrates it', async () => {
    fs.writeFileSync(zshrc, `# top\n\n${OLD_BARE_BLOCK}\n`);
    const t = claudeTarget();
    expect(await t.check()).toBe(false); // marker present but old shape → stale

    await t.repair();
    const rc = fs.readFileSync(zshrc, 'utf-8');
    expect(rc).not.toContain('claude() { BUN_OPTIONS="--preload=/old'); // old bare gone
    expect(rc).not.toMatch(/^\s*claude\(\)/m);
    expect(rc).toContain(SIG);                       // migrated to guarded block
    expect(rc.match(/BEGIN claude-code-intercept/g)!.length).toBe(1); // exactly one block
    expect(rc).toContain('# top');                   // surrounding content preserved
    expect(await t.check()).toBe(true);
  });

  it('repair() is idempotent — current block is not duplicated', async () => {
    fs.writeFileSync(zshrc, '');
    const t = claudeTarget();
    await t.repair();
    await t.repair();
    const rc = fs.readFileSync(zshrc, 'utf-8');
    expect(rc.match(/BEGIN claude-code-intercept/g)!.length).toBe(1);
  });

  it('cleanup() removes our block (disabled agent) and leaves other content', async () => {
    fs.writeFileSync(zshrc, '# keep-me\n');
    const enabled = claudeTarget(true);
    await enabled.repair(); // install first
    expect(fs.readFileSync(zshrc, 'utf-8')).toContain(SIG);

    const disabled = claudeTarget(false);
    await disabled.cleanup!();
    const rc = fs.readFileSync(zshrc, 'utf-8');
    expect(rc).not.toContain('loongsuite-pilot BEGIN claude-code-intercept');
    expect(rc).not.toContain(SIG);
    expect(rc).toContain('# keep-me'); // unrelated content untouched
  });

  it('cleanup() also removes an OLD bare block', async () => {
    fs.writeFileSync(zshrc, `# keep\n${OLD_BARE_BLOCK}\n`);
    await claudeTarget(false).cleanup!();
    const rc = fs.readFileSync(zshrc, 'utf-8');
    expect(rc).not.toContain('loongsuite-pilot BEGIN claude-code-intercept');
    expect(rc).toContain('# keep');
  });

  it('does not let a current qoderclicn block mask a stale qodercli one', async () => {
    // Both blocks name the same wrapper script, which is qodercli's signature,
    // so a file-wide signature scan would read the stale qodercli block as
    // current and never migrate it.
    const targets = HookWatchdog.defaultInterceptTargets(tmp, () => true, [zshrc]);
    const cliTarget = targets.find(t => t.id === 'qodercli-rc')!;
    const cnTarget = targets.find(t => t.id === 'qoderclicn-rc')!;

    fs.writeFileSync(zshrc, '');
    await cnTarget.repair();                       // current CN block present
    expect(await cnTarget.check()).toBe(true);
    fs.appendFileSync(zshrc, [
      '# loongsuite-pilot BEGIN qodercli-intercept',
      'qodercli() { BUN_OPTIONS="--preload=/old ${BUN_OPTIONS}" command qodercli "$@"; }',
      '# loongsuite-pilot END qodercli-intercept',
      '',
    ].join('\n'));

    expect(await cliTarget.check()).toBe(false);   // stale, despite the CN block
    await cliTarget.repair();
    const rc = fs.readFileSync(zshrc, 'utf-8');
    expect(rc).not.toContain('--preload=/old');    // old bare form migrated
    expect(rc.match(/BEGIN qodercli-intercept/g)!.length).toBe(1);
    expect(rc.match(/BEGIN qoderclicn-intercept/g)!.length).toBe(1); // CN untouched
    expect(await cliTarget.check()).toBe(true);
    expect(await cnTarget.check()).toBe(true);
  });

  it('treats a qodercli block that lost its END marker as unhealthy', async () => {
    // A partial write or a hand edit can drop the END marker. Extraction used to
    // run to EOF, so the damaged block absorbed everything below it; its own
    // current-shape body then satisfied the signature check and check() reported
    // healthy forever. Worse, had it reported unhealthy, repair()'s strip would
    // have cut to EOF and taken the CN block and the user's own lines with it.
    const targets = HookWatchdog.defaultInterceptTargets(tmp, () => true, [zshrc]);
    const cliTarget = targets.find(t => t.id === 'qodercli-rc')!;
    const cnTarget = targets.find(t => t.id === 'qoderclicn-rc')!;

    fs.writeFileSync(zshrc, '');
    await cnTarget.repair();
    const cnBlock = fs.readFileSync(zshrc, 'utf-8').trim();
    // Installer order puts qodercli first, so the CN block sits below it.
    fs.writeFileSync(zshrc, [
      '# user-top',
      '# loongsuite-pilot BEGIN qodercli-intercept',
      `  eval 'qodercli() { "/tmp/pilot/hooks/qodercli-runtime-wrapper.sh" "$@"; }'`,
      // END marker deliberately absent.
      cnBlock,
      'export PATH=/user/bin:$PATH',
      '',
    ].join('\n'));

    expect(await cliTarget.check()).toBe(false);
    expect(await cnTarget.check()).toBe(true); // the CN block reads as current

    await cliTarget.repair();
    const rc = fs.readFileSync(zshrc, 'utf-8');
    expect(rc.match(/BEGIN qodercli-intercept/g)!.length).toBe(1); // rewritten once
    expect(rc.match(/END qodercli-intercept/g)!.length).toBe(1);   // now terminated
    expect(rc.match(/BEGIN qoderclicn-intercept/g)!.length).toBe(1);
    expect(rc).toContain('LOONGSUITE_QODERCLI_FLAVOR=qoderclicn'); // CN body intact
    expect(rc).toContain('# user-top');
    expect(rc).toContain('export PATH=/user/bin:$PATH');           // user tail intact
    expect(await cliTarget.check()).toBe(true);
    expect(await cnTarget.check()).toBe(true);
  });

  it('keeps the two wrapper flavors independent in one rc file', async () => {
    const targets = HookWatchdog.defaultInterceptTargets(tmp, () => true, [zshrc]);
    const cliTarget = targets.find(t => t.id === 'qodercli-rc')!;
    const cnTarget = targets.find(t => t.id === 'qoderclicn-rc')!;

    fs.writeFileSync(zshrc, '');
    await cliTarget.repair();
    // The CN block is absent even though qodercli's marker prefix is similar.
    expect(await cnTarget.check()).toBe(false);
    await cnTarget.repair();

    const rc = fs.readFileSync(zshrc, 'utf-8');
    expect(rc).toContain("eval 'qodercli() { \"");                       // no flavor var
    expect(rc).toContain('LOONGSUITE_QODERCLI_FLAVOR=qoderclicn');
    expect(rc.match(/BEGIN qodercli-intercept/g)!.length).toBe(1);
    expect(rc.match(/BEGIN qoderclicn-intercept/g)!.length).toBe(1);

    // Disabling one flavor must not strip the other's block.
    const cnDisabled = HookWatchdog
      .defaultInterceptTargets(tmp, id => id !== 'qoder-cn', [zshrc])
      .find(t => t.id === 'qoderclicn-rc')!;
    await cnDisabled.cleanup!();
    const after = fs.readFileSync(zshrc, 'utf-8');
    expect(after).not.toContain('qoderclicn-intercept');
    expect(after).toContain('BEGIN qodercli-intercept');
  });

  it('disabled target: runCheck() runs cleanup() and does not re-inject', async () => {
    fs.writeFileSync(zshrc, '');
    await claudeTarget(true).repair(); // block present
    expect(fs.readFileSync(zshrc, 'utf-8')).toContain(SIG);

    const wd = new HookWatchdog(defaultConfig, [], [claudeTarget(false)]);
    const result = await wd.runCheck();
    expect(result.skipped).toBe(1);
    expect(fs.readFileSync(zshrc, 'utf-8')).not.toContain(SIG); // cleaned, not re-injected
  });
});

describe('stripMarkerBlock', () => {
  const BEGIN = 'loongsuite-pilot BEGIN claude-code-intercept';
  const END = 'loongsuite-pilot END claude-code-intercept';

  it('removes the marker-delimited block inclusive of the marker lines', () => {
    const content = [
      'export PATH=/x:$PATH',
      '# loongsuite-pilot BEGIN claude-code-intercept',
      'claude() { echo old; }',
      '# loongsuite-pilot END claude-code-intercept',
      'alias ll=ls',
    ].join('\n');
    const out = stripMarkerBlock(content, BEGIN, END);
    expect(out).not.toContain('claude() { echo old; }');
    expect(out).not.toContain(BEGIN);
    expect(out).not.toContain(END);
    expect(out).toContain('export PATH=/x:$PATH');
    expect(out).toContain('alias ll=ls');
  });

  it('is a no-op when the markers are absent', () => {
    const content = 'export A=1\nalias ll=ls\n';
    expect(stripMarkerBlock(content, BEGIN, END)).toBe(content);
  });

  it('handles a multi-line (new-shape) block', () => {
    const content = [
      'before',
      '# loongsuite-pilot BEGIN claude-code-intercept',
      'if ! alias claude >/dev/null 2>&1 && ! typeset -f claude >/dev/null 2>&1; then',
      "  eval 'claude() { :; }'",
      'fi',
      '# loongsuite-pilot END claude-code-intercept',
      'after',
    ].join('\n');
    const out = stripMarkerBlock(content, BEGIN, END);
    expect(out.split('\n')).toEqual(['before', 'after']);
  });

  it('an unterminated block does not swallow the next block or user content', () => {
    // repair() writes this result back over the rc file, so cutting to EOF here
    // deletes the sibling blocks and whatever the user keeps below them.
    const content = [
      'export PATH=/x:$PATH',
      '# loongsuite-pilot BEGIN claude-code-intercept',
      'claude() { echo old; }',
      // END marker deliberately absent.
      '# loongsuite-pilot BEGIN qodercli-intercept',
      "  eval 'qodercli() { :; }'",
      '# loongsuite-pilot END qodercli-intercept',
      'alias ll=ls',
    ].join('\n');
    const out = stripMarkerBlock(content, BEGIN, END);
    expect(out).not.toContain('claude() { echo old; }');  // damaged block removed
    expect(out).toContain('BEGIN qodercli-intercept');    // sibling block survives
    expect(out).toContain("eval 'qodercli() { :; }");
    expect(out).toContain('export PATH=/x:$PATH');        // user content survives
    expect(out).toContain('alias ll=ls');
  });

  it('collapses repeated BEGINs of the same block into one removal', () => {
    const content = [
      'before',
      '# loongsuite-pilot BEGIN claude-code-intercept',
      'first',
      '# loongsuite-pilot BEGIN claude-code-intercept',
      'second',
      '# loongsuite-pilot END claude-code-intercept',
      'after',
    ].join('\n');
    expect(stripMarkerBlock(content, BEGIN, END).split('\n')).toEqual(['before', 'after']);
  });
});

describe('extractMarkerBlock', () => {
  const BEGIN = 'loongsuite-pilot BEGIN claude-code-intercept';
  const END = 'loongsuite-pilot END claude-code-intercept';

  it('returns null when the BEGIN marker is absent', () => {
    expect(extractMarkerBlock('a\nb\n', BEGIN, END)).toBeNull();
  });

  it('returns only the block, excluding surrounding content', () => {
    const content = ['before', BEGIN, 'body', END, 'after'].join('\n');
    expect(extractMarkerBlock(content, BEGIN, END)).toEqual({
      text: [BEGIN, 'body', END].join('\n'),
      terminated: true,
    });
  });

  it('reports an unterminated block and returns its tail', () => {
    const content = ['before', BEGIN, 'body'].join('\n');
    expect(extractMarkerBlock(content, BEGIN, END)).toEqual({
      text: [BEGIN, 'body'].join('\n'),
      terminated: false,
    });
  });

  it('stops an unterminated block at the next block BEGIN, not at EOF', () => {
    // Running to EOF pulled the following block into this one's text, which is
    // how a neighbour could end up satisfying this block's signature check.
    const content = [
      'before',
      BEGIN,
      'body',
      '# loongsuite-pilot BEGIN qoderclicn-intercept',
      'cn body',
      '# loongsuite-pilot END qoderclicn-intercept',
    ].join('\n');
    expect(extractMarkerBlock(content, BEGIN, END)).toEqual({
      text: [BEGIN, 'body'].join('\n'),
      terminated: false,
    });
  });
});

describe('interceptRcBlockDefs migration metadata', () => {
  it('exposes signature + endMarker matching the block body', () => {
    for (const def of HookWatchdog.interceptRcBlockDefs()) {
      const block = def.blockFn(`/tmp/hooks/${def.scriptName}`);
      expect(block).toContain(def.marker);       // BEGIN marker present
      expect(block).toContain(def.endMarker);    // END marker present
      expect(block).toContain(def.signature);    // current-shape signature present
    }
  });

  it('keeps markers mutually non-overlapping so per-block scoping is unambiguous', () => {
    const defs = HookWatchdog.interceptRcBlockDefs();
    for (const a of defs) {
      for (const b of defs) {
        if (a.id === b.id) continue;
        // extractMarkerBlock matches a marker as a substring of a line, so one
        // marker containing another would make the two blocks indistinguishable.
        expect(a.marker.includes(b.marker)).toBe(false);
        expect(a.endMarker.includes(b.endMarker)).toBe(false);
      }
    }
  });

  it('gives every block a signature no other block can satisfy', () => {
    // A signature that also occurs in a sibling block would let that sibling
    // vouch for a stale block of this shape. Per-block scoping is the other half
    // of the defence; neither half should be load-bearing on its own.
    const defs = HookWatchdog.interceptRcBlockDefs();
    for (const a of defs) {
      for (const b of defs) {
        if (a.id === b.id) continue;
        expect(b.blockFn(`/tmp/hooks/${b.scriptName}`)).not.toContain(a.signature);
      }
    }
  });

  it('keeps the shared wrapper script name out of both flavors\' signatures', () => {
    const defs = HookWatchdog.interceptRcBlockDefs();
    const cli = defs.find(d => d.id === 'qodercli-rc')!;
    const cn = defs.find(d => d.id === 'qoderclicn-rc')!;
    expect(cn.scriptName).toBe(cli.scriptName); // one wrapper serves both
    expect(cli.signature).not.toContain(cli.scriptName);
    expect(cn.signature).not.toContain(cn.scriptName);
  });

  it('exposes cleanup() on every default intercept target', () => {
    const targets = HookWatchdog.defaultInterceptTargets('/tmp/test-pilot');
    for (const t of targets) {
      expect(typeof t.cleanup).toBe('function');
    }
  });
});

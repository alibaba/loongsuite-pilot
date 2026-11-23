import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

const logger = vi.hoisted(() => ({
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => logger,
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

  it('retires both legacy macOS runtime env/plist pairs', () => {
    expect(HookWatchdog.macRetiredRuntimeInterceptDefs()).toEqual([
      {
        id: 'qoderwork-env',
        envName: 'QODER_WORKER_RUNTIME_PATH',
        plistLabel: 'com.loongsuite-pilot.qoderwork-env',
      },
      {
        id: 'qwenworkcn-env',
        envName: 'QW_QODER_WORKER_RUNTIME_PATH',
        plistLabel: 'com.loongsuite-pilot.qwenworkcn-env',
      },
    ]);
  });

  it('retires both legacy Windows runtime env vars', () => {
    expect(HookWatchdog.winRetiredRuntimeInterceptDefs()).toEqual([
      { id: 'qoderwork-win-env', envName: 'QODER_WORKER_RUNTIME_PATH' },
      { id: 'qwenworkcn-win-env', envName: 'QW_QODER_WORKER_RUNTIME_PATH' },
    ]);
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

  it('wires the isAgentEnabled gate only to shell intercepts', () => {
    const isEnabled = vi.fn((id: string) => id === 'qoder-cn');
    const targets = HookWatchdog.defaultInterceptTargets('/tmp/test-pilot', isEnabled);
    const byId = Object.fromEntries(targets.map(t => [t.id, t]));

    expect(byId['claude-code-rc'].enabled?.()).toBe(false);
    expect(byId['qodercli-rc'].enabled?.()).toBe(false);
    expect(byId['qoderclicn-rc'].enabled?.()).toBe(true);
    expect(isEnabled.mock.calls.map(([id]) => id)).toEqual(['claude-code', 'qoder', 'qoder-cn']);
  });
});

describe.each(['darwin', 'win32'] as const)('%s retired runtime intercept lifecycle (mock exec and temporary HOME)', platformName => {
  const exec = vi.mocked(promisify(execFile));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const defs = platformName === 'darwin'
    ? HookWatchdog.macRetiredRuntimeInterceptDefs()
    : HookWatchdog.winRetiredRuntimeInterceptDefs();
  const allAgents = ['qoder-work', 'qoder-work-cn', 'qwen-work-cn'];
  let tmp: string;
  let dataDir: string;
  let wrapper: string;
  let env: Map<string, string>;

  function plist(id: string): string {
    return join(tmp, 'Library', 'LaunchAgents', `com.loongsuite-pilot.${id}.plist`);
  }

  function targets(isEnabled?: (id: string) => boolean) {
    return HookWatchdog.defaultInterceptTargets(dataDir, isEnabled, [])
      .filter(t => t.id.endsWith('-env'));
  }

  function installFixtures() {
    mkdirSync(join(dataDir, 'hooks'), { recursive: true });
    writeFileSync(wrapper, '// shared wrapper\n');
    for (const app of ['QoderWork', 'QoderWorkCN', 'QwenWorkCN']) {
      const appPath = platformName === 'darwin'
        ? join(tmp, 'Applications', `${app}.app`)
        : join(tmp, 'AppData', 'Local', 'Programs', app);
      mkdirSync(appPath, { recursive: true });
    }
  }

  function seedOwnedOverrides() {
    for (const def of defs) {
      env.set(def.envName, wrapper);
      if (platformName === 'darwin') writeFileSync(plist(def.id), 'legacy Pilot plist');
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tmp = mkdtempSync(join(os.tmpdir(), 'runtime-intercept-'));
    dataDir = join(tmp, 'custom data'); // No loongsuite-pilot substring.
    wrapper = join(dataDir, 'hooks', 'qoderwork-runtime-wrapper.mjs');
    env = new Map();
    mkdirSync(join(tmp, 'Library', 'LaunchAgents'), { recursive: true });
    vi.stubEnv('HOME', tmp);
    vi.stubEnv('USERPROFILE', tmp);
    vi.stubEnv('LOCALAPPDATA', join(tmp, 'AppData', 'Local'));
    vi.mocked(os.homedir).mockReturnValue(tmp);
    vi.spyOn(fsUtils, 'directoryExists').mockImplementation(async p =>
      p.startsWith(`${tmp}/`) && existsSync(p));
    Object.defineProperty(process, 'platform', { ...platform, value: platformName });
    exec.mockReset();
    exec.mockImplementation(async (command, args, options) => {
      const argv = args as string[];
      if (platformName === 'darwin') {
        expect(command).toBe('launchctl');
        const [op, key] = argv;
        if (op === 'getenv') {
          if (!env.has(key)) throw new Error('environment variable is unset');
          return { stdout: `${env.get(key)}\n`, stderr: '' };
        }
        if (op === 'unsetenv') env.delete(key);
        else {
          expect(op).toBe('unload');
          expect(key.startsWith(`${tmp}/`)).toBe(true);
        }
      } else if (command === 'reg.exe') {
        const [op, registryKey, flag, key] = argv;
        expect(registryKey).toBe('HKCU\\Environment');
        expect(flag).toBe('/v');
        if (op === 'query') {
          if (!env.has(key)) throw new Error('registry value is absent');
          return { stdout: `    ${key}    REG_SZ    ${env.get(key)}\r\n`, stderr: '' };
        }
        expect(op).toBe('delete');
        expect(argv[4]).toBe('/f');
        env.delete(key);
      } else {
        expect(command).toBe('powershell.exe');
        expect(argv.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
        expect(argv[3]).toContain("SetEnvironmentVariable($env:LOONGSUITE_PILOT_RUNTIME_ENV_NAME, $null, 'User')");
        const key = options?.env?.LOONGSUITE_PILOT_RUNTIME_ENV_NAME;
        expect(defs.map(d => d.envName)).toContain(key);
        expect(env.has(key!)).toBe(false);
      }
      return { stdout: '', stderr: '' };
    });
  });

  afterEach(async () => {
    const calls = exec.mock.calls.slice();
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    const actualOs = await vi.importActual<typeof import('node:os')>('node:os');
    vi.mocked(os.homedir).mockImplementation(actualOs.homedir);
    exec.mockReset();
    rmSync(tmp, { recursive: true, force: true });
    expect(calls.filter(([, args]) => ['setenv', 'load', 'add'].includes(args?.[0] as string))).toEqual([]);
  });

  it.each([
    ['default-enabled agents', undefined],
    ['all agents disabled', []],
    ['qoder-work only', ['qoder-work']],
    ['qoder-work-cn only', ['qoder-work-cn']],
    ['qwen-work-cn only', ['qwen-work-cn']],
    ['all three products enabled', allAgents],
  ] as [string, string[] | undefined][])('cleans both legacy overrides idempotently with %s', async (_label, enabled) => {
    installFixtures();
    seedOwnedOverrides();
    const gate = enabled && vi.fn((id: string) => enabled.includes(id));
    const envTargets = targets(gate);
    expect(envTargets.map(t => t.id)).toEqual(defs.map(d => d.id));
    for (const target of envTargets) {
      expect(target.enabled!()).toBe(false);
      vi.spyOn(target, 'precondition');
      vi.spyOn(target, 'check');
      vi.spyOn(target, 'repair');
      vi.spyOn(target, 'cleanup');
    }
    const wd = new HookWatchdog(defaultConfig, [], envTargets);

    expect(await wd.runCheck()).toEqual({ checked: 0, repaired: 0, skipped: 2 });
    expect(await wd.runCheck()).toEqual({ checked: 0, repaired: 0, skipped: 2 });
    for (const target of envTargets) {
      expect(target.precondition).not.toHaveBeenCalled();
      expect(target.check).not.toHaveBeenCalled();
      expect(target.repair).not.toHaveBeenCalled();
      expect(target.cleanup).toHaveBeenCalledTimes(2);
    }
    if (gate) expect(gate).not.toHaveBeenCalled();
    expect(fsUtils.directoryExists).not.toHaveBeenCalled();
    expect(env.size).toBe(0);
    expect(readFileSync(wrapper, 'utf8')).toBe('// shared wrapper\n');
    for (const def of defs) {
      if (platformName === 'darwin') {
        expect(existsSync(plist(def.id))).toBe(false);
        expect(exec).toHaveBeenCalledWith('launchctl', ['unsetenv', def.envName]);
        expect(exec).toHaveBeenCalledWith('launchctl', ['unload', plist(def.id)]);
      } else {
        expect(exec).toHaveBeenCalledWith('reg.exe', [
          'delete', 'HKCU\\Environment', '/v', def.envName, '/f',
        ], { timeout: 10_000, windowsHide: true });
        expect(exec).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.objectContaining({
          timeout: 10_000,
          windowsHide: true,
          env: expect.objectContaining({ LOONGSUITE_PILOT_RUNTIME_ENV_NAME: def.envName }),
        }));
      }
    }
    expect(exec.mock.calls.map(([command, args]) => `${command}:${args?.[0]}`)).toEqual(
      platformName === 'darwin'
        ? ['launchctl:getenv', 'launchctl:unsetenv', 'launchctl:unload',
          'launchctl:getenv', 'launchctl:unsetenv', 'launchctl:unload', 'launchctl:getenv', 'launchctl:getenv']
        : ['reg.exe:query', 'reg.exe:delete', 'powershell.exe:-NoProfile',
          'reg.exe:query', 'reg.exe:delete', 'powershell.exe:-NoProfile', 'reg.exe:query', 'reg.exe:query'],
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('never injects on a fresh install even with all three products enabled and present', async () => {
    installFixtures();
    const wd = new HookWatchdog(defaultConfig, [], targets(id => allAgents.includes(id)));
    expect(await wd.runCheck()).toEqual({ checked: 0, repaired: 0, skipped: 2 });
    expect(await wd.runCheck()).toEqual({ checked: 0, repaired: 0, skipped: 2 });
    expect(env.size).toBe(0);
    expect(exec).toHaveBeenCalledTimes(4);
    for (const def of defs) expect(existsSync(plist(def.id))).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('cleans missing-wrapper leftovers under a custom dataDir without checking app installation', async () => {
    seedOwnedOverrides();
    const wd = new HookWatchdog(defaultConfig, [], targets(() => true));
    expect(await wd.runCheck()).toEqual({ checked: 0, repaired: 0, skipped: 2 });
    expect(await wd.runCheck()).toEqual({ checked: 0, repaired: 0, skipped: 2 });
    expect(env.size).toBe(0);
    expect(existsSync(dataDir)).toBe(false);
    for (const def of defs) expect(existsSync(plist(def.id))).toBe(false);
    expect(fsUtils.directoryExists).not.toHaveBeenCalled();
  });

  it.each(['vendor', 'same-basename', 'suffix'])('preserves third-party %s paths, unrelated env and plists', async variant => {
    const foreign = variant === 'vendor' ? join(tmp, 'third-party', 'runtime.mjs')
      : variant === 'same-basename' ? join(tmp, 'loongsuite-pilot-other', 'hooks', 'qoderwork-runtime-wrapper.mjs')
        : `${wrapper}.backup`;
    for (const def of defs) env.set(def.envName, foreign);
    env.set('UNRELATED_RUNTIME_PATH', wrapper);
    const originalEnv = new Map(env);
    const thirdPartyPlist = join(tmp, 'Library', 'LaunchAgents', 'com.third-party.runtime.plist');
    writeFileSync(thirdPartyPlist, 'third-party plist');
    const nearMatchPlist = `${plist('qwenworkcn-env')}.backup`;
    writeFileSync(nearMatchPlist, 'user backup');
    if (platformName === 'darwin') {
      for (const def of defs) writeFileSync(plist(def.id), 'legacy Pilot plist');
    }
    const wd = new HookWatchdog(defaultConfig, [], targets(() => true));
    await wd.runCheck();
    await wd.runCheck();
    expect(env).toEqual(originalEnv);
    expect(readFileSync(thirdPartyPlist, 'utf8')).toBe('third-party plist');
    expect(readFileSync(nearMatchPlist, 'utf8')).toBe('user backup');
    expect(exec.mock.calls.filter(([cmd, args]) =>
      cmd === 'powershell.exe' || ['unsetenv', 'delete'].includes(args?.[0] as string))).toEqual([]);
    for (const def of defs) expect(existsSync(plist(def.id))).toBe(false);
  });

  it('keeps the existing platform-specific ownership case comparison', async () => {
    for (const def of defs) env.set(def.envName, wrapper.toUpperCase());
    await new HookWatchdog(defaultConfig, [], targets()).runCheck();
    expect(env.size).toBe(platformName === 'win32' ? 0 : 2);
  });

  if (platformName === 'darwin') {
    it('unloads and removes both Pilot plists even when getenv fails and the wrapper is missing', async () => {
      for (const def of defs) writeFileSync(plist(def.id), 'legacy Pilot plist');
      await new HookWatchdog(defaultConfig, [], targets()).runCheck();
      for (const def of defs) {
        expect(existsSync(plist(def.id))).toBe(false);
        expect(exec).toHaveBeenCalledWith('launchctl', ['unload', plist(def.id)]);
      }
      expect(exec.mock.calls.some(([, args]) => args?.[0] === 'unsetenv')).toBe(false);
    });
  } else {
    it('reports a failed registry deletion, continues other cleanup, and retries next cycle', async () => {
      seedOwnedOverrides();
      const implementation = exec.getMockImplementation()!;
      let failDelete = true;
      exec.mockImplementation(async (...args) => {
        if (args[0] === 'reg.exe' && args[1]?.[0] === 'delete' && args[1]?.[3] === defs[0].envName && failDelete) {
          failDelete = false;
          throw new Error('access denied');
        }
        return implementation(...args);
      });
      const wd = new HookWatchdog(defaultConfig, [], targets());
      expect(await wd.runCheck()).toEqual({ checked: 0, repaired: 0, skipped: 2 });
      expect(env.has(defs[0].envName)).toBe(true);
      expect(env.has(defs[1].envName)).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith('intercept-watchdog.cleanup-failed', {
        id: defs[0].id, error: 'Error: access denied',
      });
      expect(exec.mock.calls.filter(([cmd]) => cmd === 'powershell.exe')).toHaveLength(1);
      await wd.runCheck();
      expect(env.size).toBe(0);
      expect(exec.mock.calls.filter(([cmd]) => cmd === 'powershell.exe')).toHaveLength(2);
    });

    it('keeps registry deletions when broadcasts fail and reports the recovery action', async () => {
      seedOwnedOverrides();
      const implementation = exec.getMockImplementation()!;
      exec.mockImplementation(async (...args) => {
        if (args[0] === 'powershell.exe') throw new Error('PowerShell unavailable');
        return implementation(...args);
      });
      const wd = new HookWatchdog(defaultConfig, [], targets());
      expect(await wd.runCheck()).toEqual({ checked: 0, repaired: 0, skipped: 2 });
      expect(env.size).toBe(0);
      for (const def of defs) {
        expect(logger.warn).toHaveBeenCalledWith('windows runtime environment persisted but broadcast failed', {
          envName: def.envName, action: 'sign out and back in to refresh Explorer',
        });
      }
      await wd.runCheck();
      expect(exec.mock.calls.filter(([cmd]) => cmd === 'powershell.exe')).toHaveLength(2);
    });
  }
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

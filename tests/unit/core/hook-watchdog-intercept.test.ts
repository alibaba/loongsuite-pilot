import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HookWatchdog,
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
  execFile: vi.fn(),
}));

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
    expect(targets.length).toBeGreaterThanOrEqual(2); // at least rc targets; qoderwork-env only on macOS
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
      expect(ids).toContain('qoderwork-env');
    }
  });
});

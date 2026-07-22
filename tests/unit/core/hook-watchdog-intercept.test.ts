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

  it('defaults every target to enabled when no gate is passed', () => {
    const targets = HookWatchdog.defaultInterceptTargets('/tmp/test-pilot');
    for (const t of targets) {
      // enabled is optional; when present it must report true under the default gate
      expect(t.enabled?.() ?? true).toBe(true);
    }
  });

  it('wires the isAgentEnabled gate to the right agent id per target', () => {
    const disabled = new Set(['claude-code', 'qoder', 'qoder-work']);
    const targets = HookWatchdog.defaultInterceptTargets(
      '/tmp/test-pilot',
      (id) => !disabled.has(id),
    );
    const byId = Object.fromEntries(targets.map(t => [t.id, t]));

    expect(byId['claude-code-rc'].enabled?.()).toBe(false); // → claude-code
    expect(byId['qodercli-rc'].enabled?.()).toBe(false);    // → qoder
    if (process.platform === 'darwin') {
      expect(byId['qoderwork-env'].enabled?.()).toBe(false); // → qoder-work
    }
  });
});

describe('intercept rc block is parse-safe and non-clobbering', () => {
  // Render the rc block the way repair() would, into a temp rc file, without
  // touching the real HOME. defaultInterceptTargets(dataDir) uses os.homedir()
  // for rcPaths, which is awkward to stub across the ESM boundary; instead we
  // point HOME at a temp dir up-front and assert the block via a fresh
  // fs-backed write driven by the same rcTargets definitions the watchdog uses.
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');

  it('claude-code-rc / qodercli-rc repair writes a guarded, eval-deferred block', async () => {
    const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pilot-rc-'));
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      fs.mkdirSync(path.join(tmpHome, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(tmpHome, 'hooks', 'claude-code-fetch-intercept.mjs'), '// stub\n');
      fs.writeFileSync(path.join(tmpHome, 'hooks', 'qodercli-token-intercept.mjs'), '// stub\n');
      fs.writeFileSync(path.join(tmpHome, '.zshrc'), '# pre-existing\n');

      const targets = HookWatchdog.defaultInterceptTargets(tmpHome);
      const homeMatches = require('node:os').homedir() === tmpHome;
      // Only meaningful when os.homedir() honors HOME (POSIX). Skip on platforms
      // where it doesn't, rather than risk writing to the real rc.
      if (!homeMatches) return;

      for (const id of ['claude-code-rc', 'qodercli-rc']) {
        const target = targets.find(t => t.id === id)!;
        if (await target.check()) continue; // marker somehow already present
        await target.repair();
      }
      const rc = fs.readFileSync(path.join(tmpHome, '.zshrc'), 'utf-8');

      expect(rc).toContain('if ! alias claude >/dev/null 2>&1 && ! typeset -f claude >/dev/null 2>&1; then');
      expect(rc).toContain(`eval 'claude() { BUN_OPTIONS="--preload=`);
      expect(rc).toContain('${BUN_OPTIONS}'); // preserve user's existing BUN_OPTIONS at call time
      expect(rc).not.toMatch(/^\s*claude\(\)/m); // no bare, unguarded def token
      expect(rc).toContain('if ! alias qodercli >/dev/null 2>&1 && ! typeset -f qodercli >/dev/null 2>&1; then');
      expect(rc).toContain(`eval 'qodercli() { BUN_OPTIONS="--preload=`);
      expect(rc).not.toMatch(/^\s*qodercli\(\)/m);
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

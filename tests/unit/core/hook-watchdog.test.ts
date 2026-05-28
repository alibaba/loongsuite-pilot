import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import {
  HookWatchdog,
  type PluginCheckTarget,
} from '../../../src/core/hook-watchdog.js';
import type { HookWatchdogConfig } from '../../../src/types/index.js';

// Mock logger to silence output and allow assertions
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock child_process.spawn so tests don't actually run external commands.
// Each spawn call is recorded; behavior is controlled via `spawnBehavior`.
let spawnCalls: { cmd: string; args: string[] }[] = [];
type Behavior = 'success' | 'fail' | 'error' | 'timeout';
let spawnBehavior: Behavior = 'success';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      const child = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter | null;
        kill: (sig: string) => void;
      };
      child.stderr = new EventEmitter();
      child.kill = vi.fn();

      // Schedule async event emission
      setImmediate(() => {
        if (spawnBehavior === 'success') {
          child.emit('exit', 0);
        } else if (spawnBehavior === 'fail') {
          child.stderr?.emit('data', Buffer.from('fake error'));
          child.emit('exit', 1);
        } else if (spawnBehavior === 'error') {
          child.emit('error', new Error('spawn ENOENT'));
        }
        // 'timeout' = no event emitted; relies on watchdog's REPAIR_TIMEOUT_MS
      });

      return child as any;
    }),
  };
});

function makeConfig(overrides: Partial<HookWatchdogConfig> = {}): HookWatchdogConfig {
  return {
    enabled: true,
    intervalMs: 60_000,
    repairCooldownMs: 600_000,
    ...overrides,
  };
}

async function writeSettings(p: string, content: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(content, null, 2), 'utf-8');
}

async function makeBin(binPath: string): Promise<void> {
  await fs.mkdir(path.dirname(binPath), { recursive: true });
  await fs.writeFile(binPath, '#!/usr/bin/env node\n', { mode: 0o755 });
}

function makeClaudeTarget(tmpDir: string, overrides: Partial<PluginCheckTarget> = {}): PluginCheckTarget {
  return {
    agentId: 'claude-code',
    settingsPath: path.join(tmpDir, '.claude', 'settings.json'),
    expectedHooks: [
      'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
      'PreCompact', 'SubagentStart', 'SubagentStop', 'Notification',
    ],
    binPath: path.join(tmpDir, '.cache', 'package', 'bin', 'otel-claude-hook'),
    installArgs: ['install', '--user', '--no-alias', '--quiet'],
    markers: ['otel-claude-hook', 'hook-entry.sh'],
    ...overrides,
  };
}

function buildHealthySettings(target: PluginCheckTarget): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const evt of target.expectedHooks) {
    hooks[evt] = [
      { matcher: '*', hooks: [{ type: 'command', command: `bash /path/to/${target.markers[0]}` }] },
    ];
  }
  return { hooks };
}

describe('HookWatchdog', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir('hook-watchdog-test-');
    spawnCalls = [];
    spawnBehavior = 'success';
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  describe('checkTarget — healthy', () => {
    it('reports healthy when all expected hooks present (no repair)', async () => {
      const target = makeClaudeTarget(tmpDir);
      await makeBin(target.binPath);
      await writeSettings(target.settingsPath, buildHealthySettings(target));

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary.checked).toBe(1);
      expect(summary.repaired).toBe(0);
      expect(spawnCalls).toHaveLength(0);
    });
  });

  describe('checkTarget — missing', () => {
    it('triggers repair when at least one hook is missing', async () => {
      const target = makeClaudeTarget(tmpDir);
      await makeBin(target.binPath);

      // Healthy except 'Stop' is missing
      const settings = buildHealthySettings(target);
      delete (settings.hooks as Record<string, unknown>).Stop;
      await writeSettings(target.settingsPath, settings);

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary.repaired).toBe(1);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].cmd).toBe(process.execPath);
      expect(spawnCalls[0].args[0]).toBe(target.binPath);
      expect(spawnCalls[0].args.slice(1)).toEqual(target.installArgs);
    });

    it('treats event with empty array as missing', async () => {
      const target = makeClaudeTarget(tmpDir);
      await makeBin(target.binPath);

      const settings = buildHealthySettings(target);
      (settings.hooks as Record<string, unknown>).PreToolUse = []; // empty array
      await writeSettings(target.settingsPath, settings);

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary.repaired).toBe(1);
    });

    it('treats event with only foreign hooks as missing', async () => {
      const target = makeClaudeTarget(tmpDir);
      await makeBin(target.binPath);

      const settings = buildHealthySettings(target);
      (settings.hooks as Record<string, unknown>).UserPromptSubmit = [
        { type: 'command', command: 'bash /some/other/tool.sh' },
      ];
      await writeSettings(target.settingsPath, settings);

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary.repaired).toBe(1);
    });
  });

  describe('cooldown', () => {
    it('skips repair within cooldown window', async () => {
      const target = makeClaudeTarget(tmpDir);
      await makeBin(target.binPath);
      const settings = buildHealthySettings(target);
      delete (settings.hooks as Record<string, unknown>).Stop;
      await writeSettings(target.settingsPath, settings);

      const wd = new HookWatchdog(
        makeConfig({ repairCooldownMs: 60_000_000 }),
        [target],
      );

      // First check repairs
      const r1 = await wd.runCheck();
      expect(r1.repaired).toBe(1);
      expect(spawnCalls).toHaveLength(1);

      // Second check within cooldown window — should skip repair
      const r2 = await wd.runCheck();
      expect(r2.repaired).toBe(0);
      // checked stays 0 because cooldown returns 'cooldown' status, not 'healthy'
      expect(spawnCalls).toHaveLength(1);
    });
  });

  describe('unavailable', () => {
    it('skips when bin does not exist', async () => {
      const target = makeClaudeTarget(tmpDir);
      // No bin written
      await writeSettings(target.settingsPath, buildHealthySettings(target));

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary.skipped).toBe(1);
      expect(spawnCalls).toHaveLength(0);
    });

    it('skips when settings parent dir does not exist', async () => {
      const target = makeClaudeTarget(tmpDir, {
        settingsPath: path.join(tmpDir, 'nonexistent', 'settings.json'),
      });
      await makeBin(target.binPath);
      // No settings dir created

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary.skipped).toBe(1);
      expect(spawnCalls).toHaveLength(0);
    });

    it('treats absent settings.json as missing all hooks (and repairs if dir exists)', async () => {
      const target = makeClaudeTarget(tmpDir);
      await makeBin(target.binPath);
      // settings.json doesn't exist but its parent dir does
      await fs.mkdir(path.dirname(target.settingsPath), { recursive: true });

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary.repaired).toBe(1);
      expect(spawnCalls).toHaveLength(1);
    });
  });

  describe('repair failure', () => {
    it('does not throw when spawn exits non-zero', async () => {
      const target = makeClaudeTarget(tmpDir);
      await makeBin(target.binPath);
      const settings = buildHealthySettings(target);
      delete (settings.hooks as Record<string, unknown>).Stop;
      await writeSettings(target.settingsPath, settings);

      spawnBehavior = 'fail';
      const wd = new HookWatchdog(makeConfig(), [target]);
      await expect(wd.runCheck()).resolves.toBeDefined();
    });

    it('does not throw when spawn errors', async () => {
      const target = makeClaudeTarget(tmpDir);
      await makeBin(target.binPath);
      const settings = buildHealthySettings(target);
      delete (settings.hooks as Record<string, unknown>).Stop;
      await writeSettings(target.settingsPath, settings);

      spawnBehavior = 'error';
      const wd = new HookWatchdog(makeConfig(), [target]);
      await expect(wd.runCheck()).resolves.toBeDefined();
    });
  });

  describe('start/stop', () => {
    it('does not arm timer when disabled', () => {
      vi.useFakeTimers();
      try {
        const wd = new HookWatchdog(makeConfig({ enabled: false }), []);
        wd.start();
        // Advance past startup delay; no timer should have been set.
        vi.advanceTimersByTime(60_000);
        expect(spawnCalls).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('arms timer when enabled and runs check after startup delay', () => {
      vi.useFakeTimers();
      try {
        const wd = new HookWatchdog(makeConfig(), []);
        const spy = vi.spyOn(wd as any, 'runCheck').mockResolvedValue({ checked: 0, repaired: 0, skipped: 0 });

        wd.start();
        expect(spy).not.toHaveBeenCalled();

        vi.advanceTimersByTime(30_000);
        expect(spy).toHaveBeenCalledTimes(1);

        wd.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('multi-target isolation', () => {
    it('repairs only the broken target when one is healthy and one is broken', async () => {
      const claude = makeClaudeTarget(tmpDir, { agentId: 'claude-code' });
      const codex = makeClaudeTarget(tmpDir, {
        agentId: 'codex',
        settingsPath: path.join(tmpDir, '.codex', 'hooks.json'),
        binPath: path.join(tmpDir, '.cache-codex', 'package', 'bin', 'otel-codex-hook'),
        markers: ['otel-codex-hook'],
        expectedHooks: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'],
      });

      await makeBin(claude.binPath);
      await makeBin(codex.binPath);
      await writeSettings(claude.settingsPath, buildHealthySettings(claude));
      // Codex broken: missing Stop
      const codexSettings = buildHealthySettings(codex);
      delete (codexSettings.hooks as Record<string, unknown>).Stop;
      await writeSettings(codex.settingsPath, codexSettings);

      const wd = new HookWatchdog(makeConfig(), [claude, codex]);
      const summary = await wd.runCheck();

      expect(summary.checked).toBe(1); // claude healthy
      expect(summary.repaired).toBe(1); // codex repaired
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].args[0]).toBe(codex.binPath);
    });
  });

  describe('repairFn target', () => {
    function makeRepairFnTarget(tmpDir: string, repairFn: () => Promise<boolean>, overrides: Partial<PluginCheckTarget> = {}): PluginCheckTarget {
      return {
        agentId: 'cursor',
        settingsPath: path.join(tmpDir, '.cursor', 'hooks.json'),
        expectedHooks: ['stop', 'preToolUse'],
        markers: ['cursor-loongsuite-pilot-hook.sh'],
        repairFn,
        ...overrides,
      };
    }

    it('reports healthy when all hooks present (no repairFn call)', async () => {
      const repairFn = vi.fn().mockResolvedValue(true);
      const target = makeRepairFnTarget(tmpDir, repairFn);
      await writeSettings(target.settingsPath, buildHealthySettings(target));

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary.checked).toBe(1);
      expect(summary.repaired).toBe(0);
      expect(repairFn).not.toHaveBeenCalled();
      expect(spawnCalls).toHaveLength(0);
    });

    it('calls repairFn when hooks are missing', async () => {
      const repairFn = vi.fn().mockResolvedValue(true);
      const target = makeRepairFnTarget(tmpDir, repairFn);
      const settings = buildHealthySettings(target);
      delete (settings.hooks as Record<string, unknown>).stop;
      await writeSettings(target.settingsPath, settings);

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary.repaired).toBe(1);
      expect(repairFn).toHaveBeenCalledTimes(1);
      expect(spawnCalls).toHaveLength(0);
    });

    it('reports repair-failed when repairFn returns false', async () => {
      const repairFn = vi.fn().mockResolvedValue(false);
      const target = makeRepairFnTarget(tmpDir, repairFn);
      await fs.mkdir(path.dirname(target.settingsPath), { recursive: true });

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary.checked).toBe(1);
      expect(summary.repaired).toBe(0);
      expect(repairFn).toHaveBeenCalledTimes(1);
    });

    it('reports repair-failed when repairFn throws', async () => {
      const repairFn = vi.fn().mockRejectedValue(new Error('oops'));
      const target = makeRepairFnTarget(tmpDir, repairFn);
      await fs.mkdir(path.dirname(target.settingsPath), { recursive: true });

      const wd = new HookWatchdog(makeConfig(), [target]);
      await expect(wd.runCheck()).resolves.toBeDefined();
      expect(repairFn).toHaveBeenCalledTimes(1);
    });

    it('does not require binPath (no unavailable skip)', async () => {
      const repairFn = vi.fn().mockResolvedValue(true);
      const target = makeRepairFnTarget(tmpDir, repairFn);
      // No binPath set, and no bin file created — should NOT be skipped
      await fs.mkdir(path.dirname(target.settingsPath), { recursive: true });

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      // All hooks missing → repairFn called
      expect(repairFn).toHaveBeenCalledTimes(1);
      expect(summary.skipped).toBe(0);
    });

    it('mixes command and repairFn targets independently', async () => {
      const commandTarget = makeClaudeTarget(tmpDir, { agentId: 'claude-code' });
      await makeBin(commandTarget.binPath!);
      const commandSettings = buildHealthySettings(commandTarget);
      delete (commandSettings.hooks as Record<string, unknown>).Stop;
      await writeSettings(commandTarget.settingsPath, commandSettings);

      const repairFn = vi.fn().mockResolvedValue(true);
      const fnTarget = makeRepairFnTarget(tmpDir, repairFn);
      const fnSettings = buildHealthySettings(fnTarget);
      delete (fnSettings.hooks as Record<string, unknown>).stop;
      await writeSettings(fnTarget.settingsPath, fnSettings);

      const wd = new HookWatchdog(makeConfig(), [commandTarget, fnTarget]);
      const summary = await wd.runCheck();

      expect(summary.repaired).toBe(2);
      expect(spawnCalls).toHaveLength(1);
      expect(repairFn).toHaveBeenCalledTimes(1);
    });
  });
});

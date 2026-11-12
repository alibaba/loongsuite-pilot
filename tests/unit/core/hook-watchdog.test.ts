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

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock logger to silence output and allow assertions
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => mockLogger,
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
    vi.clearAllMocks();
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

    it('parses JSONC settings for Qwen without triggering repair', async () => {
      const repairFn = vi.fn(async () => true);
      const target: PluginCheckTarget = {
        agentId: 'qwen-code-cli',
        settingsPath: path.join(tmpDir, '.qwen', 'settings.json'),
        settingsSyntax: 'jsonc',
        expectedHooks: ['Stop'],
        markers: ['qwen-code-cli-loongsuite-pilot-hook.sh'],
        repairFn,
      };
      await fs.mkdir(path.dirname(target.settingsPath), { recursive: true });
      await fs.writeFile(target.settingsPath, `{
  // Qwen officially accepts JSONC settings.
  "model": "qwen-max",
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/opt/qwen-code-cli-loongsuite-pilot-hook.sh stop"
          }
        ]
      }
    ]
  }
}
`, 'utf-8');

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary).toEqual({ checked: 1, repaired: 0, skipped: 0 });
      expect(repairFn).not.toHaveBeenCalled();
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

  describe('disabled', () => {
    it('does not repair a plugin target whose agent is disabled, even with hooks missing', async () => {
      const target = makeClaudeTarget(tmpDir, { enabled: () => false });
      await makeBin(target.binPath);

      // Hooks are missing — a repair would fire if the target were enabled.
      const settings = buildHealthySettings(target);
      delete (settings.hooks as Record<string, unknown>).Stop;
      await writeSettings(target.settingsPath, settings);

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary).toEqual({ checked: 0, repaired: 0, skipped: 1 });
      expect(spawnCalls).toHaveLength(0);
    });

    it('does not invoke repairFn for a disabled hook target', async () => {
      const repairFn = vi.fn(async () => true);
      const target: PluginCheckTarget = {
        agentId: 'claude-code',
        settingsPath: path.join(tmpDir, '.claude', 'settings.json'),
        expectedHooks: ['Stop'],
        markers: ['claude-code-loongsuite-pilot-hook.sh'],
        repairFn,
        enabled: () => false,
      };
      await fs.mkdir(path.dirname(target.settingsPath), { recursive: true });
      // No settings.json → all hooks missing → repair would fire if enabled.

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary).toEqual({ checked: 0, repaired: 0, skipped: 1 });
      expect(repairFn).not.toHaveBeenCalled();
    });

    it('still repairs when enabled() returns true', async () => {
      const target = makeClaudeTarget(tmpDir, { enabled: () => true });
      await makeBin(target.binPath);
      const settings = buildHealthySettings(target);
      delete (settings.hooks as Record<string, unknown>).Stop;
      await writeSettings(target.settingsPath, settings);

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

    it('does not repair an invalid existing JSONC settings file', async () => {
      const repairFn = vi.fn(async () => true);
      const target: PluginCheckTarget = {
        agentId: 'qwen-code-cli',
        settingsPath: path.join(tmpDir, '.qwen', 'settings.json'),
        settingsSyntax: 'jsonc',
        expectedHooks: ['Stop'],
        markers: ['qwen-code-cli-loongsuite-pilot-hook.sh'],
        repairFn,
      };
      await fs.mkdir(path.dirname(target.settingsPath), { recursive: true });
      await fs.writeFile(
        target.settingsPath,
        '{ // incomplete JSONC\n  "model": "qwen-max",\n',
        'utf-8',
      );

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary).toEqual({ checked: 0, repaired: 0, skipped: 1 });
      expect(repairFn).not.toHaveBeenCalled();
    });

    it('repairs an existing whitespace-only settings file', async () => {
      const repairFn = vi.fn(async () => true);
      const target: PluginCheckTarget = {
        agentId: 'qwen-code-cli',
        settingsPath: path.join(tmpDir, '.qwen', 'settings.json'),
        settingsSyntax: 'jsonc',
        expectedHooks: ['Stop'],
        markers: ['qwen-code-cli-loongsuite-pilot-hook.sh'],
        repairFn,
      };
      await fs.mkdir(path.dirname(target.settingsPath), { recursive: true });
      await fs.writeFile(target.settingsPath, '  \n', 'utf-8');

      const wd = new HookWatchdog(makeConfig(), [target]);
      const summary = await wd.runCheck();

      expect(summary).toEqual({ checked: 0, repaired: 1, skipped: 0 });
      expect(repairFn).toHaveBeenCalledTimes(1);
    });

    it('logs a continuous invalid-config error once and logs again after recovery', async () => {
      const repairFn = vi.fn(async () => true);
      const target: PluginCheckTarget = {
        agentId: 'qwen-code-cli',
        settingsPath: path.join(tmpDir, '.qwen', 'settings.json'),
        settingsSyntax: 'jsonc',
        expectedHooks: ['Stop'],
        markers: ['qwen-code-cli-loongsuite-pilot-hook.sh'],
        repairFn,
      };
      await fs.mkdir(path.dirname(target.settingsPath), { recursive: true });
      const invalid = '{ // incomplete JSONC\n  "model": "qwen-max",\n';
      await fs.writeFile(target.settingsPath, invalid, 'utf-8');

      const wd = new HookWatchdog(makeConfig(), [target]);
      await wd.runCheck();
      await wd.runCheck();

      expect(
        mockLogger.error.mock.calls.filter(([message]) =>
          message === 'hook-watchdog.invalid-config'
        ),
      ).toHaveLength(1);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'hook-watchdog.invalid-config-suppressed',
        expect.objectContaining({ agent: 'qwen-code-cli' }),
      );

      await fs.writeFile(target.settingsPath, JSON.stringify({
        hooks: {
          Stop: [{
            hooks: [{
              command: '/opt/qwen-code-cli-loongsuite-pilot-hook.sh stop',
            }],
          }],
        },
      }), 'utf-8');
      await wd.runCheck();
      await fs.writeFile(target.settingsPath, invalid, 'utf-8');
      await wd.runCheck();

      expect(
        mockLogger.error.mock.calls.filter(([message]) =>
          message === 'hook-watchdog.invalid-config'
        ),
      ).toHaveLength(2);
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

    it('checks Codex trust only when config.toml changes and reuses repairFn', async () => {
      const repairFn = vi.fn().mockResolvedValue(true);
      const needsRepairOnChange = vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const configPath = path.join(tmpDir, '.codex', 'config.toml');
      const target = makeRepairFnTarget(tmpDir, repairFn, {
        agentId: 'codex',
        settingsPath: path.join(tmpDir, '.codex', 'hooks.json'),
        changeWatchPath: configPath,
        needsRepairOnChange,
      });
      await writeSettings(target.settingsPath, buildHealthySettings(target));
      await fs.writeFile(configPath, 'model = "first"\n', 'utf-8');

      const wd = new HookWatchdog(makeConfig({ repairCooldownMs: 0 }), [target]);

      await wd.runCheck();
      await wd.runCheck();
      expect(needsRepairOnChange).not.toHaveBeenCalled();
      expect(repairFn).not.toHaveBeenCalled();

      await fs.writeFile(configPath, 'model = "changed-and-longer"\n', 'utf-8');
      const repaired = await wd.runCheck();
      expect(needsRepairOnChange).toHaveBeenCalledTimes(1);
      expect(repairFn).toHaveBeenCalledTimes(1);
      expect(repaired.repaired).toBe(1);

      // The repair itself may replace config.toml. Its new signature is checked
      // once, then unchanged intervals skip the shared deployment inspection.
      await fs.writeFile(configPath, 'model = "reconciled"\n', 'utf-8');
      await wd.runCheck();
      await wd.runCheck();
      expect(needsRepairOnChange).toHaveBeenCalledTimes(2);
      expect(repairFn).toHaveBeenCalledTimes(1);
    });

    it('detects a config.toml edit made before the first watchdog check', async () => {
      const repairFn = vi.fn().mockResolvedValue(true);
      const needsRepairOnChange = vi.fn().mockResolvedValue(true);
      const configPath = path.join(tmpDir, '.codex', 'config.toml');
      const target = makeRepairFnTarget(tmpDir, repairFn, {
        agentId: 'codex',
        settingsPath: path.join(tmpDir, '.codex', 'hooks.json'),
        changeWatchPath: configPath,
        needsRepairOnChange,
      });
      await writeSettings(target.settingsPath, buildHealthySettings(target));
      await fs.writeFile(configPath, 'model = "post-deploy"\n', 'utf-8');

      const wd = new HookWatchdog(makeConfig({ repairCooldownMs: 0 }), [target]);
      await fs.writeFile(configPath, 'model = "changed-before-first-check"\n', 'utf-8');

      const result = await wd.runCheck();

      expect(needsRepairOnChange).toHaveBeenCalledTimes(1);
      expect(repairFn).toHaveBeenCalledTimes(1);
      expect(result.repaired).toBe(1);
    });

    it('retries a failed changed-config inspection without another file change', async () => {
      const repairFn = vi.fn().mockResolvedValue(true);
      const needsRepairOnChange = vi.fn()
        .mockRejectedValueOnce(new Error('transient read failure'))
        .mockResolvedValueOnce(false);
      const configPath = path.join(tmpDir, '.codex', 'config.toml');
      const target = makeRepairFnTarget(tmpDir, repairFn, {
        agentId: 'codex',
        settingsPath: path.join(tmpDir, '.codex', 'hooks.json'),
        changeWatchPath: configPath,
        needsRepairOnChange,
      });
      await writeSettings(target.settingsPath, buildHealthySettings(target));
      await fs.writeFile(configPath, 'model = "test"\n', 'utf-8');

      const wd = new HookWatchdog(makeConfig(), [target]);
      await wd.runCheck();
      await fs.writeFile(configPath, 'model = "changed"\n', 'utf-8');
      await wd.runCheck();
      await wd.runCheck();

      expect(needsRepairOnChange).toHaveBeenCalledTimes(2);
      expect(repairFn).not.toHaveBeenCalled();
    });

    it('keeps a changed config pending until repair succeeds', async () => {
      const repairFn = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const needsRepairOnChange = vi.fn().mockResolvedValue(true);
      const configPath = path.join(tmpDir, '.codex', 'config.toml');
      const target = makeRepairFnTarget(tmpDir, repairFn, {
        agentId: 'codex',
        settingsPath: path.join(tmpDir, '.codex', 'hooks.json'),
        changeWatchPath: configPath,
        needsRepairOnChange,
      });
      await writeSettings(target.settingsPath, buildHealthySettings(target));
      await fs.writeFile(configPath, 'model = "test"\n', 'utf-8');

      const wd = new HookWatchdog(makeConfig({ repairCooldownMs: 0 }), [target]);
      await wd.runCheck();
      await fs.writeFile(configPath, 'model = "changed"\n', 'utf-8');
      expect((await wd.runCheck()).repaired).toBe(0);
      expect((await wd.runCheck()).repaired).toBe(1);

      expect(needsRepairOnChange).toHaveBeenCalledTimes(2);
      expect(repairFn).toHaveBeenCalledTimes(2);
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

  describe('hook asset bytes', () => {
    const scriptText = '#!/bin/sh\necho ok\n';
    const processorText = 'export const x = 1;\n';

    async function installAssets(): Promise<{ pilotDir: string; dataDir: string }> {
      const pilotDir = path.join(tmpDir, 'pilot');
      const dataDir = path.join(tmpDir, 'data');
      const sourceRoot = path.join(pilotDir, 'assets', 'hooks', 'shared');
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.writeFile(
        path.join(pilotDir, 'assets', 'hooks', 'claude-code-loongsuite-pilot-hook.sh'),
        scriptText,
        { mode: 0o755 },
      );
      await fs.writeFile(path.join(sourceRoot, 'decode-payload.mjs'), processorText);
      return { pilotDir, dataDir };
    }

    it('restores a missing script from the install tree', async () => {
      const { pilotDir, dataDir } = await installAssets();
      const wd = new HookWatchdog(makeConfig(), [], [], { pilotDir, dataDir });

      await wd.runCheck();

      const restored = path.join(dataDir, 'hooks', 'claude-code-loongsuite-pilot-hook.sh');
      expect(await fs.readFile(restored, 'utf8')).toBe(scriptText);
      expect(await fs.readFile(path.join(dataDir, 'hooks', 'shared', 'decode-payload.mjs'), 'utf8')).toBe(processorText);
    });

    it('overwrites a modified processor and leaves package-extra files', async () => {
      const { pilotDir, dataDir } = await installAssets();
      const processor = path.join(dataDir, 'hooks', 'shared', 'decode-payload.mjs');
      const extra = path.join(dataDir, 'hooks', 'user-note.txt');
      await fs.mkdir(path.dirname(processor), { recursive: true });
      await fs.writeFile(processor, 'export const x = 2;\n');
      await fs.writeFile(extra, 'keep\n');
      const wd = new HookWatchdog(makeConfig(), [], [], { pilotDir, dataDir });

      await wd.runCheck();

      expect(await fs.readFile(processor, 'utf8')).toBe(processorText);
      expect(await fs.readFile(extra, 'utf8')).toBe('keep\n');
    });

    it('restores the execute bit without calling settings repair', async () => {
      const { pilotDir, dataDir } = await installAssets();
      const script = path.join(dataDir, 'hooks', 'claude-code-loongsuite-pilot-hook.sh');
      await fs.mkdir(path.dirname(script), { recursive: true });
      await fs.writeFile(script, scriptText, { mode: 0o644 });
      await fs.mkdir(path.join(dataDir, 'hooks', 'shared'), { recursive: true });
      await fs.writeFile(path.join(dataDir, 'hooks', 'shared', 'decode-payload.mjs'), processorText);

      const repairFn = vi.fn(async () => true);
      const target = makeClaudeTarget(tmpDir, { repairFn });
      await writeSettings(target.settingsPath, buildHealthySettings(target));
      const wd = new HookWatchdog(makeConfig(), [target], [], { pilotDir, dataDir });

      const summary = await wd.runCheck();

      expect(repairFn).not.toHaveBeenCalled();
      expect(summary.repaired).toBe(0);
      expect(summary.checked).toBe(1);
      if (process.platform !== 'win32') {
        expect((await fs.stat(script)).mode & 0o111).not.toBe(0);
      }
      expect(await fs.readFile(script, 'utf8')).toBe(scriptText);
    });

    it('leaves deployed hooks alone when the install tree is missing', async () => {
      const dataDir = path.join(tmpDir, 'data');
      const deployed = path.join(dataDir, 'hooks', 'claude-code-loongsuite-pilot-hook.sh');
      await fs.mkdir(path.dirname(deployed), { recursive: true });
      await fs.writeFile(deployed, 'local\n');
      const wd = new HookWatchdog(makeConfig(), [], [], {
        pilotDir: path.join(tmpDir, 'missing-pilot'),
        dataDir,
      });

      await wd.runCheck();

      expect(await fs.readFile(deployed, 'utf8')).toBe('local\n');
    });

    it('replaces a symlinked hook file without following it', async () => {
      const { pilotDir, dataDir } = await installAssets();
      const outside = path.join(tmpDir, 'outside.mjs');
      const link = path.join(dataDir, 'hooks', 'shared', 'decode-payload.mjs');
      await fs.writeFile(outside, 'outside\n');
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(outside, link);
      const wd = new HookWatchdog(makeConfig(), [], [], { pilotDir, dataDir });

      await wd.runCheck();

      expect(await fs.readFile(outside, 'utf8')).toBe('outside\n');
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(link, 'utf8')).toBe(processorText);
    });

    it('does not write through a symlinked parent directory', async () => {
      const { pilotDir, dataDir } = await installAssets();
      const outsideDir = path.join(tmpDir, 'outside-dir');
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, 'decode-payload.mjs'), 'outside\n');
      const shared = path.join(dataDir, 'hooks', 'shared');
      await fs.mkdir(path.dirname(shared), { recursive: true });
      await fs.symlink(outsideDir, shared);
      const wd = new HookWatchdog(makeConfig(), [], [], { pilotDir, dataDir });

      await wd.runCheck();

      expect(await fs.readFile(path.join(outsideDir, 'decode-payload.mjs'), 'utf8')).toBe('outside\n');
      expect((await fs.lstat(shared)).isSymbolicLink()).toBe(true);
    });

    it('leaves hooks alone while a version candidate is present', async () => {
      const { pilotDir, dataDir } = await installAssets();
      const deployed = path.join(dataDir, 'hooks', 'claude-code-loongsuite-pilot-hook.sh');
      await fs.mkdir(path.dirname(deployed), { recursive: true });
      await fs.writeFile(deployed, 'tampered\n');
      await fs.mkdir(path.join(path.dirname(pilotDir), '1.2.0_abc.candidate'));
      const wd = new HookWatchdog(makeConfig(), [], [], { pilotDir, dataDir });

      await wd.runCheck();

      expect(await fs.readFile(deployed, 'utf8')).toBe('tampered\n');
    });

    it('does not roll hooks back after current moves to another version', async () => {
      const { pilotDir, dataDir } = await installAssets();
      const deployed = path.join(dataDir, 'hooks', 'claude-code-loongsuite-pilot-hook.sh');
      await fs.mkdir(path.dirname(deployed), { recursive: true });
      await fs.writeFile(deployed, 'tampered\n');
      await fs.mkdir(path.join(dataDir, 'versions', 'v2'), { recursive: true });
      await fs.writeFile(path.join(dataDir, 'current'), 'v2\n');
      const wd = new HookWatchdog(makeConfig(), [], [], { pilotDir, dataDir });

      await wd.runCheck();

      expect(await fs.readFile(deployed, 'utf8')).toBe('tampered\n');
    });
  });
});

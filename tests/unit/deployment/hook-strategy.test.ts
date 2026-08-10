import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HookStrategy } from '../../../src/deployment/hook-strategy.js';
import type { AgentDefinition, DeployedAgentRecord } from '../../../src/types/index.js';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/deployment/detect-utils.js', () => ({
  detectAgent: vi.fn(),
}));

vi.mock('../../../src/utils/fs-utils.js', () => ({
  fileExists: vi.fn(),
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn(),
  writeTextFileAtomic: vi.fn(),
  resolveHome: vi.fn((p: string) => p),
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/deployment/codex-trust-writer.js', () => ({
  writeTrustedHashes: vi.fn(),
  removeTrustBlock: vi.fn(),
  verifyTrustHashes: vi.fn(() => ({ valid: true, mismatches: [] })),
}));

import { detectAgent } from '../../../src/deployment/detect-utils.js';
import * as fs from 'node:fs/promises';
import {
  fileExists,
  readJsonFile,
  writeJsonFile,
  writeTextFileAtomic,
} from '../../../src/utils/fs-utils.js';
import { verifyTrustHashes } from '../../../src/deployment/codex-trust-writer.js';

function makeDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'test-hook-agent',
    displayName: 'Test Hook Agent',
    deployMode: 'hook',
    detection: { paths: ['/home/.test'], commands: [] },
    hook: {
      settingsPath: '/home/.test/hooks.json',
      events: ['Stop', 'PostToolUse'],
      hookCommand: '/opt/pilot/hooks/test.sh',
      format: 'flat',
    },
    ...overrides,
  };
}

describe('HookStrategy', () => {
  let mockHookManager: {
    isHookInstalled: ReturnType<typeof vi.fn>;
    installHook: ReturnType<typeof vi.fn>;
    uninstallHook: ReturnType<typeof vi.fn>;
  };
  let strategy: HookStrategy;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fileExists).mockResolvedValue(false);
    mockHookManager = {
      isHookInstalled: vi.fn(),
      installHook: vi.fn(),
      uninstallHook: vi.fn(),
    };
    strategy = new HookStrategy(mockHookManager as any);
  });

  describe('detect', () => {
    it('delegates to detectAgent', async () => {
      vi.mocked(detectAgent).mockResolvedValue(true);
      const def = makeDef();
      const result = await strategy.detect(def);
      expect(result).toBe(true);
      expect(detectAgent).toHaveBeenCalledWith(def.detection);
    });

    it('returns false when agent not found', async () => {
      vi.mocked(detectAgent).mockResolvedValue(false);
      expect(await strategy.detect(makeDef())).toBe(false);
    });
  });

  describe('needsDeploy', () => {
    it('returns true when any hook is not installed', async () => {
      mockHookManager.isHookInstalled
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await strategy.needsDeploy(makeDef());
      expect(result).toBe(true);
    });

    it('returns false when all hooks are installed', async () => {
      mockHookManager.isHookInstalled.mockResolvedValue(true);

      const result = await strategy.needsDeploy(makeDef());
      expect(result).toBe(false);
      expect(mockHookManager.isHookInstalled).toHaveBeenCalledTimes(2);
    });

    it('returns true when Codex hooks.json has a stale version field', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({ version: 1, hooks: {} });
      mockHookManager.isHookInstalled.mockResolvedValue(true);

      const result = await strategy.needsDeploy(makeDef({
        hook: {
          settingsPath: '/home/.codex/hooks.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'nested',
        },
      }));

      expect(result).toBe(true);
      expect(mockHookManager.isHookInstalled).not.toHaveBeenCalled();
    });

    it('returns true when Codex hook exists but its trust state is invalid', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({ hooks: {} });
      vi.mocked(verifyTrustHashes).mockReturnValue({
        valid: false,
        mismatches: ['missing trust state'],
      });
      mockHookManager.isHookInstalled.mockResolvedValue(true);

      const result = await strategy.needsDeploy(makeDef({
        id: 'codex',
        hook: {
          settingsPath: '/home/.codex/hooks.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/codex-hook.sh',
          format: 'nested',
          eventSubcommand: 'kebab-case',
          trustToml: {
            configPath: '/home/.codex/config.toml',
            trustAlgo: 'v1',
            marker: 'otel-codex-hook',
          },
        },
      }));

      expect(result).toBe(true);
      expect(verifyTrustHashes).toHaveBeenCalledOnce();
    });

    it('builds correct hook definitions from agent config', async () => {
      mockHookManager.isHookInstalled.mockResolvedValue(true);
      const def = makeDef();
      await strategy.needsDeploy(def);

      const firstCall = mockHookManager.isHookInstalled.mock.calls[0][0];
      expect(firstCall).toMatchObject({
        agentId: 'test-hook-agent',
        settingsPath: '/home/.test/hooks.json',
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: '/opt/pilot/hooks/test.sh',
        useNestedFormat: false,
      });

      const secondCall = mockHookManager.isHookInstalled.mock.calls[1][0];
      expect(secondCall.hookJsonPath).toEqual(['hooks', 'PostToolUse']);
    });

    it('quotes only Codex PowerShell hook paths and removes the previous Windows command', async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        vi.mocked(readJsonFile).mockResolvedValue({ hooks: {} });
        mockHookManager.isHookInstalled.mockResolvedValue(true);
        const script = 'C:/Users/Test User/.loongsuite-pilot/hooks/codex-loongsuite-pilot-hook.ps1';
        const def = makeDef({
          id: 'codex',
          hook: {
            settingsPath: 'C:/Users/Test User/.codex/hooks.json',
            events: ['Stop'],
            hookCommand: script,
            format: 'nested',
            matcher: '*',
            eventSubcommand: 'kebab-case',
          },
        });

        await strategy.needsDeploy(def);

        expect(mockHookManager.isHookInstalled.mock.calls[0][0]).toMatchObject({
          hookCommand: 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass '
            + `-File "${script}" stop`,
          replaceHookCommands: [`${script} stop`],
        });
      } finally {
        if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('preserves the existing Windows command format for non-Codex hook agents', async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        mockHookManager.isHookInstalled.mockResolvedValue(true);
        const def = makeDef({
          id: 'claude-code',
          hook: {
            settingsPath: 'C:/Users/test/.claude/settings.json',
            events: ['Stop'],
            hookCommand: 'C:/Users/test/.loongsuite-pilot/hooks/claude-code-hook.ps1',
            format: 'nested',
            eventSubcommand: 'kebab-case',
          },
        });

        await strategy.needsDeploy(def);

        expect(mockHookManager.isHookInstalled.mock.calls[0][0]).toMatchObject({
          hookCommand: 'powershell -NoProfile -ExecutionPolicy Bypass '
            + '-File C:/Users/test/.loongsuite-pilot/hooks/claude-code-hook.ps1 stop',
          replaceHookCommands: [],
        });
      } finally {
        if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('passes replaceHookCommands to hook definitions', async () => {
      mockHookManager.isHookInstalled.mockResolvedValue(true);
      const def = makeDef({
        hook: {
          settingsPath: '/home/.test/hooks.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'nested',
          replaceHookCommands: ['/old/hook.sh'],
        },
      });

      await strategy.needsDeploy(def);
      const call = mockHookManager.isHookInstalled.mock.calls[0][0];
      expect(call.useNestedFormat).toBe(true);
      expect(call.replaceHookCommands).toEqual(['/old/hook.sh']);
    });

    it('emits winShell as def.shell on Windows', async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        mockHookManager.isHookInstalled.mockResolvedValue(true);
        const def = makeDef({
          id: 'qoder',
          hook: {
            settingsPath: 'C:/Users/test/.qoder/settings.json',
            events: ['Stop'],
            hookCommand: 'C:/Users/test/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.ps1',
            format: 'nested',
            matcher: '*',
            winShell: 'powershell',
          },
        });

        await strategy.needsDeploy(def);
        expect(mockHookManager.isHookInstalled.mock.calls[0][0].shell).toBe('powershell');
      } finally {
        if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('ignores winShell on non-Windows platforms', async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      try {
        mockHookManager.isHookInstalled.mockResolvedValue(true);
        const def = makeDef({
          id: 'qoder',
          hook: {
            settingsPath: '/home/.qoder/settings.json',
            events: ['Stop'],
            hookCommand: '/opt/pilot/hooks/qoder-loongsuite-pilot-hook.sh',
            format: 'nested',
            matcher: '*',
            winShell: 'powershell',
          },
        });

        await strategy.needsDeploy(def);
        expect(mockHookManager.isHookInstalled.mock.calls[0][0].shell).toBeUndefined();
      } finally {
        if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('leaves def.shell undefined when winShell is not set (e.g. codex)', async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        mockHookManager.isHookInstalled.mockResolvedValue(true);
        const def = makeDef({
          id: 'codex',
          hook: {
            settingsPath: 'C:/Users/test/.codex/hooks.json',
            events: ['Stop'],
            hookCommand: 'C:/Users/test/.loongsuite-pilot/hooks/codex-loongsuite-pilot-hook.ps1',
            format: 'nested',
            matcher: '*',
          },
        });

        await strategy.needsDeploy(def);
        expect(mockHookManager.isHookInstalled.mock.calls[0][0].shell).toBeUndefined();
      } finally {
        if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('uses per-event matchers when configured', async () => {
      mockHookManager.isHookInstalled.mockResolvedValue(true);
      await strategy.needsDeploy(makeDef({
        hook: {
          settingsPath: '/home/.workbuddy/settings.json',
          events: ['SessionStart', 'PreToolUse'],
          hookCommand: '/opt/pilot/hooks/workbuddy.sh',
          format: 'nested',
          eventMatchers: { PreToolUse: '.*' },
        },
      }));
      expect(mockHookManager.isHookInstalled.mock.calls[0][0].matcher).toBeUndefined();
      expect(mockHookManager.isHookInstalled.mock.calls[1][0].matcher).toBe('.*');
    });

    it('passes JSONC settings syntax to Qwen hook definitions', async () => {
      mockHookManager.isHookInstalled.mockResolvedValue(true);
      const def = makeDef({
        id: 'qwen-code-cli',
        hook: {
          settingsPath: '/home/.qwen/settings.json',
          settingsSyntax: 'jsonc',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/qwen.sh',
          format: 'nested',
        },
      });

      await strategy.needsDeploy(def);

      expect(mockHookManager.isHookInstalled.mock.calls[0][0]).toMatchObject({
        agentId: 'qwen-code-cli',
        settingsSyntax: 'jsonc',
        settingsPath: '/home/.qwen/settings.json',
      });
    });
  });

  describe('deploy', () => {
    it('returns error when hook config is missing', async () => {
      const def = makeDef({ hook: undefined });
      const result = await strategy.deploy(def);
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing hook config');
    });

    it('creates settings file for hooks.json that does not exist', async () => {
      vi.mocked(readJsonFile).mockResolvedValue(null);
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);

      await strategy.deploy(makeDef());

      expect(writeJsonFile).toHaveBeenCalledWith(
        '/home/.test/hooks.json',
        { hooks: {} },
      );
    });

    it('creates settings file with version for Cursor hooks.json', async () => {
      vi.mocked(readJsonFile).mockResolvedValue(null);
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);

      const def = makeDef({
        hook: {
          settingsPath: '/home/.cursor/hooks.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'flat',
        },
      });
      await strategy.deploy(def);

      expect(writeJsonFile).toHaveBeenCalledWith(
        '/home/.cursor/hooks.json',
        { version: 1, hooks: {} },
      );
    });

    it('adds version field to existing Cursor hooks.json without one', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({ hooks: {} });
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);

      const def = makeDef({
        hook: {
          settingsPath: '/home/.cursor/hooks.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'flat',
        },
      });
      await strategy.deploy(def);

      expect(writeJsonFile).toHaveBeenCalledWith(
        '/home/.cursor/hooks.json',
        { version: 1, hooks: {} },
      );
    });

    it('does not add version to Codex hooks.json', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({ hooks: {} });
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);

      const def = makeDef({
        hook: {
          settingsPath: '/home/.codex/hooks.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'nested',
        },
      });
      await strategy.deploy(def);

      expect(writeJsonFile).not.toHaveBeenCalled();
    });

    it('removes stale version field from Codex hooks.json', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({ version: 1, hooks: { Stop: [] } });
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);

      const def = makeDef({
        hook: {
          settingsPath: '/home/.codex/hooks.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'nested',
        },
      });
      await strategy.deploy(def);

      expect(writeJsonFile).toHaveBeenCalledWith(
        '/home/.codex/hooks.json',
        { hooks: { Stop: [] } },
      );
    });

    it('creates Codex hooks.json without version when file does not exist', async () => {
      vi.mocked(readJsonFile).mockResolvedValue(null);
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);

      const def = makeDef({
        hook: {
          settingsPath: '/home/.codex/hooks.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'nested',
        },
      });
      await strategy.deploy(def);

      expect(writeJsonFile).toHaveBeenCalledWith(
        '/home/.codex/hooks.json',
        { hooks: {} },
      );
    });

    it('does not overwrite version on existing hooks.json that already has one', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({ version: 2, hooks: {} });
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);

      const def = makeDef({
        hook: {
          settingsPath: '/home/.cursor/hooks.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'flat',
        },
      });
      await strategy.deploy(def);

      expect(writeJsonFile).not.toHaveBeenCalled();
    });

    it('skips settings file creation for non-hooks.json paths', async () => {
      vi.mocked(readJsonFile).mockResolvedValue(null);
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);

      const def = makeDef({
        hook: {
          settingsPath: '/home/.test/settings.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'flat',
        },
      });
      await strategy.deploy(def);

      expect(writeJsonFile).not.toHaveBeenCalled();
    });

    it('does not replace an existing invalid strict hooks.json file', async () => {
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(readJsonFile).mockResolvedValue(null);
      vi.mocked(fs.readFile).mockResolvedValue('{ "hooks": ');

      const result = await strategy.deploy(makeDef());

      expect(result.success).toBe(false);
      expect(result.error).toContain('refusing to overwrite invalid settings');
      expect(writeJsonFile).not.toHaveBeenCalled();
      expect(mockHookManager.installHook).not.toHaveBeenCalled();
    });

    it('initializes an existing whitespace-only Cursor hooks.json safely', async () => {
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(readJsonFile).mockResolvedValue(null);
      vi.mocked(fs.readFile).mockResolvedValue('  \n');
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);

      const def = makeDef({
        hook: {
          settingsPath: '/home/.cursor/hooks.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'flat',
        },
      });
      const result = await strategy.deploy(def);

      expect(result.success).toBe(true);
      expect(writeTextFileAtomic).toHaveBeenCalledWith(
        '/home/.cursor/hooks.json',
        '{\n  "hooks": {},\n  "version": 1\n}\n',
        { expected: { exists: true, content: '  \n' } },
      );
      expect(writeJsonFile).not.toHaveBeenCalled();
      expect(mockHookManager.installHook).toHaveBeenCalled();
    });

    it('installs only hooks not already installed', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({ version: 1, hooks: {} });
      mockHookManager.isHookInstalled
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      mockHookManager.installHook.mockResolvedValue(true);

      const result = await strategy.deploy(makeDef());

      expect(result.success).toBe(true);
      expect(mockHookManager.installHook).toHaveBeenCalledTimes(1);
    });

    it('removes retired hook events before installing the current definition', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({ version: 1, hooks: {} });
      mockHookManager.uninstallHook.mockResolvedValue(true);
      mockHookManager.isHookInstalled.mockResolvedValue(true);
      const def = makeDef({
        hook: {
          settingsPath: '/home/.test/hooks.json',
          events: ['Stop'],
          retiredEvents: ['SessionStart', 'PreToolUse'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'flat',
          eventSubcommand: 'kebab-case',
          replaceHookCommands: ['/old/codex-hook.sh'],
        },
      });

      const result = await strategy.deploy(def);

      expect(result.success).toBe(true);
      expect(mockHookManager.uninstallHook).toHaveBeenCalledTimes(2);
      expect(mockHookManager.uninstallHook.mock.calls.map(([definition]) => definition.hookJsonPath)).toEqual([
        ['hooks', 'SessionStart'],
        ['hooks', 'PreToolUse'],
      ]);
      expect(mockHookManager.uninstallHook.mock.calls[0]?.[0].hookCommand).toBe(
        '/opt/pilot/hooks/test.sh session-start',
      );
      expect(mockHookManager.uninstallHook.mock.calls[0]?.[0].replaceHookCommands).toEqual([
        '/old/codex-hook.sh',
      ]);
    });

    it('returns failure if installHook returns false', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({ version: 1, hooks: {} });
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(false);

      const result = await strategy.deploy(makeDef());

      expect(result.success).toBe(false);
      expect(result.error).toContain('failed to install hook');
    });

    it('returns failure on exception', async () => {
      vi.mocked(readJsonFile).mockRejectedValue(new Error('disk error'));

      const result = await strategy.deploy(makeDef());

      expect(result.success).toBe(false);
      expect(result.error).toContain('disk error');
    });
  });

  describe('env injection (settings.env merge)', () => {
    // Helper: build a def whose hook block carries an env directive.
    // Uses settings.json (not hooks.json) so ensureSettingsFile is a no-op
    // and the only writeJsonFile we observe comes from applyEnvToSettings.
    const envHookDef = (env: Record<string, string> | undefined) =>
      makeDef({
        hook: {
          settingsPath: '/home/.test/settings.json',
          events: ['Stop'],
          hookCommand: '/opt/pilot/hooks/test.sh',
          format: 'nested',
          ...(env ? { env } : {}),
        },
      });

    beforeEach(() => {
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);
    });

    it('hook config without env → no settings write', async () => {
      vi.mocked(readJsonFile).mockResolvedValue(null);

      await strategy.deploy(envHookDef(undefined));

      expect(writeJsonFile).not.toHaveBeenCalled();
    });

    // NOTE: applyEnvToSettings does NOT itself expand $PILOT_DATA — that's
    // done upstream by AgentDefLoader.resolveVariables() at load time.
    // These tests pass already-resolved paths to mirror real input shape.
    const RESOLVED_PRELOAD = '--preload=/home/.loongsuite-pilot/hooks/intercept.mjs';

    it('first-time injection: value written as-is into a fresh env block', async () => {
      // No existing settings file
      vi.mocked(readJsonFile).mockResolvedValue(null);

      await strategy.deploy(envHookDef({
        BUN_OPTIONS: RESOLVED_PRELOAD,
      }));

      expect(writeJsonFile).toHaveBeenCalledWith(
        '/home/.test/settings.json',
        { env: { BUN_OPTIONS: RESOLVED_PRELOAD } },
      );
    });

    it('BUN_OPTIONS idempotency: existing value already contains our preload → skip write', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({
        env: { BUN_OPTIONS: RESOLVED_PRELOAD },
      });

      await strategy.deploy(envHookDef({ BUN_OPTIONS: RESOLVED_PRELOAD }));

      expect(writeJsonFile).not.toHaveBeenCalled();
    });

    it('BUN_OPTIONS token-boundary match: superstring is NOT treated as already injected', async () => {
      // Existing token is our preload path with a `-debug` suffix — must not
      // false-positive as "already injected" (regression guard for substring
      // match bug; comment 3 in code review).
      vi.mocked(readJsonFile).mockResolvedValue({
        env: { BUN_OPTIONS: '--preload=/home/.loongsuite-pilot/hooks/intercept.mjs-debug' },
      });

      await strategy.deploy(envHookDef({ BUN_OPTIONS: RESOLVED_PRELOAD }));

      expect(writeJsonFile).toHaveBeenCalledWith(
        '/home/.test/settings.json',
        {
          env: {
            BUN_OPTIONS:
              '--preload=/home/.loongsuite-pilot/hooks/intercept.mjs-debug ' + RESOLVED_PRELOAD,
          },
        },
      );
    });

    it('BUN_OPTIONS coexistence: append our preload alongside user\'s own', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({
        env: { BUN_OPTIONS: '--preload=/user/own/script.js' },
      });

      await strategy.deploy(envHookDef({ BUN_OPTIONS: RESOLVED_PRELOAD }));

      expect(writeJsonFile).toHaveBeenCalledWith(
        '/home/.test/settings.json',
        {
          env: {
            BUN_OPTIONS: '--preload=/user/own/script.js ' + RESOLVED_PRELOAD,
          },
        },
      );
    });

    it('non-BUN_OPTIONS key overwrites existing value', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({
        env: { OTHER_KEY: 'old_value' },
      });

      await strategy.deploy(envHookDef({ OTHER_KEY: 'new_value' }));

      expect(writeJsonFile).toHaveBeenCalledWith(
        '/home/.test/settings.json',
        { env: { OTHER_KEY: 'new_value' } },
      );
    });

    it('preserves unrelated env keys and other top-level settings', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({
        env: { ANTHROPIC_AUTH_TOKEN: 'secret' },
        otherTopLevel: 'preserved',
      });

      await strategy.deploy(envHookDef({ BUN_OPTIONS: RESOLVED_PRELOAD }));

      expect(writeJsonFile).toHaveBeenCalledWith(
        '/home/.test/settings.json',
        {
          env: {
            ANTHROPIC_AUTH_TOKEN: 'secret',
            BUN_OPTIONS: RESOLVED_PRELOAD,
          },
          otherTopLevel: 'preserved',
        },
      );
    });

    it('same value re-deploy → no write (general idempotency)', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({
        env: { CUSTOM_KEY: 'same_value' },
      });

      await strategy.deploy(envHookDef({ CUSTOM_KEY: 'same_value' }));

      expect(writeJsonFile).not.toHaveBeenCalled();
    });

    it('env merge failure must not block hook deploy (returns success)', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({});
      vi.mocked(writeJsonFile).mockRejectedValueOnce(new Error('disk full'));

      const result = await strategy.deploy(envHookDef({ BUN_OPTIONS: RESOLVED_PRELOAD }));

      expect(result.success).toBe(true);
      // Hook installation still attempted normally
      expect(mockHookManager.installHook).toHaveBeenCalled();
    });
  });

  describe('undeploy', () => {
    it('uninstalls all hooks', async () => {
      mockHookManager.uninstallHook.mockResolvedValue(true);

      const result = await strategy.undeploy(makeDef());
      expect(result).toBe(true);
      expect(mockHookManager.uninstallHook).toHaveBeenCalledTimes(2);
    });

    it('returns false if any uninstall fails', async () => {
      mockHookManager.uninstallHook
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await strategy.undeploy(makeDef());
      expect(result).toBe(false);
    });
  });

  describe('kiro agent default-agent config', () => {
    const kiroDef = (overrides?: Partial<AgentDefinition>): AgentDefinition => makeDef({
      id: 'kiro-cli',
      hook: {
        settingsPath: '/home/.kiro/agents/pilot-kiro.json',
        events: ['userPromptSubmit', 'preToolUse', 'postToolUse', 'stop'],
        hookCommand: '/opt/pilot/hooks/kiro.sh',
        format: 'flat',
        matcher: '*',
        eventSubcommand: 'as-is',
        kiroAgent: { name: 'pilot-kiro', tools: ['read', 'write', 'shell'] },
        ...overrides,
      },
    });

    it('sets chat.defaultAgent=pilot-kiro in cli.json when missing', async () => {
      // pilot-kiro.json: empty; cli.json: no chat.defaultAgent
      vi.mocked(readJsonFile).mockResolvedValue({} as any);
      mockHookManager.installHook.mockResolvedValue(true);

      await strategy.deploy(kiroDef());

      // writeJsonFile should be called with cli.json containing chat.defaultAgent
      const calls = vi.mocked(writeJsonFile).mock.calls;
      const cliCall = calls.find((c: any) => String(c[0]).includes('settings/cli.json'));
      expect(cliCall).toBeTruthy();
      expect((cliCall![1] as any)['chat.defaultAgent']).toBe('pilot-kiro');
    });

    it('does not override an existing chat.defaultAgent', async () => {
      // cli.json already has a different defaultAgent
      vi.mocked(readJsonFile).mockResolvedValue({ 'chat.defaultAgent': 'my-custom-agent' } as any);
      mockHookManager.installHook.mockResolvedValue(true);

      await strategy.deploy(kiroDef());

      const cliCall = vi.mocked(writeJsonFile).mock.calls
        .find((c: any) => String(c[0]).includes('settings/cli.json'));
      // Should not write cli.json (defaultAgent already set, respected)
      expect(cliCall).toBeUndefined();
    });
  });
});

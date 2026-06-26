import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HookStrategy } from '../../../src/deployment/hook-strategy.js';
import type { AgentDefinition, DeployedAgentRecord } from '../../../src/types/index.js';

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
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn(),
  resolveHome: vi.fn((p: string) => p),
}));

import { detectAgent } from '../../../src/deployment/detect-utils.js';
import { readJsonFile, writeJsonFile } from '../../../src/utils/fs-utils.js';

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
});

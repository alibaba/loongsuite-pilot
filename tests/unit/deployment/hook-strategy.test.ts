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
        { version: 1, hooks: {} },
      );
    });

    it('adds version field to existing hooks.json without one', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({ hooks: {} });
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);

      await strategy.deploy(makeDef());

      expect(writeJsonFile).toHaveBeenCalledWith(
        '/home/.test/hooks.json',
        { version: 1, hooks: {} },
      );
    });

    it('does not overwrite version on existing hooks.json that already has one', async () => {
      vi.mocked(readJsonFile).mockResolvedValue({ version: 2, hooks: {} });
      mockHookManager.isHookInstalled.mockResolvedValue(false);
      mockHookManager.installHook.mockResolvedValue(true);

      await strategy.deploy(makeDef());

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

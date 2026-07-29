import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { HookManager } from '../../../src/hooks/hook-manager.js';

describe('HookManager', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-manager-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('builds Qoder Work hooks with the dedicated entrypoint', () => {
    const [def] = HookManager.buildQoderWorkHooks('/opt/loongsuite-pilot');

    expect(def.hookCommand).toBe('/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh');
    expect(def.replaceHookCommands).toEqual([
      '/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-work',
    ]);
    expect(def.agentId).toBe('qoder-work');
    expect(def.useNestedFormat).toBe(true);
  });

  it('replaces the legacy Qoder Work hook command during install', async () => {
    const settingsPath = path.join(tmpDir, '.qoderwork', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: '*',
            hooks: [
              {
                command: '/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-work',
                type: 'command',
              },
            ],
          },
        ],
      },
    }, null, 2));

    const manager = new HookManager(
      path.join(tmpDir, 'hooks'),
      path.join(tmpDir, 'logs'),
    );
    const ok = await manager.installHook({
      agentId: 'qoder-work',
      settingsPath,
      hookJsonPath: ['hooks', 'Stop'],
      hookCommand: '/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh',
      replaceHookCommands: [
        '/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-work',
      ],
      matcher: '*',
      useNestedFormat: true,
    });

    expect(ok).toBe(true);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
    expect(JSON.stringify(settings)).not.toContain('qoder-loongsuite-pilot-hook.sh qoder-work');
    expect(settings.hooks.Stop).toEqual([
      {
        matcher: '*',
        hooks: [
          {
            command: '/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh',
            type: 'command',
          },
        ],
      },
    ]);
  });

  it('treats hooks with replacement commands as not fully installed', async () => {
    const settingsPath = path.join(tmpDir, '.qoderwork', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: '*',
            hooks: [
              {
                command: '/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh',
                type: 'command',
              },
            ],
          },
          {
            matcher: '*',
            hooks: [
              {
                command: '/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-work',
                type: 'command',
              },
            ],
          },
        ],
      },
    }, null, 2));

    const manager = new HookManager(
      path.join(tmpDir, 'hooks'),
      path.join(tmpDir, 'logs'),
    );
    await expect(manager.isHookInstalled({
      agentId: 'qoder-work',
      settingsPath,
      hookJsonPath: ['hooks', 'Stop'],
      hookCommand: '/opt/loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh',
      replaceHookCommands: [
        '/opt/loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-work',
      ],
      matcher: '*',
      useNestedFormat: true,
    })).resolves.toBe(false);
  });

  it.each(['', '  \n'])(
    'initializes an existing blank strict-JSON settings file',
    async (original) => {
      const settingsPath = path.join(tmpDir, '.qoder', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, original, 'utf-8');

      const manager = new HookManager(
        path.join(tmpDir, 'hooks'),
        path.join(tmpDir, 'logs'),
      );
      const ok = await manager.installHook({
        agentId: 'qoder',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: '/opt/qoder-loongsuite-pilot-hook.sh',
        matcher: '*',
        useNestedFormat: true,
      });

      expect(ok).toBe(true);
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
      expect(settings.hooks.Stop[0].hooks[0].command).toBe(
        '/opt/qoder-loongsuite-pilot-hook.sh',
      );
    },
  );

  it('removes replacement commands during uninstall', async () => {
    const settingsPath = path.join(tmpDir, '.codex', 'hooks.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                command: 'otel-codex-hook pre-tool-use',
                type: 'command',
              },
            ],
          },
          {
            matcher: '*',
            hooks: [
              {
                command: '/opt/loongsuite-pilot/hooks/codex-loongsuite-pilot-hook.sh pre-tool-use',
                type: 'command',
              },
            ],
          },
        ],
      },
    }, null, 2));

    const manager = new HookManager(
      path.join(tmpDir, 'hooks'),
      path.join(tmpDir, 'logs'),
    );
    const ok = await manager.uninstallHook({
      agentId: 'codex',
      settingsPath,
      hookJsonPath: ['hooks', 'PreToolUse'],
      hookCommand: '/opt/loongsuite-pilot/hooks/codex-loongsuite-pilot-hook.sh pre-tool-use',
      replaceHookCommands: ['otel-codex-hook pre-tool-use'],
      matcher: '*',
      useNestedFormat: true,
    });

    expect(ok).toBe(true);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
    expect(settings.hooks.PreToolUse).toBeUndefined();
  });

  it('installs a Qwen hook without removing JSONC comments or user settings', async () => {
    const settingsPath = path.join(tmpDir, '.qwen', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const original = `{
  // Keep the user's selected model.
  "model": "qwen-max",
  "mcpServers": {
    "work": {
      "command": "node"
    }
  },
  "permissions": {
    // This comment must survive hook installation.
    "allow": ["read"]
  },
  "hooks": {
    "Stop": [
      // Keep a third-party hook and its comment.
      {
        "matcher": "*",
        "hooks": [
          {
            "command": "/opt/other-hook.sh",
            "type": "command"
          }
        ]
      }
    ]
  }
}
`;
    await fs.writeFile(settingsPath, original, 'utf-8');

    const manager = new HookManager(
      path.join(tmpDir, 'hooks'),
      path.join(tmpDir, 'logs'),
    );
    const ok = await manager.installHook({
      agentId: 'qwen-code-cli',
      settingsPath,
      settingsSyntax: 'jsonc',
      hookJsonPath: ['hooks', 'Stop'],
      hookCommand: '/opt/qwen-loongsuite-pilot-hook.sh stop',
      matcher: '*',
      useNestedFormat: true,
    });

    expect(ok).toBe(true);
    const updated = await fs.readFile(settingsPath, 'utf-8');
    expect(updated).toContain("// Keep the user's selected model.");
    expect(updated).toContain('// This comment must survive hook installation.');
    expect(updated).toContain('// Keep a third-party hook and its comment.');
    expect(updated).toContain('/opt/qwen-loongsuite-pilot-hook.sh stop');

    const errors: ParseError[] = [];
    const parsed = parseJsonc(updated, errors, { allowTrailingComma: true });
    expect(errors).toEqual([]);
    expect(parsed.model).toBe('qwen-max');
    expect(parsed.mcpServers.work.command).toBe('node');
    expect(parsed.permissions.allow).toEqual(['read']);
    expect(parsed.hooks.Stop).toHaveLength(2);
    await expect(
      fs.readFile(`${settingsPath}.loongsuite-pilot.bak`, 'utf-8'),
    ).resolves.toBe(original);
  });

  it.each(['', '  \n'])(
    'initializes an existing blank JSONC settings file without losing write guards',
    async (original) => {
      const settingsPath = path.join(tmpDir, '.qwen', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, original, 'utf-8');

      const manager = new HookManager(
        path.join(tmpDir, 'hooks'),
        path.join(tmpDir, 'logs'),
      );
      const ok = await manager.installHook({
        agentId: 'qwen-code-cli',
        settingsPath,
        settingsSyntax: 'jsonc',
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: '/opt/qwen-loongsuite-pilot-hook.sh stop',
        matcher: '*',
        useNestedFormat: true,
      });

      expect(ok).toBe(true);
      const updated = await fs.readFile(settingsPath, 'utf-8');
      const errors: ParseError[] = [];
      const parsed = parseJsonc(updated, errors, { allowTrailingComma: true });
      expect(errors).toEqual([]);
      expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
        '/opt/qwen-loongsuite-pilot-hook.sh stop',
      );
      await expect(
        fs.readFile(`${settingsPath}.loongsuite-pilot.bak`, 'utf-8'),
      ).resolves.toBe(original);
    },
  );

  it('uninstalls a Qwen hook with path-level JSONC edits', async () => {
    const settingsPath = path.join(tmpDir, '.qwen', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const pilotCommand = '/opt/qwen-loongsuite-pilot-hook.sh stop';
    await fs.writeFile(settingsPath, `{
  // Keep the model comment.
  "model": "qwen-max",
  "hooks": {
    "Stop": [
      // Keep this third-party hook comment.
      {
        "matcher": "*",
        "hooks": [{ "command": "/opt/other-hook.sh", "type": "command" }]
      },
      {
        "matcher": "*",
        "hooks": [{ "command": "${pilotCommand}", "type": "command" }]
      }
    ]
  }
}
`, 'utf-8');

    const manager = new HookManager(
      path.join(tmpDir, 'hooks'),
      path.join(tmpDir, 'logs'),
    );
    const ok = await manager.uninstallHook({
      agentId: 'qwen-code-cli',
      settingsPath,
      settingsSyntax: 'jsonc',
      hookJsonPath: ['hooks', 'Stop'],
      hookCommand: pilotCommand,
      matcher: '*',
      useNestedFormat: true,
    });

    expect(ok).toBe(true);
    const updated = await fs.readFile(settingsPath, 'utf-8');
    expect(updated).toContain('// Keep the model comment.');
    expect(updated).toContain('// Keep this third-party hook comment.');
    expect(updated).toContain('/opt/other-hook.sh');
    expect(updated).not.toContain(pilotCommand);
  });

  it('does not overwrite an existing invalid JSONC settings file', async () => {
    const settingsPath = path.join(tmpDir, '.qwen', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const invalid = `{
  // The file exists but is incomplete.
  "model": "qwen-max",
`;
    await fs.writeFile(settingsPath, invalid, 'utf-8');

    const manager = new HookManager(
      path.join(tmpDir, 'hooks'),
      path.join(tmpDir, 'logs'),
    );
    const ok = await manager.installHook({
      agentId: 'qwen-code-cli',
      settingsPath,
      settingsSyntax: 'jsonc',
      hookJsonPath: ['hooks', 'Stop'],
      hookCommand: '/opt/qwen-loongsuite-pilot-hook.sh stop',
      useNestedFormat: true,
    });

    expect(ok).toBe(false);
    await expect(fs.readFile(settingsPath, 'utf-8')).resolves.toBe(invalid);
    await expect(fs.stat(`${settingsPath}.loongsuite-pilot.bak`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not treat strict JSON parse failures as empty settings', async () => {
    const settingsPath = path.join(tmpDir, '.cursor', 'hooks.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const invalid = '{ "version": 1, "hooks": ';
    await fs.writeFile(settingsPath, invalid, 'utf-8');

    const manager = new HookManager(
      path.join(tmpDir, 'hooks'),
      path.join(tmpDir, 'logs'),
    );
    const ok = await manager.installHook({
      agentId: 'cursor',
      settingsPath,
      hookJsonPath: ['hooks', 'stop'],
      hookCommand: '/opt/cursor-loongsuite-pilot-hook.sh',
    });

    expect(ok).toBe(false);
    await expect(fs.readFile(settingsPath, 'utf-8')).resolves.toBe(invalid);
  });
});

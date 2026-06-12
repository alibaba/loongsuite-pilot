import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
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
});

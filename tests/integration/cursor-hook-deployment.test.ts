import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { AgentDefLoader } from '../../src/deployment/agent-def-loader.js';
import { HookStrategy } from '../../src/deployment/hook-strategy.js';
import { HookManager } from '../../src/hooks/hook-manager.js';

it('upgrades Cursor collection hooks to a 30-second timeout without duplicating them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-cursor-hooks-'));
  try {
    const dataDir = path.join(root, 'Pilot data');
    const settingsPath = path.join(root, '.cursor', 'hooks.json');
    const loader = new AgentDefLoader({
      builtinDir: path.resolve('agents.d'),
      localDir: path.join(root, 'agents.d'),
      pilotDir: root,
      dataDir,
    });
    const definition = (await loader.load()).find(def => def.id === 'cursor')!;
    const hook = definition.hook!;
    hook.settingsPath = settingsPath;
    const script = hook.hookCommand;
    const command = process.platform === 'win32'
      ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`
      : script;
    const otherHook = { command: 'user-managed-hook', timeout: 5 };
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({
      version: 1,
      hooks: { stop: [{ command: script, type: 'command' }, otherHook] },
    }));

    const strategy = new HookStrategy(new HookManager(
      path.join(dataDir, 'hooks'), path.join(dataDir, 'logs'),
    ));
    await expect(strategy.needsDeploy(definition)).resolves.toBe(true);
    await expect(strategy.deploy(definition)).resolves.toMatchObject({ success: true });
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    const expectedHook = { command, type: 'command', timeout: 30 };
    expect(settings.hooks.stop).toHaveLength(2);
    expect(settings.hooks.stop).toEqual(expect.arrayContaining([expectedHook, otherHook]));
    for (const event of hook.events.filter(event => event !== 'stop')) {
      expect(settings.hooks[event]).toEqual([expectedHook]);
    }
    await expect(strategy.needsDeploy(definition)).resolves.toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

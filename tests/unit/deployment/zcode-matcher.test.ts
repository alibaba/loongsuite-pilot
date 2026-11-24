import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { HookManager } from '../../../src/hooks/hook-manager.js';
import { HookStrategy } from '../../../src/deployment/hook-strategy.js';
import type { AgentDefinition } from '../../../src/types/index.js';

const AGENTS_D = path.resolve(__dirname, '../../../agents.d');

describe('zcode agent definition — matcher regression', () => {
  async function loadZcodeDef(settingsPath: string): Promise<AgentDefinition> {
    const raw = await fs.readFile(path.join(AGENTS_D, 'zcode.json'), 'utf-8');
    const def = JSON.parse(raw) as AgentDefinition;
    return {
      ...def,
      hook: { ...def.hook!, settingsPath },
    };
  }

  it('zcode.json declares format=nested and no matcher field', async () => {
    const raw = await fs.readFile(path.join(AGENTS_D, 'zcode.json'), 'utf-8');
    const def = JSON.parse(raw);
    expect(def.hook.format).toBe('nested');
    expect(def.hook.matcher).toBeUndefined();
  });

  it('deployed zcode config uses nested format with no matcher (CP3 BLOCKER regression)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-deploy-'));
    try {
      const settingsPath = path.join(tmpDir, '.zcode', 'cli', 'config.json');
      const def = await loadZcodeDef(settingsPath);

      const hookManager = new HookManager(
        path.join(tmpDir, 'hooks'),
        path.join(tmpDir, 'logs'),
      );
      const strategy = new HookStrategy(hookManager);

      const result = await strategy.deploy(def);
      expect(result.success).toBe(true);

      const deployed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
      const serialized = JSON.stringify(deployed);
      expect(serialized).not.toContain('"matcher"');

      const events = deployed.hooks.events;
      for (const event of def.hook!.events) {
        const arr = events[event];
        expect(Array.isArray(arr)).toBe(true);
        expect(arr.length).toBe(1);
        expect(arr[0].matcher).toBeUndefined();
        expect(Array.isArray(arr[0].hooks)).toBe(true);
        expect(arr[0].hooks.length).toBe(1);
        expect(arr[0].hooks[0].type).toBe('command');
        expect(arr[0].hooks[0].command).toContain('zcode-loongsuite-pilot-hook.sh');
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

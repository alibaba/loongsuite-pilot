import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentDefLoader } from '../../../src/deployment/agent-def-loader.js';
import { HookStrategy } from '../../../src/deployment/hook-strategy.js';
import { HookManager } from '../../../src/hooks/hook-manager.js';
import type { AgentDefinition } from '../../../src/types/index.js';

let tmp: string;

beforeEach(async () => { tmp = await mkdtemp(path.join(tmpdir(), 'copilot-deploy-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

async function loadCopilotDef(): Promise<AgentDefinition> {
  const loader = new AgentDefLoader({
    builtinDir: path.resolve('agents.d'), localDir: path.join(tmp, 'local'), pilotDir: tmp, dataDir: tmp,
  });
  const def = (await loader.load()).find(d => d.id === 'copilot');
  if (!def) throw new Error('copilot agent definition not found');
  return def;
}

describe('copilot agent definition', () => {
  it('is a hook agent detected from ~/.copilot with three wakeup events', async () => {
    const def = await loadCopilotDef();
    expect(def.deployMode).toBe('hook');
    expect(def.detection.paths).toEqual([expect.stringMatching(/\.copilot$/)]);
    expect(def.hook?.events).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    expect(def.hook?.settingsPath).toMatch(/\.copilot[\\/]hooks[\\/]loongsuite-pilot\.json$/);
    expect(def.hook?.hookCommand).toContain('copilot-loongsuite-pilot-hook');
  });

  it('writes a Copilot-native hook file with one command entry per event', async () => {
    const def = await loadCopilotDef();
    const settingsPath = path.join(tmp, 'copilot-home', 'hooks', 'loongsuite-pilot.json');
    const deployable: AgentDefinition = { ...def, hook: { ...def.hook!, settingsPath } };
    const strategy = new HookStrategy(new HookManager(path.join(tmp, 'hook-scripts'), path.join(tmp, 'logs')));

    const result = await strategy.deploy(deployable);
    expect(result.success).toBe(true);

    const written = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    expect(Object.keys(written.hooks).sort()).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit']);
    for (const [event, subcommand] of [
      ['SessionStart', 'session-start'], ['UserPromptSubmit', 'user-prompt-submit'], ['Stop', 'stop'],
    ]) {
      expect(written.hooks[event]).toHaveLength(1);
      const entry = written.hooks[event][0];
      expect(entry.type).toBe('command');
      expect(Object.keys(entry).sort()).toEqual(['command', 'type']);
      expect(String(entry.command)).toContain('copilot-loongsuite-pilot-hook');
      expect(String(entry.command)).toMatch(new RegExp(`${subcommand}$`));
    }
    expect(await strategy.needsDeploy(deployable)).toBe(false);
  });
});

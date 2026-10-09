import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';
import { AgentDefLoader } from '../../../src/deployment/agent-def-loader.js';
import { resolveHome } from '../../../src/utils/fs-utils.js';

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});

let root: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it('isolates built-in config targets and restores inherited directory overrides', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-home-'));
  for (const key of ['HOME', 'USERPROFILE', 'GROK_HOME', 'HERMES_HOME', 'PI_CODING_AGENT_DIR', 'DSH_HOME', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR']) {
    vi.stubEnv(key, path.join(root, 'outside', key));
  }
  vi.stubEnv('XDG_CONFIG_HOME', undefined);
  const keys = [
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
    'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'HERMES_HOME',
    'PI_CODING_AGENT_DIR', 'DSH_HOME',
    'OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR',
  ];
  const directoryEnv = () => Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const beforeEnv = directoryEnv();
  const beforeHome = os.homedir();
  const home = path.join(root, 'sandbox');
  const restore = isolateAgentHome(home);
  try {
    expect(os.homedir()).toBe(home);
    expect(resolveHome('~')).toBe(home);
    expect(process.env.DSH_HOME).toBe(path.join(home, '.dsh'));
    expect(process.env.OPENCLAW_CONFIG_PATH).toBe('');
    expect(process.env.OPENCLAW_STATE_DIR).toBe('');
    const definitions = await new AgentDefLoader({
      pilotDir: process.cwd(),
      dataDir: home,
      builtinDir: path.join(process.cwd(), 'agents.d'),
      localDir: path.join(home, 'agents.d.local'),
    }).load();
    expect(definitions.length).toBeGreaterThan(0);
    for (const def of definitions) {
      const targets = [
        def.hook?.settingsPath, def.hook?.trustToml?.configPath,
        ...(def.pluginInject?.configPaths ?? []), def.directoryPlugin?.targetDir,
      ].filter((target): target is string => Boolean(target));
      for (const target of targets) {
        expect(path.relative(home, target), def.id).not.toMatch(/^\.\.(?:[\\/]|$)/);
        expect(path.isAbsolute(target), def.id).toBe(true);
      }
    }
  } finally { restore(); }
  expect(directoryEnv()).toEqual(beforeEnv);
  expect(os.homedir()).toBe(beforeHome);
});

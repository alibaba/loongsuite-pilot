import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';
import { runHookInstall } from '../../../src/deployment/hook-install-service.js';

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('hook install state merge', () => {
  let tmp: string;
  let dataDir: string;
  let pilotDir: string;
  let restoreHome: () => void;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-hook-merge-'));
    restoreHome = isolateAgentHome(tmp);
    dataDir = path.join(tmp, 'data');
    pilotDir = path.join(tmp, 'pilot');
    const home = path.join(tmp, 'agent-home');
    await fs.mkdir(path.join(pilotDir, 'agents.d'), { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(pilotDir, 'agents.d', 'sample-agent.json'), JSON.stringify({
      id: 'sample-agent',
      displayName: 'Sample',
      deployMode: 'hook',
      detection: { paths: [home], commands: [] },
      hook: {
        settingsPath: path.join(home, 'settings.json'),
        events: ['Stop'],
        hookCommand: '$PILOT_DATA/hooks/sample-agent-hook.sh',
        format: 'nested',
        matcher: '*',
      },
    }));
    await fs.writeFile(path.join(dataDir, 'deployed-agents.json'), JSON.stringify({
      'daemon-agent': {
        deployMode: 'hook',
        deployedAt: '2020-01-01T00:00:00.000Z',
        installedBy: 'daemon',
      },
    }));
  });

  afterEach(async () => {
    restoreHome();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('keeps daemon records while recording the hook install', async () => {
    const result = await runHookInstall({
      dataDir,
      pilotDir,
      builtinAgentsDir: path.join(pilotDir, 'agents.d'),
      writeResult: true,
      agentsFlag: 'sample-agent',
      identity: { identity: 'f'.repeat(64), source: 'cgroup' },
    });
    expect(result.exitCode).toBe(0);
    const state = JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf8'));
    expect(state['daemon-agent']).toEqual({
      deployMode: 'hook',
      deployedAt: '2020-01-01T00:00:00.000Z',
      installedBy: 'daemon',
    });
    expect(state['sample-agent'].installedBy).toBe('hook-install');
  });
});

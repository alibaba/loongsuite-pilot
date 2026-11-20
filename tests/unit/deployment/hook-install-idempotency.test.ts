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

describe('hook install idempotency', () => {
  let tmp: string;
  let dataDir: string;
  let pilotDir: string;
  let settingsPath: string;
  let restoreHome: () => void;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-hook-idem-'));
    restoreHome = isolateAgentHome(tmp);
    dataDir = path.join(tmp, 'data');
    pilotDir = path.join(tmp, 'pilot');
    const home = path.join(tmp, 'agent-home');
    settingsPath = path.join(home, 'settings.json');
    await fs.mkdir(path.join(pilotDir, 'agents.d'), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(pilotDir, 'agents.d', 'sample-agent.json'), JSON.stringify({
      id: 'sample-agent',
      displayName: 'Sample',
      deployMode: 'hook',
      detection: { paths: [home], commands: [] },
      hook: {
        settingsPath,
        events: ['Stop'],
        hookCommand: '$PILOT_DATA/hooks/sample-agent-hook.sh',
        format: 'nested',
        matcher: '*',
      },
    }));
  });

  afterEach(async () => {
    restoreHome();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function install() {
    return runHookInstall({
      dataDir,
      pilotDir,
      builtinAgentsDir: path.join(pilotDir, 'agents.d'),
      writeResult: true,
      agentsFlag: 'sample-agent',
      identity: { identity: 'd'.repeat(64), source: 'cgroup' },
    });
  }

  it('reports up-to-date without rewriting settings, then rewrites only the damaged file', async () => {
    const first = await install();
    expect(first.report.agents[0].status).toBe('ok');
    const before = await fs.readFile(settingsPath, 'utf8');
    const beforeStat = await fs.stat(settingsPath);

    const second = await install();
    expect(second.report.agents[0].status).toBe('up-to-date');
    const after = await fs.readFile(settingsPath, 'utf8');
    const afterStat = await fs.stat(settingsPath);
    expect(after).toBe(before);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    await fs.writeFile(settingsPath, '{}\n');
    const third = await install();
    expect(third.report.agents[0].status).toBe('ok');
    const restored = await fs.readFile(settingsPath, 'utf8');
    expect(restored).toBe(before);
    expect(restored).not.toBe('{}\n');
  });
});

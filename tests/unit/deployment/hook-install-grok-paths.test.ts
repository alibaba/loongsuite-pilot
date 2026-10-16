import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';
import { DeploymentManager } from '../../../src/deployment/deployment-manager.js';
import { applyPersistedDeployTargets } from '../../../src/deployment/persisted-deploy-paths.js';
import { runHookInstall } from '../../../src/deployment/hook-install-service.js';
import type { AgentDefinition } from '../../../src/types/deployment.js';

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/deployment/deploy-notification.js', () => ({
  writeDeployNotification: vi.fn().mockResolvedValue(undefined),
}));

describe('grok hook install paths', () => {
  let tmp: string;
  let dataDir: string;
  let pilotDir: string;
  let builtinDir: string;
  let restoreHome: () => void;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-grok-hooks-'));
    restoreHome = isolateAgentHome(tmp);
    dataDir = path.join(tmp, 'data');
    pilotDir = path.join(tmp, 'pilot');
    builtinDir = path.join(pilotDir, 'agents.d');
    await fs.mkdir(builtinDir, { recursive: true });
    await fs.writeFile(path.join(builtinDir, 'grok-build.json'), JSON.stringify({
      id: 'grok-build',
      displayName: 'Grok Build',
      deployMode: 'hook',
      detection: { paths: [path.join(tmp, 'missing-grok-home')], commands: [] },
      hook: {
        settingsPath: path.join(tmp, 'missing-grok-home', 'hooks', 'loongsuite-pilot.json'),
        events: ['stop'],
        hookCommand: '$PILOT_DATA/hooks/grok-build-loongsuite-pilot-hook.sh',
        format: 'nested',
        matcher: '',
        eventSubcommand: 'as-is',
      },
    }));
  });

  afterEach(async () => {
    restoreHome();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function install(home: string) {
    return runHookInstall({
      dataDir,
      pilotDir,
      builtinAgentsDir: builtinDir,
      writeResult: true,
      agentsFlag: 'grok-build',
      homes: { 'grok-build': home },
      identity: { identity: 'e'.repeat(64), source: 'cgroup' },
    });
  }

  it('writes one settings file per home and does not treat a new home as up-to-date', async () => {
    const firstHome = path.join(tmp, 'u', 'aaa');
    const secondHome = path.join(tmp, 'u', 'bbb');
    const firstFile = path.join(firstHome, 'hooks', 'loongsuite-pilot.json');
    const secondFile = path.join(secondHome, 'hooks', 'loongsuite-pilot.json');

    const first = await install(firstHome);
    expect(first.exitCode).toBe(0);
    expect(first.report.agents[0].status).toBe('ok');
    await fs.access(firstFile);

    const second = await install(secondHome);
    expect(second.report.agents[0].status).toBe('ok');
    const secondText = await fs.readFile(secondFile, 'utf8');
    expect(secondText).toContain('grok-build-loongsuite-pilot-hook.sh');
    const firstStat = await fs.stat(firstFile);

    const again = await install(firstHome);
    expect(again.report.agents[0].status).toBe('up-to-date');
    expect((await fs.stat(firstFile)).mtimeMs).toBe(firstStat.mtimeMs);
    expect(await fs.readFile(secondFile, 'utf8')).toBe(secondText);

    const loaded = JSON.parse(await fs.readFile(path.join(builtinDir, 'grok-build.json'), 'utf8')) as AgentDefinition;
    const redirected = applyPersistedDeployTargets(loaded, {
      deployMode: 'hook',
      deployedAt: '2020-01-01T00:00:00.000Z',
      hookSettingsPath: firstFile,
      hookSettingsPaths: [firstFile],
    }, { preserveHookSettings: true });
    expect(redirected.hook?.settingsPath).toBe(loaded.hook?.settingsPath);
  });

  it('repairs every recorded grok settings file', async () => {
    const firstHome = path.join(tmp, 'u', 'ccc');
    const secondHome = path.join(tmp, 'u', 'ddd');
    await install(firstHome);
    await install(secondHome);
    const files = [
      path.join(firstHome, 'hooks', 'loongsuite-pilot.json'),
      path.join(secondHome, 'hooks', 'loongsuite-pilot.json'),
    ];
    for (const file of files) await fs.writeFile(file, '{}\n');

    const manager = new DeploymentManager({
      dataDir,
      pilotDir,
      builtinAgentsDir: builtinDir,
      installedBy: 'daemon',
    });
    const defs = await manager.loadDefinitions();
    const def = defs.find(item => item.id === 'grok-build');
    expect(def).toBeTruthy();
    const repaired = await manager.repairHookSettings(def!);
    expect(repaired.success).toBe(true);
    for (const file of files) {
      expect(await fs.readFile(file, 'utf8')).toContain('grok-build-loongsuite-pilot-hook.sh');
    }
  });
});

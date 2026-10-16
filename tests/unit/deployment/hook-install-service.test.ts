import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';
import {
  HOOK_INSTALL_REASONS,
  hintForReason,
  hookInstallResultPath,
  runHookInstall,
  selectAgents,
  toPublicReport,
} from '../../../src/deployment/hook-install-service.js';

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  redirectRootLoggerToStderr: vi.fn(),
}));

describe('hook install service', () => {
  let tmp: string;
  let dataDir: string;
  let pilotDir: string;
  let home: string;
  let restoreHome: () => void;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-hook-install-'));
    restoreHome = isolateAgentHome(tmp);
    dataDir = path.join(tmp, 'data');
    pilotDir = path.join(tmp, 'pilot');
    home = path.join(tmp, 'agent-home');
    await fs.mkdir(path.join(pilotDir, 'agents.d'), { recursive: true });
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
  });

  afterEach(async () => {
    restoreHome();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function run(overrides: Partial<Parameters<typeof runHookInstall>[0]> = {}) {
    return runHookInstall({
      dataDir,
      pilotDir,
      builtinAgentsDir: path.join(pilotDir, 'agents.d'),
      writeResult: true,
      identity: { identity: 'c'.repeat(64), source: 'cgroup' },
      ...overrides,
    });
  }

  it('treats unset, empty, and literal null as full detection, and only none as skip', async () => {
    expect(selectAgents(undefined, undefined)).toEqual({ kind: 'detect', warnLiteralNull: false });
    expect(selectAgents(undefined, '')).toEqual({ kind: 'detect', warnLiteralNull: false });
    expect(selectAgents(undefined, 'null')).toEqual({ kind: 'detect', warnLiteralNull: true });
    expect(selectAgents('null', 'claude-code')).toEqual({ kind: 'detect', warnLiteralNull: true });
    expect(selectAgents(undefined, 'none')).toEqual({ kind: 'skip' });
    expect(selectAgents('none', undefined)).toEqual({ kind: 'skip' });
    expect(selectAgents('sample-agent', 'none').kind).toBe('named');

    const skipped = await run({ agentsFlag: 'none' });
    expect(skipped.exitCode).toBe(0);
    expect(skipped.wroteResult).toBe(false);
    await expect(fs.access(hookInstallResultPath(dataDir))).rejects.toThrow();

    const detected = await run({ envAgents: 'null' });
    expect(detected.warnings).toEqual([
      'LOONGSUITE_PILOT_AGENTS or --agents is the literal "null"; detecting all agents.',
    ]);
    expect(detected.report.scope).toBe('detected');
    expect(detected.report.agents.map(agent => agent.id)).toEqual(['sample-agent']);
    expect(detected.exitCode).toBe(0);
  });

  it('fails unknown ids and agents that were named but not detected, and every reason has a hint', async () => {
    for (const reason of HOOK_INSTALL_REASONS) {
      expect(hintForReason(reason, 'sample-agent').length).toBeGreaterThan(0);
    }

    const unknown = await run({ agentsFlag: 'missing-agent' });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.report.agents[0]).toMatchObject({
      id: 'missing-agent',
      status: 'failed',
      reason: 'unknown-id',
    });
    expect(unknown.report.agents[0].hint).toBeTruthy();

    await fs.rm(home, { recursive: true, force: true });
    const missing = await run({ agentsFlag: 'sample-agent' });
    expect(missing.exitCode).toBe(1);
    expect(missing.report.agents[0]).toMatchObject({
      status: 'failed',
      reason: 'not-detected',
    });
    expect(missing.report.agents[0].hint).toContain('home');
  });

  it('reports uid-mismatch from an injected euid without requiring the CI user to be root', async () => {
    const result = await run({
      agentsFlag: 'sample-agent',
      homes: { 'sample-agent': home },
      euid: 0,
      homeOwner: async () => 1000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.agents[0]).toMatchObject({ reason: 'uid-mismatch', status: 'failed' });
    expect(result.report.agents[0].hint).toContain('agent user');
    await expect(fs.access(path.join(home, 'settings.json'))).rejects.toThrow();
  });

  it('writes a result file with the same agents and scope as the public JSON', async () => {
    const result = await run({ agentsFlag: 'sample-agent' });
    expect(result.report.scope).toBe('named');
    const disk = JSON.parse(await fs.readFile(hookInstallResultPath(dataDir), 'utf8'));
    const pub = toPublicReport(result.report);
    expect(pub.scope).toBe(disk.scope);
    expect(pub.agents).toEqual(disk.agents);
    expect(disk.alarmSent).toBe(true);
    expect(pub).not.toHaveProperty('alarmSent');
    expect(result.report.agents[0].status).toBe('ok');
  });
});

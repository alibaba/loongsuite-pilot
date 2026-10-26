import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';
import {
  HOOK_INSTALL_REASONS,
  classifyDeployError,
  definitionAtInstallHome,
  hintForReason,
  hookInstallResultPath,
  markHookInstallAlarmSent,
  mergeInstalledAgents,
  runHookInstall,
  selectAgents,
  toPublicReport,
} from '../../../src/deployment/hook-install-service.js';
import { resolveDeploymentScope } from '../../../src/deployment/deployment-scope.js';

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
    expect(unknown.report.scope).toBe('detected');
    expect(resolveDeploymentScope(
      { identity: 'c'.repeat(64), source: 'cgroup' },
      unknown.report,
    )).toBe('auto');

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

  it('does not treat a path containing json or an empty settings file as invalid JSON', async () => {
    expect(classifyDeployError('cannot write /tmp/settings.json: EACCES')).toBe('deploy-failed');
    expect(classifyDeployError(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe('deploy-failed');
    expect(classifyDeployError(new SyntaxError('Unexpected token'))).toBe('invalid-settings');

    await fs.writeFile(path.join(pilotDir, 'agents.d', 'sample-agent.json'), JSON.stringify({
      id: 'sample-agent',
      displayName: 'Sample',
      deployMode: 'hook',
      detection: { paths: [home], commands: [] },
      hook: {
        settingsPath: path.join(home, 'settings.json'),
        settingsSyntax: 'jsonc',
        events: ['Stop'],
        hookCommand: '$PILOT_DATA/hooks/sample-agent-hook.sh',
        format: 'nested',
        matcher: '*',
      },
    }));
    await fs.writeFile(path.join(home, 'settings.json'), '{ /* keep */ }\n');
    const commented = await run({ agentsFlag: 'sample-agent' });
    expect(commented.report.agents[0].reason).toBeNull();
    await fs.writeFile(path.join(home, 'settings.json'), '   \n');
    const empty = await run({ agentsFlag: 'sample-agent' });
    expect(empty.report.agents[0].reason).toBeNull();
    expect(empty.report.agents[0].status).toBe('ok');
  });

  it('keeps a Kiro hook under agents/ and writes CLI settings in the same home', async () => {
    const kiroHome = path.join(tmp, 'custom-kiro');
    const defaultHome = path.join(tmp, 'default-kiro');
    await fs.writeFile(path.join(pilotDir, 'agents.d', 'kiro-cli.json'), JSON.stringify({
      id: 'kiro-cli',
      displayName: 'Kiro CLI',
      deployMode: 'hook',
      detection: { paths: [defaultHome], commands: [] },
      hook: {
        settingsPath: path.join(defaultHome, 'agents', 'pilot-kiro.json'),
        events: ['stop'],
        hookCommand: '$PILOT_DATA/hooks/kiro-cli-loongsuite-pilot-hook.sh',
        format: 'flat',
        matcher: '*',
        eventSubcommand: 'as-is',
        kiroAgent: { name: 'pilot-kiro', tools: ['read'] },
      },
    }));
    const placed = definitionAtInstallHome({
      id: 'kiro-cli',
      displayName: 'Kiro CLI',
      deployMode: 'hook',
      detection: { paths: [defaultHome], commands: [] },
      hook: {
        settingsPath: path.join(defaultHome, 'agents', 'pilot-kiro.json'),
        events: ['stop'],
        hookCommand: 'hook.sh',
        format: 'flat',
      },
    }, kiroHome);
    expect(placed?.hook?.settingsPath).toBe(path.join(kiroHome, 'agents', 'pilot-kiro.json'));

    const result = await run({
      agentsFlag: 'kiro-cli',
      homes: { 'kiro-cli': kiroHome },
    });
    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(path.join(kiroHome, 'agents', 'pilot-kiro.json'), 'utf8')).toContain('stop');
    expect(await fs.readFile(path.join(kiroHome, 'settings', 'cli.json'), 'utf8')).toContain('pilot-kiro');
    await expect(fs.access(path.join(defaultHome, 'agents', 'pilot-kiro.json'))).rejects.toThrow();
  });

  it('writes a plugin config under --home instead of the default directory', async () => {
    const custom = path.join(tmp, 'custom-opencode');
    const defaults = path.join(tmp, 'default-opencode');
    await fs.writeFile(path.join(pilotDir, 'agents.d', 'opencode.json'), JSON.stringify({
      id: 'opencode',
      displayName: 'OpenCode',
      deployMode: 'plugin-inject',
      detection: { paths: [defaults], commands: [] },
      pluginInject: {
        createIfMissing: true,
        configPaths: [path.join(defaults, 'opencode.jsonc')],
        pluginSpec: 'file:///tmp/pilot-plugin.mjs',
        pluginId: 'loongsuite-pilot-opencode',
      },
    }));
    const result = await run({
      agentsFlag: 'opencode',
      homes: { opencode: custom },
    });
    expect(result.exitCode).toBe(0);
    await fs.access(path.join(custom, 'opencode.jsonc'));
    await expect(fs.access(path.join(defaults, 'opencode.jsonc'))).rejects.toThrow();
  });

  it('reports a missing hook as not installed until a record exists', async () => {
    const status = await run({ agentsFlag: 'sample-agent', mode: 'status', writeResult: false });
    expect(status.report.agents[0].reason).toBe('not-detected');
  });

  it('keeps an earlier named agent when a later install names a different one', async () => {
    const otherHome = path.join(tmp, 'other-home');
    await fs.mkdir(otherHome, { recursive: true });
    await fs.writeFile(path.join(pilotDir, 'agents.d', 'other-agent.json'), JSON.stringify({
      id: 'other-agent',
      displayName: 'Other',
      deployMode: 'hook',
      detection: { paths: [otherHome], commands: [] },
      hook: {
        settingsPath: path.join(otherHome, 'settings.json'),
        events: ['Stop'],
        hookCommand: '$PILOT_DATA/hooks/other-agent-hook.sh',
        format: 'nested',
        matcher: '*',
      },
    }));
    const first = await run({ agentsFlag: 'sample-agent' });
    expect(first.exitCode).toBe(0);
    const sampleSettings = path.join(home, 'settings.json');
    const sampleText = await fs.readFile(sampleSettings, 'utf8');

    const second = await run({ agentsFlag: 'other-agent' });
    expect(second.exitCode).toBe(0);
    expect(await fs.readFile(sampleSettings, 'utf8')).toBe(sampleText);
    const disk = JSON.parse(await fs.readFile(hookInstallResultPath(dataDir), 'utf8'));
    const ids = disk.agents.filter((agent: { status: string }) => agent.status === 'ok').map((agent: { id: string }) => agent.id);
    expect(ids).toEqual(expect.arrayContaining(['sample-agent', 'other-agent']));
  });

  it('keeps named scope through a full detect so the next named install still merges', async () => {
    const otherHome = path.join(tmp, 'later-home');
    await fs.mkdir(otherHome, { recursive: true });
    const first = await run({ agentsFlag: 'sample-agent' });
    expect(first.report.scope).toBe('named');

    const detected = await run({});
    expect(detected.exitCode).toBe(0);
    const afterDetect = JSON.parse(await fs.readFile(hookInstallResultPath(dataDir), 'utf8'));
    expect(afterDetect.scope).toBe('named');
    expect(afterDetect.agents.some((agent: { id: string; status: string }) =>
      agent.id === 'sample-agent' && (agent.status === 'ok' || agent.status === 'up-to-date'))).toBe(true);

    await fs.writeFile(path.join(pilotDir, 'agents.d', 'other-agent.json'), JSON.stringify({
      id: 'other-agent',
      displayName: 'Other',
      deployMode: 'hook',
      detection: { paths: [otherHome], commands: [] },
      hook: {
        settingsPath: path.join(otherHome, 'settings.json'),
        events: ['Stop'],
        hookCommand: '$PILOT_DATA/hooks/other-agent-hook.sh',
        format: 'nested',
        matcher: '*',
      },
    }));
    const second = await run({ agentsFlag: 'other-agent' });
    expect(second.exitCode).toBe(0);
    const disk = JSON.parse(await fs.readFile(hookInstallResultPath(dataDir), 'utf8'));
    expect(disk.scope).toBe('named');
    const ids = disk.agents
      .filter((agent: { status: string }) => agent.status === 'ok' || agent.status === 'up-to-date')
      .map((agent: { id: string }) => agent.id);
    expect(ids).toEqual(expect.arrayContaining(['sample-agent', 'other-agent']));
  });

  it('mergeInstalledAgents keeps a previous success when the same id fails later', () => {
    const merged = mergeInstalledAgents(
      [{ id: 'grok-build', status: 'ok', reason: null, hint: null, settingsPath: '/a', deployMode: 'hook' }],
      [{ id: 'grok-build', status: 'failed', reason: 'uid-mismatch', hint: 'x', settingsPath: '/b', deployMode: 'hook' }],
    );
    expect(merged.map(agent => agent.status)).toEqual(['ok', 'failed']);
  });

  it('does not let an alarm mark replace a hook install report written under the same lock', async () => {
    const file = hookInstallResultPath(dataDir);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      schema: 1,
      identity: 'c'.repeat(64),
      ts: 'old',
      scope: 'detected',
      agents: [],
      alarmSent: false,
    }));
    const installed = run({ agentsFlag: 'sample-agent' });
    const marked = markHookInstallAlarmSent(file, 'old');
    await Promise.all([installed, marked]);
    const disk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(disk.ts).not.toBe('old');
    expect(disk.agents.some((agent: { id: string }) => agent.id === 'sample-agent')).toBe(true);
  });

  it('does not mark a newer hook-install report as already alarmed', async () => {
    const file = hookInstallResultPath(dataDir);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      schema: 1,
      identity: 'c'.repeat(64),
      ts: 'new',
      scope: 'named',
      agents: [],
      alarmSent: false,
    }));
    expect(await markHookInstallAlarmSent(file, 'old')).toBe('stale');
    const disk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(disk.ts).toBe('new');
    expect(disk.alarmSent).toBe(false);
  });
});

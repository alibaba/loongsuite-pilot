import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { AlarmManager } from '../../../src/metrics/alarm-manager.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockExecFileAsync = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:util', () => ({
  promisify: () => (...args: unknown[]) => mockExecFileAsync(...args),
}));

import { UpdaterWatchdog } from '../../../src/core/updater-watchdog.js';

const UPDATER_PID = 12345;
const realPlatform = process.platform;

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

async function writePid(dataDir: string, pid = UPDATER_PID): Promise<void> {
  await fs.writeFile(path.join(dataDir, 'loongsuite-pilot-updater.pid'), `${pid}\n`, 'utf-8');
}

async function writeHeartbeat(
  dataDir: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await fs.mkdir(path.join(dataDir, 'logs'), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'logs', 'updater-runtime.json'),
    JSON.stringify({
      status: 'running',
      pid: UPDATER_PID,
      version: '1.0.2',
      versionDir: '1.0.2_bbb',
      gitCommit: 'bbb',
      updatedAt: new Date().toISOString(),
      consecutiveFailures: 0,
      ...overrides,
    }),
    'utf-8',
  );
}

function makeAlarmManager(): AlarmManager {
  return new AlarmManager({ ip: '127.0.0.1', version: 'test', userId: 'test-user' });
}

describe('UpdaterWatchdog', () => {
  let tmpDir: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await createTempDir('updater-watchdog-test-');
    mockExecFileAsync.mockReset();
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'ps') {
        return Promise.resolve({
          stdout: 'node /home/test/.loongsuite-pilot/bin/updater-daemon.js\n',
          stderr: '',
        });
      }
      if (cmd === 'powershell.exe' && args.includes('-Command')) {
        return Promise.resolve({
          stdout: '12345\tpowershell.exe -Command node C:\\Users\\test\\.loongsuite-pilot\\bin\\updater-daemon.js\n',
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === UPDATER_PID && signal === 0) return true;
      throw new Error('not running');
    }) as typeof process.kill);
  });

  afterEach(async () => {
    mockPlatform(realPlatform);
    killSpy.mockRestore();
    vi.useRealTimers();
    await cleanupTempDir(tmpDir);
  });

  it('reports healthy when updater pid, command, and heartbeat match', async () => {
    await writePid(tmpDir);
    await writeHeartbeat(tmpDir);
    const alarms = makeAlarmManager();

    const wd = new UpdaterWatchdog({
      enabled: true,
      dataDir: tmpDir,
      loongsuitePilotBin: '/bin/loongsuite-pilot',
      startupGraceMs: 0,
      alarmManager: alarms,
    });

    const result = await wd.runCheck();

    expect(result.status).toBe('healthy');
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('/bin/loongsuite-pilot', ['restart-updater'], expect.anything());
    expect(alarms.serialize()).toEqual([]);
  });

  it('restarts and records service alarm when updater process is missing', async () => {
    const alarms = makeAlarmManager();
    const wd = new UpdaterWatchdog({
      enabled: true,
      dataDir: tmpDir,
      loongsuitePilotBin: '/bin/loongsuite-pilot',
      startupGraceMs: 0,
      alarmManager: alarms,
    });

    const result = await wd.runCheck();

    expect(result.status).toBe('restart-attempted');
    expect(mockExecFileAsync).toHaveBeenCalledWith('/bin/loongsuite-pilot', ['restart-updater'], expect.anything());
    expect(alarms.serialize()[0]).toMatchObject({
      alarm_type: 'SERVICE_NOT_RUNNING_ALARM',
      input_name: 'updater',
    });
  });

  it('restarts when updater command does not look like the updater daemon', async () => {
    await writePid(tmpDir);
    await writeHeartbeat(tmpDir);
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === 'ps') return Promise.resolve({ stdout: 'node /tmp/other.js\n', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const alarms = makeAlarmManager();
    const wd = new UpdaterWatchdog({
      enabled: true,
      dataDir: tmpDir,
      loongsuitePilotBin: '/bin/loongsuite-pilot',
      startupGraceMs: 0,
      alarmManager: alarms,
    });

    const result = await wd.runCheck();

    expect(result.status).toBe('restart-attempted');
    expect(alarms.serialize()[0]).toMatchObject({
      alarm_type: 'UPDATER_FAILURE_ALARM',
      input_name: 'updater',
    });
  });

  it('restarts when heartbeat is stale outside grace', async () => {
    await writePid(tmpDir);
    await writeHeartbeat(tmpDir, { updatedAt: new Date(Date.now() - 10_000).toISOString() });
    const alarms = makeAlarmManager();

    const wd = new UpdaterWatchdog({
      enabled: true,
      dataDir: tmpDir,
      loongsuitePilotBin: '/bin/loongsuite-pilot',
      staleHeartbeatMs: 1_000,
      startupGraceMs: 0,
      alarmManager: alarms,
    });

    const result = await wd.runCheck();

    expect(result.status).toBe('restart-attempted');
    expect(result.reason).toContain('stale');
    expect(alarms.serialize()[0]).toMatchObject({
      alarm_type: 'UPDATER_FAILURE_ALARM',
      input_name: 'updater',
    });
  });

  it('uses startup grace before restarting for stale heartbeat', async () => {
    await writePid(tmpDir);
    await writeHeartbeat(tmpDir, { updatedAt: new Date(Date.now() - 10_000).toISOString() });
    const wd = new UpdaterWatchdog({
      enabled: true,
      dataDir: tmpDir,
      loongsuitePilotBin: '/bin/loongsuite-pilot',
      staleHeartbeatMs: 1_000,
      startupGraceMs: 60_000,
    });

    const result = await wd.runCheck();

    expect(result.status).toBe('grace');
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('/bin/loongsuite-pilot', ['restart-updater'], expect.anything());
  });

  it('uses sleep/wake grace before restarting for stale heartbeat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:00:00Z'));
    await writePid(tmpDir);
    await writeHeartbeat(tmpDir);

    const wd = new UpdaterWatchdog({
      enabled: true,
      dataDir: tmpDir,
      loongsuitePilotBin: '/bin/loongsuite-pilot',
      intervalMs: 1_000,
      staleHeartbeatMs: 1_000,
      startupGraceMs: 0,
      sleepWakeGraceMs: 5_000,
    });

    expect((await wd.runCheck()).status).toBe('healthy');
    vi.setSystemTime(new Date('2026-06-16T00:00:07Z'));

    const result = await wd.runCheck();

    expect(result.status).toBe('grace');
    expect(mockExecFileAsync).not.toHaveBeenCalledWith('/bin/loongsuite-pilot', ['restart-updater'], expect.anything());
  });

  it('rate limits repeated restart attempts', async () => {
    const wd = new UpdaterWatchdog({
      enabled: true,
      dataDir: tmpDir,
      loongsuitePilotBin: '/bin/loongsuite-pilot',
      startupGraceMs: 0,
      restartCooldownMs: 60_000,
    });

    expect((await wd.runCheck()).status).toBe('restart-attempted');
    expect((await wd.runCheck()).status).toBe('restart-rate-limited');
    const restartCalls = mockExecFileAsync.mock.calls.filter(([cmd]) => cmd === '/bin/loongsuite-pilot');
    expect(restartCalls).toHaveLength(1);
  });

  it('records updater failure alarm when restart command fails', async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === '/bin/loongsuite-pilot') return Promise.reject(new Error('boom'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    const alarms = makeAlarmManager();
    const wd = new UpdaterWatchdog({
      enabled: true,
      dataDir: tmpDir,
      loongsuitePilotBin: '/bin/loongsuite-pilot',
      startupGraceMs: 0,
      alarmManager: alarms,
    });

    const result = await wd.runCheck();

    expect(result.status).toBe('restart-failed');
    expect(alarms.serialize()).toEqual(expect.arrayContaining([
      expect.objectContaining({ alarm_type: 'UPDATER_FAILURE_ALARM', input_name: 'updater' }),
    ]));
  });

  it('restarts through PowerShell on Windows', async () => {
    mockPlatform('win32');
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'powershell.exe' && args.includes('-Command')) {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const wd = new UpdaterWatchdog({
      enabled: true,
      dataDir: tmpDir,
      loongsuitePilotBin: 'C:\\Users\\test\\.local\\bin\\loongsuite-pilot.ps1',
      startupGraceMs: 0,
    });

    const result = await wd.runCheck();

    expect(result.status).toBe('restart-attempted');
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        '-File',
        'C:\\Users\\test\\.local\\bin\\loongsuite-pilot.ps1',
        'restart-updater',
      ]),
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('does not require heartbeat pid to match pid file on Windows', async () => {
    mockPlatform('win32');
    await writePid(tmpDir);
    await writeHeartbeat(tmpDir, { pid: 67890 });

    const wd = new UpdaterWatchdog({
      enabled: true,
      dataDir: tmpDir,
      loongsuitePilotBin: 'C:\\Users\\test\\.local\\bin\\loongsuite-pilot.ps1',
      startupGraceMs: 0,
    });

    const result = await wd.runCheck();

    expect(result.status).toBe('healthy');
    expect(mockExecFileAsync).not.toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-File', 'C:\\Users\\test\\.local\\bin\\loongsuite-pilot.ps1', 'restart-updater']),
      expect.anything(),
    );
  });

  it('does nothing when disabled', async () => {
    const wd = new UpdaterWatchdog({
      enabled: false,
      dataDir: tmpDir,
      loongsuitePilotBin: '/bin/loongsuite-pilot',
    });

    expect(await wd.runCheck()).toEqual({ status: 'disabled' });
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

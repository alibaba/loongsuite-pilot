import { describe, expect, it, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  checkProcessLiveness,
  COLLECTOR_PROCESS_PATTERNS,
  isCommandMatch,
  isProcessAlive,
  UPDATER_PROCESS_PATTERNS,
} from '../../../src/utils/pid-utils.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const readFileSyncMock = vi.mocked(fs.readFileSync);
const existsSyncMock = vi.mocked(fs.existsSync);
const execFileSyncMock = vi.mocked(execFileSync);

describe('pid-utils identity-first liveness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches strict collector and updater command identities', () => {
    expect(isCommandMatch('/usr/bin/node /home/a/.loongsuite-pilot/bin/collector-daemon.js', COLLECTOR_PROCESS_PATTERNS)).toBe(true);
    expect(isCommandMatch('/usr/bin/node /home/a/.loongsuite-pilot/bin/updater-daemon.js', UPDATER_PROCESS_PATTERNS)).toBe(true);
    expect(isCommandMatch('/usr/bin/node unrelated.js', COLLECTOR_PROCESS_PATTERNS)).toBe(false);
    expect(isCommandMatch('/usr/bin/node unrelated.js', UPDATER_PROCESS_PATTERNS)).toBe(false);
  });

  it('treats EPERM from kill zero as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    expect(isProcessAlive(123)).toBe(true);
  });

  it('uses pid file as fast path when pid command matches identity', () => {
    readFileSyncMock.mockReturnValueOnce('123\n');
    vi.spyOn(process, 'kill').mockReturnValue(true);
    execFileSyncMock.mockReturnValueOnce('/usr/bin/node /tmp/collector-daemon.js\n');

    const result = checkProcessLiveness('/tmp/pilot.pid', COLLECTOR_PROCESS_PATTERNS);

    expect(result).toMatchObject({
      running: true,
      pid: 123,
      source: 'pid-file',
      pidFileState: 'matched',
    });
  });

  it('falls through to process scan when pid file command is unreadable', () => {
    readFileSyncMock.mockReturnValueOnce('123\n');
    vi.spyOn(process, 'kill').mockReturnValue(true);
    execFileSyncMock.mockReturnValueOnce('');
    execFileSyncMock.mockReturnValueOnce('456 /usr/bin/node /tmp/collector-daemon.js\n');

    const result = checkProcessLiveness('/tmp/pilot.pid', COLLECTOR_PROCESS_PATTERNS);

    expect(result).toMatchObject({
      running: true,
      pid: 456,
      source: 'process-scan',
      pidFileState: 'stale',
      pidFileProcessAlive: true,
      pidFileCommandMatched: undefined,
    });
  });

  it('reports unhealthy when pid file command is unreadable and scan finds nothing', () => {
    readFileSyncMock.mockReturnValueOnce('123\n');
    vi.spyOn(process, 'kill').mockReturnValue(true);
    execFileSyncMock.mockReturnValueOnce('');
    execFileSyncMock.mockReturnValueOnce('456 /usr/bin/node unrelated.js\n');

    const result = checkProcessLiveness('/tmp/pilot.pid', COLLECTOR_PROCESS_PATTERNS);

    expect(result).toMatchObject({
      running: false,
      pid: 123,
      source: 'none',
      pidFileState: 'stale',
      pidFileProcessAlive: true,
      pidFileCommandMatched: undefined,
    });
  });

  it('does not report down when pid changed but command identity is present', () => {
    readFileSyncMock.mockReturnValueOnce('123\n');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('missing') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    execFileSyncMock.mockReturnValueOnce('456 /usr/bin/node /tmp/collector-daemon.js\n');

    const result = checkProcessLiveness('/tmp/pilot.pid', COLLECTOR_PROCESS_PATTERNS);

    expect(result).toMatchObject({
      running: true,
      pid: 456,
      source: 'process-scan',
      pidFileState: 'stale',
    });
  });

  it('reports unhealthy when pid is stale and no matching command exists', () => {
    readFileSyncMock.mockReturnValueOnce('123\n');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('missing') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    execFileSyncMock.mockReturnValueOnce('456 /usr/bin/node unrelated.js\n');

    const result = checkProcessLiveness('/tmp/pilot.pid', COLLECTOR_PROCESS_PATTERNS);

    expect(result).toMatchObject({
      running: false,
      pid: 123,
      source: 'none',
      pidFileState: 'stale',
    });
  });

  it('falls back to command identity when pid file is missing', () => {
    readFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    existsSyncMock.mockReturnValueOnce(false);
    execFileSyncMock.mockReturnValueOnce('789 /usr/bin/node /tmp/updater-daemon.js\n');

    const result = checkProcessLiveness('/tmp/updater.pid', UPDATER_PROCESS_PATTERNS);

    expect(result).toMatchObject({
      running: true,
      pid: 789,
      source: 'process-scan',
      pidFileState: 'missing',
    });
  });
});

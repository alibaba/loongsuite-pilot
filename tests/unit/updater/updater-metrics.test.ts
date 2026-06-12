import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const appendedLines: { path: string; line: string }[] = [];
vi.mock('../../../src/utils/fs-utils.js', () => ({
  appendLine: vi.fn(async (path: string, line: string) => {
    appendedLines.push({ path, line });
  }),
  ensureDir: vi.fn(),
}));

const mockSendAlarm = vi.fn();
const mockSendStatus = vi.fn();
vi.mock('../../../src/internal/sender.js', () => ({
  sendAlarm: (...args: unknown[]) => mockSendAlarm(...args),
  sendStatus: (...args: unknown[]) => mockSendStatus(...args),
}));

const mockReadFileSync = vi.fn<[string, string], string>();
vi.mock('node:fs', () => ({
  readFileSync: (...args: [string, string]) => mockReadFileSync(...args),
}));

import { UpdaterMetrics } from '../../../src/updater/updater-metrics.js';

describe('UpdaterMetrics', () => {
  let killSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    appendedLines.length = 0;
    mockSendAlarm.mockClear();
    mockSendStatus.mockClear();
    mockReadFileSync.mockReturnValue('12345\n');
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number) => {
      if (signal === 0) return true;
      throw new Error('not supported');
    }) as typeof process.kill);
  });

  afterEach(() => {
    killSpy?.mockRestore();
    killSpy = null;
    vi.useRealTimers();
  });

  function createMetrics() {
    return new UpdaterMetrics({
      dataDir: '/tmp/test-data',
      version: '1.0.0',
      collectorPidFile: '/tmp/test-data/loongsuite-pilot.pid',
    });
  }

  describe('writeEvent', () => {
    it('writes updater event to pilot-updater-events.jsonl after flush', async () => {
      const m = createMetrics();
      await m.start();
      m.writeEvent('updater_started');
      await m.stop();

      const eventLines = appendedLines.filter(l => l.path.includes('pilot-updater-events.jsonl'));
      expect(eventLines).toHaveLength(1);

      const parsed = JSON.parse(eventLines[0].line);
      expect(parsed.event_type).toBe('updater_started');
      expect(parsed.version).toBe('1.0.0');
      expect(parsed.ip).toBeDefined();
      expect(parsed.__time__).toBeTypeOf('number');
    });

    it('includes extra fields when provided', async () => {
      const m = createMetrics();
      await m.start();
      m.writeEvent('new_version_available', {
        current_version: '1.0.0',
        latest_version: '1.0.1',
      });
      await m.stop();

      const eventLines = appendedLines.filter(l => l.path.includes('pilot-updater-events.jsonl'));
      const parsed = JSON.parse(eventLines[0].line);
      expect(parsed.current_version).toBe('1.0.0');
      expect(parsed.latest_version).toBe('1.0.1');
    });

    it('includes error info for failure events', async () => {
      const m = createMetrics();
      await m.start();
      m.writeEvent('update_failure', {
        error: 'download timeout',
        consecutive_failures: 3,
      });
      await m.stop();

      const eventLines = appendedLines.filter(l => l.path.includes('pilot-updater-events.jsonl'));
      const parsed = JSON.parse(eventLines[0].line);
      expect(parsed.error).toBe('download timeout');
      expect(parsed.consecutive_failures).toBe(3);
    });
  });

  describe('writeAlarm', () => {
    it('writes alarm entry to pilot-alarms.jsonl after flush', async () => {
      const m = createMetrics();
      await m.start();
      m.writeAlarm('UPDATER_FAILURE_ALARM', '2', 'update failed');
      await m.stop();

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      expect(alarmLines).toHaveLength(1);

      const parsed = JSON.parse(alarmLines[0].line);
      expect(parsed.alarm_type).toBe('UPDATER_FAILURE_ALARM');
      expect(parsed.alarm_level).toBe('2');
      expect(parsed.alarm_message).toBe('update failed');
      expect(parsed.alarm_count).toBe('1');
      expect(parsed.ver).toBe('1.0.0');
    });
  });

  describe('flush cadence', () => {
    it('flushes queued events on 30s ticker', async () => {
      const m = createMetrics();
      await m.start();
      m.writeEvent('updater_started');

      expect(appendedLines.filter(l => l.path.includes('pilot-updater-events.jsonl'))).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      const eventLines = appendedLines.filter(l => l.path.includes('pilot-updater-events.jsonl'));
      expect(eventLines).toHaveLength(1);

      await m.stop();
    });

    it('coalesces multiple writes within one flush window', async () => {
      const m = createMetrics();
      await m.start();
      m.writeEvent('updater_started');
      m.writeEvent('check_started');
      m.writeAlarm('UPDATER_FAILURE_ALARM', '2', 'err');
      await m.stop();

      expect(appendedLines.filter(l => l.path.includes('pilot-updater-events.jsonl'))).toHaveLength(2);
      expect(appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'))).toHaveLength(1);
    });
  });

  describe('sendAlarm / sendStatus integration', () => {
    it('calls sendStatus for queued events on flush', async () => {
      const m = createMetrics();
      await m.start();
      m.writeEvent('updater_started');
      await m.stop();

      expect(mockSendStatus).toHaveBeenCalled();
      const call = mockSendStatus.mock.calls.find(
        (c: unknown[]) => c[0] === 'pilot_updater_event',
      );
      expect(call).toBeDefined();
      expect(call![1]).not.toHaveProperty('__topic__');
    });

    it('calls sendAlarm for queued alarms on flush', async () => {
      const m = createMetrics();
      await m.start();
      m.writeAlarm('UPDATER_FAILURE_ALARM', '2', 'test error');
      await m.stop();

      const call = mockSendAlarm.mock.calls.find(
        (c: unknown[]) => c[0] === 'pilot_alarm',
      );
      expect(call).toBeDefined();
      expect(call![1]).not.toHaveProperty('__topic__');
    });
  });

  describe('collector health check', () => {
    it('writes SERVICE_NOT_RUNNING_ALARM when collector PID file is missing', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const m = createMetrics();
      await m.start();
      await m.stop();

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      expect(alarmLines.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(alarmLines[0].line);
      expect(parsed.alarm_type).toBe('SERVICE_NOT_RUNNING_ALARM');
      expect(parsed.alarm_level).toBe('3');
    });

    it('does NOT write alarm when collector process is running', async () => {
      mockReadFileSync.mockReturnValue('12345\n');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number) => {
        if (signal === 0) return true;
        throw new Error('not supported');
      }) as typeof process.kill);

      const m = createMetrics();
      await m.start();
      await m.stop();

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      expect(alarmLines).toHaveLength(0);

      killSpy.mockRestore();
    });

    it('fires health check every 60 seconds', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const m = createMetrics();
      await m.start();

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);
      const before = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl')).length;

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      const after = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl')).length;
      expect(after).toBeGreaterThan(before);

      await m.stop();
    });
  });
});

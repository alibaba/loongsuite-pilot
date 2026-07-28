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
const mockExistsSync = vi.fn<[string], boolean>();
vi.mock('node:fs', () => ({
  readFileSync: (...args: [string, string]) => mockReadFileSync(...args),
  existsSync: (...args: [string]) => mockExistsSync(...args),
}));

import { UpdaterMetrics } from '../../../src/updater/updater-metrics.js';
import type { ProcessLiveness } from '../../../src/utils/pid-utils.js';

describe('UpdaterMetrics', () => {
  let killSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    appendedLines.length = 0;
    mockSendAlarm.mockClear();
    mockSendStatus.mockClear();
    mockReadFileSync.mockReturnValue('12345\n');
    mockExistsSync.mockReturnValue(true);
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

  function createMetrics(userId = 'test-user', collectorLiveness?: () => ProcessLiveness) {
    return new UpdaterMetrics({
      dataDir: '/tmp/test-data',
      version: '1.0.0',
      collectorPidFile: '/tmp/test-data/loongsuite-pilot.pid',
      userId,
      collectorLiveness,
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

    it('includes user_id in events', async () => {
      const m = createMetrics('user-123');
      await m.start();
      m.writeEvent('updater_started');
      await m.stop();

      const eventLines = appendedLines.filter(l => l.path.includes('pilot-updater-events.jsonl'));
      const parsed = JSON.parse(eventLines[0].line);
      expect(parsed.user_id).toBe('user-123');
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
      expect(parsed.user_id).toBe('test-user');
      expect(parsed.ver).toBe('1.0.0');
    });
  });

  describe('userId format alarm', () => {
    it('emits USER_ID_FORMAT_ALARM when userId has braces', async () => {
      const m = createMetrics('{123456}');
      await m.start();
      await m.stop();

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      const formatAlarm = alarmLines
        .map(l => JSON.parse(l.line))
        .find((a: { alarm_type: string }) => a.alarm_type === 'USER_ID_FORMAT_ALARM');
      expect(formatAlarm).toBeDefined();
      expect(formatAlarm.alarm_level).toBe('1');
      expect(formatAlarm.alarm_message).toContain('{123456}');
    });

    it('does not emit USER_ID_FORMAT_ALARM when userId is plain', async () => {
      const m = createMetrics('123456');
      await m.start();
      await m.stop();

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      const formatAlarm = alarmLines
        .map(l => JSON.parse(l.line))
        .find((a: { alarm_type: string }) => a.alarm_type === 'USER_ID_FORMAT_ALARM');
      expect(formatAlarm).toBeUndefined();
    });

    it('emits USER_ID_FORMAT_ALARM only once per lifetime', async () => {
      const m = createMetrics('{123456}');
      await m.start();

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      await m.stop();

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      const formatAlarms = alarmLines
        .map(l => JSON.parse(l.line))
        .filter((a: { alarm_type: string }) => a.alarm_type === 'USER_ID_FORMAT_ALARM');
      expect(formatAlarms).toHaveLength(1);
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
    it('suppresses SERVICE_NOT_RUNNING_ALARM during startup grace', async () => {
      const m = createMetrics('test-user', () => down('pid file is missing'));

      await m.start();
      await m.stop();

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      expect(alarmLines).toHaveLength(0);
    });

    it('requires two consecutive misses after startup grace before alarming', async () => {
      const m = createMetrics('test-user', () => down('no matching collector command found'));

      await m.start();
      await vi.advanceTimersByTimeAsync(3 * 60_000 + 60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      expect(alarmLines).toHaveLength(1);
      const parsed = JSON.parse(alarmLines[0].line);
      expect(parsed.alarm_type).toBe('SERVICE_NOT_RUNNING_ALARM');
      expect(parsed.alarm_message).toContain('no matching collector command found');
      await m.stop();
    });

    it('enriches SERVICE_NOT_RUNNING_ALARM with the startup-crash cause when a breadcrumb exists', async () => {
      mockReadFileSync.mockImplementation((p: string) => {
        if (p.includes('last-startup-crash.json')) {
          return JSON.stringify({
            schema: 1, ts: 1, phase: 'module_load', version: '9.9.9', pid: 1,
            error_message: 'Cannot open sqlite3 binding',
            error_stack_head: 'Error: Cannot open sqlite3 binding',
          });
        }
        return '12345\n';
      });
      const m = createMetrics('test-user', () => down('no matching collector command found'));

      await m.start();
      await vi.advanceTimersByTimeAsync(3 * 60_000 + 60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      expect(alarmLines).toHaveLength(1);
      const parsed = JSON.parse(alarmLines[0].line);
      expect(parsed.alarm_type).toBe('SERVICE_NOT_RUNNING_ALARM');
      expect(parsed.alarm_message).toContain('cause=native_module_missing');
      expect(parsed.alarm_message).toContain('version=9.9.9');
      expect(parsed.alarm_message).toContain('no matching collector command found');
      await m.stop();
    });

    it('does not alarm when collector PID changes but command identity is found', async () => {
      const m = createMetrics('test-user', () => ({
        running: true,
        pid: 456,
        source: 'process-scan',
        reason: 'matching process command found; pid file points to stale or mismatched pid 123',
        pidFileState: 'stale',
      }));

      await m.start();
      await vi.advanceTimersByTimeAsync(3 * 60_000 + 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await m.stop();

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      expect(alarmLines).toHaveLength(0);
    });

    it('resets collector failures after process identity recovery', async () => {
      let call = 0;
      const liveness = vi.fn<[], ProcessLiveness>().mockImplementation(() => {
        call++;
        if (call <= 4) return down('no matching collector command found');
        return { running: true, pid: 456, source: 'process-scan', reason: 'matching process command found' };
      });
      const m = createMetrics('test-user', liveness);

      await m.start();
      await vi.advanceTimersByTimeAsync(3 * 60_000 + 60_000);
      await m.stop();

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      expect(alarmLines).toHaveLength(0);
    });

    it('respects service alarm cooldown for persistent misses', async () => {
      const m = createMetrics('test-user', () => down('no matching collector command found'));

      await m.start();
      await vi.advanceTimersByTimeAsync(3 * 60_000 + 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      const alarmLines = appendedLines.filter(l => l.path.includes('pilot-alarms.jsonl'));
      expect(alarmLines).toHaveLength(1);
      await m.stop();
    });
  });
});

function down(reason: string): ProcessLiveness {
  return {
    running: false,
    source: 'none',
    reason,
    pidFileState: 'missing',
  };
}


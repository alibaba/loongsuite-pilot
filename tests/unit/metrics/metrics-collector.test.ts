import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetricsCollector } from '../../../src/metrics/metrics-collector.js';
import type { DataflowSnapshot } from '../../../src/metrics/metrics-collector.js';

function buildSnapshot(overrides: Partial<DataflowSnapshot> = {}): DataflowSnapshot {
  return {
    sendEntriesTotal: 0,
    receivedBytesTotal: 0,
    inputCount: 0,
    activeInputCount: 0,
    flusherRunner: {
      inEntries: 0, inBytes: 0, outEntries: 0, outFailed: 0,
      totalDelayMs: 0, lastFlushTime: '', startTime: '',
    },
    inputs: new Map(),
    flushers: new Map(),
    agentVersions: {},
    inputIdleMinutes: new Map(),
    ...overrides,
  };
}

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector({ version: '1.0.0', userId: 'test-user' });
  });

  describe('collectL1', () => {
    it('returns all required fields with correct types', () => {
      const snapshot = buildSnapshot({
        sendEntriesTotal: 100,
        receivedBytesTotal: 5000,
        inputCount: 3,
        activeInputCount: 2,
        flusherRunner: {
          inEntries: 80, inBytes: 4000, outEntries: 75, outFailed: 5,
          totalDelayMs: 1200, lastFlushTime: '2026-05-19 10:00:00', startTime: '2026-05-19 09:00:00',
        },
      });

      const result = collector.collectL1(snapshot);

      expect(result.version).toBe('1.0.0');
      expect(result.user_id).toBe('test-user');
      expect(result.hostname).toBe(require('os').hostname());
      expect(result.pid).toBe(process.pid);
      expect(result.os).toBe(require('os').type());
      expect(result.os_detail).toContain(require('os').type());
      expect(result.os_detail).toContain(require('os').arch());

      // instance_id format: userId_ip_timestamp
      expect(result.instance_id).toMatch(/^test-user_.+_\d+$/);

      // Numeric fields stored as strings
      expect(typeof result.cpu).toBe('string');
      expect(typeof result.mem).toBe('string');
      expect(typeof result.mem_heap).toBe('string');
      expect(Number(result.mem)).toBeGreaterThan(0);

      // metric_json fields
      expect(result.metric_json.input_count).toBe('3');
      expect(result.metric_json.active_input_count).toBe('2');
      expect(result.metric_json.send_entries_total).toBe('100');
      expect(result.metric_json.received_bytes_total).toBe('5000');
      expect(typeof result.metric_json.open_fd).toBe('string');

      // flusher_runner
      expect(result.flusher_runner.in_entries_total).toBe('80');
      expect(result.flusher_runner.in_bytes_total).toBe('4000');
      expect(result.flusher_runner.out_entries_total).toBe('75');
      expect(result.flusher_runner.out_failed_entries_total).toBe('5');
      expect(result.flusher_runner.last_flush_time).toBe('2026-05-19 10:00:00');

      // __time__ is unix timestamp
      expect(result.__time__).toBeGreaterThan(1700000000);
    });

    it('reports zero rates on the first sample (seeds baseline)', () => {
      // Even when the first snapshot already shows nonzero totals, the
      // collector must not divide them by a near-zero elapsed window.
      const result = collector.collectL1(buildSnapshot({
        sendEntriesTotal: 1234,
        receivedBytesTotal: 99999,
      }));
      expect(result.metric_json.send_entries_ps).toBe('0.0');
      expect(result.metric_json.received_bytes_ps).toBe('0.0');
    });

    it('calculates per-second rates from deltas after the first sample', async () => {
      // First call seeds baseline
      collector.collectL1(buildSnapshot({ sendEntriesTotal: 0, receivedBytesTotal: 0 }));

      // Wait a tick so elapsed > 0
      await new Promise(r => setTimeout(r, 50));

      const result = collector.collectL1(buildSnapshot({
        sendEntriesTotal: 60,
        receivedBytesTotal: 3000,
      }));

      const entriesPs = parseFloat(result.metric_json.send_entries_ps);
      const bytesPs = parseFloat(result.metric_json.received_bytes_ps);

      // Rates should be positive (delta / elapsed)
      expect(entriesPs).toBeGreaterThan(0);
      expect(bytesPs).toBeGreaterThan(0);
    });

    it('start_time remains constant across calls', () => {
      const r1 = collector.collectL1(buildSnapshot());
      const r2 = collector.collectL1(buildSnapshot());
      expect(r1.start_time).toBe(r2.start_time);
    });

    it('ip field is a valid IPv4 address', () => {
      const result = collector.collectL1(buildSnapshot());
      expect(result.ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    });
  });

  describe('collectL2Inputs', () => {
    it('returns one InputMetrics per input in snapshot', () => {
      const inputs = new Map<string, any>();
      inputs.set('qoder-sqlite', {
        inEvents: 42, inBytes: 1024, outEvents: 40, outFailed: 2,
        lastPollTime: '2026-05-19 10:01:00', startTime: '2026-05-19 09:00:00',
        type: 'polling',
      });
      inputs.set('cursor-hook', {
        inEvents: 10, inBytes: 500, outEvents: 10, outFailed: 0,
        lastPollTime: '2026-05-19 10:02:00', startTime: '2026-05-19 09:30:00',
        type: 'hook',
      });

      const result = collector.collectL2Inputs(buildSnapshot({ inputs }));

      expect(result).toHaveLength(2);

      const qoder = result.find(r => r.label.input_name === 'qoder-sqlite')!;
      expect(qoder.category).toBe('input');
      expect(qoder.label.input_type).toBe('polling');
      expect(qoder.in_events_total).toBe('42');
      expect(qoder.in_size_bytes).toBe('1024');
      expect(qoder.out_events_total).toBe('40');
      expect(qoder.out_failed_events_total).toBe('2');
      expect(qoder.last_poll_time).toBe('2026-05-19 10:01:00');
      expect(qoder.start_time).toBe('2026-05-19 09:00:00');
      expect(qoder.__time__).toBeGreaterThan(0);
    });

    it('returns empty array when no inputs', () => {
      const result = collector.collectL2Inputs(buildSnapshot());
      expect(result).toEqual([]);
    });
  });

  describe('collectL2Flushers', () => {
    it('returns one FlusherMetrics per endpoint in snapshot', () => {
      const flushers = new Map<string, any>();
      flushers.set('internal-default', {
        inEntries: 200, inBytes: 50000, outEntries: 195, outFailed: 5,
        totalDelayMs: 3500, lastFlushTime: '2026-05-19 10:05:00',
        startTime: '2026-05-19 09:00:00', flusherName: 'sls', mode: 'webtracking',
        endpoint: 'https://cn-heyuan.log.aliyuncs.com', project: 'my-project', logstore: 'my-logstore',
      });

      const result = collector.collectL2Flushers(buildSnapshot({ flushers }));

      expect(result).toHaveLength(1);
      const ep = result[0];
      expect(ep.category).toBe('flusher');
      expect(ep.label.flusher_name).toBe('sls');
      expect(ep.label.endpoint_name).toBe('https://cn-heyuan.log.aliyuncs.com');
      expect(ep.label.project).toBe('my-project');
      expect(ep.label.logstore).toBe('my-logstore');
      expect(ep.label.mode).toBe('webtracking');
      expect(ep.in_entries_total).toBe('200');
      expect(ep.in_size_bytes).toBe('50000');
      expect(ep.out_entries_total).toBe('195');
      expect(ep.out_failed_entries_total).toBe('5');
      expect(ep.total_delay_ms).toBe('3500');
      expect(ep.last_flush_time).toBe('2026-05-19 10:05:00');
      expect(ep.start_time).toBe('2026-05-19 09:00:00');
    });

    it('returns empty array when no flushers', () => {
      const result = collector.collectL2Flushers(buildSnapshot());
      expect(result).toEqual([]);
    });
  });

  describe('calcCpuPercent (via collectL1)', () => {
    it('reports zero CPU on first sample to avoid startup inflation', () => {
      const result = collector.collectL1(buildSnapshot());
      expect(Number(result.cpu)).toBe(0);
    });

    it('reports non-negative CPU on second sample', async () => {
      collector.collectL1(buildSnapshot());
      await new Promise(r => setTimeout(r, 50));
      const result = collector.collectL1(buildSnapshot());
      expect(Number(result.cpu)).toBeGreaterThanOrEqual(0);
    });

    it('computes per-process CPU percentage from cpuUsage deltas', () => {
      const cpuSpy = vi.spyOn(process, 'cpuUsage');
      let clock = 1_000_000;
      const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);

      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user' });

      // First collectL1 → calcCpuPercent seeds baseline, returns 0
      cpuSpy.mockReturnValueOnce({ user: 0, system: 0 });
      const r1 = col.collectL1(buildSnapshot());
      expect(Number(r1.cpu)).toBe(0);

      // Advance wall clock by 1000ms
      clock += 1000;

      // Second collectL1 → 150ms of CPU time (100ms user + 50ms system)
      cpuSpy.mockReturnValueOnce({ user: 100_000, system: 50_000 });
      const r2 = col.collectL1(buildSnapshot());
      // Per-process CPU: (150_000µs / 1000 / 1000ms) * 100 = 15%
      expect(Number(r2.cpu)).toBe(15);

      cpuSpy.mockRestore();
      dateSpy.mockRestore();
    });
  });

  describe('collectL2Alarms', () => {
    it('returns per-input alarm rows scoped to the input only', () => {
      const inputs = new Map<string, any>();
      inputs.set('cursor-hook', {
        inEvents: 20, inBytes: 4096, outEvents: 18, outFailed: 2,
        lastPollTime: '2026-05-19 10:00:00', startTime: '2026-05-19 09:00:00', type: 'hook-jsonl',
      });
      const inputIdleMinutes = new Map([['cursor-hook', 5]]);

      const result = collector.collectL2Alarms(buildSnapshot({ inputs, inputIdleMinutes }));

      expect(result).toHaveLength(1);
      const m = result[0];
      expect(m.category).toBe('alarm');
      expect(m.input_name).toBe('cursor-hook');
      expect(m.succeed_events).toBe('18');
      expect(m.failed_events).toBe('2');
      expect(m.input_idle_minutes).toBe('5');
      expect(m.instance_id).toContain('test-user');
      expect(m.__time__).toBeGreaterThan(0);
      // Global flusher stats must NOT be smeared across per-input rows
      // (they live in collectL2Flushers instead).
      expect((m as Record<string, unknown>).flush_failed_total).toBeUndefined();
      expect((m as Record<string, unknown>).flush_latency_avg_ms).toBeUndefined();
    });

    it('returns empty when no inputs', () => {
      expect(collector.collectL2Alarms(buildSnapshot())).toEqual([]);
    });
  });
});

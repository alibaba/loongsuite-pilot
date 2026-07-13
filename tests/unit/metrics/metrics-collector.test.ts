import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MetricsCollector } from '../../../src/metrics/metrics-collector.js';
import type { DataflowSnapshot } from '../../../src/metrics/metrics-collector.js';
import type { ProcessLiveness } from '../../../src/utils/pid-utils.js';

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
    inputIdleMinutes: new Map(),
    ...overrides,
  };
}

describe('MetricsCollector', () => {
  let collector: MetricsCollector;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-collector-test-'));
    collector = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });

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

  describe('init_type', () => {
    it('reads launchd from init-type file', () => {
      fs.writeFileSync(path.join(tmpDir, 'init-type'), 'launchd');
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).init_type).toBe('launchd');
    });

    it('reads nohup from init-type file', () => {
      fs.writeFileSync(path.join(tmpDir, 'init-type'), 'nohup');
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).init_type).toBe('nohup');
    });

    it('defaults to unknown when init-type file does not exist', () => {
      expect(collector.collectL1(buildSnapshot()).init_type).toBe('unknown');
    });

    it('defaults to unknown when init-type file is empty', () => {
      fs.writeFileSync(path.join(tmpDir, 'init-type'), '');
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).init_type).toBe('unknown');
    });
  });

  describe('infra health (via collectL1)', () => {
    it('reports updater_pid_alive=true during grace period even if updater liveness is down', () => {
      const col = new MetricsCollector({
        version: '1.0.0',
        userId: 'test-user',
        dataDir: tmpDir,
        updaterLiveness: () => down('pid file is missing'),
      });
      const r1 = col.collectL1(buildSnapshot());
      const r2 = col.collectL1(buildSnapshot());
      expect(r1.updater_pid_alive).toBe('true');
      expect(r2.updater_pid_alive).toBe('true');
    });

    it('reports updater_pid_alive=false after grace period when updater identity is absent', () => {
      const col = new MetricsCollector({
        version: '1.0.0',
        userId: 'test-user',
        dataDir: tmpDir,
        updaterLiveness: () => down('no matching updater command found'),
      });
      col.collectL1(buildSnapshot());
      col.collectL1(buildSnapshot());
      const r3 = col.collectL1(buildSnapshot());
      expect(r3.updater_pid_alive).toBe('false');
      expect(col.getLastInfraHealth()!.updaterConsecutiveFailures).toBe(1);
    });

    it('reports updater_pid_alive=true when stale PID is recovered by process identity scan', () => {
      const col = new MetricsCollector({
        version: '1.0.0',
        userId: 'test-user',
        dataDir: tmpDir,
        updaterLiveness: () => ({
          running: true,
          pid: 456,
          source: 'process-scan',
          reason: 'matching process command found; pid file points to stale or mismatched pid 123',
          pidFileState: 'stale',
        }),
      });
      col.collectL1(buildSnapshot());
      col.collectL1(buildSnapshot());
      const r3 = col.collectL1(buildSnapshot());
      expect(r3.updater_pid_alive).toBe('true');
      expect(col.getLastInfraHealth()!.updaterConsecutiveFailures).toBe(0);
    });

    it('increments consecutive failures and resets on identity match', () => {
      const liveness = vi.fn<[], ProcessLiveness>()
        .mockReturnValueOnce(down('no matching updater command found'))
        .mockReturnValueOnce(down('no matching updater command found'))
        .mockReturnValueOnce({ running: true, pid: 456, source: 'process-scan', reason: 'matching process command found' });
      const col = new MetricsCollector({
        version: '1.0.0',
        userId: 'test-user',
        dataDir: tmpDir,
        updaterLiveness: liveness,
      });
      col.collectL1(buildSnapshot());
      col.collectL1(buildSnapshot());
      col.collectL1(buildSnapshot());
      expect(col.getLastInfraHealth()!.updaterConsecutiveFailures).toBe(1);
      col.collectL1(buildSnapshot());
      expect(col.getLastInfraHealth()!.updaterConsecutiveFailures).toBe(2);
      col.collectL1(buildSnapshot());
      expect(col.getLastInfraHealth()!.updaterConsecutiveFailures).toBe(0);
      expect(col.getLastInfraHealth()!.updaterPidAlive).toBe(true);
    });

    it('reports current_version_valid=true when current points to existing version dir', () => {
      fs.mkdirSync(path.join(tmpDir, 'versions', '1.0.0_abc'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'current'), '1.0.0_abc');
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).current_version_valid).toBe('true');
    });

    it('reports current_version_valid=false when current points to non-existent dir', () => {
      fs.writeFileSync(path.join(tmpDir, 'current'), 'missing_version');
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).current_version_valid).toBe('false');
    });

    it('reports node_bin_valid=true when node-bin points to executable', () => {
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), process.execPath);
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).node_bin_valid).toBe('true');
    });

    it('reports node_bin_valid=false when node-bin points to non-existent path', () => {
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), '/nonexistent/path/node');
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).node_bin_valid).toBe('false');
    });

    it('reports rollback_available based on previous file validity', () => {
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).rollback_available).toBe('false');

      fs.mkdirSync(path.join(tmpDir, 'versions', '0.9.0_def'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'previous'), '0.9.0_def');
      const col2 = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col2.collectL1(buildSnapshot()).rollback_available).toBe('true');
    });

    it('reports correct version_count excluding dotfiles', () => {
      fs.mkdirSync(path.join(tmpDir, 'versions', 'v1'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'versions', 'v2'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'versions', '.DS_Store'), '');
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).version_count).toBe('2');
    });
  });

  describe('capture_message_disabled_agents', () => {
    it('returns empty string when no agents configured', () => {
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).capture_message_disabled_agents).toBe('');
    });

    it('lists only agents with captureMessageContent=false in sorted order', () => {
      const col = new MetricsCollector({
        version: '1.0.0',
        userId: 'test-user',
        dataDir: tmpDir,
        agentsConfig: {
          cursor: { captureMessageContent: false },
          'claude-code': { captureMessageContent: false },
          codex: { captureMessageContent: true },
        },
      });
      expect(col.collectL1(buildSnapshot()).capture_message_disabled_agents).toBe('claude-code cursor');
    });

    it('excludes agents whose captureMessageContent is true', () => {
      const col = new MetricsCollector({
        version: '1.0.0',
        userId: 'test-user',
        dataDir: tmpDir,
        agentsConfig: {
          cursor: { captureMessageContent: true },
        },
      });
      expect(col.collectL1(buildSnapshot()).capture_message_disabled_agents).toBe('');
    });
  });

  describe('project', () => {
    it('returns empty string when no SLS endpoints', () => {
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).project).toBe('');
    });

    it('joins unique projects with space in sorted order', () => {
      const col = new MetricsCollector({
        version: '1.0.0',
        userId: 'test-user',
        dataDir: tmpDir,
        slsEndpoints: [
          { name: 'a', endpoint: 'https://x', project: 'bbb', logstore: 'l1', kind: 'agentActivity', mode: 'ak' },
          { name: 'b', endpoint: 'https://x', project: 'aaa', logstore: 'l2', kind: 'agentActivity', mode: 'ak' },
          { name: 'c', endpoint: 'https://x', project: 'aaa', logstore: 'l3', kind: 'agentActivity', mode: 'ak' },
        ],
      });
      expect(col.collectL1(buildSnapshot()).project).toBe('aaa bbb');
    });
  });

  describe('cms_workspace', () => {
    it('returns empty string when not configured', () => {
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).cms_workspace).toBe('');
    });

    it('returns the configured workspace verbatim', () => {
      const col = new MetricsCollector({
        version: '1.0.0',
        userId: 'test-user',
        dataDir: tmpDir,
        cmsWorkspace: 'ws-abc',
      });
      expect(col.collectL1(buildSnapshot()).cms_workspace).toBe('ws-abc');
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

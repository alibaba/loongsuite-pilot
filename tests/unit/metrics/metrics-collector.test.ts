import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MetricsCollector } from '../../../src/metrics/metrics-collector.js';
import type { DataflowSnapshot } from '../../../src/metrics/metrics-collector.js';
import type { ProcessLiveness } from '../../../src/utils/pid-utils.js';

const fsMockState: {
  blockAccessSync: boolean;
  accessOverride: ((p: string, mode?: number) => void) | null;
} = { blockAccessSync: false, accessOverride: null };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    accessSync: (p: fs.PathLike, mode?: number) => {
      if (fsMockState.accessOverride) {
        return fsMockState.accessOverride(String(p), mode);
      }
      if (fsMockState.blockAccessSync && mode === actual.constants.X_OK) {
        throw new Error(`EACCES: permission denied, access '${p}'`);
      }
      return actual.accessSync(p as any, mode);
    },
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const execMockState: {
  override: ((file: string) => string) | null;
} = { override: null };

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (file: any, args?: any, opts?: any) => {
      if (execMockState.override) {
        return execMockState.override(String(file));
      }
      return actual.execFileSync(file, args, opts);
    },
  };
});

/** Inputs are a collection detail; what the tests care about is the owning agent. */
function inputEntry(agent: string, overrides: Record<string, any> = {}): any {
  return {
    sourceKind: 'primary',
    rawReadCalls: 0, rawReadBytes: 0,
    rawInRecords: 0, rawInBytes: 0,
    rawInMaxBatchBytes: 0, rawInMaxRecordBytes: 0, rawBacklogBytesMax: 0,
    parseSuccessRecords: 0, parseFailedRecords: 0,
    readDurationMs: 0, processDurationMs: 0,
    inEvents: 0, inBytes: 0, outFailed: 0,
    lastPollTime: '', startTime: '', type: 'polling', agent,
    running: true, ...overrides,
  };
}

/** Egress is measured where the writes happen: one entry per destination. */
function flusherEntry(kind: string, overrides: Record<string, any> = {}): any {
  return {
    kind, project: '', logstore: '', mode: '',
    // SLS counts the bytes it serializes; the OTLP families can only estimate.
    bytesBasis: kind === 'sls' ? 'measured' : 'estimated',
    inEntries: 0, inBytes: 0, outEntries: 0, outBytes: 0, outFailed: 0,
    totalDelayMs: 0, lastFlushTime: '', startTime: '',
    ...overrides,
  };
}

function buildSnapshot(overrides: Partial<DataflowSnapshot> = {}): DataflowSnapshot {
  return {
    inEventsTotal: 0,
    inBytesTotal: 0,
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
        inEventsTotal: 110,
        inBytesTotal: 5000,
        // Egress is the flusher side, summed over every destination the data was
        // written to: 70+30 entries and 3000+1800 bytes.
        flushers: new Map<string, any>([
          ['sls:main', flusherEntry('sls', { outEntries: 70, outBytes: 3000 })],
          ['cms:arms', flusherEntry('cms', { outEntries: 30, outBytes: 1800 })],
        ]),
        // qoder owns two inputs, cursor one, and kiro-cli is registered but never
        // started — so the agent dimension reads 2 installed, 1 of them collecting.
        inputs: new Map<string, any>([
          ['qoder-sqlite', inputEntry('qoder')],
          ['qoder-trace', inputEntry('qoder')],
          ['cursor-hook', inputEntry('cursor')],
          ['kiro-cli', inputEntry('kiro-cli', { running: false })],
        ]),
        inputIdleMinutes: new Map([['qoder-sqlite', 4]]),
      });

      const result = collector.collectL1(snapshot);

      expect(result.version).toBe('1.0.0');
      expect(result.user_id).toBe('test-user');
      expect(result.hostname).toBe(require('os').hostname());
      expect(result.pid).toBe(process.pid);
      expect(result.os_detail).toContain(require('os').type());
      expect(result.os_detail).toContain(require('os').arch());

      // instance_id: hostname_userid_<base64url(dataDir)> (no timestamp, restart-invariant)
      const dirEnc = Buffer.from(tmpDir, 'utf8').toString('base64url');
      expect(result.instance_id).toBe(`${require('os').hostname()}_test-user_${dirEnc}`);
      // dataDir is encoded, not plaintext, but reversible
      expect(result.instance_id).not.toContain(tmpDir);
      expect(Buffer.from(dirEnc, 'base64url').toString('utf8')).toBe(tmpDir);
      // run_id: instance_id plus the startTimestamp incarnation suffix
      expect(result.run_id.startsWith(result.instance_id + '_')).toBe(true);
      expect(result.run_id).toMatch(/_\d+$/);

      // Numeric fields stored as strings
      expect(typeof result.cpu).toBe('string');
      expect(typeof result.mem).toBe('string');
      expect(typeof result.mem_heap).toBe('string');
      expect(Number(result.mem)).toBeGreaterThan(0);

      // metric_json fields — agent-dimensioned, inputs never surface
      expect(result.metric_json.agent_count).toBe('2');
      expect(result.metric_json.active_agent_count).toBe('1');
      expect((result.metric_json as Record<string, unknown>).input_count).toBeUndefined();
      expect((result.metric_json as Record<string, unknown>).active_input_count).toBeUndefined();
      // Raw source metrics stay on type=input rows until every Input has the
      // same instrumentation coverage; mixing partial raw totals with complete
      // event totals at L1 would make the funnel misleading.
      expect(result.metric_json).not.toHaveProperty('raw_in_records');
      expect(result.metric_json).not.toHaveProperty('raw_in_bytes');
      expect(result.metric_json).not.toHaveProperty('raw_in_max_batch_bytes');
      expect(result.metric_json.in_events).toBe('110');
      expect(result.metric_json.in_bytes).toBe('5000');
      // Instance egress: what was written to the backends, not what the inputs
      // handed to the fan-out.
      expect(result.metric_json.out_events).toBe('100');
      expect(result.metric_json.out_bytes).toBe('4800');
      expect(typeof result.metric_json.window_ms).toBe('string');
      expect(typeof result.metric_json.open_fd).toBe('string');

      // flusher_runner is removed — per-flusher detail lives in pilot_pipeline now
      expect((result as Record<string, unknown>).flusher_runner).toBeUndefined();

      // updater events are NOT in status telemetry (local JSONL + alarms only)
      expect((result as Record<string, unknown>).updater_event).toBeUndefined();

      // __time__ is unix timestamp
      expect(result.__time__).toBeGreaterThan(1700000000);
    });

    it('counts installed agents, and an agent stays installed while idle', () => {
      const result = collector.collectL1(buildSnapshot({
        inputs: new Map<string, any>([
          ['qoder-sqlite', inputEntry('qoder')],
          ['codex-jsonl', inputEntry('codex')],
          // Registered for an agent this host does not have: never started.
          ['wukong-hook', inputEntry('wukong', { running: false })],
        ]),
        // Only qoder has ever collected; codex is installed but has produced nothing.
        inputIdleMinutes: new Map([['qoder-sqlite', 120], ['codex-jsonl', -1]]),
      }));

      expect(result.metric_json.agent_count).toBe('2');
      expect(result.metric_json.active_agent_count).toBe('1');
    });

    it('reports zero rates on the first sample (seeds baseline)', () => {
      // Even when the first snapshot already shows nonzero totals, the
      // collector must not divide them by a near-zero elapsed window.
      const result = collector.collectL1(buildSnapshot({
        inEventsTotal: 1234,
        inBytesTotal: 99999,
        flushers: new Map<string, any>([['sls:main', flusherEntry('sls', { outEntries: 1200, outBytes: 88888 })]]),
      }));
      expect(result.metric_json.in_events_ps).toBe('0.0');
      expect(result.metric_json.in_bytes_ps).toBe('0.0');
      expect(result.metric_json.out_events_ps).toBe('0.0');
      expect(result.metric_json.out_bytes_ps).toBe('0.0');
    });

    it('calculates per-second rates from deltas after the first sample', async () => {
      // First call seeds baseline
      collector.collectL1(buildSnapshot({
        inEventsTotal: 0, inBytesTotal: 0,
        flushers: new Map<string, any>([['sls:main', flusherEntry('sls')]]),
      }));

      // Wait a tick so elapsed > 0
      await new Promise(r => setTimeout(r, 50));

      const result = collector.collectL1(buildSnapshot({
        inEventsTotal: 70,
        inBytesTotal: 3000,
        flushers: new Map<string, any>([['sls:main', flusherEntry('sls', { outEntries: 60, outBytes: 2800 })]]),
      }));

      // Rates should be positive (delta / elapsed) across all four dimensions
      expect(parseFloat(result.metric_json.in_events_ps)).toBeGreaterThan(0);
      expect(parseFloat(result.metric_json.in_bytes_ps)).toBeGreaterThan(0);
      expect(parseFloat(result.metric_json.out_events_ps)).toBeGreaterThan(0);
      expect(parseFloat(result.metric_json.out_bytes_ps)).toBeGreaterThan(0);
    });

    it('drains flow values on report, so an idle window reads zero', () => {
      const snapshot = buildSnapshot({
        inEventsTotal: 110, inBytesTotal: 5000,
        flushers: new Map<string, any>([['sls:main', flusherEntry('sls', { outEntries: 100, outBytes: 4800 })]]),
      });

      const first = collector.collectL1(snapshot);
      expect(first.metric_json.in_events).toBe('110');
      expect(first.metric_json.out_bytes).toBe('4800');

      // Same cumulative totals means nothing flowed since the previous row.
      const second = collector.collectL1(snapshot);
      expect(second.metric_json.in_events).toBe('0');
      expect(second.metric_json.in_bytes).toBe('0');
      expect(second.metric_json.out_events).toBe('0');
      expect(second.metric_json.out_bytes).toBe('0');

      // Only the increment shows up in the next row, never the running total.
      const third = collector.collectL1(buildSnapshot({
        inEventsTotal: 135, inBytesTotal: 5600,
        flushers: new Map<string, any>([['sls:main', flusherEntry('sls', { outEntries: 130, outBytes: 5400 })]]),
      }));
      expect(third.metric_json.in_events).toBe('25');
      expect(third.metric_json.in_bytes).toBe('600');
      expect(third.metric_json.out_events).toBe('30');
      expect(third.metric_json.out_bytes).toBe('600');
    });

    it('clamps at zero when a counter goes backwards', () => {
      collector.collectL1(buildSnapshot({ inEventsTotal: 100, inBytesTotal: 4000 }));
      // Source counters are monotonic in practice; a regression here would
      // otherwise report a large negative window.
      const result = collector.collectL1(buildSnapshot({ inEventsTotal: 10, inBytesTotal: 400 }));
      expect(result.metric_json.in_events).toBe('0');
      expect(result.metric_json.in_bytes).toBe('0');
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

  describe('collectL2', () => {
    function pipelineSnapshot(): DataflowSnapshot {
      const inputs = new Map<string, any>();
      // Two inputs owned by the same agent — they must roll up into one entry.
      inputs.set('qoder-sqlite', inputEntry('qoder', {
        rawInRecords: 50, rawInBytes: 2048, rawInMaxBatchBytes: 1600,
        inEvents: 42, inBytes: 1024, outFailed: 2,
        lastPollTime: '2026-05-19 10:01:00', startTime: '2026-05-19 09:00:00',
      }));
      inputs.set('qoder-trace', inputEntry('qoder', {
        rawReadCalls: 4, rawReadBytes: 1024,
        rawInRecords: 10, rawInBytes: 512, rawInMaxBatchBytes: 4096,
        rawInMaxRecordBytes: 128, rawBacklogBytesMax: 2048,
        parseSuccessRecords: 9, parseFailedRecords: 1,
        readDurationMs: 12.4, processDurationMs: 21.6,
        inEvents: 8, inBytes: 256, outFailed: 0,
        lastPollTime: '2026-05-19 10:03:00', startTime: '2026-05-19 08:30:00',
        type: 'trace',
      }));
      inputs.set('cursor-hook', inputEntry('cursor', {
        rawInRecords: 12, rawInBytes: 700, rawInMaxBatchBytes: 700,
        inEvents: 10, inBytes: 500, outFailed: 0,
        lastPollTime: '2026-05-19 10:02:00', startTime: '2026-05-19 09:30:00',
        type: 'hook',
      }));
      const inputIdleMinutes = new Map([['qoder-sqlite', 3], ['qoder-trace', 7]]);

      const flushers = new Map<string, any>();
      flushers.set('sls:main', flusherEntry('sls', {
        project: 'proj-a', logstore: 'store-a', mode: 'sls',
        inEntries: 200, inBytes: 50000, outEntries: 195, outBytes: 48000, outFailed: 5,
        totalDelayMs: 3500, lastFlushTime: '2026-05-19 10:05:00',
        startTime: '2026-05-19 09:00:00',
      }));
      flushers.set('cms:arms', flusherEntry('cms', {
        inEntries: 60, inBytes: 9000, outEntries: 60, outBytes: 8800,
        totalDelayMs: 900, lastFlushTime: '2026-05-19 10:06:00',
        startTime: '2026-05-19 09:10:00',
      }));

      return buildSnapshot({
        inputs, inputIdleMinutes, flushers,
        inEventsTotal: 60, inBytesTotal: 1780,
      });
    }

    function agentRow(rows: any[], agent: string): any {
      return rows.find(r => r.agent === agent);
    }

    it('emits only detail rows — no instance-total row', () => {
      const l2 = collector.collectL2(pipelineSnapshot())!;

      // The total would be the exact sum of these rows over one window, and L1
      // already reports the same four axes plus agent_count for the instance.
      // Emitting it a third time is three chances for the numbers to disagree.
      expect(Object.keys(l2).sort()).toEqual(['agents', 'flushers', 'inputs']);
      expect([...l2.agents, ...l2.inputs, ...l2.flushers].map(r => r.type).includes('pipeline' as never)).toBe(false);

      // Raw totals are recoverable only from Input rows, whose coverage and
      // dimensions are explicit. Agent rows keep the complete event totals.
      const sum = (rows: any[], field: string): number =>
        rows.reduce((acc, r) => acc + Number(r[field]), 0);
      expect(sum(l2.inputs, 'raw_in_records')).toBe(72);
      expect(sum(l2.inputs, 'raw_in_bytes')).toBe(3260);
      expect(sum(l2.agents, 'in_events')).toBe(60);
      expect(sum(l2.agents, 'in_bytes')).toBe(1780);
      expect(sum(l2.flushers, 'out_entries')).toBe(255);
      expect(sum(l2.flushers, 'out_bytes')).toBe(56800);
    });

    it('repeats the full identity on every row', () => {
      const { agents, inputs, flushers } = collector.collectL2(pipelineSnapshot())!;
      // Same values L1 reports — the two levels must not disagree about the host.
      const l1 = collector.collectL1(buildSnapshot());

      // Identity is repeated on every row so each type can be queried on its own,
      // with no join to another row (or to L1) needed to learn the host.
      for (const row of [...agents, ...inputs, ...flushers]) {
        expect(row.hostname).toBe(require('os').hostname());
        expect(row.hostname).toBe(l1.hostname);
        expect(row.ip).toBe(l1.ip);
        expect(row.instance_id).toBe(`${require('os').hostname()}_test-user_${Buffer.from(tmpDir, 'utf8').toString('base64url')}`);
        expect(row.run_id).toMatch(/_\d+$/);
        expect(row.user_id).toBe(l1.user_id);
        expect(Number(row.window_ms)).toBeGreaterThanOrEqual(0);
        expect(row.__time__).toBeGreaterThan(0);
      }
      // One window per cycle: every row of the cycle must carry the same one.
      const windows = new Set([...agents, ...inputs, ...flushers].map(r => r.window_ms));
      expect(windows.size).toBe(1);
    });

    it('reports one complete row per Input without dynamic identifiers', () => {
      const { inputs } = collector.collectL2(pipelineSnapshot())!;
      const qoder = inputs.find(row => row.input_name === 'qoder-trace')!;

      expect(qoder).toMatchObject({
        type: 'input',
        agent: 'qoder',
        source_kind: 'primary',
        collection_method: 'trace',
        raw_read_calls: '4',
        raw_read_bytes: '1024',
        raw_in_records: '10',
        raw_in_bytes: '512',
        raw_in_max_batch_bytes: '4096',
        raw_in_max_record_bytes: '128',
        raw_backlog_bytes_max: '2048',
        parse_success_records: '9',
        parse_failed_records: '1',
        read_duration_ms: '12',
        process_duration_ms: '22',
        in_events: '8',
        in_bytes: '256',
        failed_events: '0',
      });
      expect(qoder).not.toHaveProperty('session_id');
      expect(qoder).not.toHaveProperty('turn_id');
      expect(qoder).not.toHaveProperty('trace_id');
    });

    it('rolls ingress up by owning agent, one row each', () => {
      const { agents } = collector.collectL2(pipelineSnapshot())!;

      expect(agents.map(r => r.agent).sort()).toEqual(['cursor', 'qoder']);
      expect(agents.every(r => r.type === 'agent')).toBe(true);

      const qoder = agentRow(agents, 'qoder');
      expect(qoder).not.toHaveProperty('raw_in_records');
      expect(qoder).not.toHaveProperty('raw_in_bytes');
      expect(qoder).not.toHaveProperty('raw_in_max_batch_bytes');
      expect(qoder.in_events).toBe('50');
      expect(qoder.in_bytes).toBe('1280');
      // Ingress only: egress cannot be attributed to an agent, it lives per flusher.
      expect(qoder.out_events).toBeUndefined();
      expect(qoder.out_bytes).toBeUndefined();
      expect(qoder.failed_events).toBe('2');
      // Most-recent poll and earliest start win across the agent's inputs.
      expect(qoder.last_poll_time).toBe('2026-05-19 10:03:00');
      expect(qoder.start_time).toBe('2026-05-19 08:30:00');
      // idle_minutes folded in from the former pilot_alarm_metric topic; smallest wins.
      expect(qoder.idle_minutes).toBe('3');
      // Never active: -1 rather than a misleading 0.
      expect(agentRow(agents, 'cursor').idle_minutes).toBe('-1');
    });

    it('reports one flusher row per destination, with its own identity', () => {
      const { flushers } = collector.collectL2(pipelineSnapshot())!;

      // One row per destination, told apart by family + project/logstore. The
      // process-local config alias ('main', 'arms') is a map key only, never a field.
      expect(flushers.map(r => r.flusher).sort()).toEqual(['cms', 'sls']);
      expect(flushers.every(r => !('endpoint' in r))).toBe(true);

      const sls = flushers.find(r => r.flusher === 'sls')!;
      // project / logstore ride along: billing has to attribute bytes to them.
      expect(sls.type).toBe('flusher');
      expect(sls.project).toBe('proj-a');
      expect(sls.logstore).toBe('store-a');
      expect(sls.mode).toBe('sls');
      expect(sls.in_entries).toBe('200');
      expect(sls.in_bytes).toBe('50000');
      expect(sls.out_entries).toBe('195');
      expect(sls.out_bytes).toBe('48000');
      expect(sls.failed_entries).toBe('5');
      expect(sls.total_delay_ms).toBe('3500');
      expect(sls.last_flush_time).toBe('2026-05-19 10:05:00');
      expect(sls.start_time).toBe('2026-05-19 09:00:00');

      const cms = flushers.find(r => r.flusher === 'cms')!;
      expect(cms.out_entries).toBe('60');
      expect(cms.out_bytes).toBe('8800');
      // Non-SLS destinations have no project/logstore to report.
      expect(cms.project).toBe('');
      expect(cms.logstore).toBe('');
    });

    it('keeps two logstores on one endpoint apart', () => {
      const snapshot = pipelineSnapshot();
      snapshot.flushers.set('sls:second', flusherEntry('sls', {
        project: 'proj-a', logstore: 'store-b',
        outEntries: 7, outBytes: 700,
      }));

      const { flushers } = collector.collectL2(snapshot)!;

      expect(flushers.filter(r => r.flusher === 'sls').map(r => r.logstore).sort())
        .toEqual(['store-a', 'store-b']);
      // Every destination reports its own bytes: 195 + 60 + 7.
      expect(flushers.reduce((acc, r) => acc + Number(r.out_entries), 0)).toBe(262);
    });

    it('drains ingress and egress on report', () => {
      const snapshot = pipelineSnapshot();
      collector.collectL2(snapshot);

      // Second call over the same cumulative counters: nothing flowed since.
      const second = collector.collectL2(snapshot)!;
      // The installed agents still report — at zero flow, with idle_minutes intact.
      // That row is the only way a consumer can see an agent has gone quiet.
      expect(second.agents.map(r => r.agent).sort()).toEqual(['cursor', 'qoder']);
      expect(second.agents.every(r => r.in_events === '0' && r.in_bytes === '0')).toBe(true);
      expect(agentRow(second.agents, 'qoder').idle_minutes).toBe('3');
      const sls = second.flushers.find(r => r.flusher === 'sls')!;
      expect(sls.out_entries).toBe('0');
      expect(sls.out_bytes).toBe('0');
      expect(sls.total_delay_ms).toBe('0');
      // Descriptors and state are not flow — they stay put.
      expect(sls.project).toBe('proj-a');
      expect(sls.last_flush_time).toBe('2026-05-19 10:05:00');
    });

    it('reports only the increment in the following window', () => {
      collector.collectL2(pipelineSnapshot());

      const next = pipelineSnapshot();
      next.inputs.get('qoder-sqlite')!.rawInRecords = 55;
      next.inputs.get('qoder-sqlite')!.rawInBytes = 2248;
      next.inputs.get('qoder-sqlite')!.inEvents = 50;
      next.inputs.get('qoder-sqlite')!.outFailed = 3;
      next.flushers.get('sls:main')!.outEntries = 200;
      next.flushers.get('sls:main')!.outBytes = 49000;
      const result = collector.collectL2(next)!;

      // Only qoder moved; cursor is still installed, so it reports a zero row.
      expect(result.agents.map(r => r.agent).sort()).toEqual(['cursor', 'qoder']);
      expect(agentRow(result.agents, 'cursor').in_events).toBe('0');
      expect(agentRow(result.agents, 'qoder').in_events).toBe('8');
      expect(agentRow(result.agents, 'qoder').failed_events).toBe('1');
      expect(result.flushers.find(r => r.flusher === 'sls')!.out_entries).toBe('5');
      expect(result.flushers.find(r => r.flusher === 'sls')!.out_bytes).toBe('1000');
      // A silent destination still reports, at zero.
      expect(result.flushers.find(r => r.flusher === 'cms')!.out_entries).toBe('0');
    });

    it('counts an input registered mid-run in full, having no baseline yet', () => {
      collector.collectL2(pipelineSnapshot());

      const next = pipelineSnapshot();
      next.inputs.set('codex-jsonl', inputEntry('codex', {
        inEvents: 12, inBytes: 900, outFailed: 0,
        lastPollTime: '2026-05-19 10:07:00', startTime: '2026-05-19 10:06:00',
      }));
      const result = collector.collectL2(next)!;

      expect(agentRow(result.agents, 'codex').in_events).toBe('12');
    });

    it('keeps a silent running agent but drops one that is not installed', () => {
      const snapshot = pipelineSnapshot();
      // An input is registered for every agent the build knows about, but discovery
      // only starts the ones actually found on the host. A never-started input is a
      // missing agent, not an idle one, so it must not ship a row; a running input
      // that carried nothing must, because that silence is what idle alarms read.
      snapshot.inputs.set('wukong-hook', inputEntry('wukong', { running: false }));
      snapshot.inputs.set('dsh-hook', inputEntry('dsh', { running: false }));
      snapshot.inputs.set('stopped-file', inputEntry('stopped-agent', {
        rawInMaxBatchBytes: 4096,
        running: false,
      }));
      snapshot.inputs.set('idle-hook', inputEntry('idle-agent'));

      const result = collector.collectL2(snapshot)!;

      expect(result.agents.map(r => r.agent).sort()).toEqual(['cursor', 'idle-agent', 'qoder']);
      const idle = agentRow(result.agents, 'idle-agent');
      expect(idle.in_events).toBe('0');
      expect(idle.in_bytes).toBe('0');
      // How many are installed is L1's job, and it counts the silent-but-running one.
      expect(collector.collectL1(snapshot).metric_json.agent_count).toBe('3');
    });

    it('keeps traffic an uninstalled agent collected before it stopped', () => {
      const snapshot = pipelineSnapshot();
      // Discovery stopped this input mid-window, but the events it collected while
      // running still have to be reported or the chain totals lose them.
      snapshot.inputs.set('kiro-cli', inputEntry('kiro-cli', {
        inEvents: 5, inBytes: 300, running: false,
      }));

      const result = collector.collectL2(snapshot)!;

      expect(agentRow(result.agents, 'kiro-cli').in_events).toBe('5');
      expect(result.agents.reduce((acc, r) => acc + Number(r.in_events), 0)).toBe(65);
      // It is no longer installed, so it is not counted as one.
      expect(collector.collectL1(snapshot).metric_json.agent_count).toBe('2');
    });

    it('returns null when there are no inputs and no flushers', () => {
      expect(collector.collectL2(buildSnapshot())).toBeNull();
    });

    it('still reports when only flushers are present', () => {
      const flushers = new Map<string, any>([['sls:main', flusherEntry('sls', {
        inEntries: 1, inBytes: 2, outEntries: 1, outBytes: 2, totalDelayMs: 5,
      })]]);
      const result = collector.collectL2(buildSnapshot({ flushers }))!;
      expect(result.agents).toEqual([]);
      expect(result.inputs).toEqual([]);
      expect(result.flushers[0].out_entries).toBe('1');
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

    it('never probes the updater pid when auto-update is disabled', () => {
      // Auto-update resolves to disabled whenever no package source is configured: nothing
      // registers a service for the updater, no updater process runs, and the updater
      // binary exits on sight of that config. Probing anyway would report a permanent
      // failure and alarm about a process that was never supposed to run.
      const liveness = vi.fn<[], ProcessLiveness>(() => down('no matching updater command found'));
      const col = new MetricsCollector({
        version: '1.0.0',
        userId: 'test-user',
        dataDir: tmpDir,
        autoUpdateEnabled: false,
        updaterLiveness: liveness,
      });
      for (let i = 0; i < 5; i++) col.collectL1(buildSnapshot());
      expect(liveness).not.toHaveBeenCalled();
      expect(col.getLastInfraHealth()!.updaterConsecutiveFailures).toBe(0);
      expect(col.getLastInfraHealth()!.updaterPidAlive).toBe(true);
    });

    it('probes the updater pid when the flag is omitted, since a host install has one', () => {
      const liveness = vi.fn<[], ProcessLiveness>(() => down('no matching updater command found'));
      const col = new MetricsCollector({
        version: '1.0.0',
        userId: 'test-user',
        dataDir: tmpDir,
        updaterLiveness: liveness,
      });
      for (let i = 0; i < 3; i++) col.collectL1(buildSnapshot());
      expect(liveness).toHaveBeenCalled();
      expect(col.getLastInfraHealth()!.updaterPidAlive).toBe(false);
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

    it('self-heals node-bin when path is invalid but process.execPath is available', () => {
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), '/nonexistent/path/node');
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).node_bin_valid).toBe('true');
      const healed = fs.readFileSync(path.join(tmpDir, 'node-bin'), 'utf-8').trim();
      expect(healed).not.toBe('/nonexistent/path/node');
      expect(healed.length).toBeGreaterThan(0);
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

  describe('projects', () => {
    it('returns empty string when no SLS endpoints', () => {
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).projects).toBe('');
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
      expect(col.collectL1(buildSnapshot()).projects).toBe('aaa bbb');
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
  describe('node-bin self-heal', () => {
    it('does not modify node-bin file when path is already valid', () => {
      const validPath = process.execPath;
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), validPath);
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      col.collectL1(buildSnapshot());
      const content = fs.readFileSync(path.join(tmpDir, 'node-bin'), 'utf-8').trim();
      expect(content).toBe(validPath);
    });

    it('heals node-bin using process.execPath and is idempotent', () => {
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), '/stale/nvm/v18/bin/node');
      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });

      col.collectL1(buildSnapshot());
      const first = fs.readFileSync(path.join(tmpDir, 'node-bin'), 'utf-8').trim();
      expect(col.getLastInfraHealth()!.nodeBinValid).toBe(true);
      expect(col.getLastInfraHealth()!.nodeBinDiagnostic).toBeUndefined();

      col.collectL1(buildSnapshot());
      const second = fs.readFileSync(path.join(tmpDir, 'node-bin'), 'utf-8').trim();
      expect(second).toBe(first);
    });

    it('prefers the managed runtime node over process.execPath when healing a broken pin', () => {
      const runtimeBin = path.join(tmpDir, 'runtime', 'node-v22.22.2-test-arm64', 'bin');
      fs.mkdirSync(runtimeBin, { recursive: true });
      const managedNode = path.join(runtimeBin, process.platform === 'win32' ? 'node.exe' : 'node');
      fs.writeFileSync(managedNode, '#!/bin/sh\necho "v22.22.2"\n');
      fs.chmodSync(managedNode, 0o755);
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), '/nonexistent/nvm/v22/bin/node');

      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      expect(col.collectL1(buildSnapshot()).node_bin_valid).toBe('true');

      const healed = fs.readFileSync(path.join(tmpDir, 'node-bin'), 'utf-8').trim();
      expect(fs.realpathSync(healed)).toBe(fs.realpathSync(managedNode));
    });

    it('picks the newest runtime version when multiple managed nodes exist', () => {
      const versions = [
        ['node-v22.20.0-test-arm64', 'v22.20.0'],
        ['node-v22.22.2-test-arm64', 'v22.22.2'],
        ['node-v24.1.0-test-arm64', 'v24.1.0'],
      ];
      for (const [dir, ver] of versions) {
        const binDir = path.join(tmpDir, 'runtime', dir, 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        const bin = path.join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
        fs.writeFileSync(bin, `#!/bin/sh\necho "${ver}"\n`);
        fs.chmodSync(bin, 0o755);
      }
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), '/nonexistent/node');

      const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
      col.collectL1(buildSnapshot());

      const healed = fs.readFileSync(path.join(tmpDir, 'node-bin'), 'utf-8').trim();
      expect(healed).toContain(path.join('node-v24.1.0-test-arm64', 'bin'));
    });

    it('supports the official win zip layout (node.exe at the runtime dir root)', () => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        const runtimeDir = path.join(tmpDir, 'runtime', 'node-v22.22.2-win-x64');
        fs.mkdirSync(runtimeDir, { recursive: true });
        const rootNode = path.join(runtimeDir, 'node.exe');
        fs.writeFileSync(rootNode, '#!/bin/sh\necho "v22.22.2"\n');
        fs.chmodSync(rootNode, 0o755);
        fs.writeFileSync(path.join(tmpDir, 'node-bin'), '/nonexistent/node');

        const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
        expect(col.collectL1(buildSnapshot()).node_bin_valid).toBe('true');

        const healed = fs.readFileSync(path.join(tmpDir, 'node-bin'), 'utf-8').trim();
        expect(fs.realpathSync(healed)).toBe(fs.realpathSync(rootNode));
      } finally {
        platformSpy.mockRestore();
      }
    });

    it('prefers bin/node.exe over the official root layout on win', () => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        const runtimeDir = path.join(tmpDir, 'runtime', 'node-v22.22.2-win-x64');
        fs.mkdirSync(path.join(runtimeDir, 'bin'), { recursive: true });
        for (const p of [path.join(runtimeDir, 'bin', 'node.exe'), path.join(runtimeDir, 'node.exe')]) {
          fs.writeFileSync(p, '#!/bin/sh\necho "v22.22.2"\n');
          fs.chmodSync(p, 0o755);
        }
        fs.writeFileSync(path.join(tmpDir, 'node-bin'), '/nonexistent/node');

        const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
        col.collectL1(buildSnapshot());

        const healed = fs.readFileSync(path.join(tmpDir, 'node-bin'), 'utf-8').trim();
        expect(healed).toBe(fs.realpathSync(path.join(runtimeDir, 'bin', 'node.exe')));
      } finally {
        platformSpy.mockRestore();
      }
    });

    it('reports diagnostic when self-heal fails (no usable node found)', () => {
      const stalePath = '/nonexistent/nvm/v16/bin/node';
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), stalePath);

      const execPathSpy = vi.spyOn(process, 'execPath', 'get').mockReturnValue('/also/broken/node');
      const origPath = process.env.PATH;
      process.env.PATH = '/no_such_dir';
      fsMockState.blockAccessSync = true;

      try {
        const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
        col.collectL1(buildSnapshot());
        const health = col.getLastInfraHealth()!;
        expect(health.nodeBinValid).toBe(false);
        expect(health.nodeBinDiagnostic).toEqual({
          originalPath: stalePath,
          pathExists: false,
          pathExecutable: false,
        });
      } finally {
        fsMockState.blockAccessSync = false;
        process.env.PATH = origPath;
        execPathSpy.mockRestore();
      }
    });

    it('diagnostic distinguishes exists-but-not-executable from missing', () => {
      const existsNotExec = path.join(tmpDir, 'fake-node');
      fs.writeFileSync(existsNotExec, 'not a binary');
      fs.chmodSync(existsNotExec, 0o644);
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), existsNotExec);

      const execPathSpy = vi.spyOn(process, 'execPath', 'get').mockReturnValue('/also/broken/node');
      const origPath = process.env.PATH;
      process.env.PATH = '/no_such_dir';
      fsMockState.blockAccessSync = true;

      try {
        const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
        col.collectL1(buildSnapshot());
        const health = col.getLastInfraHealth()!;
        expect(health.nodeBinValid).toBe(false);
        expect(health.nodeBinDiagnostic).toEqual({
          originalPath: existsNotExec,
          pathExists: true,
          pathExecutable: false,
        });
      } finally {
        fsMockState.blockAccessSync = false;
        process.env.PATH = origPath;
        execPathSpy.mockRestore();
      }
    });

    it('skips an executable candidate whose Node major version is below 18', () => {
      const stalePath = '/nonexistent/nvm/v16/bin/node';
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), stalePath);

      const execPathSpy = vi.spyOn(process, 'execPath', 'get').mockReturnValue('/fake/current/node');
      const origPath = process.env.PATH;
      process.env.PATH = '/fake/bin';
      fsMockState.accessOverride = (p, mode) => {
        if (mode === fs.constants.X_OK && p === '/fake/bin/node') return;
        if (mode === fs.constants.X_OK) throw new Error(`EACCES: ${p}`);
      };
      execMockState.override = () => 'v16.20.0\n';

      try {
        const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
        col.collectL1(buildSnapshot());
        const health = col.getLastInfraHealth()!;
        expect(health.nodeBinValid).toBe(false);
        expect(fs.readFileSync(path.join(tmpDir, 'node-bin'), 'utf-8').trim()).toBe(stalePath);
      } finally {
        fsMockState.accessOverride = null;
        execMockState.override = null;
        process.env.PATH = origPath;
        execPathSpy.mockRestore();
      }
    });

    it('accepts an executable candidate whose Node major version is >= 18', () => {
      const stalePath = '/nonexistent/nvm/v16/bin/node';
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), stalePath);

      const execPathSpy = vi.spyOn(process, 'execPath', 'get').mockReturnValue('/fake/current/node');
      const origPath = process.env.PATH;
      process.env.PATH = '/fake/bin';
      fsMockState.accessOverride = (p, mode) => {
        if (mode === fs.constants.X_OK && p === '/fake/bin/node') return;
        if (mode === fs.constants.X_OK) throw new Error(`EACCES: ${p}`);
      };
      execMockState.override = (file) => (file === '/fake/bin/node' ? 'v20.11.0\n' : 'v16.20.0\n');

      try {
        const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
        col.collectL1(buildSnapshot());
        const health = col.getLastInfraHealth()!;
        expect(health.nodeBinValid).toBe(true);
        expect(fs.readFileSync(path.join(tmpDir, 'node-bin'), 'utf-8').trim()).toBe('/fake/bin/node');
      } finally {
        fsMockState.accessOverride = null;
        execMockState.override = null;
        process.env.PATH = origPath;
        execPathSpy.mockRestore();
      }
    });

    it('skips a candidate whose --version execution fails', () => {
      const stalePath = '/nonexistent/nvm/v16/bin/node';
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), stalePath);

      const execPathSpy = vi.spyOn(process, 'execPath', 'get').mockReturnValue('/fake/current/node');
      const origPath = process.env.PATH;
      process.env.PATH = '/fake/bin';
      fsMockState.accessOverride = (p, mode) => {
        if (mode === fs.constants.X_OK && p === '/fake/bin/node') return;
        if (mode === fs.constants.X_OK) throw new Error(`EACCES: ${p}`);
      };
      execMockState.override = () => {
        throw new Error('ETIMEDOUT: --version timed out');
      };

      try {
        const col = new MetricsCollector({ version: '1.0.0', userId: 'test-user', dataDir: tmpDir });
        col.collectL1(buildSnapshot());
        const health = col.getLastInfraHealth()!;
        expect(health.nodeBinValid).toBe(false);
        expect(fs.readFileSync(path.join(tmpDir, 'node-bin'), 'utf-8').trim()).toBe(stalePath);
      } finally {
        fsMockState.accessOverride = null;
        execMockState.override = null;
        process.env.PATH = origPath;
        execPathSpy.mockRestore();
      }
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

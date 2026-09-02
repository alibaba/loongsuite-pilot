import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { MetricsWriter } from '../../../src/metrics/metrics-writer.js';
import { AlarmManager } from '../../../src/metrics/alarm-manager.js';
import type { DataflowSnapshot } from '../../../src/metrics/metrics-collector.js';
import { createRuntimeIdentity } from '../../../src/metrics/runtime-identity.js';
import {
  TRACE_RUNTIME_SIZE_THRESHOLDS,
  TraceRuntimeObserver,
} from '../../../src/metrics/trace-runtime-observer.js';

const fsMockState = { blockAccessSync: false };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    accessSync: (p: fs.PathLike, mode?: number) => {
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

const mockSendAlarm = vi.fn();
const mockSendStatus = vi.fn();
const mockSendRunningStatus = vi.fn();
vi.mock('../../../src/internal/sender.js', () => ({
  sendAlarm: (...args: unknown[]) => mockSendAlarm(...args),
  sendStatus: (...args: unknown[]) => mockSendStatus(...args),
  sendRunningStatus: (...args: unknown[]) => mockSendRunningStatus(...args),
}));

function buildSnapshot(): DataflowSnapshot {
  return {
    inEventsTotal: 12,
    inBytesTotal: 2048,
    inputs: new Map([
      ['test-input', {
        sourceKind: 'primary' as const,
        rawReadCalls: 2, rawReadBytes: 2048,
        rawInRecords: 7, rawInBytes: 1536,
        rawInMaxBatchBytes: 1024, rawInMaxRecordBytes: 512, rawBacklogBytesMax: 1024,
        parseSuccessRecords: 6, parseFailedRecords: 1,
        readDurationMs: 4, processDurationMs: 8,
        inEvents: 5, inBytes: 1024, outFailed: 0,
        lastPollTime: '2026-05-19 10:00:00', startTime: '2026-05-19 09:00:00',
        type: 'polling', agent: 'test-agent', running: true,
      }],
    ]),
    flushers: new Map([
      ['sls:main', { kind: 'sls' as const, project: 'proj-a', logstore: 'store-a', mode: 'sls', bytesBasis: 'measured' as const, inEntries: 10, inBytes: 2048, outEntries: 9, outBytes: 1900, outFailed: 1, totalDelayMs: 500, lastFlushTime: '2026-05-19 10:00:00', startTime: '2026-05-19 09:00:00' }],
    ]),
    inputIdleMinutes: new Map(),
  };
}

function makeAlarmWriter(tmpDir: string): { writer: MetricsWriter; alarmManager: AlarmManager } {
  const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
  return {
    alarmManager,
    writer: new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
      alarmManager,
    }),
  };
}

function checkThresholdsForTest(writer: MetricsWriter, metrics: { cpu: string; mem: string }): void {
  (writer as any).checkThresholds(metrics);
}

function cpuAboveProcessThreshold(): string {
  return '81';
}

function managedLogFile(metricDir: string, prefix: string): string {
  const file = fs.readdirSync(metricDir).find(name => (
    name.startsWith(`${prefix}-`) && /-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)
  ));
  if (!file) throw new Error(`managed log file not found for ${prefix}`);
  return path.join(metricDir, file);
}

function hasManagedLogFile(metricDir: string, prefix: string): boolean {
  return fs.existsSync(metricDir) && fs.readdirSync(metricDir).some(name => (
    name.startsWith(`${prefix}-`) && name.endsWith('.jsonl')
  ));
}

describe('MetricsWriter', () => {
  let tmpDir: string;
  let writer: MetricsWriter;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-writer-test-'));
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    mockSendAlarm.mockClear();
    mockSendStatus.mockClear();
    mockSendRunningStatus.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await writer?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes L1 metrics on start', async () => {
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
    });

    vi.useRealTimers();
    await writer.start();

    const filePath = managedLogFile(path.join(tmpDir, 'logs', 'metric_alarm'), 'pilot-metrics');
    expect(fs.existsSync(filePath)).toBe(true);

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.version).toBe('2.0.0');
    expect(entry.user_id).toBe('u1');
    expect(entry.metric_json.agent_count).toBe('1');
    expect(entry.metric_json).not.toHaveProperty('raw_in_records');
    expect(entry.metric_json).not.toHaveProperty('raw_in_bytes');
    expect(entry.metric_json).not.toHaveProperty('raw_in_max_batch_bytes');
  });

  it('calls sendStatus with pilot_status topic on L1 write', async () => {
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
    });

    vi.useRealTimers();
    await writer.start();
    await new Promise(r => setTimeout(r, 50));

    expect(mockSendStatus).toHaveBeenCalled();
    const call = mockSendStatus.mock.calls.find(
      (c: unknown[]) => c[0] === 'pilot_status',
    );
    expect(call).toBeDefined();
    expect(call![1]).toHaveProperty('version', '2.0.0');
    expect(call![1]).not.toHaveProperty('__topic__');

    // Old L2 topics must no longer be emitted (merged into pilot_pipeline)
    const legacy = mockSendStatus.mock.calls.filter((c: unknown[]) =>
      ['pilot_input_detail', 'pilot_flusher_detail', 'pilot_alarm_metric'].includes(c[0] as string),
    );
    expect(legacy).toHaveLength(0);
  });

  it('writes Trace runtime details and windows only to the internal runtime topic', async () => {
    const runtimeIdentity = createRuntimeIdentity({
      version: '2.0.0',
      userId: 'u1',
      dataDir: tmpDir,
    });
    const observer = new TraceRuntimeObserver({ identity: runtimeIdentity });
    observer.openTurn({
      bufferKey: 'turn:s:t',
      agentType: 'codex',
      inputName: 'codex-transcript',
      sessionId: 's',
      turnId: 's:t',
    });
    observer.append('turn:s:t', TRACE_RUNTIME_SIZE_THRESHOLDS[0]);
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
      runtimeIdentity,
      traceRuntimeObserver: observer,
    });

    await (writer as any).writeL1();
    await (writer as any).writeTraceRuntimeDetails();
    await (writer as any).writeTraceRuntimeWindows();

    const runtimeRows = mockSendStatus.mock.calls
      .filter((call: unknown[]) => call[0] === 'pilot_trace_runtime')
      .map((call: unknown[]) => call[1] as Record<string, string>);
    expect(runtimeRows.map(row => row.record_type)).toEqual(['turn', 'window']);
    expect(runtimeRows[0]).toMatchObject({
      schema_version: '1',
      run_id: runtimeIdentity.runId,
      instance_id: runtimeIdentity.instanceId,
      threshold_kind: 'buffer_logical_bytes',
    });
    const statusRow = mockSendStatus.mock.calls
      .find((call: unknown[]) => call[0] === 'pilot_status')?.[1] as Record<string, string>;
    expect(runtimeRows[0]).toMatchObject({
      run_id: statusRow.run_id,
      instance_id: statusRow.instance_id,
    });
    expect(Math.abs(Number(runtimeRows[0].__time__) - Number(statusRow.__time__)))
      .toBeLessThanOrEqual(1);
    expect(mockSendStatus.mock.calls.some((call: unknown[]) =>
      call[0] !== 'pilot_trace_runtime'
      && (call[1] as Record<string, string>).threshold_kind !== undefined,
    )).toBe(false);
  });

  it('isolates an internal Trace runtime send failure', async () => {
    const runtimeIdentity = createRuntimeIdentity({
      version: '2.0.0',
      userId: 'u1',
      dataDir: tmpDir,
    });
    const observer = new TraceRuntimeObserver({ identity: runtimeIdentity });
    observer.openTurn({
      bufferKey: 'turn:s:t',
      agentType: 'codex',
      inputName: 'codex-transcript',
    });
    observer.append('turn:s:t', TRACE_RUNTIME_SIZE_THRESHOLDS[0]);
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
      runtimeIdentity,
      traceRuntimeObserver: observer,
    });
    mockSendStatus.mockImplementationOnce(() => {
      throw new Error('internal sender unavailable');
    });

    await expect((writer as any).writeTraceRuntimeDetails()).resolves.toBeUndefined();
  });

  it('sends one row per agent and per destination on L2 flush', async () => {
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
    });

    vi.useRealTimers();
    // Flush explicitly rather than leaning on start()'s priming flush: an
    // overlapping prime coalesces into the same in-flight write, which would
    // make a call count assertion race.
    await (writer as any).writeL2();

    // All row types share pilot_pipeline and are distinguished by `type`.
    const rows = mockSendStatus.mock.calls
      .filter((c: unknown[]) => c[0] === 'pilot_pipeline')
      .map((c: unknown[]) => c[1] as Record<string, string>);
    expect(rows.map(r => r.type)).toEqual(['agent', 'input', 'flusher']);

    const [agent, input, flusher] = rows;
    // Host identity ships with every flow row, so grouping by machine needs no
    // join back to pilot_status.
    expect(agent.hostname).toBe(os.hostname());
    expect(agent.ip).toBeDefined();
    expect(flusher.hostname).toBe(os.hostname());

    // Flat string fields throughout: nothing needs json_extract to be queried.
    expect(agent.agent).toBe('test-agent');
    expect(agent).not.toHaveProperty('raw_in_records');
    expect(agent).not.toHaveProperty('raw_in_bytes');
    expect(agent).not.toHaveProperty('raw_in_max_batch_bytes');
    expect(agent.in_events).toBe('5');
    expect(input.input_name).toBe('test-input');
    expect(input.source_kind).toBe('primary');
    expect(input.raw_read_bytes).toBe('2048');
    expect(input.parse_failed_records).toBe('1');
    expect(flusher.flusher).toBe('sls');
    expect(flusher.project).toBe('proj-a');
    expect(flusher.logstore).toBe('store-a');
    expect(flusher.out_entries).toBe('9');
  });

  it('drains the rows, so an unchanged snapshot reports zeros', async () => {
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
    });

    vi.useRealTimers();
    await (writer as any).writeL2();
    mockSendStatus.mockClear();
    await (writer as any).writeL2();

    const rows = mockSendStatus.mock.calls
      .filter((c: unknown[]) => c[0] === 'pilot_pipeline')
      .map((c: unknown[]) => c[1] as Record<string, string>);
    expect(rows.map(r => r.type)).toEqual(['agent', 'input', 'flusher']);
    expect(rows[0].in_events).toBe('0');
    expect(rows[0].in_bytes).toBe('0');
    expect(rows[1].raw_read_bytes).toBe('0');
    expect(rows[1].parse_failed_records).toBe('0');
    expect(rows[2].out_entries).toBe('0');
    expect(rows[2].out_bytes).toBe('0');
  });

  it('mirrors each L2 row type to its own file on stop (final flush)', async () => {
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
    });

    vi.useRealTimers();
    await writer.start();
    await writer.stop();

    const metricDir = path.join(tmpDir, 'logs', 'metric_alarm');
    const firstLine = (prefix: string): any => JSON.parse(
      fs.readFileSync(managedLogFile(metricDir, prefix), 'utf-8').trim().split('\n')[0],
    );

    const agent = firstLine('pilot-agent-metrics');
    expect(agent.type).toBe('agent');
    expect(agent.user_id).toBe('u1');
    expect(agent.agent).toBe('test-agent');
    expect(agent.in_events).toBe('5');

    const input = firstLine('pilot-input-metrics');
    expect(input.type).toBe('input');
    expect(input.input_name).toBe('test-input');
    expect(input.raw_read_calls).toBe('2');

    const flusher = firstLine('pilot-flusher-metrics');
    expect(flusher.type).toBe('flusher');
    expect(flusher.flusher).toBe('sls');
    expect(flusher.logstore).toBe('store-a');
    expect(flusher.out_entries).toBe('9');
  });

  it('takes a fresh final snapshot after an in-flight dataflow cycle', async () => {
    const getSnapshot = vi.fn(buildSnapshot);
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot,
    });
    vi.useRealTimers();

    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const original = (writer as any).collectAndWriteDataflow.bind(writer);
    let cycleCount = 0;
    vi.spyOn(writer as any, 'collectAndWriteDataflow').mockImplementation(async () => {
      cycleCount++;
      if (cycleCount === 1) await firstBlocked;
      await original();
    });

    const inFlight = (writer as any).writeDataflow() as Promise<void>;
    const stopping = writer.stop();
    await Promise.resolve();
    expect(cycleCount).toBe(1);

    releaseFirst();
    await inFlight;
    await stopping;

    expect(cycleCount).toBe(2);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('does not reject stop when the final dataflow snapshot fails', async () => {
    let failSnapshot = false;
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: () => {
        if (failSnapshot) throw new Error('snapshot exploded');
        return buildSnapshot();
      },
    });
    vi.useRealTimers();

    await writer.start();
    failSnapshot = true;

    await expect(writer.stop()).resolves.toBeUndefined();
  });

  it('does not write the L2 file when snapshot has no inputs/flushers', async () => {
    const emptySnapshot: DataflowSnapshot = {
      inEventsTotal: 0, inBytesTotal: 0,
      inputs: new Map(),
      flushers: new Map(),
      inputIdleMinutes: new Map(),
    };

    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '1.0.0',
      userId: 'u2',
      getSnapshot: () => emptySnapshot,
    });

    vi.useRealTimers();
    await writer.start();
    await writer.stop();

    const metricDir = path.join(tmpDir, 'logs', 'metric_alarm');
    expect(hasManagedLogFile(metricDir, 'pilot-agent-metrics')).toBe(false);
    expect(hasManagedLogFile(metricDir, 'pilot-input-metrics')).toBe(false);
    expect(hasManagedLogFile(metricDir, 'pilot-flusher-metrics')).toBe(false);
  });

  it('includes capture_message_disabled_agents in L1 metrics', async () => {
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
      agentsConfig: {
        cursor: { captureMessageContent: true },
        qoder: { captureMessageContent: false },
      },
    });

    vi.useRealTimers();
    await writer.start();

    const filePath = managedLogFile(path.join(tmpDir, 'logs', 'metric_alarm'), 'pilot-metrics');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);

    expect(entry.capture_message_disabled_agents).toBe('qoder');
  });

  describe('process resource thresholds', () => {
    it('debounces soft memory alarms until 3 consecutive samples', () => {
      const setup = makeAlarmWriter(tmpDir);
      writer = setup.writer;
      const { alarmManager } = setup;

      checkThresholdsForTest(writer, { cpu: '0', mem: '600' });
      checkThresholdsForTest(writer, { cpu: '0', mem: '620' });
      expect(alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM')).toBeUndefined();

      checkThresholdsForTest(writer, { cpu: '0', mem: '640' });
      const alarm = alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM');

      expect(alarm).toBeDefined();
      expect(alarm!.alarm_level).toBe('2');
      expect(alarm!.alarm_message).toContain('soft threshold 512MB');
      expect(alarm!.alarm_message).toContain('3 consecutive soft samples');
    });

    it('alerts hard and critical memory tiers immediately', () => {
      const setup = makeAlarmWriter(tmpDir);
      writer = setup.writer;
      const { alarmManager } = setup;

      checkThresholdsForTest(writer, { cpu: '0', mem: '1200' });
      let alarm = alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM');
      expect(alarm).toBeDefined();
      expect(alarm!.alarm_level).toBe('2');
      expect(alarm!.alarm_message).toContain('hard threshold 1024MB');
      expect(alarm!.alarm_message).toContain('1 consecutive hard sample');

      checkThresholdsForTest(writer, { cpu: '0', mem: '2300' });
      alarm = alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM');
      expect(alarm).toBeDefined();
      expect(alarm!.alarm_level).toBe('3');
      expect(alarm!.alarm_message).toContain('critical threshold 2048MB');
      expect(alarm!.alarm_message).toContain('1 consecutive critical sample');
    });

    it('does not reuse hard or critical samples after falling back to soft memory tier', () => {
      for (const initialMem of ['1200', '2300']) {
        vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
        const setup = makeAlarmWriter(tmpDir);
        writer = setup.writer;
        const { alarmManager } = setup;

        checkThresholdsForTest(writer, { cpu: '0', mem: initialMem });
        expect(alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM')).toBeDefined();

        vi.setSystemTime(new Date('2026-07-15T01:00:01Z'));
        checkThresholdsForTest(writer, { cpu: '0', mem: '600' });
        expect(alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM')).toBeUndefined();

        checkThresholdsForTest(writer, { cpu: '0', mem: '620' });
        expect(alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM')).toBeUndefined();

        checkThresholdsForTest(writer, { cpu: '0', mem: '640' });
        const softAlarm = alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM');
        expect(softAlarm).toBeDefined();
        expect(softAlarm!.alarm_message).toContain('soft threshold 512MB');
        expect(softAlarm!.alarm_message).toContain('3 consecutive soft samples');
      }
    });

    it('uses one memory cooldown for same or lower tiers and lets higher tiers escalate', () => {
      vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
      const setup = makeAlarmWriter(tmpDir);
      writer = setup.writer;
      const { alarmManager } = setup;

      checkThresholdsForTest(writer, { cpu: '0', mem: '600' });
      checkThresholdsForTest(writer, { cpu: '0', mem: '620' });
      checkThresholdsForTest(writer, { cpu: '0', mem: '640' });
      let alarm = alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM');
      expect(alarm).toBeDefined();
      expect(alarm!.alarm_message).toContain('soft threshold 512MB');

      vi.setSystemTime(new Date('2026-07-15T00:30:00Z'));
      checkThresholdsForTest(writer, { cpu: '0', mem: '650' });
      expect(alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM')).toBeUndefined();

      checkThresholdsForTest(writer, { cpu: '0', mem: '1200' });
      alarm = alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM');
      expect(alarm).toBeDefined();
      expect(alarm!.alarm_message).toContain('hard threshold 1024MB');

      checkThresholdsForTest(writer, { cpu: '0', mem: '700' });
      checkThresholdsForTest(writer, { cpu: '0', mem: '710' });
      checkThresholdsForTest(writer, { cpu: '0', mem: '720' });
      expect(alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM')).toBeUndefined();
    });

    it('suppresses transient CPU spikes until 3 consecutive process CPU samples', () => {
      const setup = makeAlarmWriter(tmpDir);
      writer = setup.writer;
      const { alarmManager } = setup;
      const highCpu = cpuAboveProcessThreshold();

      checkThresholdsForTest(writer, { cpu: highCpu, mem: '128' });
      checkThresholdsForTest(writer, { cpu: highCpu, mem: '128' });
      expect(alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_CPU_ALARM')).toBeUndefined();

      checkThresholdsForTest(writer, { cpu: highCpu, mem: '128' });
      const alarm = alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_CPU_ALARM');

      expect(alarm).toBeDefined();
      expect(alarm!.alarm_level).toBe('2');
      expect(alarm!.alarm_message).toContain('3 consecutive samples');
      expect(alarm!.alarm_message).toContain('CPU usage 81% exceeds 80%');
      expect(alarm!.alarm_message).not.toContain('cores');
    });

    it('compares CPU threshold against raw process percent', () => {
      const setup = makeAlarmWriter(tmpDir);
      writer = setup.writer;
      const { alarmManager } = setup;

      checkThresholdsForTest(writer, { cpu: '81', mem: '128' });
      checkThresholdsForTest(writer, { cpu: '81', mem: '128' });
      checkThresholdsForTest(writer, { cpu: '81', mem: '128' });

      const alarm = alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_CPU_ALARM');
      expect(alarm).toBeDefined();
      expect(alarm!.alarm_message).toContain('CPU usage 81% exceeds 80%');
    });

    it('keeps CPU and memory alarms split in the same flush window', () => {
      const setup = makeAlarmWriter(tmpDir);
      writer = setup.writer;
      const { alarmManager } = setup;
      const highCpu = cpuAboveProcessThreshold();

      checkThresholdsForTest(writer, { cpu: highCpu, mem: '128' });
      checkThresholdsForTest(writer, { cpu: highCpu, mem: '128' });
      checkThresholdsForTest(writer, { cpu: highCpu, mem: '1200' });

      const entries = alarmManager.serialize();
      expect(entries.map(e => e.alarm_type).sort()).toEqual([
        'PROCESS_CPU_ALARM',
        'PROCESS_MEMORY_ALARM',
      ]);
      expect(entries.find(e => e.alarm_type === 'PROCESS_CPU_ALARM')!.alarm_message).toContain('CPU usage');
      expect(entries.find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM')!.alarm_message).toContain('Memory usage');
    });

    it('cools down repeated process resource alarms', () => {
      vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
      const setup = makeAlarmWriter(tmpDir);
      writer = setup.writer;
      const { alarmManager } = setup;

      checkThresholdsForTest(writer, { cpu: '0', mem: '1200' });
      expect(alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM')).toBeDefined();

      vi.setSystemTime(new Date('2026-07-15T00:30:00Z'));
      checkThresholdsForTest(writer, { cpu: '0', mem: '1300' });
      expect(alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM')).toBeUndefined();

      vi.setSystemTime(new Date('2026-07-15T01:00:01Z'));
      checkThresholdsForTest(writer, { cpu: '0', mem: '1300' });
      expect(alarmManager.serialize().find(e => e.alarm_type === 'PROCESS_MEMORY_ALARM')).toBeDefined();
    });
  });

  describe('DEGRADED_STARTUP_ALARM', () => {
    it('records alarm when init_type is nohup', async () => {
      fs.writeFileSync(path.join(tmpDir, 'init-type'), 'nohup');
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
      writer = new MetricsWriter({
        dataDir: tmpDir,
        version: '2.0.0',
        userId: 'u1',
        getSnapshot: buildSnapshot,
        alarmManager,
      });

      vi.useRealTimers();
      await writer.start();

      const entries = alarmManager.serialize();
      const alarm = entries.find(e => e.alarm_type === 'DEGRADED_STARTUP_ALARM');
      expect(alarm).toBeDefined();
      expect(alarm!.alarm_level).toBe('2');
      expect(alarm!.alarm_message).toContain('nohup');
    });

    it('records alarm when init_type is unknown (file missing)', async () => {
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
      writer = new MetricsWriter({
        dataDir: tmpDir,
        version: '2.0.0',
        userId: 'u1',
        getSnapshot: buildSnapshot,
        alarmManager,
      });

      vi.useRealTimers();
      await writer.start();

      const entries = alarmManager.serialize();
      const alarm = entries.find(e => e.alarm_type === 'DEGRADED_STARTUP_ALARM');
      expect(alarm).toBeDefined();
      expect(alarm!.alarm_message).toContain('unknown');
    });

    it('does not record alarm when init_type is launchd', async () => {
      fs.writeFileSync(path.join(tmpDir, 'init-type'), 'launchd');
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
      writer = new MetricsWriter({
        dataDir: tmpDir,
        version: '2.0.0',
        userId: 'u1',
        getSnapshot: buildSnapshot,
        alarmManager,
      });

      vi.useRealTimers();
      await writer.start();

      const entries = alarmManager.serialize();
      const alarm = entries.find(e => e.alarm_type === 'DEGRADED_STARTUP_ALARM');
      expect(alarm).toBeUndefined();
    });

    it('does not record alarm when init_type is systemd-user', async () => {
      fs.writeFileSync(path.join(tmpDir, 'init-type'), 'systemd-user');
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
      writer = new MetricsWriter({
        dataDir: tmpDir,
        version: '2.0.0',
        userId: 'u1',
        getSnapshot: buildSnapshot,
        alarmManager,
      });

      vi.useRealTimers();
      await writer.start();

      const entries = alarmManager.serialize();
      const alarm = entries.find(e => e.alarm_type === 'DEGRADED_STARTUP_ALARM');
      expect(alarm).toBeUndefined();
    });
  });

  describe('infra health alarms', () => {
    it('UPDATER_NOT_RUNNING_ALARM does not fire during grace period', async () => {
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
      writer = new MetricsWriter({
        dataDir: tmpDir,
        version: '2.0.0',
        userId: 'u1',
        getSnapshot: buildSnapshot,
        alarmManager,
      });

      vi.useRealTimers();
      await writer.start(); // first writeL1 (cycle 1)

      const entries = alarmManager.serialize();
      const alarm = entries.find(e => e.alarm_type === 'UPDATER_NOT_RUNNING_ALARM');
      expect(alarm).toBeUndefined();
    });

    it('UPDATER_NOT_RUNNING_ALARM fires after 2 consecutive failures post-grace', async () => {
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
      writer = new MetricsWriter({
        dataDir: tmpDir,
        version: '2.0.0',
        userId: 'u1',
        getSnapshot: buildSnapshot,
        alarmManager,
        updaterLiveness: () => ({
          running: false,
          source: 'none',
          reason: 'no matching updater command found',
          pidFileState: 'missing',
        }),
      });

      vi.useRealTimers();
      // Manually invoke writeL1 multiple times to pass grace + accumulate failures
      await (writer as any).writeL1(); // cycle 1 (grace)
      await (writer as any).writeL1(); // cycle 2 (grace)
      await (writer as any).writeL1(); // cycle 3 (fail 1)
      alarmManager.serialize(); // clear
      await (writer as any).writeL1(); // cycle 4 (fail 2 → alarm)

      const entries = alarmManager.serialize();
      const alarm = entries.find(e => e.alarm_type === 'UPDATER_NOT_RUNNING_ALARM');
      expect(alarm).toBeDefined();
      expect(alarm!.alarm_level).toBe('3');
    });

    it('UPDATER_NOT_RUNNING_ALARM never fires when auto-update is disabled', async () => {
      // With auto-update disabled nothing registers an updater service and the updater
      // exits on that config, so the pid is missing by design. Left ungated, every such
      // install would report this level-3 alarm ~30min after start (L1 runs every 10min
      // and the probe begins on cycle 3) about a process that is not supposed to exist.
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
      writer = new MetricsWriter({
        dataDir: tmpDir,
        version: '2.0.0',
        userId: 'u1',
        getSnapshot: buildSnapshot,
        alarmManager,
        autoUpdateEnabled: false,
        updaterLiveness: () => ({
          running: false,
          source: 'none',
          reason: 'no matching updater command found',
          pidFileState: 'missing',
        }),
      });

      vi.useRealTimers();
      // Same four cycles that make the enabled case alarm above.
      for (let i = 0; i < 4; i++) await (writer as any).writeL1();

      const entries = alarmManager.serialize();
      expect(entries.find(e => e.alarm_type === 'UPDATER_NOT_RUNNING_ALARM')).toBeUndefined();
    });

    it('BROKEN_VERSION_POINTER_ALARM fires when current points to missing dir', async () => {
      fs.writeFileSync(path.join(tmpDir, 'current'), 'nonexistent_version');
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
      writer = new MetricsWriter({
        dataDir: tmpDir,
        version: '2.0.0',
        userId: 'u1',
        getSnapshot: buildSnapshot,
        alarmManager,
      });

      vi.useRealTimers();
      await writer.start();

      const entries = alarmManager.serialize();
      const alarm = entries.find(e => e.alarm_type === 'BROKEN_VERSION_POINTER_ALARM');
      expect(alarm).toBeDefined();
      expect(alarm!.alarm_level).toBe('2');
    });

    it('BROKEN_VERSION_POINTER_ALARM does not fire when current is valid', async () => {
      fs.mkdirSync(path.join(tmpDir, 'versions', '1.0.0_abc'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'current'), '1.0.0_abc');
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
      writer = new MetricsWriter({
        dataDir: tmpDir,
        version: '2.0.0',
        userId: 'u1',
        getSnapshot: buildSnapshot,
        alarmManager,
      });

      vi.useRealTimers();
      await writer.start();

      const entries = alarmManager.serialize();
      const alarm = entries.find(e => e.alarm_type === 'BROKEN_VERSION_POINTER_ALARM');
      expect(alarm).toBeUndefined();
    });

    it('INVALID_NODE_BIN_ALARM fires when node-bin is invalid and self-heal fails', async () => {
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), '/nonexistent/path/node');
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
      writer = new MetricsWriter({
        dataDir: tmpDir,
        version: '2.0.0',
        userId: 'u1',
        getSnapshot: buildSnapshot,
        alarmManager,
      });

      const execPathSpy = vi.spyOn(process, 'execPath', 'get').mockReturnValue('/also/broken/node');
      const origPath = process.env.PATH;
      process.env.PATH = '/no_such_dir';
      fsMockState.blockAccessSync = true;

      try {
        vi.useRealTimers();
        await writer.start();

        const entries = alarmManager.serialize();
        const alarm = entries.find(e => e.alarm_type === 'INVALID_NODE_BIN_ALARM');
        expect(alarm).toBeDefined();
        expect(alarm!.alarm_level).toBe('2');
        expect(alarm!.alarm_message).toContain('path does not exist');
      } finally {
        fsMockState.blockAccessSync = false;
        process.env.PATH = origPath;
        execPathSpy.mockRestore();
      }
    });

    it('INVALID_NODE_BIN_ALARM does not fire when node-bin is valid', async () => {
      fs.writeFileSync(path.join(tmpDir, 'node-bin'), process.execPath);
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: '2.0.0', userId: 'test-user' });
      writer = new MetricsWriter({
        dataDir: tmpDir,
        version: '2.0.0',
        userId: 'u1',
        getSnapshot: buildSnapshot,
        alarmManager,
      });

      vi.useRealTimers();
      await writer.start();

      const entries = alarmManager.serialize();
      const alarm = entries.find(e => e.alarm_type === 'INVALID_NODE_BIN_ALARM');
      expect(alarm).toBeUndefined();
    });
  });
});

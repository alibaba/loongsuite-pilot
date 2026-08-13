/**
 * SLS flusher failure handling: failure propagation & counting (D1/D2a),
 * transient escalation (D4 方案B), config cooldown (D3/D4), circuit breaker (D3/D5),
 * and oversize payload guard (D2b/D6).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SlsFlusherConfig, SlsEndpoint } from '../../../src/types/index.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

const mockPostLogStoreLogs = vi.fn().mockResolvedValue(undefined);
const mockFailureWrite = vi.fn().mockResolvedValue(true);

vi.mock('@alicloud/log', () => ({
  default: vi.fn().mockImplementation(() => ({ postLogStoreLogs: mockPostLogStoreLogs })),
}));

const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
vi.stubGlobal('fetch', fetchSpy);

vi.mock('../../../src/utils/fs-utils.js', () => ({
  getTodayDateString: () => '2026-04-27',
  readInstalledVersion: () => '0.0.0-test',
}));

vi.mock('../../../src/flushers/sls-failure-log-writer.js', () => ({
  SlsFailureLogWriter: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    write: mockFailureWrite,
  })),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SlsFlusher } from '../../../src/flushers/sls-flusher.js';
import { AlarmManager } from '../../../src/metrics/alarm-manager.js';

function akEndpoint(name: string, url: string, project: string): SlsEndpoint {
  return {
    name, endpoint: url, project, logstore: `${project}-store`,
    kind: 'agentActivity', mode: 'ak',
    accessKeyId: `${name}-ak`, accessKeySecret: `${name}-sk`, redact: false,
  };
}

function wtEndpoint(name: string, url: string, project: string): SlsEndpoint {
  return {
    name, endpoint: url, project, logstore: `${project}-store`,
    kind: 'agentActivity', mode: 'webtracking', redact: false,
  };
}

function makeConfig(endpoints: SlsEndpoint[]): SlsFlusherConfig {
  const primary = endpoints[0];
  return {
    enabled: true,
    accessKeyId: primary.accessKeyId ?? '',
    accessKeySecret: primary.accessKeySecret ?? '',
    apiKey: primary.apiKey ?? '',
    endpoint: primary.endpoint,
    mode: primary.mode,
    endpoints,
    batchMaxSize: 20,
    flushIntervalMs: 99999,
    serviceNamePrefix: '',
  };
}

// A non-retryable error (so the ak send path breaks immediately, no retry sleeps)
// that classifyFailure maps to `transient` (matches none of payload/quota/config).
function transientErr(msg = 'boom'): Error {
  return new Error(msg);
}
// Non-retryable + classified as config (terminal).
function configErr(): Error {
  return new Error('{"errorCode":"ProjectNotExist","errorMessage":"gone"}');
}

function counters(flusher: SlsFlusher, name: string) {
  return flusher.getEndpointCounters().get(name)!;
}

describe('SlsFlusher failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy.mockReset().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    mockPostLogStoreLogs.mockReset().mockResolvedValue(undefined);
    mockFailureWrite.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- D1 / D2a: failure propagation & counting -------------------------

  it('counts failed entries in outFailed, not outEntries, on send failure', async () => {
    const flusher = new SlsFlusher(makeConfig([akEndpoint('user', 'https://cn-shanghai.log.aliyuncs.com', 'p')]), '/tmp/data');
    mockPostLogStoreLogs.mockRejectedValue(transientErr());

    await flusher.send(buildTestEntry());
    await flusher.flush();

    const c = counters(flusher, 'user');
    expect(c.outFailed).toBe(1);
    expect(c.outEntries).toBe(0);
  });

  it('counts succeeded entries in outEntries on success', async () => {
    const flusher = new SlsFlusher(makeConfig([akEndpoint('user', 'https://cn-shanghai.log.aliyuncs.com', 'p')]), '/tmp/data');

    await flusher.send(buildTestEntry());
    await flusher.flush();

    const c = counters(flusher, 'user');
    expect(c.outEntries).toBe(1);
    expect(c.outFailed).toBe(0);
  });

  it('splits succeeded vs failed counts across webtracking chunks (partial failure)', async () => {
    const flusher = new SlsFlusher(makeConfig([wtEndpoint('internal', 'https://cn-heyuan.log.aliyuncs.com', 'p')]), '/tmp/data');

    // Two ~1.6MB entries force a 2-chunk split (cap is 2.8MB). One chunk succeeds, one 404s.
    const big = 'x'.repeat(1_600_000);
    await flusher.send(buildTestEntry({ 'gen_ai.completion': big }));
    await flusher.send(buildTestEntry({ 'gen_ai.completion': big }));

    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"errorCode":"ProjectNotExist"}' });

    await flusher.flush();

    const c = counters(flusher, 'internal');
    expect(c.outEntries).toBe(1);
    expect(c.outFailed).toBe(1);
  });

  // --- D4 方案B: transient escalation -----------------------------------

  it('does not alarm on a single transient failure, escalates only after threshold', async () => {
    const alarm = new AlarmManager({ ip: '1.1.1.1', version: 'v', userId: 'u' });
    const flusher = new SlsFlusher(makeConfig([akEndpoint('user', 'https://cn-shanghai.log.aliyuncs.com', 'p')]), '/tmp/data');
    flusher.setAlarmManager(alarm);
    mockPostLogStoreLogs.mockRejectedValue(transientErr());

    // Threshold is 3 consecutive all-failed cycles.
    for (let i = 0; i < 2; i++) {
      await flusher.send(buildTestEntry());
      await flusher.flush();
    }
    expect(alarm.serialize()).toHaveLength(0); // still below threshold

    await flusher.send(buildTestEntry());
    await flusher.flush();
    const entries = alarm.serialize();
    expect(entries).toHaveLength(1);
    expect(entries[0].alarm_type).toBe('FLUSH_SEND_ALARM');
    expect(entries[0].failure_class).toBe('transient');
    expect(entries[0].alarm_level).toBe('3');
  });

  it('resets the transient streak after a success (intermittent failures stay silent)', async () => {
    const alarm = new AlarmManager({ ip: '1.1.1.1', version: 'v', userId: 'u' });
    const flusher = new SlsFlusher(makeConfig([akEndpoint('user', 'https://cn-shanghai.log.aliyuncs.com', 'p')]), '/tmp/data');
    flusher.setAlarmManager(alarm);

    for (let i = 0; i < 5; i++) {
      // fail, then succeed — never 3 in a row
      mockPostLogStoreLogs.mockRejectedValueOnce(transientErr());
      await flusher.send(buildTestEntry());
      await flusher.flush();
      await flusher.send(buildTestEntry());
      await flusher.flush(); // success resets streak
    }
    expect(alarm.serialize()).toHaveLength(0);
  });

  it('always counts transient failures in outFailed regardless of alarming', async () => {
    const flusher = new SlsFlusher(makeConfig([akEndpoint('user', 'https://cn-shanghai.log.aliyuncs.com', 'p')]), '/tmp/data');
    mockPostLogStoreLogs.mockRejectedValue(transientErr());

    await flusher.send(buildTestEntry());
    await flusher.flush();
    expect(counters(flusher, 'user').outFailed).toBe(1);
  });

  // --- D3 / D4: config cooldown -----------------------------------------

  it('alarms once for config failure within the cooldown window', async () => {
    const alarm = new AlarmManager({ ip: '1.1.1.1', version: 'v', userId: 'u' });
    const record = vi.spyOn(alarm, 'record');
    const flusher = new SlsFlusher(makeConfig([akEndpoint('user', 'https://cn-shanghai.log.aliyuncs.com', 'p')]), '/tmp/data');
    flusher.setAlarmManager(alarm);
    mockPostLogStoreLogs.mockRejectedValue(configErr());

    // Several config failures in quick succession → only one alarm (cooldown).
    for (let i = 0; i < 3; i++) {
      await flusher.send(buildTestEntry());
      await flusher.flush();
    }
    const configAlarms = record.mock.calls.filter(c => (c[3] as { failure_class?: string })?.failure_class === 'config');
    expect(configAlarms).toHaveLength(1);
    expect(configAlarms[0][1]).toBe('1'); // level 1
  });

  // --- D3 / D5: circuit breaker -----------------------------------------

  it('trips the breaker after consecutive config failures and stops sending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const flusher = new SlsFlusher(makeConfig([akEndpoint('user', 'https://cn-shanghai.log.aliyuncs.com', 'p')]), '/tmp/data');
    mockPostLogStoreLogs.mockRejectedValue(configErr());

    // 3 config failures trip the breaker.
    for (let i = 0; i < 3; i++) {
      await flusher.send(buildTestEntry());
      await flusher.flush();
    }
    expect(mockPostLogStoreLogs).toHaveBeenCalledTimes(3);
    const failWritesAfterTrip = mockFailureWrite.mock.calls.length;

    // Next cycle: breaker open, send is skipped, but still counted as failed.
    await flusher.send(buildTestEntry());
    await flusher.flush();
    expect(mockPostLogStoreLogs).toHaveBeenCalledTimes(3); // no new send
    expect(mockFailureWrite.mock.calls.length).toBe(failWritesAfterTrip); // no new persist
    expect(counters(flusher, 'user').outFailed).toBe(4); // still counted
  });

  it('recovers automatically when a half-open probe succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const flusher = new SlsFlusher(makeConfig([akEndpoint('user', 'https://cn-shanghai.log.aliyuncs.com', 'p')]), '/tmp/data');
    mockPostLogStoreLogs.mockRejectedValue(configErr());

    for (let i = 0; i < 3; i++) {
      await flusher.send(buildTestEntry());
      await flusher.flush();
    }
    // Advance past the backoff window; next flush is a half-open probe.
    vi.setSystemTime(10_000);
    mockPostLogStoreLogs.mockReset().mockResolvedValue(undefined);
    await flusher.send(buildTestEntry());
    await flusher.flush();
    expect(mockPostLogStoreLogs).toHaveBeenCalledTimes(1); // probe went through

    // Breaker cleared: subsequent sends flow normally.
    await flusher.send(buildTestEntry());
    await flusher.flush();
    expect(mockPostLogStoreLogs).toHaveBeenCalledTimes(2);
  });

  it('circuit breaker on one endpoint does not affect another', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const flusher = new SlsFlusher(makeConfig([
      akEndpoint('bad', 'https://cn-shanghai.log.aliyuncs.com', 'bad'),
      akEndpoint('good', 'https://cn-heyuan.log.aliyuncs.com', 'good'),
    ]), '/tmp/data');
    // bad endpoint always config-fails; good always succeeds.
    mockPostLogStoreLogs.mockImplementation((project: string) =>
      project === 'bad' ? Promise.reject(configErr()) : Promise.resolve(undefined),
    );

    for (let i = 0; i < 5; i++) {
      await flusher.send(buildTestEntry());
      await flusher.flush();
    }
    // good endpoint kept flushing every cycle.
    expect(counters(flusher, 'good').outEntries).toBe(5);
    expect(counters(flusher, 'good').outFailed).toBe(0);
  });

  // --- D2b / D6: oversize payload guard ---------------------------------

  it('drops an entry that stays oversize even after truncation, without blocking the batch', async () => {
    const flusher = new SlsFlusher(makeConfig([wtEndpoint('internal', 'https://cn-heyuan.log.aliyuncs.com', 'p')]), '/tmp/data');

    // One normal entry + one whose many fields are each huge (no single field to trim under cap).
    await flusher.send(buildTestEntry());
    const oversize: Record<string, string> = {};
    for (let i = 0; i < 40; i++) oversize[`f${i}`] = 'y'.repeat(100_000); // ~4MB spread across fields
    await flusher.send(buildTestEntry(oversize));

    await flusher.flush();

    // Normal entry still sent; oversize entry dropped + persisted.
    expect(fetchSpy).toHaveBeenCalled();
    const persistedPayload = mockFailureWrite.mock.calls.some(c => String((c[0] as { error: unknown }).error).includes('payload dropped'));
    expect(persistedPayload).toBe(true);
    expect(counters(flusher, 'internal').outFailed).toBeGreaterThanOrEqual(1);
  });

  it('truncates an entry with one oversize field so it fits and still sends', async () => {
    const flusher = new SlsFlusher(makeConfig([wtEndpoint('internal', 'https://cn-heyuan.log.aliyuncs.com', 'p')]), '/tmp/data');

    // Single field just over the 2.8MB cap → truncated, then sent.
    await flusher.send(buildTestEntry({ 'gen_ai.completion': 'z'.repeat(3_000_000) }));
    await flusher.flush();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
    const sent = body.__logs__[0]['gen_ai.completion'] as string;
    expect(sent.endsWith('...[TRUNCATED]')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(body.__logs__[0]))).toBeLessThanOrEqual(2_800_000);
    expect(counters(flusher, 'internal').outEntries).toBe(1);
  });
});

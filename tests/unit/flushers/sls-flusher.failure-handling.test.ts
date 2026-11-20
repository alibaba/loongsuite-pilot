import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlsFlusher } from '../../../src/flushers/sls-flusher.js';
import { WEBTRACKING_MAX_BODY_BYTES } from '../../../src/flushers/sls-transport.js';
import { serialiseLogEntry } from '../../../src/normalization/entry-builder.js';
import { AlarmManager } from '../../../src/metrics/alarm-manager.js';
import { ClientType, type SlsEndpoint } from '../../../src/types/index.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

const { sdkSend, writeFailure } = vi.hoisted(() => ({ sdkSend: vi.fn(), writeFailure: vi.fn() }));
vi.mock('@alicloud/log', () => ({ default: vi.fn().mockImplementation(() => ({ postLogStoreLogs: sdkSend })) }));
vi.mock('../../../src/flushers/sls-failure-log-writer.js', () => ({
  SlsFailureLogWriter: vi.fn().mockImplementation(() => ({ write: writeFailure })),
}));

const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>();
const success = () => new Response(null, { status: 200 });
const error = (status: number, code?: string) => new Response(code ? JSON.stringify({ errorCode: code }) : '', { status });
const sentIds = (options: RequestInit) => JSON.parse(options.body as string).__logs__.map((row: Record<string, string>) => row['event.id']);

function makeFlusher(modes: SlsEndpoint['mode'][] = ['webtracking']) {
  const endpoint = 'http://sls.invalid';
  const flusher = new SlsFlusher({ enabled: true, endpoint, accessKeyId: '', accessKeySecret: '', apiKey: '',
    mode: modes[0], batchMaxSize: 10_000, flushIntervalMs: 999_999, serviceNamePrefix: 'pilot',
    retry: { retryMaxAttempts: 1 }, endpoints: modes.map((mode, i) => ({ name: `ep${i}`, endpoint,
      project: '', logstore: `store${i}`, kind: 'agentActivity', mode })) }, '/tmp/sls-test', 'test');
  const alarms = new AlarmManager({ ip: '127.0.0.1', version: 'test', userId: 'test' });
  flusher.setAlarmManager(alarms);
  return { flusher, alarms, counter: flusher.getEndpointCounters().get('ep0')! };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(0));
  fetchMock.mockReset();
  sdkSend.mockReset();
  writeFailure.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('SLS final failure handling', () => {
  it('accounts for the JSON envelope, isolates a large entry and sends recoverable records intact', async () => {
    const { flusher, alarms, counter } = makeFlusher();
    fetchMock.mockImplementation(async () => success());
    const sizedEntry = (id: string) => {
      const entry = buildTestEntry({ 'event.id': id, custom_text: '' });
      const overhead = Buffer.byteLength(JSON.stringify({ ...serialiseLogEntry(entry, { dropAgentScopedFields: true }), version: 'test' }));
      return { ...entry, custom_text: 'x'.repeat(WEBTRACKING_MAX_BODY_BYTES / 2 - overhead - 8) };
    };
    await flusher.send(sizedEntry('first'));
    await flusher.send(buildTestEntry({ 'event.id': 'oversize', 'gen_ai.input.messages': [
      { role: 'user', parts: [{ type: 'text', content: '界'.repeat(1_050_000) }] },
    ] }));
    await flusher.send(sizedEntry('second'));
    await flusher.flush();

    expect(fetchMock.mock.calls.map(([, options]) => sentIds(options))).toEqual([['first'], ['second']]);
    expect(fetchMock.mock.calls.every(([, { body }]) => Buffer.byteLength(body as string) <= WEBTRACKING_MAX_BODY_BYTES)).toBe(true);
    expect(counter).toMatchObject({ outEntries: 2, outBytes: WEBTRACKING_MAX_BODY_BYTES - 16, outFailed: 1 });
    expect(writeFailure).toHaveBeenCalledOnce();
    expect(writeFailure.mock.calls[0][0]).toMatchObject({ batchCount: 1, error: { status: 413 } });
    expect(alarms.serialize()).toMatchObject([{ failure_class: 'payload', alarm_message: expect.stringContaining('attempts=0') }]);
  });

  it('keeps a compatible singleton above the batching target and does not acknowledge rejected Codex data', async () => {
    const { flusher, alarms, counter } = makeFlusher();
    fetchMock.mockImplementation(async () => success());
    await flusher.send(buildTestEntry({ custom_text: 'x'.repeat(2_900_000) }));
    await flusher.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(error(413, 'PostBodyTooLarge'));
    await expect(flusher.send(buildTestEntry({ 'gen_ai.agent.type': ClientType.CodexCliHook, custom_text: 'x'.repeat(3_200_000) })))
      .rejects.toMatchObject({ name: 'CodexOutputDurabilityError' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(counter).toMatchObject({ outEntries: 1, outFailed: 1 });
    expect(alarms.serialize()).toMatchObject([{ failure_class: 'payload', alarm_message: expect.stringContaining('attempts=1') }]);
  });

  it('reports official write-quota codes across SDK and HTTP without opening a config breaker', async () => {
    const { flusher, alarms } = makeFlusher(['ak', 'webtracking']);
    sdkSend.mockRejectedValue(Object.assign(new Error('synthetic quota'), { code: 'WriteQuotaExceed' }));
    fetchMock.mockImplementation(async () => error(403, 'ShardWriteQuotaExceed'));
    for (let i = 0; i < 4; i++) {
      await flusher.send(buildTestEntry());
      await flusher.flush();
    }
    expect(sdkSend).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(alarms.serialize()).toMatchObject(['ep0', 'ep1'].flatMap(endpoint_name => [
      { alarm_type: 'FLUSH_SEND_ALARM', failure_class: 'quota', endpoint_name, alarm_count: '4' },
      { alarm_type: 'FLUSH_QUOTA_ALARM', endpoint_name, alarm_count: '4' },
    ]));
  });

  it('counts transient failures per cycle and resets on partial success without tripping on proxy errors', async () => {
    const { flusher, alarms } = makeFlusher();
    let partial = false;
    fetchMock.mockImplementation(async (_, options) => partial && sentIds(options)[0] === 'cursor'
      ? success() : error(403, 'ProxyForbidden'));
    async function cycle() {
      await flusher.send(buildTestEntry({ 'event.id': 'qoder', 'gen_ai.agent.type': ClientType.Qoder }));
      await flusher.send(buildTestEntry({ 'event.id': 'cursor', 'gen_ai.agent.type': ClientType.Cursor }));
      await flusher.flush();
    }
    await cycle(); await cycle();
    expect(alarms.serialize()).toEqual([]);
    partial = true;
    await cycle();
    partial = false;
    await cycle(); await cycle();
    expect(alarms.serialize()).toEqual([]);
    await cycle(); await cycle();
    expect(fetchMock).toHaveBeenCalledTimes(14);
    expect(alarms.serialize()).toMatchObject([{ failure_class: 'transient', alarm_count: '1',
      alarm_message: expect.stringContaining('consecutive_failed_cycles=3') }]);
  });

  it('retains pending entries through a failed single probe and forwards them after recovery', async () => {
    const { flusher, alarms, counter } = makeFlusher();
    let healthy = false;
    fetchMock.mockImplementation(async () => healthy ? success() : error(403, 'ProjectForbidden'));
    for (let i = 0; i < 3; i++) {
      await flusher.send(buildTestEntry());
      await flusher.flush();
    }
    await flusher.send(buildTestEntry({ 'event.id': 'deferred-first' }));
    await flusher.send(buildTestEntry({ 'event.id': 'deferred-second', 'gen_ai.agent.type': ClientType.Cursor }));
    await flusher.flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(counter.outFailed).toBe(3);

    vi.setSystemTime(2_000);
    await Promise.all([flusher.flush(), flusher.flush()]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sentIds(fetchMock.mock.calls[3][1])).toEqual(['deferred-first']);
    expect(counter.outFailed).toBe(3);
    await flusher.flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    healthy = true;
    vi.setSystemTime(6_000);
    await flusher.flush();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await flusher.flush();
    expect(fetchMock.mock.calls.slice(4).flatMap(([, options]) => sentIds(options)).sort())
      .toEqual(['deferred-first', 'deferred-second']);
    expect(counter).toMatchObject({ outEntries: 2, outFailed: 3 });
    expect(alarms.serialize()).toMatchObject([{ failure_class: 'config', alarm_count: '1' }]);
  });

  it('passes a held bucket through normal delivery during shutdown', async () => {
    const { flusher, counter } = makeFlusher();
    fetchMock.mockImplementation(async () => error(404, 'ProjectNotExist'));
    for (let i = 0; i < 3; i++) {
      await flusher.send(buildTestEntry());
      await flusher.flush();
    }
    fetchMock.mockImplementation(async () => success());
    await flusher.send(buildTestEntry({ 'event.id': 'held' }));
    await flusher.flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await flusher.shutdown();
    expect(sentIds(fetchMock.mock.calls[3][1])).toEqual(['held']);
    expect(counter).toMatchObject({ outEntries: 1, outFailed: 3 });
  });

  it('does not release the rest of a held queue after a transient half-open failure', async () => {
    const { flusher, counter } = makeFlusher();
    fetchMock.mockImplementation(async () => error(403, 'ProjectForbidden'));
    for (let i = 0; i < 3; i++) {
      await flusher.send(buildTestEntry());
      await flusher.flush();
    }
    await flusher.send(buildTestEntry({ 'event.id': 'held-a' }));
    await flusher.send(buildTestEntry({ 'event.id': 'held-b' }));
    fetchMock.mockRejectedValueOnce(new Error('TimeoutError'));
    vi.setSystemTime(2_000);
    await flusher.flush();
    expect(sentIds(fetchMock.mock.calls[3][1])).toEqual(['held-a']);
    expect(counter.outFailed).toBe(3);

    await flusher.flush();
    expect(fetchMock.mock.calls.map(([, options]) => sentIds(options)).slice(3)).toEqual([['held-a']]);
    expect(counter.outFailed).toBe(3);

    vi.setSystemTime(5_999);
    await flusher.flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetchMock.mockImplementation(async () => success());
    vi.setSystemTime(6_000);
    await flusher.flush();
    expect(fetchMock.mock.calls.map(([, options]) => sentIds(options)).slice(3)).toEqual([['held-a'], ['held-a']]);
    await flusher.flush();
    expect(sentIds(fetchMock.mock.calls[5][1])).toEqual(['held-b']);
    expect(counter).toMatchObject({ outEntries: 2, outFailed: 3 });
  });

  it('measures transport config failures even when a local payload is rejected in the same cycle', async () => {
    const { flusher, counter } = makeFlusher();
    fetchMock.mockImplementation(async () => error(404, 'ProjectNotExist'));
    const oversized = buildTestEntry({ custom_text: 'x'.repeat(3_200_000) });
    for (let i = 0; i < 3; i++) {
      await flusher.send(oversized);
      await flusher.send(buildTestEntry());
      await flusher.flush();
    }
    await flusher.send(buildTestEntry());
    await flusher.flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(counter.outFailed).toBe(6);
  });

  it('bounds an open circuit queue by forwarding under pressure while another endpoint stays live', async () => {
    const { flusher, counter } = makeFlusher(['webtracking', 'webtracking']);
    let healthy = false;
    fetchMock.mockImplementation(async url => healthy || url.includes('/store1/')
      ? success() : error(403, 'ProjectForbidden'));
    for (let i = 0; i < 3; i++) {
      await flusher.send(buildTestEntry());
      await flusher.flush();
    }
    await flusher.send(buildTestEntry({ 'event.id': 'waiting' }));
    await flusher.flush();
    const primary = () => fetchMock.mock.calls.filter(([url]) => url.includes('/store0/'));
    const backup = flusher.getEndpointCounters().get('ep1')!;
    expect(primary()).toHaveLength(3);
    expect(backup.outEntries).toBe(4);
    healthy = true;
    for (let i = 0; i < 499; i++) await flusher.send(buildTestEntry());
    await flusher.flush();
    expect(primary()).toHaveLength(4);
    expect(sentIds(primary()[3][1])).toHaveLength(500);
    expect(sentIds(primary()[3][1])).toContain('waiting');
    expect(counter).toMatchObject({ outEntries: 500, outFailed: 3 });
    expect(backup).toMatchObject({ outEntries: 503, outFailed: 0 });
  });
});

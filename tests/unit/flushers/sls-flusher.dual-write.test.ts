/**
 * SLS flusher per-endpoint dispatch.
 * Covers webtracking-only, AK-only, mixed dual-write, failure isolation,
 * and per-endpoint failed-log filename uniqueness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SlsFlusherConfig, SlsEndpoint } from '../../../src/types/index.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

const mockPostLogStoreLogs = vi.fn().mockResolvedValue(undefined);
const mockFailureWrite = vi.fn().mockResolvedValue(true);

// Track each ALY client constructor call so we can assert on per-endpoint instances.
const akClientCtorCalls: Array<{ endpoint: string; accessKeyId: string }> = [];

vi.mock('@alicloud/log', () => {
  return {
    default: vi.fn().mockImplementation((opts: { endpoint: string; accessKeyId: string }) => {
      akClientCtorCalls.push({ endpoint: opts.endpoint, accessKeyId: opts.accessKeyId });
      return { postLogStoreLogs: mockPostLogStoreLogs };
    }),
  };
});

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
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { SlsFlusher } from '../../../src/flushers/sls-flusher.js';

function akEndpoint(name: string, url: string, project: string): SlsEndpoint {
  return {
    name, endpoint: url, project, logstore: `${project}-store`,
    kind: 'agentActivity', mode: 'ak',
    accessKeyId: `${name}-ak`, accessKeySecret: `${name}-sk`,
    redact: false,
  };
}

function wtEndpoint(name: string, url: string, project: string): SlsEndpoint {
  return {
    name, endpoint: url, project, logstore: `${project}-store`,
    kind: 'agentActivity', mode: 'webtracking',
    redact: false,
  };
}

function makeConfig(endpoints: SlsEndpoint[]): SlsFlusherConfig {
  const primary = endpoints[0];
  return {
    enabled: true,
    accessKeyId: primary.accessKeyId ?? '',
    accessKeySecret: primary.accessKeySecret ?? '',
    endpoint: primary.endpoint,
    mode: primary.mode,
    endpoints,
    batchMaxSize: 20,
    flushIntervalMs: 99999,
    serviceNamePrefix: '',
  };
}

describe('SlsFlusher dual-write — per-endpoint dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    akClientCtorCalls.length = 0;
    fetchSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('webtracking-only single endpoint posts via fetch (no AK client)', async () => {
    const flusher = new SlsFlusher(
      makeConfig([wtEndpoint('user', 'https://cn-hangzhou.log.aliyuncs.com', 'p')]),
      '/tmp/data',
    );

    await flusher.send(buildTestEntry());
    await flusher.flush();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(mockPostLogStoreLogs).not.toHaveBeenCalled();
    expect(akClientCtorCalls).toHaveLength(0);

    const [url] = fetchSpy.mock.calls[0];
    // Project subdomain rewriting: https://<project>.<host>...
    expect(String(url)).toContain('p.cn-hangzhou.log.aliyuncs.com');
  });

  it('ak-only single endpoint uses ALY client with that endpoint URL', async () => {
    const flusher = new SlsFlusher(
      makeConfig([akEndpoint('user', 'https://cn-shanghai.log.aliyuncs.com', 'p')]),
      '/tmp/data',
    );

    await flusher.send(buildTestEntry());
    await flusher.flush();

    expect(mockPostLogStoreLogs).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(akClientCtorCalls).toEqual([
      { endpoint: 'https://cn-shanghai.log.aliyuncs.com', accessKeyId: 'user-ak' },
    ]);
  });

  it('mixed dual-write: AK user + webtracking internal dispatched independently', async () => {
    const flusher = new SlsFlusher(
      makeConfig([
        akEndpoint('user-sls', 'https://cn-shanghai.log.aliyuncs.com', 'user-proj'),
        wtEndpoint('internal-sls', 'https://cn-heyuan.log.aliyuncs.com', 'internal-proj'),
      ]),
      '/tmp/data',
    );

    await flusher.send(buildTestEntry());
    await flusher.flush();

    // One AK call for the user endpoint.
    expect(mockPostLogStoreLogs).toHaveBeenCalledOnce();
    expect(akClientCtorCalls).toEqual([
      { endpoint: 'https://cn-shanghai.log.aliyuncs.com', accessKeyId: 'user-sls-ak' },
    ]);

    // One webtracking POST for the internal endpoint.
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('internal-proj.cn-heyuan.log.aliyuncs.com');
  });

  it('caches AK client per endpoint name across batches', async () => {
    const flusher = new SlsFlusher(
      makeConfig([akEndpoint('user', 'https://cn-shanghai.log.aliyuncs.com', 'p')]),
      '/tmp/data',
    );

    await flusher.send(buildTestEntry());
    await flusher.flush();
    await flusher.send(buildTestEntry());
    await flusher.flush();

    // Two send calls but only one client construction.
    expect(mockPostLogStoreLogs).toHaveBeenCalledTimes(2);
    expect(akClientCtorCalls).toHaveLength(1);
  });

  it('failure on one endpoint does not block the other', async () => {
    const flusher = new SlsFlusher(
      makeConfig([
        akEndpoint('user-sls', 'https://cn-shanghai.log.aliyuncs.com', 'user-proj'),
        wtEndpoint('internal-sls', 'https://cn-heyuan.log.aliyuncs.com', 'internal-proj'),
      ]),
      '/tmp/data',
    );

    // The AK leg fails; the webtracking leg should still succeed.
    mockPostLogStoreLogs.mockRejectedValueOnce(new Error('quota exceeded'));

    await flusher.send(buildTestEntry());
    await flusher.flush();

    // Webtracking still went through.
    expect(fetchSpy).toHaveBeenCalledOnce();
    // Only the failing leg's batch was persisted.
    expect(mockFailureWrite).toHaveBeenCalledOnce();
    const metadata = mockFailureWrite.mock.calls[0][0];
    expect(metadata.endpoint).toBe('user-sls');
    expect(String(metadata.error)).toContain('quota exceeded');
    expect(metadata).not.toHaveProperty('logGroup');
  });

  it('persists independent metadata for endpoints that share the same kind', async () => {
    const flusher = new SlsFlusher(
      makeConfig([
        akEndpoint('user-sls', 'https://cn-shanghai.log.aliyuncs.com', 'user-proj'),
        akEndpoint('internal-sls', 'https://cn-heyuan.log.aliyuncs.com', 'internal-proj'),
      ]),
      '/tmp/data',
    );

    // Both legs fail.
    mockPostLogStoreLogs
      .mockRejectedValueOnce(new Error('user-fail'))
      .mockRejectedValueOnce(new Error('internal-fail'));

    await flusher.send(buildTestEntry());
    await flusher.flush();

    expect(mockFailureWrite).toHaveBeenCalledTimes(2);
    const endpoints = mockFailureWrite.mock.calls.map((call: unknown[]) => (call[0] as { endpoint: string }).endpoint);
    expect(endpoints.sort()).toEqual(['internal-sls', 'user-sls']);
  });
});

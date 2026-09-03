/**
 * SLS flusher per-endpoint dispatch.
 * Covers webtracking-only, AK-only, mixed dual-write, failure isolation,
 * and per-endpoint failed-log filename uniqueness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SlsFlusherConfig, SlsEndpoint } from '../../../src/types/index.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';
import * as http from 'node:http';
import * as crypto from 'node:crypto';

const mockPostLogStoreLogs = vi.fn().mockResolvedValue(undefined);
const mockFailureWrite = vi.fn().mockResolvedValue(true);
const mockAlarmRecord = vi.fn();

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

function apiKeyEndpoint(name: string, url: string, project: string): SlsEndpoint {
  return {
    name, endpoint: url, project, logstore: `${project}-store`,
    kind: 'agentActivity', mode: 'apiKey',
    apiKey: `${name}-api-key`,
    redact: false,
  };
}

function makeConfig(
  endpoints: SlsEndpoint[],
  overrides: Partial<SlsFlusherConfig> = {},
): SlsFlusherConfig {
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
    ...overrides,
  };
}

describe('SlsFlusher dual-write — per-endpoint dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostLogStoreLogs.mockReset().mockResolvedValue(undefined);
    mockFailureWrite.mockReset().mockResolvedValue(true);
    fetchSpy.mockReset().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    akClientCtorCalls.length = 0;
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

  it('apiKey endpoint posts protobuf to local mock service with bearer auth', async () => {
    const received = await withMockSlsServer(async ({ endpoint, requests }) => {
      const flusher = new SlsFlusher(
        makeConfig([apiKeyEndpoint('api-key-sls', endpoint, 'api-key-project')]),
        '/tmp/data',
      );

      await flusher.send(buildTestEntry());
      await flusher.flush();

      return requests[0];
    });

    expect(received.url).toBe('/logstores/api-key-project-store/shards/lb');
    expect(received.headers.authorization).toBe('Bearer api-key-sls-api-key');
    expect(received.headers['content-type']).toBe('application/x-protobuf');
    expect(Number.isFinite(Date.parse(String(received.headers.date)))).toBe(true);
    expect(received.headers['x-log-apiversion']).toBe('0.6.0');
    expect(received.headers['x-log-signaturemethod']).toBeUndefined();
    expect(received.headers['content-md5']).toBe(
      crypto.createHash('md5').update(received.body).digest('hex').toUpperCase(),
    );
    expect(received.headers['x-log-bodyrawsize']).toBe(String(received.body.byteLength));
    expect(received.body.toString('utf8')).toContain('gen_ai.session.id');
    expect(received.body.toString('utf8')).toContain('test-session-1');
  });

  it('apiKey failure persists failed batch without raw API Key', async () => {
    await withMockSlsServer(async ({ endpoint }) => {
      const flusher = new SlsFlusher(
        makeConfig([apiKeyEndpoint('api-key-sls', endpoint, 'api-key-project')]),
        '/tmp/data',
      );

      await flusher.send(buildTestEntry());
      await flusher.flush();
    }, { statusCode: 403, body: '{"errorCode":"Forbidden"}' });

    expect(mockFailureWrite).toHaveBeenCalledOnce();
    const [failure] = mockFailureWrite.mock.calls[0];
    expect(JSON.stringify(failure)).not.toContain('api-key-sls-api-key');
    expect(failure).toMatchObject({
      endpoint: 'api-key-sls',
      mode: 'apiKey',
      project: 'api-key-project',
      logstore: 'api-key-project-store',
      kind: 'agentActivity',
      batchCount: 1,
    });
    expect(failure.batchBytes).toBeGreaterThan(0);
    expect(String(failure.error)).toContain('Forbidden');
  });

  it('keeps WebTracking retries for a real fetch error and reports bounded safe detail', async () => {
    const causeText = `getaddrinfo ENOTFOUND original-host.example Authorization: Bearer test-token ${'x'.repeat(700)}`;
    fetchSpy.mockRejectedValue(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(causeText), { code: 'ENOTFOUND' }),
    }));
    const flusher = new SlsFlusher(
      makeConfig(
        [wtEndpoint('web-network', 'https://cn-shanghai.log.aliyuncs.com', 'web-project')],
        { retry: { retryMaxAttempts: 3, retryBaseDelayMs: 0, retryJitter: false } },
      ),
      '/tmp/data',
    );
    flusher.setAlarmManager({ record: mockAlarmRecord } as any);

    await flusher.send(buildTestEntry());
    await flusher.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(mockAlarmRecord).toHaveBeenCalledOnce();
    const message = mockAlarmRecord.mock.calls[0][2] as string;
    expect(message).toContain('category=dns code=ENOTFOUND attempts=3');
    expect(message).toContain('TypeError: fetch failed');
    expect(message).toContain('original-host.example');
    expect(message).toContain('Authorization: [REDACTED]');
    expect(message).not.toContain('test-token');
    expect(message).not.toContain('x'.repeat(700));
  });

  it('does not change permanent HTTP retry behavior or report the response body', async () => {
    const body = '{"errorCode":"Forbidden","message":"original response text"}';
    fetchSpy.mockResolvedValue({ ok: false, status: 403, text: async () => body });
    const flusher = new SlsFlusher(
      makeConfig(
        [wtEndpoint('web-http', 'https://cn-shanghai.log.aliyuncs.com', 'web-project')],
        { retry: { retryMaxAttempts: 3, retryBaseDelayMs: 0, retryJitter: false } },
      ),
      '/tmp/data',
    );
    flusher.setAlarmManager({ record: mockAlarmRecord } as any);

    await flusher.send(buildTestEntry());
    await flusher.flush();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(mockAlarmRecord).toHaveBeenCalledOnce();
    const message = mockAlarmRecord.mock.calls[0][2] as string;
    expect(message).toContain('category=http code=Forbidden status=403 attempts=1');
    expect(message).not.toContain('original response text');
  });
});

interface MockRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

async function withMockSlsServer<T>(
  fn: (args: { endpoint: string; requests: MockRequest[] }) => Promise<T>,
  response: { statusCode: number; body: string } = { statusCode: 200, body: '' },
): Promise<T> {
  const requests: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.statusCode = response.statusCode;
      res.end(response.body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock server did not bind to a TCP port');
    return await fn({ endpoint: `http://127.0.0.1:${address.port}`, requests });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
}

import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import {
  contentMd5Hex,
  postApiKeyLogStoreLogs,
} from '../../../src/flushers/sls-transport.js';

describe('SLS API Key transport', () => {
  it('computes uppercase hex Content-MD5', () => {
    expect(contentMd5Hex(Buffer.from('abc'))).toBe('900150983CD24FB0D6963F7D28E17F72');
  });

  it('posts protobuf bytes to a local mock service and retries retryable responses', async () => {
    const requests = await withMockSlsServer(
      async ({ endpoint, requests }) => {
        await postApiKeyLogStoreLogs(
          {
            endpoint,
            project: 'api-key-project',
            logstore: 'shimu-test',
            apiKey: 'secret-api-key',
            maxRetries: 2,
            retryBaseDelayMs: 1,
            timeoutMs: 5000,
          },
          {
            logs: [{
              timestamp: 1_782_820_111,
              content: {
                message: 'local mock api key transport test',
                test_case: 'api-key-transport',
              },
            }],
            topic: 'api-key-test',
            source: 'unit-test',
            tags: [{ __hostname__: 'unit-host' }],
          },
          { userAgent: 'unit-test-agent' },
        );
        return requests;
      },
      [500, 200],
    );

    expect(requests).toHaveLength(2);
    const last = requests[1];
    expect(last.url).toBe('/logstores/shimu-test/shards/lb');
    expect(last.headers.host).toMatch(/^api-key-project\.127\.0\.0\.1:\d+$/);
    expect(last.headers.authorization).toBe('Bearer secret-api-key');
    expect(last.headers['content-type']).toBe('application/x-protobuf');
    expect(last.headers['content-md5']).toBe(crypto.createHash('md5').update(last.body).digest('hex').toUpperCase());
    expect(Number.isFinite(Date.parse(String(last.headers.date)))).toBe(true);
    expect(last.headers['x-log-bodyrawsize']).toBe(String(last.body.byteLength));
    expect(last.headers['x-log-signaturemethod']).toBeUndefined();
    expect(last.body.toString('utf8')).toContain('api-key-transport');
  });
});

interface MockRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

async function withMockSlsServer<T>(
  fn: (args: { endpoint: string; requests: MockRequest[] }) => Promise<T>,
  statusCodes: number[],
): Promise<T> {
  const requests: MockRequest[] = [];
  let count = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.statusCode = statusCodes[Math.min(count, statusCodes.length - 1)] ?? 200;
      count++;
      res.end(res.statusCode >= 400 ? '{"errorCode":"retry"}' : '');
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

import { describe, it, expect } from 'vitest';
import { constants as osConstants } from 'node:os';
import {
  splitForWebtracking,
  isRetryable,
  HttpError,
  classifySlsFailure,
  extractEndpointHost,
} from '../../../src/flushers/sls-transport.js';

describe('splitForWebtracking', () => {
  it('returns single chunk when under limits', () => {
    const logs = [{ content: 'line1' }, { content: 'line2' }];
    const chunks = splitForWebtracking(logs);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(logs);
  });

  it('splits by max logs count', () => {
    const logs = Array.from({ length: 5 }, (_, i) => ({ content: `line${i}` }));
    const chunks = splitForWebtracking(logs, 2);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(2);
    expect(chunks[1]).toHaveLength(2);
    expect(chunks[2]).toHaveLength(1);
  });

  it('splits by max bytes', () => {
    const bigContent = 'x'.repeat(1000);
    const logs = Array.from({ length: 5 }, () => ({ content: bigContent }));
    const chunks = splitForWebtracking(logs, 100, 2500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
  });

  it('returns empty array for empty input', () => {
    expect(splitForWebtracking([])).toEqual([]);
  });
});

describe('isRetryable', () => {
  it('returns true for retryable HttpError status codes', () => {
    expect(isRetryable(new HttpError(429, 'rate limited'))).toBe(true);
    expect(isRetryable(new HttpError(500, 'internal'))).toBe(true);
    expect(isRetryable(new HttpError(502, 'bad gateway'))).toBe(true);
    expect(isRetryable(new HttpError(503, 'unavailable'))).toBe(true);
    expect(isRetryable(new HttpError(504, 'timeout'))).toBe(true);
    expect(isRetryable(new HttpError(408, 'request timeout'))).toBe(true);
  });

  it('returns false for non-retryable HttpError status codes', () => {
    expect(isRetryable(new HttpError(400, 'bad request'))).toBe(false);
    expect(isRetryable(new HttpError(401, 'unauthorized'))).toBe(false);
    expect(isRetryable(new HttpError(403, 'forbidden'))).toBe(false);
    expect(isRetryable(new HttpError(404, 'not found'))).toBe(false);
  });

  it('returns true for network errors', () => {
    expect(isRetryable(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryable(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRetryable(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
    expect(isRetryable(new Error('TimeoutError'))).toBe(true);
    expect(isRetryable(Object.assign(new Error('operation aborted'), { name: 'AbortError' }))).toBe(true);
  });

  it('returns false for unknown errors', () => {
    expect(isRetryable(new Error('some random error'))).toBe(false);
    expect(isRetryable('string error')).toBe(false);
  });
});

describe('classifySlsFailure', () => {
  it.each([
    [401, 'auth_failed', false],
    [403, 'permission_denied', false],
    [404, 'not_found', false],
    [408, 'network_timeout', true],
    [413, 'payload_too_large', false],
    [429, 'quota_throttle', true],
    [500, 'server_error', true],
  ] as const)('classifies HTTP %s as %s', (status, failureClass, retryable) => {
    const diagnostics = classifySlsFailure(new HttpError(status, 'body'));
    expect(diagnostics.failure_class).toBe(failureClass);
    expect(diagnostics.status_code).toBe(status);
    expect(diagnostics.retryable).toBe(retryable);
  });

  it('classifies timeout and refused network errors', () => {
    expect(classifySlsFailure(Object.assign(new Error('operation aborted'), { name: 'AbortError' })).failure_class).toBe('network_timeout');
    expect(classifySlsFailure(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })).failure_class).toBe('network_timeout');
    expect(classifySlsFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).failure_class).toBe('network_refused');
  });

  it('classifies Node fetch TypeError by nested cause code and errno', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18082'), {
      code: 'ECONNREFUSED',
      errno: -osConstants.errno.ECONNREFUSED,
      syscall: 'connect',
      address: '127.0.0.1',
      port: 18082,
    });
    const err = new TypeError('fetch failed');
    Object.assign(err, { cause });

    const diagnostics = classifySlsFailure(err);
    expect(diagnostics.failure_class).toBe('network_refused');
    expect(diagnostics.status_code).toBeUndefined();
    expect(diagnostics.retryable).toBe(true);
    expect(diagnostics.reason).toContain('name=TypeError');
    expect(diagnostics.reason).toContain('message=fetch failed');
    expect(diagnostics.reason).toContain('cause.code=ECONNREFUSED');
    expect(diagnostics.reason).toContain(`cause.errno=${-osConstants.errno.ECONNREFUSED}`);
    expect(diagnostics.reason).toContain('cause.message=connect ECONNREFUSED 127.0.0.1:18082');
  });

  it('classifies nested cause timeout and reset errors', () => {
    const timeoutCause = Object.assign(new Error('connect timeout'), {
      errno: -osConstants.errno.ETIMEDOUT,
    });
    const timeoutWrapper = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('wrapped transport error'), {
        cause: timeoutCause,
      }),
    });
    expect(classifySlsFailure(timeoutWrapper)).toMatchObject({
      failure_class: 'network_timeout',
      retryable: true,
    });

    const resetErr = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket closed'), {
        code: 'ECONNRESET',
        errno: -osConstants.errno.ECONNRESET,
      }),
    });
    expect(classifySlsFailure(resetErr)).toMatchObject({
      failure_class: 'network_refused',
      retryable: true,
    });
  });

  it('classifies common AK SDK error shape', () => {
    const diagnostics = classifySlsFailure({
      statusCode: 403,
      code: 'AccessDenied',
      name: 'SlsError',
      message: 'missing log:PostLogStoreLogs permission',
    });

    expect(diagnostics.failure_class).toBe('permission_denied');
    expect(diagnostics.status_code).toBe(403);
    expect(diagnostics.retryable).toBe(false);
    expect(diagnostics.reason).toContain('AccessDenied');
  });

  it('sanitizes and limits failure reason', () => {
    const diagnostics = classifySlsFailure(new HttpError(
      403,
      `AccessKeyId=LTAI1234567890SECRET "accessKeySecret":"plainsecret" Authorization: Bearer tokenvalue url=https://user:pass@example.com/path?token=abc ${'x'.repeat(400)}`,
    ));

    expect(diagnostics.reason.length).toBeLessThanOrEqual(240);
    expect(diagnostics.reason).not.toContain('LTAI1234567890SECRET');
    expect(diagnostics.reason).not.toContain('plainsecret');
    expect(diagnostics.reason).not.toContain('tokenvalue');
    expect(diagnostics.reason).not.toContain('/path?token=abc');
    expect(diagnostics.reason).toContain('[url:example.com]');
  });

  it('falls back to unknown for unrecognized errors', () => {
    const diagnostics = classifySlsFailure(new Error('some random error'));
    expect(diagnostics.failure_class).toBe('unknown');
    expect(diagnostics.status_code).toBeUndefined();
    expect(diagnostics.retryable).toBe(false);
  });
});

describe('extractEndpointHost', () => {
  it('extracts only host from URL endpoint', () => {
    expect(extractEndpointHost('https://user:pass@cn-hangzhou.log.aliyuncs.com/path?q=1')).toBe('cn-hangzhou.log.aliyuncs.com');
  });

  it('supports host-only endpoints and returns empty for invalid input', () => {
    expect(extractEndpointHost('cn-hangzhou.log.aliyuncs.com')).toBe('cn-hangzhou.log.aliyuncs.com');
    expect(extractEndpointHost('')).toBe('');
  });
});

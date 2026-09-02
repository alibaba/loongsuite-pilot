import { describe, it, expect } from 'vitest';
import {
  splitForWebtracking,
  isRetryable,
  HttpError,
  classifySlsSendError,
  formatSlsSendFailureMessage,
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
  });

  it('returns false for unknown errors', () => {
    expect(isRetryable(new Error('some random error'))).toBe(false);
    expect(isRetryable('string error')).toBe(false);
  });

  it('does not expand retry behavior based on a nested diagnostic code', () => {
    const outer = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('private detail'), { code: 'ECONNRESET' }),
    });
    expect(isRetryable(outer)).toBe(false);
    expect(classifySlsSendError(outer)).toMatchObject({
      retryable: false,
      code: 'ECONNRESET',
      category: 'connection_reset',
    });
  });

  it('does not traverse cause while making the legacy retry decision', () => {
    let causeReads = 0;
    const outer = Object.defineProperty(new Error('network failure'), 'cause', {
      get: () => {
        causeReads += 1;
        return Object.assign(new Error('private detail'), { code: 'ECONNRESET' });
      },
    });
    expect(isRetryable(outer)).toBe(true);
    expect(causeReads).toBe(0);
  });
});

describe('classifySlsSendError', () => {
  it('keeps structured ShardWriteQuotaExceed 403 permanent while exposing its code', () => {
    for (const body of [
      '{"errorCode":"ShardWriteQuotaExceed"}',
      '{"code":"ShardWriteQuotaExceed"}',
    ]) {
      expect(classifySlsSendError(new HttpError(403, body))).toEqual({
        retryable: false,
        quota: false,
        category: 'http',
        code: 'ShardWriteQuotaExceed',
        httpStatus: 403,
        detail: '',
      });
    }

    expect(isRetryable(new HttpError(403, 'ShardWriteQuotaExceed'))).toBe(false);
    expect(isRetryable(new HttpError(403, '{broken ShardWriteQuotaExceed'))).toBe(false);
    expect(isRetryable(new HttpError(403, 'network ECONNRESET'))).toBe(false);
    expect(isRetryable(new HttpError(
      403,
      `${'{"errorCode":"ShardWriteQuotaExceed","padding":"'}${'x'.repeat(17_000)}"}`,
    ))).toBe(false);
  });

  it('exposes AK SDK error codes without changing retry policy', () => {
    expect(classifySlsSendError({ code: 'ShardWriteQuotaExceed', statusCode: 403 })).toEqual({
      retryable: false,
      quota: false,
      category: 'http',
      code: 'ShardWriteQuotaExceed',
      httpStatus: 403,
      detail: '',
    });
    expect(classifySlsSendError({ errorCode: 'ShardWriteQuotaExceed', status: '403' })).toMatchObject({
      retryable: false,
      quota: false,
      category: 'http',
      code: 'ShardWriteQuotaExceed',
    });
    expect(classifySlsSendError({ code: 'ShardWriteQuotaExceed' })).toMatchObject({
      retryable: false,
      quota: false,
      category: 'unknown',
      code: 'ShardWriteQuotaExceed',
    });
    expect(classifySlsSendError({ code: 'ShardWriteQuotaExceed', status: 400 })).toMatchObject({
      retryable: false,
      quota: false,
      category: 'http',
      httpStatus: 400,
    });
  });

  it('preserves existing HTTP 429 retry and quota classification', () => {
    expect(classifySlsSendError(new HttpError(429, 'throttled'))).toEqual({
      retryable: true,
      quota: true,
      category: 'quota',
      code: 'HTTP_429',
      httpStatus: 429,
      detail: '',
    });
  });

  it.each([
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNRESET', 'connection_reset'],
    ['ECONNREFUSED', 'connection_refused'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['ENETUNREACH', 'route'],
    ['EHOSTUNREACH', 'route'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['UND_ERR_PROXY', 'proxy'],
  ])('maps nested code %s to %s', (code, category) => {
    const outer = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('private detail'), { code }),
    });
    expect(classifySlsSendError(outer)).toMatchObject({ code, category });
  });

  it('maps proxy and generic HTTP status without guessing raw causes', () => {
    expect(classifySlsSendError(new HttpError(407, 'proxy address here'))).toMatchObject({
      category: 'proxy',
      code: 'HTTP_407',
      httpStatus: 407,
    });
    expect(classifySlsSendError(new HttpError(403, '{"errorCode":"Forbidden"}'))).toEqual({
      retryable: false,
      quota: false,
      category: 'http',
      code: 'Forbidden',
      httpStatus: 403,
      detail: '',
    });
  });

  it('terminates on cyclic and over-depth cause chains', () => {
    const cyclic: Record<string, unknown> = { name: 'Error', message: 'outer' };
    cyclic.cause = cyclic;
    expect(classifySlsSendError(cyclic)).toMatchObject({
      retryable: false,
      category: 'unknown',
      code: 'UNKNOWN',
    });

    const nodes = Array.from({ length: 6 }, () => ({ cause: undefined as unknown }));
    for (let index = 0; index < nodes.length - 1; index++) nodes[index].cause = nodes[index + 1];
    Object.assign(nodes[5], { code: 'ECONNRESET' });
    expect(classifySlsSendError(nodes[0]).code).toBe('UNKNOWN');

    const hostile = Object.defineProperty({}, 'cause', {
      get: () => { throw new Error('getter must not escape'); },
    });
    expect(() => classifySlsSendError(hostile)).not.toThrow();
  });

  it('rejects unsafe or overlong codes and uses an unknown fallback', () => {
    expect(classifySlsSendError({ code: 'unsafe code with spaces' }).code).toBe('UNKNOWN');
    expect(classifySlsSendError({ code: `E${'X'.repeat(128)}` }).code).toBe('UNKNOWN');
    expect(classifySlsSendError(new TypeError('fetch failed'))).toEqual({
      retryable: false,
      quota: false,
      category: 'unknown',
      code: 'UNKNOWN',
      httpStatus: 0,
      detail: 'TypeError: fetch failed',
    });
  });

  it('includes bounded network detail while redacting credential patterns', () => {
    const classification = classifySlsSendError(Object.assign(
      new Error('Authorization: Bearer secret and https://private.example'),
      { cause: Object.assign(new Error('certificate detail'), { code: 'ENOTFOUND' }) },
    ));
    const message = formatSlsSendFailureMessage('webtracking', classification, 3);
    expect(message).toBe(
      'SLS webtracking send failed [category=dns code=ENOTFOUND attempts=3]'
      + ' detail="Error: Authorization: [REDACTED] and https://private.example <- Error: certificate detail"',
    );
    expect(message).not.toContain('secret');
    expect(message).toContain('private.example');
    expect(message).toContain('certificate detail');
  });

  it('bounds and flattens network detail to 512 UTF-8 bytes', () => {
    const classification = classifySlsSendError(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(`line one\n${'测'.repeat(400)}`), { code: 'ECONNRESET' }),
    }));
    expect(Buffer.byteLength(classification.detail, 'utf8')).toBeLessThanOrEqual(512);
    expect(classification.detail).not.toContain('\n');
  });
});

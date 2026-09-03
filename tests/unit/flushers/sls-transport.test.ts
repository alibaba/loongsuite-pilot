import { describe, it, expect } from 'vitest';
import { splitForWebtracking, isRetryable, HttpError } from '../../../src/flushers/sls-transport.js';
import {
  classifySlsSendError,
  formatSlsSendFailureMessage,
  redactSensitiveErrorText,
} from '../../../src/flushers/sls-error-classifier.js';

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
});

describe('SLS send error diagnostics', () => {
  it.each([
    ['Authorization: Bearer test-token', 'Authorization: [REDACTED]'],
    ['Authorization=Basic test-token', 'Authorization=[REDACTED]'],
    ['Bearer test-token', 'Bearer [REDACTED]'],
    ['accessKeyId=test-key', 'accessKeyId=[REDACTED]'],
    ['access-key-secret=test-secret', 'access-key-secret=[REDACTED]'],
    ['api_key=test-api-key', 'api_key=[REDACTED]'],
    [`LTAI${'1'.repeat(16)}`, '[REDACTED_ACCESS_KEY]'],
    ['https://user:password@example.com', 'https://[REDACTED]@example.com'],
  ])('redacts known credential pattern in %s', (input, expected) => {
    expect(redactSensitiveErrorText(input)).toBe(expected);
  });

  it.each([
    ['ENOTFOUND', 'dns'],
    ['ECONNRESET', 'connection_reset'],
    ['ECONNREFUSED', 'connection_refused'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['ENETUNREACH', 'route'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['UND_ERR_PROXY', 'proxy'],
  ])('reads nested code %s as %s', (code, category) => {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('original cause text'), { code }),
    });

    expect(classifySlsSendError(error)).toMatchObject({ code, category });
  });

  it('extracts a structured HTTP code without including the response body', () => {
    const body = '{"errorCode":"Forbidden","message":"original response text"}';
    const classification = classifySlsSendError(new HttpError(403, body));

    expect(classification).toEqual({
      category: 'http',
      code: 'Forbidden',
      httpStatus: 403,
      detail: '',
    });
    expect(formatSlsSendFailureMessage('webtracking', classification, 1))
      .not.toContain('original response text');
  });

  it('redacts credentials from network error detail', () => {
    const causeText = 'Authorization: Bearer test-token accessKeySecret=test-secret'
      + ' apiKey=test-api-key https://user:password@example.com';
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(causeText), { code: 'ECONNRESET' }),
    });
    const classification = classifySlsSendError(error);
    const message = formatSlsSendFailureMessage('webtracking', classification, 3);

    expect(classification).not.toHaveProperty('retryable');
    expect(message).toContain('category=connection_reset code=ECONNRESET attempts=3');
    expect(message).toContain('Authorization: [REDACTED]');
    expect(message).toContain('accessKeySecret=[REDACTED]');
    expect(message).toContain('apiKey=[REDACTED]');
    expect(message).toContain('https://[REDACTED]@example.com');
    expect(message).not.toContain('test-token');
    expect(message).not.toContain('test-secret');
    expect(message).not.toContain('test-api-key');
    expect(message).not.toContain('user:password');
  });

  it('flattens and truncates network detail to 512 UTF-8 bytes', () => {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(`line one\n${'测'.repeat(400)}`), { code: 'ECONNRESET' }),
    });
    const classification = classifySlsSendError(error);

    expect(Buffer.byteLength(classification.detail, 'utf8')).toBeLessThanOrEqual(512);
    expect(classification.detail).not.toContain('\n');
    expect(classification.detail).not.toContain('\uFFFD');
  });

  it('bounds HTTP response parsing and error codes', () => {
    const overlongBody = `${'{"errorCode":"Forbidden","padding":"'}${'x'.repeat(17_000)}"}`;

    expect(classifySlsSendError(new HttpError(403, overlongBody))).toEqual({
      category: 'http',
      code: 'HTTP_403',
      httpStatus: 403,
      detail: '',
    });
    expect(classifySlsSendError({ code: `E${'X'.repeat(128)}` }).code).toBe('UNKNOWN');
  });

  it('terminates on a cyclic cause chain', () => {
    const error: Record<string, unknown> = { name: 'Error', message: 'cyclic' };
    error.cause = error;

    expect(classifySlsSendError(error)).toEqual({
      category: 'unknown',
      code: 'UNKNOWN',
      httpStatus: 0,
      detail: 'Error: cyclic',
    });
  });
});

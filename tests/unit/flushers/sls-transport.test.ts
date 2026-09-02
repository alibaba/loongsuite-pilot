import { describe, it, expect } from 'vitest';
import { splitForWebtracking, isRetryable, HttpError } from '../../../src/flushers/sls-transport.js';
import {
  classifySlsSendError,
  formatSlsSendFailureMessage,
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

  it('extracts a structured HTTP code and retains the original response text', () => {
    const body = '{"errorCode":"Forbidden","message":"original response text"}';
    const classification = classifySlsSendError(new HttpError(403, body));

    expect(classification).toEqual({
      category: 'http',
      code: 'Forbidden',
      httpStatus: 403,
      detail: `Error: 403 ${body}`,
    });
    expect(formatSlsSendFailureMessage('webtracking', classification, 1))
      .toContain('original response text');
  });

  it('retains unredacted and untruncated error and cause text', () => {
    const causeText = `Authorization: Bearer original-token ${'x'.repeat(700)}`;
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(causeText), { code: 'ECONNRESET' }),
    });
    const classification = classifySlsSendError(error);
    const message = formatSlsSendFailureMessage('webtracking', classification, 3);

    expect(classification).not.toHaveProperty('retryable');
    expect(classification.detail).toBe(`TypeError: fetch failed <- Error: ${causeText}`);
    expect(message).toContain('category=connection_reset code=ECONNRESET attempts=3');
    expect(message).toContain('original-token');
    expect(message.length).toBeGreaterThan(700);
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

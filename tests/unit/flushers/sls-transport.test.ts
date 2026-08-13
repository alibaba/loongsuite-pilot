import { describe, it, expect } from 'vitest';
import {
  splitForWebtracking,
  isRetryable,
  HttpError,
  classifyFailure,
  FAILURE_CLASS_ALARM_LEVEL,
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
});

describe('classifyFailure', () => {
  it('classifies 413 / body-too-large as payload', () => {
    expect(classifyFailure(new HttpError(413, 'Request Entity Too Large'))).toBe('payload');
    // ak SDK style: no status, message carries the API error
    expect(classifyFailure(new Error('PostBodyTooLarge: body size must little than 10485760'))).toBe('payload');
  });

  it('classifies 429 / ServerBusy as quota', () => {
    expect(classifyFailure(new HttpError(429, 'rate limited'))).toBe('quota');
    expect(classifyFailure({ code: 'ServerBusy', message: 'slow down' })).toBe('quota');
  });

  it('classifies terminal config errors as config', () => {
    expect(classifyFailure(new HttpError(404, '{"errorCode":"ProjectNotExist"}'))).toBe('config');
    expect(classifyFailure(new HttpError(403, 'forbidden'))).toBe('config');
    // ak SDK style: errorCode field, no HTTP status
    expect(classifyFailure({ errorCode: 'ProjectForbidden', message: 'forbidden' })).toBe('config');
    expect(classifyFailure({ code: 'ProjectInRecycleBin' })).toBe('config');
  });

  it('classifies timeouts / network / unknown as transient', () => {
    expect(classifyFailure(new Error('TimeoutError'))).toBe('transient');
    expect(classifyFailure(new Error('fetch failed'))).toBe('transient');
    expect(classifyFailure(new HttpError(500, 'internal'))).toBe('transient');
    expect(classifyFailure('some unknown error')).toBe('transient');
  });

  it('maps each class to the expected alarm level', () => {
    expect(FAILURE_CLASS_ALARM_LEVEL.transient).toBe('3');
    expect(FAILURE_CLASS_ALARM_LEVEL.quota).toBe('2');
    expect(FAILURE_CLASS_ALARM_LEVEL.config).toBe('1');
    expect(FAILURE_CLASS_ALARM_LEVEL.payload).toBe('1');
  });
});

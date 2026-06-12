import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

const mockAxiosPost = vi.fn().mockResolvedValue({ status: 200 });

vi.mock('axios', () => ({
  default: { post: (...args: unknown[]) => mockAxiosPost(...args) },
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { HttpFlusher } from '../../../src/flushers/http-flusher.js';
import type { HttpFlusherConfig } from '../../../src/types/index.js';

function makeConfig(overrides: Partial<HttpFlusherConfig> = {}): HttpFlusherConfig {
  return {
    enabled: true,
    url: 'https://api.example.com/report',
    batchMaxSize: 5,
    flushIntervalMs: 99999,
    requestTimeoutMs: 10000,
    ...overrides,
  };
}

describe('HttpFlusher', () => {
  let flusher: HttpFlusher;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    flusher = new HttpFlusher(makeConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('buffer and auto-flush (T018)', () => {
    it('buffers entries until batchMaxSize is reached', async () => {
      for (let i = 0; i < 4; i++) {
        await flusher.send(buildTestEntry());
      }
      expect(mockAxiosPost).not.toHaveBeenCalled();

      await flusher.send(buildTestEntry());
      expect(mockAxiosPost).toHaveBeenCalledOnce();
    });

    it('sends { entries: batch } payload to configured URL', async () => {
      for (let i = 0; i < 5; i++) {
        await flusher.send(buildTestEntry());
      }

      const [url, body] = mockAxiosPost.mock.calls[0];
      expect(url).toBe('https://api.example.com/report');
      expect(body.entries).toHaveLength(5);
    });
  });

  describe('failure re-queue (T019)', () => {
    it('unshifts batch back to buffer head on failure', async () => {
      mockAxiosPost.mockRejectedValueOnce(new Error('network error'));

      for (let i = 0; i < 5; i++) {
        await flusher.send(buildTestEntry());
      }
      // After failure, batch should be back in buffer
      // Now a successful flush should send them
      mockAxiosPost.mockResolvedValueOnce({ status: 200 });
      await flusher.flush();

      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
      const secondBody = mockAxiosPost.mock.calls[1][1];
      expect(secondBody.entries.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('shutdown (T020)', () => {
    it('stops timer and flushes remaining buffer', async () => {
      await flusher.start();
      await flusher.send(buildTestEntry());
      await flusher.send(buildTestEntry());

      await flusher.shutdown();

      expect(mockAxiosPost).toHaveBeenCalledOnce();
      const body = mockAxiosPost.mock.calls[0][1];
      expect(body.entries).toHaveLength(2);
    });

    it('does not flush when buffer is empty', async () => {
      await flusher.start();
      await flusher.shutdown();
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });
  });

  describe('request config (T021)', () => {
    it('passes custom headers and timeout', async () => {
      flusher = new HttpFlusher(makeConfig({
        headers: { 'X-Api-Key': 'secret' },
        requestTimeoutMs: 5000,
        batchMaxSize: 1,
      }));

      await flusher.send(buildTestEntry());

      const [, , config] = mockAxiosPost.mock.calls[0];
      expect(config.headers['X-Api-Key']).toBe('secret');
      expect(config.headers['Content-Type']).toBe('application/json');
      expect(config.timeout).toBe(5000);
    });
  });

  describe('sendRaw', () => {
    it('posts topic and payload to configured URL', async () => {
      await flusher.sendRaw('test-topic', { key: 'val' });

      expect(mockAxiosPost).toHaveBeenCalledOnce();
      const [url, body] = mockAxiosPost.mock.calls[0];
      expect(url).toBe('https://api.example.com/report');
      expect(body.topic).toBe('test-topic');
      expect(body.key).toBe('val');
    });
  });

  describe('sendBatch', () => {
    it('buffers all entries and auto-flushes when threshold met', async () => {
      const entries = Array.from({ length: 5 }, () => buildTestEntry());
      await flusher.sendBatch(entries);

      expect(mockAxiosPost).toHaveBeenCalledOnce();
      const body = mockAxiosPost.mock.calls[0][1];
      expect(body.entries).toHaveLength(5);
    });
  });
});

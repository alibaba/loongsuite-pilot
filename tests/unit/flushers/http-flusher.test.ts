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
    mockAxiosPost.mockReset().mockResolvedValue({ status: 200 });
    vi.useFakeTimers();
    flusher = new HttpFlusher(makeConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('buffer and auto-flush (T018)', () => {
    it('posts one Codex batch immediately and waits for network ACK below the buffer threshold', async () => {
      let acknowledge!: () => void;
      mockAxiosPost.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve; }));
      const entries = [1, 2].map(index => buildTestEntry({ 'event.id': `codex-${index}`, 'gen_ai.agent.type': 'codex' }));
      let accepted = false;
      const sending = flusher.sendBatch(entries).then(() => { accepted = true; });
      expect(mockAxiosPost).toHaveBeenCalledOnce();
      expect(mockAxiosPost.mock.calls[0][1].entries).toHaveLength(2);
      expect(accepted).toBe(false);
      acknowledge();
      await sending;
      await flusher.flush();
      expect(accepted).toBe(true);
      expect(mockAxiosPost).toHaveBeenCalledOnce();
    });

    it('retries the same failed Codex batch on the existing timer and only accepts its ACK', async () => {
      flusher = new HttpFlusher(makeConfig({ flushIntervalMs: 100 }));
      await flusher.start();
      await flusher.send(buildTestEntry({ 'event.id': 'ordinary-queued' }));
      mockAxiosPost.mockRejectedValueOnce(new Error('offline'));
      let accepted = false;
      const sending = flusher.send(buildTestEntry({ 'event.id': 'codex-retry', 'gen_ai.agent.type': 'codex' }))
        .then(() => { accepted = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(accepted).toBe(false);
      expect(mockAxiosPost).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      await sending;
      expect(accepted).toBe(true);
      expect(mockAxiosPost.mock.calls.map(call => call[1].entries.map((entry: Record<string, string>) => entry['event.id'])))
        .toEqual([['codex-retry'], ['ordinary-queued'], ['codex-retry']]);
      await flusher.flush();
      expect(mockAxiosPost).toHaveBeenCalledTimes(3);
      await flusher.shutdown();
    });

    it('serializes Codex retries across timer and concurrent flush calls', async () => {
      let acknowledge!: () => void;
      mockAxiosPost.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve; }));
      const sending = flusher.send(buildTestEntry({ 'gen_ai.agent.type': 'codex' }));
      const first = flusher.flush();
      const second = flusher.flush();
      expect(mockAxiosPost).toHaveBeenCalledOnce();
      acknowledge();
      await Promise.all([sending, first, second]);
      await flusher.flush();
      expect(mockAxiosPost).toHaveBeenCalledOnce();
    });

    it('keeps every pending Codex batch until its own ACK', async () => {
      mockAxiosPost.mockRejectedValueOnce(new Error('offline'));
      const first = flusher.send(buildTestEntry({ 'event.id': 'first', 'gen_ai.agent.type': 'codex' }));
      const second = flusher.send(buildTestEntry({ 'event.id': 'second', 'gen_ai.agent.type': 'codex' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockAxiosPost).toHaveBeenCalledOnce();
      await flusher.flush();
      await Promise.all([first, second]);
      expect(mockAxiosPost.mock.calls.map(call => call[1].entries[0]['event.id'])).toEqual(['first', 'first', 'second']);
    });

    it('cancels a retained Codex batch without retrying it after its input stops', async () => {
      const controller = new AbortController();
      mockAxiosPost.mockRejectedValueOnce(new Error('offline'));
      const sending = flusher.sendBatch([buildTestEntry({ 'gen_ai.agent.type': 'codex' })], undefined, controller.signal);
      const rejected = expect(sending).rejects.toMatchObject({ name: 'CodexOutputDurabilityError' });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await rejected;
      await flusher.flush();
      expect(mockAxiosPost).toHaveBeenCalledOnce();
    });

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

    it('releases a failed Codex send during shutdown and leaves ordinary flushing intact', async () => {
      await flusher.start();
      mockAxiosPost.mockRejectedValueOnce(new Error('offline'));
      const sending = flusher.send(buildTestEntry({ 'gen_ai.agent.type': 'codex' }));
      const rejected = expect(sending).rejects.toMatchObject({ name: 'CodexOutputDurabilityError' });
      await vi.advanceTimersByTimeAsync(0);
      await flusher.send(buildTestEntry({ 'event.id': 'ordinary' }));
      await flusher.shutdown();
      await rejected;
      await vi.advanceTimersByTimeAsync(99999);
      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
      expect(mockAxiosPost.mock.calls[1][1].entries[0]['event.id']).toBe('ordinary');
    });

    it('aborts an in-flight Codex request before waiting for shutdown', async () => {
      mockAxiosPost.mockImplementationOnce((_url, _body, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
      const sending = flusher.send(buildTestEntry({ 'gen_ai.agent.type': 'codex' }));
      const rejected = expect(sending).rejects.toMatchObject({ name: 'CodexOutputDurabilityError' });
      await flusher.shutdown();
      await rejected;
      expect(mockAxiosPost.mock.calls[0][2].signal.aborted).toBe(true);
      expect(mockAxiosPost).toHaveBeenCalledOnce();
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

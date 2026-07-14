import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPostWebtracking = vi.fn().mockResolvedValue(undefined);
const mockPersistFailedLogs = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/flushers/sls-transport.js', () => ({
  postWebtracking: (...args: unknown[]) => mockPostWebtracking(...args),
  persistFailedLogs: (...args: unknown[]) => mockPersistFailedLogs(...args),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { FileSlsSender } from '../../../src/pipeline/flusher/file/file-sls-sender.js';

function makeSender(): FileSlsSender {
  return new FileSlsSender(
    {
      Type: 'flusher_sls',
      Endpoint: 'cn-hangzhou.log.aliyuncs.com',
      Project: 'test-project',
      Logstore: 'test-logstore',
    },
    'test-config',
    '/tmp/test-failed',
  );
}

describe('FileSlsSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueue adds lines to buffer and returns true', () => {
    const sender = makeSender();
    expect(sender.bufferSize()).toBe(0);
    const result = sender.enqueue(['line1', 'line2', 'line3'], '/tmp/test.log');
    expect(result).toBe(true);
    expect(sender.bufferSize()).toBe(3);
  });

  it('enqueue returns false when buffer is full', () => {
    const sender = makeSender();
    const bigBatch = Array.from({ length: 64_001 }, (_, i) => `line${i}`);
    const r1 = sender.enqueue(bigBatch.slice(0, 64_000), '/tmp/test.log');
    expect(r1).toBe(true);

    const r2 = sender.enqueue(['overflow_line'], '/tmp/test.log');
    expect(r2).toBe(false);
    expect(sender.bufferSize()).toBe(64_000);
  });

  it('isBackpressured returns true at high watermark', () => {
    const sender = makeSender();
    expect(sender.isBackpressured()).toBe(false);

    const batch = Array.from({ length: 32_000 }, (_, i) => `line${i}`);
    sender.enqueue(batch, '/tmp/test.log');
    expect(sender.isBackpressured()).toBe(true);
  });

  it('flush sends buffered lines via postWebtracking', async () => {
    const sender = makeSender();
    sender.enqueue(['line1', 'line2'], '/tmp/test.log');
    await sender.flush();

    expect(mockPostWebtracking).toHaveBeenCalledTimes(1);
    const [config, logs, opts] = mockPostWebtracking.mock.calls[0];
    expect(config.project).toBe('test-project');
    expect(config.logstore).toBe('test-logstore');
    expect(config.endpoint).toBe('https://cn-hangzhou.log.aliyuncs.com');
    expect(logs).toEqual([{ content: 'line1' }, { content: 'line2' }]);
    expect(opts.topic).toBe('test-config');
  });

  it('flush does nothing when buffer is empty', async () => {
    const sender = makeSender();
    await sender.flush();
    expect(mockPostWebtracking).not.toHaveBeenCalled();
  });

  it('flush persists failed logs on error', async () => {
    mockPostWebtracking.mockRejectedValueOnce(new Error('network error'));
    const sender = makeSender();
    sender.enqueue(['line1'], '/tmp/test.log');
    await sender.flush();
    expect(mockPersistFailedLogs).toHaveBeenCalledTimes(1);
  });

  it('shutdown flushes remaining buffer', async () => {
    const sender = makeSender();
    sender.start();
    sender.enqueue(['line1'], '/tmp/test.log');
    await sender.shutdown();
    expect(mockPostWebtracking).toHaveBeenCalled();
    expect(sender.bufferSize()).toBe(0);
  });

  it('bufferSize reflects current count', () => {
    const sender = makeSender();
    expect(sender.bufferSize()).toBe(0);
    sender.enqueue(['a', 'b'], '/tmp/a.log');
    expect(sender.bufferSize()).toBe(2);
    sender.enqueue(['c'], '/tmp/b.log');
    expect(sender.bufferSize()).toBe(3);
  });
});

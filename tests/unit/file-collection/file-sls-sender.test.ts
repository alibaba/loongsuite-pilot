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

import { FileSlsSender } from '../../../src/file-collection/file-sls-sender.js';

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

  it('enqueue adds lines to buffer', () => {
    const sender = makeSender();
    expect(sender.bufferSize()).toBe(0);
    sender.enqueue(['line1', 'line2', 'line3']);
    expect(sender.bufferSize()).toBe(3);
  });

  it('flush sends buffered lines via postWebtracking', async () => {
    const sender = makeSender();
    sender.enqueue(['line1', 'line2']);
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
    sender.enqueue(['line1']);
    await sender.flush();
    expect(mockPersistFailedLogs).toHaveBeenCalledTimes(1);
  });

  it('shutdown flushes remaining buffer', async () => {
    const sender = makeSender();
    sender.start();
    sender.enqueue(['line1']);
    await sender.shutdown();
    expect(mockPostWebtracking).toHaveBeenCalled();
    expect(sender.bufferSize()).toBe(0);
  });

  it('bufferSize reflects current count', () => {
    const sender = makeSender();
    expect(sender.bufferSize()).toBe(0);
    sender.enqueue(['a', 'b']);
    expect(sender.bufferSize()).toBe(2);
    sender.enqueue(['c']);
    expect(sender.bufferSize()).toBe(3);
  });
});

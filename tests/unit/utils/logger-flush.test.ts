import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { flushLogsSync, initFileLogging } from '../../../src/utils/logger.js';

const { mockBuild } = vi.hoisted(() => ({ mockBuild: vi.fn() }));
vi.mock('pino-roll', () => ({ default: mockBuild }));

describe('logger flushLogsSync', () => {
  it('is a safe no-op before file logging is initialized', () => {
    // fileStreamRef is null until initFileLogging runs; the guarded optional-call must
    // not throw. This is the state every early exit path (analytics disabled, lock not
    // acquired, pre-init fatal) relies on when it calls flushLogsSync() before exit.
    expect(() => flushLogsSync()).not.toThrow();
  });

  it('waits for the rotating file to open before exposing the synchronous flush', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilot-logger-ready-'));
    const stream = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValue(true),
      flushSync: vi.fn(),
    });
    mockBuild.mockResolvedValueOnce(stream);
    try {
      const starting = initFileLogging(join(dir, 'service.log'));
      await new Promise<void>(resolve => setImmediate(resolve));
      flushLogsSync();
      expect(stream.flushSync).not.toHaveBeenCalled();

      stream.emit('ready');
      await starting;
      flushLogsSync();
      expect(stream.flushSync).toHaveBeenCalledOnce();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

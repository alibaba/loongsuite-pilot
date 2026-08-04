import { describe, expect, it } from 'vitest';
import { flushLogsSync } from '../../../src/utils/logger.js';

describe('logger flushLogsSync', () => {
  it('is a safe no-op before file logging is initialized', () => {
    // fileStreamRef is null until initFileLogging runs; the guarded optional-call must
    // not throw. This is the state every early exit path (analytics disabled, lock not
    // acquired, pre-init fatal) relies on when it calls flushLogsSync() before exit.
    expect(() => flushLogsSync()).not.toThrow();
  });
});

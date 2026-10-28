import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_POLL_INTERVAL_MS,
  globalPollIntervalMs,
  resolvePollIntervalMs,
} from '../../../src/utils/poll-interval.js';

describe('globalPollIntervalMs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts decimal integers from 1000 through the setInterval maximum', () => {
    vi.stubEnv('LOONGSUITE_PILOT_POLL_INTERVAL_MS', '1000');
    expect(globalPollIntervalMs()).toBe(1_000);
    vi.stubEnv('LOONGSUITE_PILOT_POLL_INTERVAL_MS', '3000');
    expect(globalPollIntervalMs()).toBe(3_000);
    vi.stubEnv('LOONGSUITE_PILOT_POLL_INTERVAL_MS', '2147483647');
    expect(globalPollIntervalMs()).toBe(2_147_483_647);
  });

  it('ignores values Node would clamp, and non-integers', () => {
    for (const raw of ['0', '0.4', '3', '1e5', '1e-5', '0x10', '2147483648', 'nope', '']) {
      vi.stubEnv('LOONGSUITE_PILOT_POLL_INTERVAL_MS', raw);
      expect(globalPollIntervalMs()).toBeUndefined();
    }
    expect(resolvePollIntervalMs(30_000, DEFAULT_POLL_INTERVAL_MS)).toBe(30_000);
  });
});

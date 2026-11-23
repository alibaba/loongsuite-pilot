import { describe, it, expect, vi, beforeEach } from 'vitest';

const { postWebTracking } = vi.hoisted(() => ({ postWebTracking: vi.fn() }));

vi.mock('../../../src/internal/webtracking-post.js', () => ({
  buildWebTrackingUrl: () => 'https://example.test/track',
  postWebTracking: (...args: unknown[]) => postWebTracking(...args),
}));

const { sendRunningStatus } = await import('../../../src/internal/statistic.js');

describe('sendRunningStatus', () => {
  beforeEach(() => {
    postWebTracking.mockClear();
  });

  it('keeps mac and sn and drops fields outside the running-status whitelist', () => {
    sendRunningStatus({
      cpu: '1',
      mac: 'aa:bb:cc:dd:ee:ff',
      sn: 'C02SERIAL',
      hostname: 'host',
      pid: 99,
      user_id: 'someone',
    });

    expect(postWebTracking).toHaveBeenCalledOnce();
    const body = postWebTracking.mock.calls[0][1] as {
      __topic__: string;
      __logs__: Record<string, unknown>[];
    };
    expect(body.__topic__).toBe('pilot_running_status');
    expect(body.__logs__).toEqual([{
      cpu: '1',
      mac: 'aa:bb:cc:dd:ee:ff',
      sn: 'C02SERIAL',
      hostname: 'host',
    }]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'node:crypto';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { DingTalkNotifier } from '../../../src/notifications/dingtalk-notifier.js';
import type { SelfCheckAlert } from '../../../src/notifications/notifier.js';

const mockFetch = vi.fn();

function makeAlert(overrides?: Partial<SelfCheckAlert>): SelfCheckAlert {
  return {
    alertType: 'DATA_GAP',
    agentId: 'claude-code',
    agentDisplayName: 'Claude Code',
    agentVersion: '2.1.119',
    pilotVersion: '1.0.0',
    userId: 'test-user',
    hostname: 'test-host',
    message: 'test alert message',
    timestamp: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('DingTalkNotifier', () => {
  let notifier: DingTalkNotifier;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    notifier = new DingTalkNotifier({
      enabled: true,
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test123',
      secret: 'SECtest_secret',
    });
  });

  it('sends markdown POST with HMAC-SHA256 signed URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: 'ok' }),
    });

    await notifier.send(makeAlert());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('access_token=test123');
    expect(url).toContain('&timestamp=');
    expect(url).toContain('&sign=');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.msgtype).toBe('markdown');
    expect(body.markdown.text).toContain('Claude Code');
    expect(body.markdown.title).toContain('loongsuite-pilot');
    expect(body.markdown.text).toContain('test-host');
  });

  it('produces correct HMAC-SHA256 signature', async () => {
    const timestamp = 1782878400000;
    vi.spyOn(Date, 'now').mockReturnValue(timestamp);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: 'ok' }),
    });

    await notifier.send(makeAlert());

    const [url] = mockFetch.mock.calls[0];
    const expectedSign = crypto.createHmac('sha256', 'SECtest_secret')
      .update(`${timestamp}\nSECtest_secret`)
      .digest('base64');
    expect(url).toContain(`sign=${encodeURIComponent(expectedSign)}`);

    vi.restoreAllMocks();
  });

  it('swallows fetch errors without throwing', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    await expect(notifier.send(makeAlert())).resolves.toBeUndefined();
  });

  it('handles non-200 responses without throwing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    await expect(notifier.send(makeAlert())).resolves.toBeUndefined();
  });

  it('skips signing when secret is empty', async () => {
    const noSecretNotifier = new DingTalkNotifier({
      enabled: true,
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
      secret: '',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: 'ok' }),
    });

    await noSecretNotifier.send(makeAlert());

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://oapi.dingtalk.com/robot/send?access_token=abc');
    expect(url).not.toContain('sign=');
    expect(url).not.toContain('timestamp=');
  });

  it('handles DingTalk errcode without throwing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 310000, errmsg: 'rate limited' }),
    });
    await expect(notifier.send(makeAlert())).resolves.toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('../../../src/notifications/dingtalk-notifier.js', () => ({
  DingTalkNotifier: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { NotificationGateway } from '../../../src/notifications/notification-gateway.js';
import { DingTalkNotifier } from '../../../src/notifications/dingtalk-notifier.js';
import type { SelfCheckAlert } from '../../../src/notifications/notifier.js';

function makeAlert(agentId = 'claude-code'): SelfCheckAlert {
  return {
    alertType: 'DATA_GAP',
    agentId,
    agentDisplayName: 'Claude Code',
    agentVersion: '2.1.0',
    pilotVersion: '1.0.0',
    userId: 'test',
    hostname: 'test',
    message: 'test',
    timestamp: new Date().toISOString(),
  };
}

describe('NotificationGateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when no notifiers are configured', async () => {
    const gw = new NotificationGateway({});
    expect(gw.hasNotifiers).toBe(false);
    await gw.send(makeAlert());
  });

  it('registers DingTalk notifier when enabled with webhook', () => {
    const gw = new NotificationGateway({
      dingtalk: { enabled: true, webhookUrl: 'https://example.com', secret: 's' },
    });
    expect(gw.hasNotifiers).toBe(true);
    expect(DingTalkNotifier).toHaveBeenCalledTimes(1);
  });

  it('dispatches alert to registered notifier', async () => {
    const gw = new NotificationGateway({
      dingtalk: { enabled: true, webhookUrl: 'https://example.com', secret: 's' },
    });
    const alert = makeAlert();
    await gw.send(alert);

    const instance = (DingTalkNotifier as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(instance.send).toHaveBeenCalledWith(alert);
  });

  it('does not register DingTalk when disabled', () => {
    const gw = new NotificationGateway({
      dingtalk: { enabled: false, webhookUrl: 'https://example.com', secret: 's' },
    });
    expect(gw.hasNotifiers).toBe(false);
  });
});

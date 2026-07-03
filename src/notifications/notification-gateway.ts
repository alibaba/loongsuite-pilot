import { createLogger } from '../utils/logger.js';
import type { NotificationConfig } from '../types/index.js';
import type { Notifier, SelfCheckAlert } from './notifier.js';
import { DingTalkNotifier } from './dingtalk-notifier.js';

const logger = createLogger('NotificationGateway');

const MIN_SEND_INTERVAL_MS = 3_000;

export class NotificationGateway {
  private readonly notifiers: Notifier[] = [];
  private lastSendAt = 0;
  private pendingQueue: SelfCheckAlert[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: NotificationConfig) {
    if (config.dingtalk?.enabled && config.dingtalk.webhookUrl) {
      this.notifiers.push(new DingTalkNotifier(config.dingtalk));
      logger.info('dingtalk notifier registered');
    }
  }

  get hasNotifiers(): boolean {
    return this.notifiers.length > 0;
  }

  async send(alert: SelfCheckAlert): Promise<void> {
    if (this.notifiers.length === 0) return;
    this.pendingQueue.push(alert);
    await this.drainQueue();
  }

  async stop(): Promise<void> {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    while (this.pendingQueue.length > 0) {
      await this.sendNext();
    }
  }

  private async drainQueue(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSendAt;

    if (elapsed >= MIN_SEND_INTERVAL_MS) {
      await this.sendNext();
      if (this.pendingQueue.length > 0 && !this.drainTimer) {
        this.drainTimer = setTimeout(() => {
          this.drainTimer = null;
          void this.drainQueue();
        }, MIN_SEND_INTERVAL_MS);
      }
    } else if (!this.drainTimer) {
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        void this.drainQueue();
      }, MIN_SEND_INTERVAL_MS - elapsed);
    }
  }

  private async sendNext(): Promise<void> {
    const alert = this.pendingQueue.shift();
    if (!alert) return;
    this.lastSendAt = Date.now();
    for (const notifier of this.notifiers) {
      await notifier.send(alert);
    }
  }
}

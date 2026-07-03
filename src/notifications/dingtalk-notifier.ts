import * as crypto from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import type { DingTalkConfig } from '../types/index.js';
import type { Notifier, SelfCheckAlert } from './notifier.js';

const logger = createLogger('DingTalkNotifier');

export class DingTalkNotifier implements Notifier {
  private readonly webhookUrl: string;
  private readonly secret: string;

  constructor(config: DingTalkConfig) {
    this.webhookUrl = config.webhookUrl;
    this.secret = config.secret;
  }

  async send(alert: SelfCheckAlert): Promise<void> {
    try {
      const url = this.secret ? this.buildSignedUrl() : this.webhookUrl;
      const body = this.buildBody(alert);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.warn('dingtalk notification failed', { status: response.status, body: text.slice(0, 200) });
        return;
      }

      const result = await response.json() as { errcode?: number; errmsg?: string };
      if (result.errcode !== 0) {
        logger.warn('dingtalk API error', { errcode: result.errcode, errmsg: result.errmsg });
        return;
      }

      logger.info('dingtalk notification sent', { alertType: alert.alertType, agentId: alert.agentId });
    } catch (err) {
      logger.warn('dingtalk notification error', { error: String(err) });
    }
  }

  private buildSignedUrl(): string {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${this.secret}`;
    const hmac = crypto.createHmac('sha256', this.secret);
    hmac.update(stringToSign);
    const sign = encodeURIComponent(hmac.digest('base64'));
    const separator = this.webhookUrl.includes('?') ? '&' : '?';
    return `${this.webhookUrl}${separator}timestamp=${timestamp}&sign=${sign}`;
  }

  private buildBody(alert: SelfCheckAlert): Record<string, unknown> {
    const title = `loongsuite-pilot self-check: ${alert.alertType}`;
    const text = [
      `### ${title}`,
      '',
      `- **Agent**: ${alert.agentDisplayName} (\`${alert.agentId}\`)`,
      `- **Agent Version**: ${alert.agentVersion}`,
      `- **Pilot Version**: ${alert.pilotVersion}`,
      `- **Host**: ${alert.hostname}`,
      `- **User**: ${alert.userId}`,
      `- **Time**: ${alert.timestamp}`,
      '',
      alert.message,
    ].join('\n');

    return { msgtype: 'markdown', markdown: { title, text } };
  }
}

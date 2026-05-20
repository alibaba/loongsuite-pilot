import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MountType } from '../types/index.js';
import { ensureDir } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DeployNotification');

function buildNotificationMessage(agentDisplayName: string, mountType: MountType): string {
  const lines = [
    `  loongsuite-pilot: 已为 ${agentDisplayName} 部署采集能力`,
  ];

  switch (mountType) {
    case 'wrapper':
      lines.push('  如果命令未生效，请执行：hash -r');
      lines.push('  或者打开一个新的终端窗口。');
      break;
    case 'rc-inject':
      lines.push('  请执行：source ~/.bashrc 或 source ~/.zshrc');
      lines.push('  或者打开一个新的终端窗口。');
      break;
    case 'env-inject':
      lines.push('  请打开一个新的终端窗口以生效。');
      break;
  }

  return lines.join('\n');
}

export async function writeDeployNotification(
  dataDir: string,
  agentDisplayName: string,
  mountType: MountType,
): Promise<void> {
  const notificationPath = path.join(dataDir, 'notifications');
  const message = buildNotificationMessage(agentDisplayName, mountType);

  try {
    await ensureDir(dataDir);
    await fs.appendFile(notificationPath, message + '\n\n', 'utf-8');
    logger.info('notification written', { agent: agentDisplayName, mountType });
  } catch (err) {
    logger.warn('failed to write notification', { error: String(err) });
  }
}

const RC_BEGIN = '# loongsuite-pilot BEGIN';
const RC_END = '# loongsuite-pilot END';

export function buildRcSnippet(dataDir: string): string {
  const notificationPath = path.join(dataDir, 'notifications');
  return [
    RC_BEGIN,
    `if [ -f "${notificationPath}" ]; then`,
    '  echo ""',
    `  cat "${notificationPath}"`,
    '  echo ""',
    `  rm -f "${notificationPath}"`,
    'fi',
    RC_END,
  ].join('\n');
}

export async function readPendingNotifications(dataDir: string): Promise<string | null> {
  const notificationPath = path.join(dataDir, 'notifications');
  try {
    const content = await fs.readFile(notificationPath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

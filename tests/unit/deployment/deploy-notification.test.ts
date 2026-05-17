import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  writeDeployNotification,
  buildRcSnippet,
  readPendingNotifications,
} from '../../../src/deployment/deploy-notification.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('deploy-notification', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-notif-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('writeDeployNotification', () => {
    it('writes wrapper notification', async () => {
      await writeDeployNotification(tmpDir, 'Claude Code', 'wrapper');

      const content = await fs.readFile(path.join(tmpDir, 'notifications'), 'utf-8');
      expect(content).toContain('Claude Code');
      expect(content).toContain('hash -r');
    });

    it('writes rc-inject notification', async () => {
      await writeDeployNotification(tmpDir, 'Codex', 'rc-inject');

      const content = await fs.readFile(path.join(tmpDir, 'notifications'), 'utf-8');
      expect(content).toContain('Codex');
      expect(content).toContain('source ~/.bashrc');
    });

    it('writes env-inject notification', async () => {
      await writeDeployNotification(tmpDir, 'TestAgent', 'env-inject');

      const content = await fs.readFile(path.join(tmpDir, 'notifications'), 'utf-8');
      expect(content).toContain('TestAgent');
      expect(content).toContain('新的终端窗口');
    });

    it('appends multiple notifications to the same file', async () => {
      await writeDeployNotification(tmpDir, 'Agent1', 'wrapper');
      await writeDeployNotification(tmpDir, 'Agent2', 'rc-inject');

      const content = await fs.readFile(path.join(tmpDir, 'notifications'), 'utf-8');
      expect(content).toContain('Agent1');
      expect(content).toContain('Agent2');
    });
  });

  describe('buildRcSnippet', () => {
    it('wraps notification logic with BEGIN/END markers', () => {
      const snippet = buildRcSnippet('/home/user/.loongsuite-pilot');

      expect(snippet).toContain('# loongsuite-pilot BEGIN');
      expect(snippet).toContain('# loongsuite-pilot END');
      expect(snippet).toContain('/home/user/.loongsuite-pilot/notifications');
      expect(snippet).toContain('cat');
      expect(snippet).toContain('rm -f');
    });

    it('is idempotent (same output for same input)', () => {
      const a = buildRcSnippet('/data');
      const b = buildRcSnippet('/data');
      expect(a).toBe(b);
    });
  });

  describe('readPendingNotifications', () => {
    it('returns content when notifications exist', async () => {
      await fs.writeFile(path.join(tmpDir, 'notifications'), 'hello world', 'utf-8');
      const result = await readPendingNotifications(tmpDir);
      expect(result).toBe('hello world');
    });

    it('returns null when no notification file exists', async () => {
      const result = await readPendingNotifications(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null when notification file is empty', async () => {
      await fs.writeFile(path.join(tmpDir, 'notifications'), '', 'utf-8');
      const result = await readPendingNotifications(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null when notification file has only whitespace', async () => {
      await fs.writeFile(path.join(tmpDir, 'notifications'), '   \n  ', 'utf-8');
      const result = await readPendingNotifications(tmpDir);
      expect(result).toBeNull();
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadJsonFile = vi.fn().mockResolvedValue(null);

vi.mock('../../../src/utils/fs-utils.js', () => ({
  readJsonFile: (...args: unknown[]) => mockReadJsonFile(...args),
  resolveHome: (p: string) => p.replace(/^~/, '/home/test'),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { loadConfig } from '../../../src/core/config-loader.js';

describe('ConfigLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('three-layer priority (T025)', () => {
    it('env vars override config file values', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        dataDir: '/from/file',
        port: 5000,
      });
      vi.stubEnv('AAC_DATA_DIR', '/from/env');
      vi.stubEnv('AAC_PORT', '9999');

      const config = await loadConfig();
      expect(config.dataDir).toBe('/from/env');
      expect(config.port).toBe(9999);
    });

    it('config file values override defaults', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        port: 7777,
        enabled: false,
      });

      const config = await loadConfig();
      expect(config.port).toBe(7777);
      expect(config.enabled).toBe(false);
    });

    it('falls back to defaults when both env and file are missing', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.port).toBe(43124);
      expect(config.enabled).toBe(true);
      expect(config.autoStart).toBe(true);
    });
  });

  describe('missing config file fallback (T026)', () => {
    it('uses all default values when readJsonFile returns null', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.enabled).toBe(true);
      expect(config.port).toBe(43124);
      expect(config.flushers.jsonl?.enabled).toBe(true);
    });
  });

  describe('SLS/HTTP/JSONL config merge (T027)', () => {
    it('merges SLS endpoints from file and env (deduplication)', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          accessKeyId: 'ak',
          accessKeySecret: 'sk',
          endpoint: 'https://sls.example.com',
          endpoints: [
            { project: 'proj1', logstore: 'log1', kind: 'agentActivity' },
          ],
        },
      });
      vi.stubEnv('SLS_ACCESS_KEY_ID', 'ak');
      vi.stubEnv('SLS_ACCESS_KEY_SECRET', 'sk');
      vi.stubEnv('SLS_ENDPOINT', 'https://sls.example.com');
      vi.stubEnv('SLS_PROJECT', 'proj1');
      vi.stubEnv('SLS_LOGSTORE', 'log1');

      const config = await loadConfig();
      // Same project/logstore should be deduplicated
      expect(config.flushers.sls?.endpoints).toHaveLength(1);
    });

    it('appends env SLS endpoint when different from file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          accessKeyId: 'ak',
          accessKeySecret: 'sk',
          endpoint: 'https://sls.example.com',
          endpoints: [
            { project: 'proj1', logstore: 'log1' },
          ],
        },
      });
      vi.stubEnv('SLS_ACCESS_KEY_ID', 'ak');
      vi.stubEnv('SLS_ACCESS_KEY_SECRET', 'sk');
      vi.stubEnv('SLS_ENDPOINT', 'https://sls.example.com');
      vi.stubEnv('SLS_PROJECT', 'proj2');
      vi.stubEnv('SLS_LOGSTORE', 'log2');

      const config = await loadConfig();
      expect(config.flushers.sls?.endpoints).toHaveLength(2);
    });

    it('resolves HTTP enabled from env', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('HTTP_REPORT_URL', 'https://api.example.com');

      const config = await loadConfig();
      expect(config.flushers.http?.enabled).toBe(true);
      expect(config.flushers.http?.url).toBe('https://api.example.com');
    });

    it('resolves JSONL enabled from env', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('JSONL_ENABLED', 'false');

      const config = await loadConfig();
      expect(config.flushers.jsonl?.enabled).toBe(false);
    });

    it('sets JSONL outputDir from env', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('JSONL_OUTPUT_DIR', '/custom/output');

      const config = await loadConfig();
      expect(config.flushers.jsonl?.outputDir).toBe('/custom/output');
    });
  });

  describe('listeners config', () => {
    it('provides default listener configs', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.listeners.qoder).toBeDefined();
      expect(config.listeners.qoder.enabled).toBe(true);
      expect(config.listeners['qoder-work'].enabled).toBe(true);
      expect(config.listeners['cursor-hook'].enabled).toBe(true);
    });

    it('merges file-level listener overrides', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        listeners: {
          qoder: { enabled: false, pollInterval: 120000 },
        },
      });

      const config = await loadConfig();
      expect(config.listeners.qoder.enabled).toBe(false);
      expect(config.listeners.qoder.pollInterval).toBe(120000);
    });
  });
});

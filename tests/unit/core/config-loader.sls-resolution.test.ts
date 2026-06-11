/**
 * SLS endpoint resolution — config-driven (no internal flag).
 *
 * Covers: no config, user config present, dedup, enabled derivation.
 */
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

function clearSlsEnv() {
  delete process.env.LOONGSUITE_SLS_MODE;
  delete process.env.LOONGSUITE_SLS_ACCESS_KEY_ID;
  delete process.env.LOONGSUITE_SLS_ACCESS_KEY_SECRET;
  delete process.env.LOONGSUITE_SLS_ENDPOINT;
  delete process.env.LOONGSUITE_SLS_PROJECT;
  delete process.env.LOONGSUITE_SLS_LOGSTORE;
}

describe('SLS resolver — config-driven', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    clearSlsEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('No user destination → SLS disabled (empty endpoints)', () => {
    it('returns empty endpoints when no sls fields are present', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(0);
      expect(cfg.flushers.sls?.enabled).toBe(false);
    });

    it('treats project-only as incomplete → disabled', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: { project: 'orphan-project' },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(0);
      expect(cfg.flushers.sls?.enabled).toBe(false);
    });
  });

  describe('User destination present → [USER] endpoint', () => {
    it('returns user endpoint when sls fields are configured', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: 'https://cn-shanghai.log.aliyuncs.com',
          project: 'user-proj',
          logstore: 'user-store',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        name: 'user-sls',
        endpoint: 'https://cn-shanghai.log.aliyuncs.com',
        project: 'user-proj',
        logstore: 'user-store',
        mode: 'webtracking',
      });
      expect(cfg.flushers.sls?.enabled).toBe(true);
    });

    it('infers AK mode when access keys are present', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: 'https://cn-shanghai.log.aliyuncs.com',
          project: 'user-proj',
          logstore: 'user-store',
          accessKeyId: 'ak-id',
          accessKeySecret: 'ak-sk',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        mode: 'ak',
        accessKeyId: 'ak-id',
        accessKeySecret: 'ak-sk',
      });
      expect(cfg.flushers.sls?.enabled).toBe(true);
    });

    it('reads user fields from env over file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: { project: 'file-proj', logstore: 'file-store' },
      });
      vi.stubEnv('LOONGSUITE_SLS_PROJECT', 'env-proj');
      vi.stubEnv('LOONGSUITE_SLS_LOGSTORE', 'env-store');

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        project: 'env-proj',
        logstore: 'env-store',
      });
    });

    it('produces empty endpoint URL when user omits endpoint', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          project: 'user-proj',
          logstore: 'user-store',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0].endpoint).toBe('');
      expect(cfg.flushers.sls?.enabled).toBe(false);
    });

    it('ignores legacy destinationOverride', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          destinationOverride: true,
          endpoint: 'https://cn-shanghai.log.aliyuncs.com',
          project: 'user-proj',
          logstore: 'user-store',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0].name).toBe('user-sls');
    });
  });

  describe('Dedup: collapses identical normalized triples', () => {
    it('normalizes trailing slash and missing scheme for dedup', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: 'cn-heyuan.log.aliyuncs.com/',
          project: 'my-project',
          logstore: 'my-store',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0].endpoint).toBe('https://cn-heyuan.log.aliyuncs.com/');
    });
  });

  describe('enabled derivation', () => {
    it('disabled when AK mode is missing credentials', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          mode: 'ak',
          endpoint: 'https://x.log.aliyuncs.com',
          project: 'p',
          logstore: 'l',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.enabled).toBe(false);
    });

    it('respects explicit enabled=false', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          enabled: false,
          endpoint: 'https://x.log.aliyuncs.com',
          project: 'p',
          logstore: 'l',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.enabled).toBe(false);
    });

    it('respects explicit enabled=true even without complete config', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          enabled: true,
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.enabled).toBe(true);
    });
  });

  describe('sls array (multi-endpoint) from config.json', () => {
    it('parses sls array with multiple endpoints', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: [
          {
            name: 'user-sls',
            endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
            project: 'user-proj',
            logstore: 'user-store',
          },
          {
            name: 'internal-sls',
            endpoint: 'https://cn-heyuan.log.aliyuncs.com',
            project: 'ai-coding-devops',
            logstore: 'loongsuite_pilot_for_ai_coding',
          },
        ],
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(2);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        name: 'user-sls',
        project: 'user-proj',
        mode: 'webtracking',
      });
      expect(cfg.flushers.sls?.endpoints[1]).toMatchObject({
        name: 'internal-sls',
        project: 'ai-coding-devops',
      });
      expect(cfg.flushers.sls?.enabled).toBe(true);
    });

    it('supports AK mode in sls array', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: [
          {
            endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
            project: 'ak-proj',
            logstore: 'ak-store',
            accessKeyId: 'ak-id',
            accessKeySecret: 'ak-secret',
          },
        ],
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        mode: 'ak',
        accessKeyId: 'ak-id',
        accessKeySecret: 'ak-secret',
      });
    });

    it('produces no endpoints from empty sls array', async () => {
      mockReadJsonFile.mockResolvedValueOnce({ sls: [] });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(0);
      expect(cfg.flushers.sls?.enabled).toBe(false);
    });

    it('assigns default names when name is omitted', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: [
          {
            endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
            project: 'p1',
            logstore: 'l1',
          },
          {
            endpoint: 'https://cn-heyuan.log.aliyuncs.com',
            project: 'p2',
            logstore: 'l2',
          },
        ],
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints[0].name).toBe('sls-0');
      expect(cfg.flushers.sls?.endpoints[1].name).toBe('sls-1');
    });
  });

  describe('inner data_config.json merging', () => {
    it('merges inner data_config.json endpoints with config.json endpoints', async () => {
      mockReadJsonFile
        .mockResolvedValueOnce({
          sls: {
            endpoint: 'https://cn-shanghai.log.aliyuncs.com',
            project: 'user-proj',
            logstore: 'user-store',
          },
        })
        .mockResolvedValueOnce({
          sls: [
            {
              name: 'internal-sls',
              endpoint: 'https://cn-heyuan.log.aliyuncs.com',
              project: 'ai-coding-devops',
              logstore: 'loongsuite_pilot_for_ai_coding',
              mode: 'webtracking',
            },
          ],
        });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(2);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        name: 'user-sls',
        project: 'user-proj',
      });
      expect(cfg.flushers.sls?.endpoints[1]).toMatchObject({
        name: 'internal-sls',
        project: 'ai-coding-devops',
      });
      expect(cfg.flushers.sls?.enabled).toBe(true);
    });

    it('uses only inner endpoints when config.json has no sls', async () => {
      mockReadJsonFile
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          sls: [
            {
              name: 'internal-sls',
              endpoint: 'https://cn-heyuan.log.aliyuncs.com',
              project: 'ai-coding-devops',
              logstore: 'loongsuite_pilot_for_ai_coding',
              mode: 'webtracking',
            },
          ],
        });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        name: 'internal-sls',
        project: 'ai-coding-devops',
      });
      expect(cfg.flushers.sls?.enabled).toBe(true);
    });

    it('deduplicates when both files have the same endpoint', async () => {
      mockReadJsonFile
        .mockResolvedValueOnce({
          sls: [
            {
              name: 'internal-sls',
              endpoint: 'https://cn-heyuan.log.aliyuncs.com',
              project: 'ai-coding-devops',
              logstore: 'loongsuite_pilot_for_ai_coding',
            },
          ],
        })
        .mockResolvedValueOnce({
          sls: [
            {
              name: 'internal-sls',
              endpoint: 'https://cn-heyuan.log.aliyuncs.com',
              project: 'ai-coding-devops',
              logstore: 'loongsuite_pilot_for_ai_coding',
              mode: 'webtracking',
            },
          ],
        });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        project: 'ai-coding-devops',
      });
    });

    it('proceeds normally when data_config.json does not exist', async () => {
      mockReadJsonFile
        .mockResolvedValueOnce({
          sls: {
            endpoint: 'https://cn-shanghai.log.aliyuncs.com',
            project: 'user-proj',
            logstore: 'user-store',
          },
        })
        .mockResolvedValueOnce(null);

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        name: 'user-sls',
        project: 'user-proj',
      });
    });

    it('skips inner entries with missing required fields', async () => {
      mockReadJsonFile
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          sls: [
            { name: 'incomplete', endpoint: 'https://x.log.aliyuncs.com', project: 'p' },
            {
              name: 'complete',
              endpoint: 'https://cn-heyuan.log.aliyuncs.com',
              project: 'ai-coding-devops',
              logstore: 'loongsuite_pilot_for_ai_coding',
            },
          ],
        });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        name: 'complete',
        project: 'ai-coding-devops',
      });
    });

    it('returns empty endpoints when neither file has SLS', async () => {
      mockReadJsonFile
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(null);

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(0);
      expect(cfg.flushers.sls?.enabled).toBe(false);
    });

    it('config.json endpoints take priority during dedup', async () => {
      mockReadJsonFile
        .mockResolvedValueOnce({
          sls: [
            {
              name: 'user-override',
              endpoint: 'https://cn-heyuan.log.aliyuncs.com',
              project: 'ai-coding-devops',
              logstore: 'loongsuite_pilot_for_ai_coding',
              mode: 'ak',
              accessKeyId: 'ak-id',
              accessKeySecret: 'ak-secret',
            },
          ],
        })
        .mockResolvedValueOnce({
          sls: [
            {
              name: 'internal-sls',
              endpoint: 'https://cn-heyuan.log.aliyuncs.com',
              project: 'ai-coding-devops',
              logstore: 'loongsuite_pilot_for_ai_coding',
              mode: 'webtracking',
            },
          ],
        });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        name: 'user-override',
        mode: 'ak',
      });
    });
  });

  describe('webtracking with empty project', () => {
    it('allows empty project for webtracking mode (enabled=true)', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: [
          {
            name: 'wt-no-project',
            endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
            project: '',
            logstore: 'raw',
            mode: 'webtracking',
          },
        ],
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        name: 'wt-no-project',
        project: '',
        logstore: 'raw',
        mode: 'webtracking',
      });
      expect(cfg.flushers.sls?.enabled).toBe(true);
    });

    it('rejects empty project for AK mode (enabled=false)', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: [
          {
            name: 'ak-no-project',
            endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
            project: '',
            logstore: 'raw',
            mode: 'ak',
            accessKeyId: 'ak-id',
            accessKeySecret: 'ak-secret',
          },
        ],
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.enabled).toBe(false);
    });

    it('mixed endpoints: empty-project webtracking + valid AK both pass', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: [
          {
            name: 'wt-empty',
            endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
            project: '',
            logstore: 'raw',
            mode: 'webtracking',
          },
          {
            name: 'ak-valid',
            endpoint: 'https://cn-shanghai.log.aliyuncs.com',
            project: 'prod-proj',
            logstore: 'prod-store',
            mode: 'ak',
            accessKeyId: 'ak-id',
            accessKeySecret: 'ak-secret',
          },
        ],
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(2);
      expect(cfg.flushers.sls?.enabled).toBe(true);
    });
  });
});

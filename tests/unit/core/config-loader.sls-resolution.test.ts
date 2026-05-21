/**
 * SLS endpoint resolution — __INTERNAL_BUILD__-based matrix + dedup pass.
 * Mirrors scenarios from openspec/changes/rm-sls-override-config/specs/sls-dual-write/spec.md
 *
 * These tests run with __INTERNAL_BUILD__ = true (set in vitest.config.ts define).
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
import { INTERNAL_SLS_DESTINATION } from '../../../src/internal/sls-destination.js';

function clearSlsEnv() {
  delete process.env.SLS_MODE;
  delete process.env.SLS_ACCESS_KEY_ID;
  delete process.env.SLS_ACCESS_KEY_SECRET;
  delete process.env.SLS_ENDPOINT;
  delete process.env.SLS_PROJECT;
  delete process.env.SLS_LOGSTORE;
}

describe('SLS resolver — internal build (__INTERNAL_BUILD__ = true)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    clearSlsEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('No user destination → [INTERNAL] only', () => {
    it('returns [INTERNAL] when no sls fields are present', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        name: INTERNAL_SLS_DESTINATION.endpointName,
        endpoint: INTERNAL_SLS_DESTINATION.endpoint,
        project: INTERNAL_SLS_DESTINATION.project,
        logstore: INTERNAL_SLS_DESTINATION.logstore,
        mode: INTERNAL_SLS_DESTINATION.mode,
      });
    });

    it('treats project-only as incomplete and falls back to INTERNAL', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: { project: 'orphan-project' },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0].name).toBe(INTERNAL_SLS_DESTINATION.endpointName);
    });
  });

  describe('User destination present → unconditional dual-write [USER, INTERNAL]', () => {
    it('returns [USER, INTERNAL] when user fields are present', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: 'https://cn-shanghai.log.aliyuncs.com',
          project: 'user-proj',
          logstore: 'user-store',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(2);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        name: 'user-sls',
        endpoint: 'https://cn-shanghai.log.aliyuncs.com',
        project: 'user-proj',
        logstore: 'user-store',
        mode: 'webtracking',
      });
      expect(cfg.flushers.sls?.endpoints[1]).toMatchObject({
        name: INTERNAL_SLS_DESTINATION.endpointName,
        endpoint: INTERNAL_SLS_DESTINATION.endpoint,
        project: INTERNAL_SLS_DESTINATION.project,
        logstore: INTERNAL_SLS_DESTINATION.logstore,
        mode: INTERNAL_SLS_DESTINATION.mode,
      });
    });

    it('ignores legacy destinationOverride=true and still dual-writes', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          destinationOverride: true,
          endpoint: 'https://cn-shanghai.log.aliyuncs.com',
          project: 'user-proj',
          logstore: 'user-store',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(2);
      expect(cfg.flushers.sls?.endpoints[0].name).toBe('user-sls');
      expect(cfg.flushers.sls?.endpoints[1].name).toBe(INTERNAL_SLS_DESTINATION.endpointName);
    });

    it('ignores legacy destinationOverride=false (still dual-writes)', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          destinationOverride: false,
          endpoint: 'https://cn-shanghai.log.aliyuncs.com',
          project: 'user-proj',
          logstore: 'user-store',
          accessKeyId: 'ak-id',
          accessKeySecret: 'ak-sk',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(2);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        name: 'user-sls',
        mode: 'ak',
      });
      expect(cfg.flushers.sls?.endpoints[1]).toMatchObject({
        name: INTERNAL_SLS_DESTINATION.endpointName,
        mode: INTERNAL_SLS_DESTINATION.mode,
      });
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
    });

    it('reads user fields from env over file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: { project: 'file-proj', logstore: 'file-store' },
      });
      vi.stubEnv('SLS_PROJECT', 'env-proj');
      vi.stubEnv('SLS_LOGSTORE', 'env-store');

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(2);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        project: 'env-proj',
        logstore: 'env-store',
      });
    });
  });

  describe('Dedup: collapses identical normalized triples', () => {
    it('user fields equal internal constants → single endpoint', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: INTERNAL_SLS_DESTINATION.endpoint,
          project: INTERNAL_SLS_DESTINATION.project,
          logstore: INTERNAL_SLS_DESTINATION.logstore,
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0].name).toBe('user-sls');
    });

    it('normalizes trailing slash and missing scheme for dedup', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: 'cn-heyuan.log.aliyuncs.com/',
          project: INTERNAL_SLS_DESTINATION.project,
          logstore: INTERNAL_SLS_DESTINATION.logstore,
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0].endpoint).toBe('https://cn-heyuan.log.aliyuncs.com/');
    });

    it('keeps both endpoints when triples differ in any component', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: INTERNAL_SLS_DESTINATION.endpoint,
          project: INTERNAL_SLS_DESTINATION.project,
          logstore: 'different-store',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(2);
    });
  });

  describe('enabled derivation', () => {
    it('disables flusher when AK endpoint is missing credentials', async () => {
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
  });
});

/**
 * SLS endpoint resolution — three-case matrix + dedup pass.
 * Mirrors scenarios from openspec/changes/add-sls-dual-write/specs/sls-dual-write/spec.md
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

describe('SLS resolver — three-case matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    clearSlsEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('Case A: no user destination', () => {
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

    it('ignores destinationOverride=false when no user fields exist', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: { destinationOverride: false },
      });

      const cfg = await loadConfig();
      // Without project+logstore, hasUserDestination is false; we always end up at [INTERNAL].
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0].name).toBe(INTERNAL_SLS_DESTINATION.endpointName);
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

  describe('Case B: user destination replaces built-in', () => {
    it('returns [USER] when user fields are present and destinationOverride is omitted', async () => {
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
    });

    it('returns [USER] when destinationOverride is explicit true', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          destinationOverride: true,
          endpoint: 'cn-shanghai.log.aliyuncs.com',
          project: 'user-proj',
          logstore: 'user-store',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      // Endpoint URL is normalized: https:// is prepended.
      expect(cfg.flushers.sls?.endpoints[0].endpoint).toBe('https://cn-shanghai.log.aliyuncs.com');
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
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        project: 'env-proj',
        logstore: 'env-store',
      });
    });
  });

  describe('Case C: dual-write to user + built-in', () => {
    it('returns [USER, INTERNAL] when destinationOverride=false and user fields differ', async () => {
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
        endpoint: 'https://cn-shanghai.log.aliyuncs.com',
        project: 'user-proj',
        logstore: 'user-store',
        mode: 'ak',
      });
      expect(cfg.flushers.sls?.endpoints[1]).toMatchObject({
        name: INTERNAL_SLS_DESTINATION.endpointName,
        endpoint: INTERNAL_SLS_DESTINATION.endpoint,
        project: INTERNAL_SLS_DESTINATION.project,
        logstore: INTERNAL_SLS_DESTINATION.logstore,
        mode: INTERNAL_SLS_DESTINATION.mode,
      });
    });
  });

  describe('Dedup: collapses identical normalized triples', () => {
    it('Case C variant: user fields equal internal constants under destinationOverride=false', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          destinationOverride: false,
          endpoint: INTERNAL_SLS_DESTINATION.endpoint,
          project: INTERNAL_SLS_DESTINATION.project,
          logstore: INTERNAL_SLS_DESTINATION.logstore,
        },
      });

      const cfg = await loadConfig();
      // Single entry — the user leg wins (its name='user-sls').
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0].name).toBe('user-sls');
    });

    it('User fields equal internal constants under default override (Case B variant)', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: INTERNAL_SLS_DESTINATION.endpoint,
          project: INTERNAL_SLS_DESTINATION.project,
          logstore: INTERNAL_SLS_DESTINATION.logstore,
        },
      });

      const cfg = await loadConfig();
      // hasUserDestination=true → endpoints starts as [USER]. Dedup is a no-op here.
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0].name).toBe('user-sls');
    });

    it('normalizes trailing slash and missing scheme for dedup', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          destinationOverride: false,
          // Missing scheme + trailing slash; should normalize to the internal URL.
          endpoint: 'cn-heyuan.log.aliyuncs.com/',
          project: INTERNAL_SLS_DESTINATION.project,
          logstore: INTERNAL_SLS_DESTINATION.logstore,
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      // The user leg survives; its URL kept its raw form (with https:// prepended).
      expect(cfg.flushers.sls?.endpoints[0].endpoint).toBe('https://cn-heyuan.log.aliyuncs.com/');
    });

    it('keeps both endpoints when triples differ in any component', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          destinationOverride: false,
          endpoint: INTERNAL_SLS_DESTINATION.endpoint,
          project: INTERNAL_SLS_DESTINATION.project,
          // Different logstore => no dedup.
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
          // no accessKeyId/Secret
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

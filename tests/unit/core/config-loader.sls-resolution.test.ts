/**
 * SLS endpoint resolution — runtime `internal` config flag matrix + dedup pass.
 *
 * Covers all 4 scenarios: internal+no-user, internal+user, external+no-user, external+user.
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
  delete process.env.LOONGSUITE_PILOT_INTERNAL;
}

describe('SLS resolver — internal mode (config.internal = true)', () => {
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
      mockReadJsonFile.mockResolvedValueOnce({ internal: true });

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

    it('defaults to internal=true when field is omitted', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const cfg = await loadConfig();
      expect(cfg.internal).toBe(true);
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
    it('stays enabled in internal mode even when user AK endpoint is missing credentials', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          mode: 'ak',
          endpoint: 'https://x.log.aliyuncs.com',
          project: 'p',
          logstore: 'l',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.enabled).toBe(true);
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

  describe('env var override', () => {
    it('LOONGSUITE_PILOT_INTERNAL=false overrides config file internal=true', async () => {
      vi.stubEnv('LOONGSUITE_PILOT_INTERNAL', 'false');
      mockReadJsonFile.mockResolvedValueOnce({ internal: true });

      const cfg = await loadConfig();
      expect(cfg.internal).toBe(false);
      expect(cfg.flushers.sls?.endpoints).toHaveLength(0);
      expect(cfg.flushers.sls?.enabled).toBe(false);
    });
  });
});

describe('SLS resolver — external mode (config.internal = false)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    clearSlsEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('No user destination → SLS disabled (empty endpoints)', () => {
    it('returns empty endpoints and disables SLS', async () => {
      mockReadJsonFile.mockResolvedValueOnce({ internal: false });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(0);
      expect(cfg.flushers.sls?.enabled).toBe(false);
    });

    it('treats project-only as incomplete → disabled', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        internal: false,
        sls: { project: 'orphan-project' },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(0);
      expect(cfg.flushers.sls?.enabled).toBe(false);
    });
  });

  describe('User destination present → [USER] only (no internal)', () => {
    it('returns only user endpoint, no internal', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        internal: false,
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

    it('ignores legacy destinationOverride and returns only user endpoint', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        internal: false,
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

    it('produces empty endpoint URL when user omits endpoint (no malformed https://)', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        internal: false,
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
  });

  describe('AK mode in external mode', () => {
    it('infers AK mode and enables when all fields present', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        internal: false,
        sls: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'ext-proj',
          logstore: 'ext-store',
          accessKeyId: 'ak-id',
          accessKeySecret: 'ak-secret',
        },
      });

      const cfg = await loadConfig();
      expect(cfg.flushers.sls?.endpoints).toHaveLength(1);
      expect(cfg.flushers.sls?.endpoints[0]).toMatchObject({
        mode: 'ak',
        accessKeyId: 'ak-id',
        accessKeySecret: 'ak-secret',
      });
      expect(cfg.flushers.sls?.enabled).toBe(true);
    });
  });
});

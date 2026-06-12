import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/utils/fs-utils.js', () => ({
  readJsonFile: vi.fn().mockResolvedValue(null),
  resolveHome: (p: string) => p.replace(/^~/, '/home/test'),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { buildAutoUpdateConfig } from '../../../src/core/config-loader.js';

describe('buildAutoUpdateConfig', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('disabled when no packageUrl configured', () => {
    const config = buildAutoUpdateConfig(null);
    expect(config.enabled).toBe(false);
    expect(config.packageUrl).toBeUndefined();
    expect(config.manifestUrl).toBeUndefined();
  });

  it('derives manifest URL from package URL', () => {
    const config = buildAutoUpdateConfig({
      autoUpdate: {
        packageUrl: 'https://example.com/latest/pkg.tar.gz',
      },
    });
    expect(config.manifestUrl).toBe('https://example.com/latest/latest.json');
  });

  it('uses file values over defaults', () => {
    const config = buildAutoUpdateConfig({
      autoUpdate: {
        enabled: false,
        checkIntervalMs: 120_000,
        manifestUrl: 'https://example.com/manifest.json',
        packageUrl: 'https://example.com/pkg.tar.gz',
      },
    });
    expect(config.enabled).toBe(false);
    expect(config.checkIntervalMs).toBe(120_000);
    expect(config.manifestUrl).toBe('https://example.com/manifest.json');
    expect(config.packageUrl).toBe('https://example.com/pkg.tar.gz');
  });

  it('env LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED=false disables', () => {
    vi.stubEnv('LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED', 'false');
    vi.stubEnv('LOONGSUITE_PILOT_PACKAGE_URL', 'https://example.com/pkg.tar.gz');
    const config = buildAutoUpdateConfig(null);
    expect(config.enabled).toBe(false);
  });

  it('env LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS overrides interval', () => {
    vi.stubEnv('LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS', '300000');
    const config = buildAutoUpdateConfig(null);
    expect(config.checkIntervalMs).toBe(300_000);
  });

  it('env LOONGSUITE_PILOT_PACKAGE_URL overrides package URL and enables', () => {
    vi.stubEnv('LOONGSUITE_PILOT_PACKAGE_URL', 'https://custom.com/pkg.tar.gz');
    const config = buildAutoUpdateConfig(null);
    expect(config.enabled).toBe(true);
    expect(config.packageUrl).toBe('https://custom.com/pkg.tar.gz');
    expect(config.manifestUrl).toBe('https://custom.com/latest.json');
  });

  it('env LOONGSUITE_PILOT_MANIFEST_URL overrides manifest URL', () => {
    vi.stubEnv('LOONGSUITE_PILOT_MANIFEST_URL', 'https://custom.com/versions.json');
    vi.stubEnv('LOONGSUITE_PILOT_PACKAGE_URL', 'https://custom.com/pkg.tar.gz');
    const config = buildAutoUpdateConfig(null);
    expect(config.manifestUrl).toBe('https://custom.com/versions.json');
  });

  it('env overrides file values', () => {
    vi.stubEnv('LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS', '999');
    const config = buildAutoUpdateConfig({
      autoUpdate: { checkIntervalMs: 5000 },
    });
    expect(config.checkIntervalMs).toBe(999);
  });

  it('reads installId and canary fields from config', () => {
    const config = buildAutoUpdateConfig({
      installId: 'test-install-id',
      canary: { policy: 'auto', hotfix_version: 3 },
      autoUpdate: { packageUrl: 'https://example.com/pkg.tar.gz' },
    });
    expect(config.installId).toBe('test-install-id');
    expect(config.canaryPolicy).toBe('auto');
    expect(config.canaryHotfixVersion).toBe(3);
  });
});

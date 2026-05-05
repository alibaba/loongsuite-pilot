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

  it('uses defaults when no file and no env', () => {
    const config = buildAutoUpdateConfig(null);
    expect(config.enabled).toBe(true);
    expect(config.checkIntervalMs).toBe(60_000); // 1 minute
    expect(config.manifestUrl).toBeDefined();
    expect(config.packageUrl).toBeDefined();
  });

  it('derives manifest URL from package URL', () => {
    const config = buildAutoUpdateConfig(null);
    expect(config.manifestUrl).toMatch(/\/latest\.json$/);
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
    const config = buildAutoUpdateConfig(null);
    expect(config.enabled).toBe(false);
  });

  it('env LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS overrides interval', () => {
    vi.stubEnv('LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS', '300000');
    const config = buildAutoUpdateConfig(null);
    expect(config.checkIntervalMs).toBe(300_000);
  });

  it('env LOONGSUITE_PILOT_PACKAGE_URL overrides package URL', () => {
    vi.stubEnv('LOONGSUITE_PILOT_PACKAGE_URL', 'https://custom.com/pkg.tar.gz');
    const config = buildAutoUpdateConfig(null);
    expect(config.packageUrl).toBe('https://custom.com/pkg.tar.gz');
    expect(config.manifestUrl).toBe('https://custom.com/latest.json');
  });

  it('env LOONGSUITE_PILOT_MANIFEST_URL overrides manifest URL', () => {
    vi.stubEnv('LOONGSUITE_PILOT_MANIFEST_URL', 'https://custom.com/versions.json');
    const config = buildAutoUpdateConfig(null);
    expect(config.manifestUrl).toBe('https://custom.com/versions.json');
  });

  it('channel=test uses test package URL', () => {
    vi.stubEnv('LOONGSUITE_PILOT_CHANNEL', 'test');
    const config = buildAutoUpdateConfig(null);
    expect(config.packageUrl).toContain('loongsuite-dev/loongsuite-pilot');
  });

  it('channel=release uses release package URL', () => {
    vi.stubEnv('LOONGSUITE_PILOT_CHANNEL', 'release');
    const config = buildAutoUpdateConfig(null);
    expect(config.packageUrl).toContain('loongsuite/loongsuite-pilot');
    expect(config.packageUrl).not.toContain('loongsuite-dev/loongsuite-pilot');
  });

  it('env overrides file values', () => {
    vi.stubEnv('LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS', '999');
    const config = buildAutoUpdateConfig({
      autoUpdate: { checkIntervalMs: 5000 },
    });
    expect(config.checkIntervalMs).toBe(999);
  });
});

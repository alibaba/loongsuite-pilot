import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AutoUpdateConfig } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const mockComputeSha256 = vi.fn<[string], Promise<string>>();
vi.mock('../../../src/updater/version-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/updater/version-utils.js')>();
  return {
    ...actual,
    computeSha256: (...args: [string]) => mockComputeSha256(...args),
  };
});

const mockReadJsonFile = vi.fn();
const mockWriteJsonFile = vi.fn();
vi.mock('../../../src/utils/fs-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/fs-utils.js')>();
  return {
    ...actual,
    readJsonFile: (...args: any[]) => mockReadJsonFile(...args),
    writeJsonFile: (...args: any[]) => mockWriteJsonFile(...args),
  };
});

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn(),
  cp: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => ({ fake: true })),
  createReadStream: vi.fn(),
}));

vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: () => vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

import { Updater } from '../../../src/updater/updater.js';
import type { VersionManifest, CanaryManifest, LatestManifest, LocalVersion } from '../../../src/updater/updater.js';
import { deterministicBucket } from '../../../src/updater/version-utils.js';

function makeConfig(overrides: Partial<AutoUpdateConfig> = {}): AutoUpdateConfig {
  return {
    enabled: true,
    checkIntervalMs: 60_000,
    manifestUrl: 'https://example.com/latest.json',
    packageUrl: 'https://example.com/pkg.tar.gz',
    ...overrides,
  };
}

function makeLatest(canary?: CanaryManifest): LatestManifest {
  return {
    version: '1.0.35',
    git_commit: 'abc123',
    package_url: 'https://example.com/1.0.35/pkg.tar.gz',
    canary,
  };
}

function makeCanary(overrides: Partial<CanaryManifest> = {}): CanaryManifest {
  return {
    version: '1.0.36',
    git_commit: 'def456',
    package_url: 'https://example.com/1.0.36/pkg.tar.gz',
    rollout_percentage: 10,
    ...overrides,
  };
}

describe('resolveTargetVersion', () => {
  const tmpDir = '/tmp/test-canary';

  it('returns stable when no canary field', () => {
    const updater = new Updater(makeConfig(), tmpDir);
    const result = updater.resolveTargetVersion(makeLatest());
    expect(result.channel).toBe('stable');
    expect(result.manifest.version).toBe('1.0.35');
  });

  it('returns stable when canaryPolicy is off', () => {
    const updater = new Updater(makeConfig({ canaryPolicy: 'off' }), tmpDir);
    const result = updater.resolveTargetVersion(makeLatest(makeCanary()));
    expect(result.channel).toBe('stable');
    expect(result.manifest.version).toBe('1.0.35');
  });

  it('returns canary when canaryPolicy is latest', () => {
    const updater = new Updater(makeConfig({ canaryPolicy: 'latest' }), tmpDir);
    const result = updater.resolveTargetVersion(makeLatest(makeCanary()));
    expect(result.channel).toBe('canary');
    expect(result.manifest.version).toBe('1.0.36');
  });

  it('returns canary via bucketing when canaryPolicy is auto', () => {
    const canaryVersion = '1.0.36';
    let targetInstallId = '';
    for (let i = 0; i < 1000; i++) {
      const id = `test-${i}`;
      if (deterministicBucket(id, canaryVersion) < 50) {
        targetInstallId = id;
        break;
      }
    }

    const updater = new Updater(makeConfig({ canaryPolicy: 'auto', installId: targetInstallId }), tmpDir);
    const result = updater.resolveTargetVersion(makeLatest(makeCanary({ rollout_percentage: 50 })));
    expect(result.channel).toBe('canary');
  });

  it('returns canary when bucket is within rollout_percentage', () => {
    const canaryVersion = '1.0.36';
    let targetInstallId = '';
    for (let i = 0; i < 1000; i++) {
      const id = `test-${i}`;
      if (deterministicBucket(id, canaryVersion) < 10) {
        targetInstallId = id;
        break;
      }
    }

    const updater = new Updater(makeConfig({ installId: targetInstallId }), tmpDir);
    const result = updater.resolveTargetVersion(makeLatest(makeCanary({ rollout_percentage: 10 })));
    expect(result.channel).toBe('canary');
  });

  it('returns stable when bucket is outside rollout_percentage', () => {
    const canaryVersion = '1.0.36';
    let targetInstallId = '';
    for (let i = 0; i < 1000; i++) {
      const id = `test-${i}`;
      if (deterministicBucket(id, canaryVersion) >= 10) {
        targetInstallId = id;
        break;
      }
    }

    const updater = new Updater(makeConfig({ installId: targetInstallId }), tmpDir);
    const result = updater.resolveTargetVersion(makeLatest(makeCanary({ rollout_percentage: 10 })));
    expect(result.channel).toBe('stable');
  });

  it('returns stable when rollout_percentage is 0', () => {
    const updater = new Updater(makeConfig({ installId: 'any-id' }), tmpDir);
    const result = updater.resolveTargetVersion(makeLatest(makeCanary({ rollout_percentage: 0 })));
    expect(result.channel).toBe('stable');
  });

  it('returns canary for all when rollout_percentage is 100', () => {
    const updater = new Updater(makeConfig({ installId: 'any-id' }), tmpDir);
    const result = updater.resolveTargetVersion(makeLatest(makeCanary({ rollout_percentage: 100 })));
    expect(result.channel).toBe('canary');
  });

  it('falls back to stable on malformed canary (missing rollout_percentage)', () => {
    const latest: LatestManifest = {
      version: '1.0.35',
      git_commit: 'abc',
      package_url: 'https://example.com/pkg.tar.gz',
      canary: { version: '1.0.36', git_commit: 'def', package_url: 'url' } as any,
    };
    const updater = new Updater(makeConfig(), tmpDir);
    const result = updater.resolveTargetVersion(latest);
    expect(result.channel).toBe('stable');
  });

  it('returns hotfixVersion from canary manifest', () => {
    const updater = new Updater(makeConfig({ canaryPolicy: 'latest' }), tmpDir);
    const result = updater.resolveTargetVersion(makeLatest(makeCanary({ hotfix_version: 3 })));
    expect(result.hotfixVersion).toBe(3);
  });
});

describe('needsUpdate with canary channel', () => {
  const tmpDir = '/tmp/test-canary';

  it('returns true when canary hotfix_version is higher than local', () => {
    const updater = new Updater(makeConfig({ canaryHotfixVersion: 1 }), tmpDir);
    const local: LocalVersion = { version: '1.0.36', gitCommit: 'def456' };
    const manifest: CanaryManifest = {
      version: '1.0.36',
      git_commit: 'def456',
      package_url: 'url',
      rollout_percentage: 10,
      hotfix_version: 2,
    };
    expect(updater.needsUpdate(local, manifest, 'canary')).toBe(true);
  });

  it('returns false when canary hotfix_version equals local', () => {
    const updater = new Updater(makeConfig({ canaryHotfixVersion: 1 }), tmpDir);
    const local: LocalVersion = { version: '1.0.36', gitCommit: 'def456' };
    const manifest: CanaryManifest = {
      version: '1.0.36',
      git_commit: 'def456',
      package_url: 'url',
      rollout_percentage: 10,
      hotfix_version: 1,
    };
    expect(updater.needsUpdate(local, manifest, 'canary')).toBe(false);
  });

  it('stable channel does not check hotfix_version', () => {
    const updater = new Updater(makeConfig({ canaryHotfixVersion: 0 }), tmpDir);
    const local: LocalVersion = { version: '1.0.35', gitCommit: 'abc123' };
    const manifest: VersionManifest = {
      version: '1.0.35',
      git_commit: 'abc123',
      package_url: 'url',
    };
    expect(updater.needsUpdate(local, manifest, 'stable')).toBe(false);
  });

  it('defaults to stable channel when not specified', () => {
    const updater = new Updater(makeConfig(), tmpDir);
    const local: LocalVersion = { version: '1.0.35', gitCommit: 'abc123' };
    const manifest: VersionManifest = {
      version: '1.0.35',
      git_commit: 'abc123',
      package_url: 'url',
    };
    expect(updater.needsUpdate(local, manifest)).toBe(false);
  });
});

describe('installId auto-generation', () => {
  const tmpDir = '/tmp/test-canary';

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJsonFile.mockResolvedValue({});
    mockWriteJsonFile.mockResolvedValue(undefined);
  });

  it('generates installId when missing', async () => {
    const config = makeConfig();
    const updater = new Updater(config, tmpDir);
    await (updater as any).ensureInstallId();
    expect(mockWriteJsonFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ installId: expect.any(String) }),
    );
  });

  it('preserves existing installId', async () => {
    const config = makeConfig({ installId: 'existing-id' });
    const updater = new Updater(config, tmpDir);
    await (updater as any).ensureInstallId();
    expect(mockWriteJsonFile).not.toHaveBeenCalled();
  });
});

describe('canary state persistence', () => {
  const tmpDir = '/tmp/test-canary';

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJsonFile.mockResolvedValue({});
    mockWriteJsonFile.mockResolvedValue(undefined);
  });

  it('writes hotfix_version to config after canary update', async () => {
    const updater = new Updater(makeConfig(), tmpDir);
    await (updater as any).persistCanaryState(2);
    expect(mockWriteJsonFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ canary: { hotfix_version: 2 } }),
    );
  });

  it('writes default hotfix_version 0 when not specified', async () => {
    const updater = new Updater(makeConfig(), tmpDir);
    await (updater as any).persistCanaryState(0);
    expect(mockWriteJsonFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ canary: { hotfix_version: 0 } }),
    );
  });
});

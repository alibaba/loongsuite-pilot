import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

// Mock child_process: route tar to real exec, npm/loongsuite-pilot to mock
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));
vi.mock('node:util', async () => {
  return {
    promisify: () => (...args: any[]) => mockExecFile(...args),
  };
});

// Mock global fetch
const mockFetch = vi.fn();

import { Updater } from '../../src/updater/updater.js';
import { computeSha256 } from '../../src/updater/version-utils.js';
import type { AutoUpdateConfig } from '../../src/types/index.js';

describe('Updater integration (real filesystem)', () => {
  let testDir: string;

  beforeEach(async () => {
    vi.stubGlobal('fetch', mockFetch);
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'updater-test-'));
    await fs.mkdir(path.join(testDir, 'versions'), { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<AutoUpdateConfig> = {}): AutoUpdateConfig {
    return {
      enabled: true,
      checkIntervalMs: 60_000,
      manifestUrl: 'https://example.com/latest.json',
      packageUrl: 'https://example.com/pkg.tar.gz',
      ...overrides,
    };
  }

  /**
   * Create a fake version directory with the minimal required files.
   */
  async function createFakeVersion(version: string, commit: string): Promise<string> {
    const dirName = `${version}_${commit}`;
    const versionDir = path.join(testDir, 'versions', dirName);
    await fs.mkdir(path.join(versionDir, 'dist'), { recursive: true });
    await fs.mkdir(path.join(versionDir, 'scripts'), { recursive: true });
    await fs.writeFile(
      path.join(versionDir, 'VERSION'),
      `version=${version}\ngit_commit=${commit}\nbuild_time=2026-05-03T00:00:00Z\n`,
    );
    await fs.writeFile(path.join(versionDir, 'dist', 'index.js'), '// placeholder\n');
    await fs.writeFile(path.join(versionDir, 'package.json'), '{"name":"test"}\n');
    await fs.writeFile(
      path.join(versionDir, 'scripts', 'collector-daemon.js'),
      '// bootstrap\n',
    );
    return dirName;
  }

  /**
   * Create a tarball containing a fake package with the given version info.
   * Uses vi.importActual to get real child_process (vi.mock is hoisted).
   */
  async function createFakeTarball(version: string, commit: string): Promise<{
    tarballBytes: Buffer;
    sha256: string;
  }> {
    const realCp = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const realUtil = await vi.importActual<typeof import('node:util')>('node:util');
    const exec = realUtil.promisify(realCp.execFile);

    const stageDir = path.join(testDir, 'stage');
    const pkgDir = path.join(stageDir, 'loongsuite-pilot');
    await fs.mkdir(path.join(pkgDir, 'dist'), { recursive: true });
    await fs.mkdir(path.join(pkgDir, 'scripts'), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, 'VERSION'),
      `version=${version}\ngit_commit=${commit}\n`,
    );
    await fs.writeFile(path.join(pkgDir, 'dist', 'index.js'), '// new version\n');
    await fs.writeFile(path.join(pkgDir, 'package.json'), '{"name":"loongsuite-pilot"}\n');
    await fs.writeFile(path.join(pkgDir, 'scripts', 'collector-daemon.js'), '// boot\n');

    const tarballPath = path.join(testDir, 'package.tar.gz');
    await exec('tar', ['-czf', tarballPath, '-C', stageDir, 'loongsuite-pilot']);

    const tarballBytes = await fs.readFile(tarballPath);
    const hash = crypto.createHash('sha256').update(tarballBytes).digest('hex');

    await fs.rm(stageDir, { recursive: true, force: true });
    await fs.rm(tarballPath);
    return { tarballBytes, sha256: hash };
  }

  async function setCurrentPointer(dirName: string) {
    await fs.writeFile(path.join(testDir, 'current'), dirName + '\n');
  }

  async function readPointer(name: string): Promise<string | null> {
    try {
      return (await fs.readFile(path.join(testDir, name), 'utf-8')).trim();
    } catch {
      return null;
    }
  }

  // ─── Helper: setup fetch mocks + execFile routing ──────

  let realExec: (cmd: string, args: string[], opts?: any) => Promise<{ stdout: string; stderr: string }>;

  beforeEach(async () => {
    const realCp = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const realUtil = await vi.importActual<typeof import('node:util')>('node:util');
    realExec = realUtil.promisify(realCp.execFile) as any;
  });

  function setupExecFileRouting(opts?: {
    npmFails?: boolean;
    sqliteHealthCheckFails?: boolean;
  }) {
    mockExecFile.mockImplementation((cmd: string, args: string[], execOpts: any) => {
      if (cmd === 'tar') {
        return realExec(cmd, args, execOpts);
      }
      if (cmd === 'npm' && opts?.npmFails) {
        return Promise.reject(new Error('npm ERR!'));
      }
      if (
        cmd === process.execPath
        && args[0] === '-e'
        && args[1] === "require('sqlite3')"
        && opts?.sqliteHealthCheckFails
      ) {
        return Promise.reject(new Error('Could not locate the bindings file'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
  }

  function mockFetchForUpgrade(
    tarballBytes: Buffer,
    manifest: Record<string, unknown>,
  ) {
    mockFetch
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve(manifest),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(tarballBytes));
            controller.close();
          },
        }),
      });
  }

  // ─── npm install failure → no pointer update ──────────

  it('does NOT update pointer when npm install fails', async () => {
    const v1Dir = await createFakeVersion('1.0.1', 'aaa');
    await setCurrentPointer(v1Dir);

    const { tarballBytes, sha256 } = await createFakeTarball('1.0.2', 'bbb');
    mockFetchForUpgrade(tarballBytes, {
      version: '1.0.2', git_commit: 'bbb',
      package_url: 'https://example.com/pkg.tar.gz', sha256,
    });
    setupExecFileRouting({ npmFails: true });

    const updater = new Updater(makeConfig(), testDir);
    await updater.check();

    expect(await readPointer('current')).toBe('1.0.1_aaa');
    expect(await readPointer('previous')).toBeNull();
  });

  // ─── sqlite3 health check failure → no activation ─────

  it('does NOT update pointers or restart collector when sqlite3 health check fails', async () => {
    const v1Dir = await createFakeVersion('1.0.1', 'aaa');
    await setCurrentPointer(v1Dir);
    await fs.writeFile(path.join(testDir, 'previous'), '1.0.0_old\n');

    const { tarballBytes, sha256 } = await createFakeTarball('1.0.2', 'bbb');
    mockFetchForUpgrade(tarballBytes, {
      version: '1.0.2', git_commit: 'bbb',
      package_url: 'https://example.com/pkg.tar.gz', sha256,
    });
    setupExecFileRouting({ sqliteHealthCheckFails: true });

    const updater = new Updater(makeConfig(), testDir);
    await updater.check();

    expect(mockExecFile).toHaveBeenCalledWith(
      process.execPath,
      ['-e', "require('sqlite3')"],
      expect.objectContaining({
        cwd: path.join(testDir, 'versions', '1.0.2_bbb.candidate'),
        env: expect.any(Object),
      }),
    );
    expect(await readPointer('current')).toBe('1.0.1_aaa');
    expect(await readPointer('previous')).toBe('1.0.0_old');
    const restartCalls = mockExecFile.mock.calls.filter(
      ([, args]: [string, string[]]) => args.includes('restart-collector'),
    );
    expect(restartCalls).toHaveLength(0);
  });

  // ─── SHA-256 mismatch → no pointer update ─────────────

  it('does NOT update pointer when SHA-256 does not match', async () => {
    const v1Dir = await createFakeVersion('1.0.1', 'aaa');
    await setCurrentPointer(v1Dir);

    const { tarballBytes } = await createFakeTarball('1.0.2', 'bbb');
    mockFetchForUpgrade(tarballBytes, {
      version: '1.0.2', git_commit: 'bbb',
      package_url: 'https://example.com/pkg.tar.gz',
      sha256: 'deliberately_wrong_hash',
    });
    setupExecFileRouting();

    const updater = new Updater(makeConfig(), testDir);
    await updater.check();

    expect(await readPointer('current')).toBe('1.0.1_aaa');
  });

  // ─── Downgrade prevention ─────────────────────────────

  it('does NOT downgrade when remote version is older', async () => {
    const v2Dir = await createFakeVersion('1.0.2', 'bbb');
    await setCurrentPointer(v2Dir);

    // Remote says 1.0.1 (older)
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({
        version: '1.0.1', git_commit: 'aaa',
        package_url: 'https://example.com/pkg.tar.gz',
      }),
    });

    const updater = new Updater(makeConfig(), testDir);
    await updater.check();

    // Should NOT have attempted download
    expect(mockFetch).toHaveBeenCalledTimes(1); // only manifest, no download
    expect(await readPointer('current')).toBe('1.0.2_bbb');
  });

  // ─── GC preserves current + previous ──────────────────

  it('GC removes old versions but keeps current and previous', async () => {
    const v1 = await createFakeVersion('1.0.0', 'old');
    const v2 = await createFakeVersion('1.0.1', 'aaa');
    const v3 = await createFakeVersion('1.0.2', 'bbb');

    await setCurrentPointer(v3);
    await fs.writeFile(path.join(testDir, 'previous'), v2 + '\n');

    // Trigger gc via full check cycle (already up to date)
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({
        version: '1.0.2', git_commit: 'bbb',
        package_url: 'https://example.com/pkg.tar.gz',
      }),
    });

    const updater = new Updater(makeConfig(), testDir);
    // We can't easily trigger gc alone, so we test the directory state
    // directly via the private method
    await (updater as any).gcOldVersions();

    // v1 should be removed
    const v1Exists = await fs.access(path.join(testDir, 'versions', v1))
      .then(() => true).catch(() => false);
    expect(v1Exists).toBe(false);

    // v2 and v3 should remain
    const v2Exists = await fs.access(path.join(testDir, 'versions', v2))
      .then(() => true).catch(() => false);
    const v3Exists = await fs.access(path.join(testDir, 'versions', v3))
      .then(() => true).catch(() => false);
    expect(v2Exists).toBe(true);
    expect(v3Exists).toBe(true);
  });

  // ─── Legacy fallback ──────────────────────────────────

  it('falls back to legacy package/ dir when no current pointer', async () => {
    // No current pointer file, but legacy package/ exists
    const legacyDir = path.join(testDir, 'package', 'dist');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, 'index.js'), '// legacy\n');
    await fs.writeFile(
      path.join(testDir, 'package', 'VERSION'),
      'version=0.9.0\ngit_commit=legacy\n',
    );

    // Remote has newer version
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({
        version: '1.0.0', git_commit: 'new',
        package_url: 'https://example.com/pkg.tar.gz',
      }),
    });

    const updater = new Updater(makeConfig(), testDir);
    const local = await (updater as any).readLocalVersion();
    expect(local).toEqual({ version: '0.9.0', gitCommit: 'legacy' });
  });
});

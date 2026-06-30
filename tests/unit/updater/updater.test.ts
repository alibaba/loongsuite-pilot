import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AutoUpdateConfig } from '../../../src/types/index.js';

// --- Mock logger ---
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

// --- Mock version-utils (we test these separately) ---
const mockComputeSha256 = vi.fn<[string], Promise<string>>();
vi.mock('../../../src/updater/version-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/updater/version-utils.js')>();
  return {
    ...actual,
    computeSha256: (...args: [string]) => mockComputeSha256(...args),
  };
});

// --- Mock fs/promises ---
const mockFsReadFile = vi.fn<[string, string], Promise<string>>();
const mockFsWriteFile = vi.fn<[string, string], Promise<void>>();
const mockFsRename = vi.fn<[string, string], Promise<void>>();
const mockFsRm = vi.fn<[string, any], Promise<void>>();
const mockFsMkdir = vi.fn<[string, any], Promise<void>>();
const mockFsAccess = vi.fn<[string], Promise<void>>();
const mockFsReaddir = vi.fn<[string], Promise<string[]>>();
const mockFsStat = vi.fn();
const mockFsCp = vi.fn<[string, string, any], Promise<void>>();
const mockFsCopyFile = vi.fn<[string, string], Promise<void>>();
const mockFsChmod = vi.fn<[string, number], Promise<void>>();

vi.mock('node:fs/promises', () => ({
  readFile: (...args: [string, string]) => mockFsReadFile(...args),
  writeFile: (...args: [string, string]) => mockFsWriteFile(...args),
  rename: (...args: [string, string]) => mockFsRename(...args),
  rm: (...args: [string, any]) => mockFsRm(...args),
  mkdir: (...args: [string, any]) => mockFsMkdir(...args),
  access: (...args: [string]) => mockFsAccess(...args),
  readdir: (...args: [string]) => mockFsReaddir(...args),
  stat: (...args: any[]) => mockFsStat(...args),
  cp: (...args: [string, string, any]) => mockFsCp(...args),
  copyFile: (...args: [string, string]) => mockFsCopyFile(...args),
  chmod: (...args: [string, number]) => mockFsChmod(...args),
}));

// --- Mock node:fs (createWriteStream) ---
vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => ({ fake: true })),
  createReadStream: vi.fn(),
}));

// --- Mock stream pipeline ---
vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

// --- Mock child_process ---
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

// --- Mock node:util promisify to wrap our mockExecFile ---
vi.mock('node:util', () => ({
  promisify: () => (...args: any[]) => mockExecFile(...args),
}));

// --- Mock fs-utils (readJsonFile, writeJsonFile) ---
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

// --- Mock global fetch ---
const mockFetch = vi.fn<[string, any?], Promise<Response>>();

import { Updater } from '../../../src/updater/updater.js';
import type { VersionManifest, LocalVersion } from '../../../src/updater/updater.js';

function makeConfig(overrides: Partial<AutoUpdateConfig> = {}): AutoUpdateConfig {
  return {
    enabled: true,
    checkIntervalMs: 60_000,
    manifestUrl: 'https://example.com/latest.json',
    packageUrl: 'https://example.com/pkg.tar.gz',
    ...overrides,
  };
}

function makeManifest(overrides: Partial<VersionManifest> = {}): VersionManifest {
  return {
    version: '1.0.2',
    git_commit: 'bbb',
    package_url: 'https://example.com/pkg.tar.gz',
    ...overrides,
  };
}

function makeResponseJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    body: null,
  } as unknown as Response;
}

function makeResponseStream(status = 200): Response {
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    body: readable,
  } as unknown as Response;
}

describe('Updater', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', mockFetch);
    tmpDir = '/tmp/test-updater';

    // Default fs mocks
    mockFsRm.mockResolvedValue(undefined);
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsRename.mockResolvedValue(undefined);
    mockFsCp.mockResolvedValue(undefined);
    mockFsCopyFile.mockResolvedValue(undefined);
    mockFsChmod.mockResolvedValue(undefined);
    mockFsReaddir.mockResolvedValue([]);
    // Default: no current pointer file → first deployment
    mockFsReadFile.mockRejectedValue(new Error('ENOENT'));
    // Default: access checks fail (nothing exists)
    mockFsAccess.mockRejectedValue(new Error('ENOENT'));
    // Default: execFile succeeds
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    // Default: readJsonFile / writeJsonFile
    mockReadJsonFile.mockResolvedValue({});
    mockWriteJsonFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ─── LIFECYCLE ─────────────────────────────────────────

  describe('lifecycle', () => {
    it('does not start timer when disabled', () => {
      const updater = new Updater(makeConfig({ enabled: false }), tmpDir);
      updater.start();
      // No timers should be scheduled (besides the underlying fake timer queue)
      expect(vi.getTimerCount()).toBe(0);
    });

    it('schedules initial delayed check and interval on start', () => {
      const updater = new Updater(makeConfig(), tmpDir);
      updater.start();
      // setTimeout (60s) + check interval + heartbeat interval
      expect(vi.getTimerCount()).toBe(3);
      updater.stop();
    });

    it('clears timer on stop', () => {
      const updater = new Updater(makeConfig(), tmpDir);
      updater.start();
      updater.stop();
      expect(vi.getTimerCount()).toBe(1); // setTimeout remains but interval cleared
    });

    it('stop is idempotent', () => {
      const updater = new Updater(makeConfig(), tmpDir);
      updater.start();
      updater.stop();
      updater.stop(); // no error
    });
  });

  // ─── needsUpdate ───────────────────────────────────────

  describe('needsUpdate', () => {
    it('returns true when local is null (first deployment)', () => {
      const updater = new Updater(makeConfig(), tmpDir);
      expect(updater.needsUpdate(null, makeManifest())).toBe(true);
    });

    it('returns true when remote version is higher', () => {
      const updater = new Updater(makeConfig(), tmpDir);
      const local: LocalVersion = { version: '1.0.1', gitCommit: 'aaa' };
      expect(updater.needsUpdate(local, makeManifest({ version: '1.0.2' }))).toBe(true);
    });

    it('returns false when remote version is lower (no downgrade)', () => {
      const updater = new Updater(makeConfig(), tmpDir);
      const local: LocalVersion = { version: '1.0.2', gitCommit: 'bbb' };
      expect(updater.needsUpdate(local, makeManifest({ version: '1.0.1' }))).toBe(false);
    });

    it('returns true when same version but different commit (rebuild)', () => {
      const updater = new Updater(makeConfig(), tmpDir);
      const local: LocalVersion = { version: '1.0.2', gitCommit: 'aaa' };
      expect(updater.needsUpdate(local, makeManifest({ version: '1.0.2', git_commit: 'bbb' }))).toBe(true);
    });

    it('returns false when same version and same commit', () => {
      const updater = new Updater(makeConfig(), tmpDir);
      const local: LocalVersion = { version: '1.0.2', gitCommit: 'aaa' };
      expect(updater.needsUpdate(local, makeManifest({ version: '1.0.2', git_commit: 'aaa' }))).toBe(false);
    });

    it('returns false when same version and remote commit is empty', () => {
      const updater = new Updater(makeConfig(), tmpDir);
      const local: LocalVersion = { version: '1.0.2', gitCommit: 'aaa' };
      expect(updater.needsUpdate(local, makeManifest({ version: '1.0.2', git_commit: '' }))).toBe(false);
    });
  });

  // ─── check(): manifest fetching ───────────────────────

  describe('check - manifest fetching', () => {
    it('skips when manifest URL is not configured', async () => {
      const updater = new Updater(makeConfig({ manifestUrl: undefined }), tmpDir);
      await updater.check();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('handles manifest HTTP error gracefully', async () => {
      mockFetch.mockResolvedValueOnce(makeResponseJson({}, 500));
      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();
      // Should not throw, just log warning
    });

    it('handles manifest network error gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network timeout'));
      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();
      // Should not throw
    });

    it('skips update when already up to date', async () => {
      // Setup: manifest returns 1.0.2, local is also 1.0.2
      mockFetch.mockResolvedValueOnce(makeResponseJson(makeManifest({ version: '1.0.2', git_commit: 'aaa' })));
      // Make readLocalVersion return a matching version
      mockFsReadFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('/current')) return Promise.resolve('1.0.2_aaa\n');
        if (filePath.endsWith('/VERSION')) return Promise.resolve('version=1.0.2\ngit_commit=aaa\n');
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsAccess.mockResolvedValue(undefined); // versions dir exists

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      // fetch called once for manifest, not for download
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ─── check(): download and deploy ─────────────────────

  describe('check - download and deploy', () => {
    function setupForDownload() {
      // Manifest says 1.0.2, local has no version (first deploy)
      mockFetch
        .mockResolvedValueOnce(makeResponseJson(makeManifest()))  // manifest
        .mockResolvedValueOnce(makeResponseStream());              // download

      // findExtractedPackage needs readdir + stat + access
      mockFsReaddir.mockImplementation((dir: string) => {
        if (dir.includes('download-tmp')) return Promise.resolve(['loongsuite-pilot']);
        return Promise.resolve([]);
      });
      mockFsStat.mockResolvedValue({ isDirectory: () => true });
      mockFsAccess.mockImplementation((p: string) => {
        if (p.includes('package.json')) return Promise.resolve();
        if (p.includes('dist/index.js')) return Promise.resolve();
        if (p.includes('dist/updater/index.js')) return Promise.resolve();
        if (p.includes('scripts/collector-daemon.js')) return Promise.resolve();
        if (p.includes('scripts/updater-daemon.js')) return Promise.resolve();
        if (p.includes('scripts/loongsuite-pilot.sh')) return Promise.resolve();
        if (p.includes('postinstall.js')) return Promise.reject(new Error('ENOENT'));
        return Promise.reject(new Error('ENOENT'));
      });
      // copyFileAtomic reads source files via fs.readFile before copying
      mockFsReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes('/scripts/')) return Promise.resolve(Buffer.from('script'));
        return Promise.reject(new Error('ENOENT'));
      });
    }

    it('deploys successfully on first install', async () => {
      setupForDownload();
      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      // Verify pointer was written
      expect(mockFsWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('current.tmp'),
        '1.0.2_bbb\n',
      );
      expect(mockFsRename).toHaveBeenCalledWith(
        expect.stringContaining('current.tmp'),
        expect.stringContaining('/current'),
      );
    });

    it('syncs installed scripts after switching the current pointer', async () => {
      setupForDownload();
      mockFsAccess.mockImplementation((p: string) => {
        if (p.includes('package.json')) return Promise.resolve();
        if (p.includes('dist/index.js')) return Promise.resolve();
        if (p.includes('dist/updater/index.js')) return Promise.resolve();
        if (p.includes('postinstall.js')) return Promise.reject(new Error('ENOENT'));
        if (p.includes('collector-daemon.js')) return Promise.resolve();
        if (p.includes('updater-daemon.js')) return Promise.resolve();
        if (p.includes('loongsuite-pilot.sh')) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      expect(mockFsCopyFile).toHaveBeenCalledWith(
        expect.stringContaining('/scripts/collector-daemon.js'),
        expect.stringContaining('/bin/collector-daemon.js.tmp'),
      );
      expect(mockFsCopyFile).toHaveBeenCalledWith(
        expect.stringContaining('/scripts/updater-daemon.js'),
        expect.stringContaining('/bin/updater-daemon.js.tmp'),
      );
      expect(mockFsCopyFile).toHaveBeenCalledWith(
        expect.stringContaining('/scripts/loongsuite-pilot.sh'),
        expect.stringMatching(/\.local\/bin\/loongsuite-pilot\.tmp$/),
      );
      expect(mockFsChmod).toHaveBeenCalledWith(
        expect.stringMatching(/\.local\/bin\/loongsuite-pilot\.tmp$/),
        0o755,
      );
      const currentRenameCall = mockFsRename.mock.calls.findIndex(([, dst]) => dst.endsWith('/current'));
      expect(mockFsRename.mock.invocationCallOrder[currentRenameCall]).toBeLessThan(
        mockFsCopyFile.mock.invocationCallOrder[0],
      );
    });

    it('restores pointers and installed scripts when script sync fails', async () => {
      setupForDownload();
      mockFsReadFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('/current')) return Promise.resolve('1.0.1_aaa\n');
        if (filePath.endsWith('/previous')) return Promise.resolve('1.0.0_zzz\n');
        if (filePath.endsWith('/VERSION')) return Promise.resolve('version=1.0.1\ngit_commit=aaa\n');
        if (filePath.includes('/scripts/')) return Promise.resolve(Buffer.from('script'));
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsAccess.mockImplementation((p: string) => {
        if (p.includes('versions/1.0.1_aaa')) return Promise.resolve();
        if (p.includes('package.json')) return Promise.resolve();
        if (p.includes('dist/index.js')) return Promise.resolve();
        if (p.includes('dist/updater/index.js')) return Promise.resolve();
        if (p.includes('scripts/collector-daemon.js')) return Promise.resolve();
        if (p.includes('scripts/updater-daemon.js')) return Promise.resolve();
        if (p.includes('scripts/loongsuite-pilot.sh')) return Promise.resolve();
        if (p.includes('postinstall.js')) return Promise.reject(new Error('ENOENT'));
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsCopyFile.mockImplementation((src: string, dst: string) => {
        if (src.includes('/versions/1.0.2_bbb/') && dst.endsWith('loongsuite-pilot.tmp')) {
          return Promise.reject(new Error('copy failed'));
        }
        return Promise.resolve();
      });

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      expect(mockFsWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('/current.tmp'),
        '1.0.1_aaa\n',
      );
      expect(mockFsWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('/previous.tmp'),
        '1.0.0_zzz\n',
      );
      expect(mockFsCopyFile).toHaveBeenCalledWith(
        expect.stringContaining('/versions/1.0.1_aaa/scripts/loongsuite-pilot.sh'),
        expect.stringMatching(/\.local\/bin\/loongsuite-pilot\.tmp$/),
      );
    });

    it('updates previous pointer when upgrading', async () => {
      // Simulate existing version
      mockFsReadFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('/current')) return Promise.resolve('1.0.1_aaa\n');
        if (filePath.endsWith('/VERSION')) return Promise.resolve('version=1.0.1\ngit_commit=aaa\n');
        return Promise.reject(new Error('ENOENT'));
      });

      setupForDownload();
      // Override readFile to handle pointer reads and scripts
      mockFsReadFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('/current')) return Promise.resolve('1.0.1_aaa\n');
        if (filePath.endsWith('/VERSION')) return Promise.resolve('version=1.0.1\ngit_commit=aaa\n');
        if (filePath.includes('/scripts/')) return Promise.resolve(Buffer.from('script'));
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsAccess.mockImplementation((p: string) => {
        if (p.includes('versions/1.0.1_aaa')) return Promise.resolve();
        if (p.includes('package.json')) return Promise.resolve();
        if (p.includes('dist/index.js')) return Promise.resolve();
        if (p.includes('dist/updater/index.js')) return Promise.resolve();
        if (p.includes('scripts/collector-daemon.js')) return Promise.resolve();
        if (p.includes('scripts/updater-daemon.js')) return Promise.resolve();
        if (p.includes('scripts/loongsuite-pilot.sh')) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      // previous should be written with old version
      expect(mockFsWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('/previous.tmp'),
        '1.0.1_aaa\n',
      );
    });

    it('aborts when download returns HTTP error', async () => {
      mockFetch
        .mockResolvedValueOnce(makeResponseJson(makeManifest()))
        .mockResolvedValueOnce(makeResponseStream(404));

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      // Pointer should NOT be written
      expect(mockFsRename).not.toHaveBeenCalled();
    });

    it('aborts when SHA-256 does not match', async () => {
      mockFetch
        .mockResolvedValueOnce(makeResponseJson(makeManifest({ sha256: 'expected_hash' })))
        .mockResolvedValueOnce(makeResponseStream());
      mockComputeSha256.mockResolvedValueOnce('actual_different_hash');

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      expect(mockFsRename).not.toHaveBeenCalled();
    });

    it('proceeds when SHA-256 matches', async () => {
      const hash = 'abc123def456';
      mockFetch
        .mockResolvedValueOnce(makeResponseJson(makeManifest({ sha256: hash })))
        .mockResolvedValueOnce(makeResponseStream());
      mockComputeSha256.mockResolvedValueOnce(hash);

      setupForDownload();
      // Re-mock fetch since setupForDownload adds its own
      mockFetch.mockReset();
      mockFetch
        .mockResolvedValueOnce(makeResponseJson(makeManifest({ sha256: hash })))
        .mockResolvedValueOnce(makeResponseStream());
      mockComputeSha256.mockResolvedValueOnce(hash);

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      expect(mockComputeSha256).toHaveBeenCalled();
    });

    it('skips SHA-256 check when manifest has no sha256', async () => {
      setupForDownload();
      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      expect(mockComputeSha256).not.toHaveBeenCalled();
    });

    it('aborts when npm install fails — pointer NOT updated', async () => {
      setupForDownload();
      mockExecFile.mockImplementation((...args: any[]) => {
        const cmd = args[0];
        if (cmd === 'npm') return Promise.reject(new Error('npm ERR! code ERESOLVE'));
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      // current pointer should NOT be updated
      expect(mockFsRename).not.toHaveBeenCalled();
      expect(mockFsRm).toHaveBeenCalledWith(
        expect.stringContaining('1.0.2_bbb.candidate'),
        expect.objectContaining({ recursive: true, force: true }),
      );
    });

    it('cleans up download-tmp even on failure', async () => {
      mockFetch
        .mockResolvedValueOnce(makeResponseJson(makeManifest()))
        .mockResolvedValueOnce(makeResponseStream(500));

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      // rm should be called for download-tmp cleanup (in finally block)
      const rmCalls = mockFsRm.mock.calls.filter(
        ([p]: [string]) => p.includes('download-tmp'),
      );
      expect(rmCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('does not start monitor when monitor was not already running', async () => {
      setupForDownload();
      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      const loongsuitePilotCalls = mockExecFile.mock.calls.filter(
        ([cmd]: [string]) => String(cmd).includes('loongsuite-pilot'),
      );
      expect(loongsuitePilotCalls.map(([, args]) => args)).toContainEqual(['restart-collector']);
      expect(loongsuitePilotCalls.map(([, args]) => args)).not.toContainEqual(['monitor', 'start']);
    });

    it('restarts monitor after update when monitor was already running', async () => {
      setupForDownload();
      const realKill = process.kill;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === 12345 && signal === 0) return true;
        throw new Error('not running');
      }) as typeof process.kill);
      mockFsReadFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('/loongsuite-pilot-monitor.pid')) return Promise.resolve('12345\n');
        if (filePath.endsWith('/loongsuite-pilot-dashboard.pid')) return Promise.reject(new Error('ENOENT'));
        if (filePath.includes('/scripts/')) return Promise.resolve(Buffer.from('script'));
        return Promise.reject(new Error('ENOENT'));
      });

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      const loongsuitePilotCalls = mockExecFile.mock.calls
        .filter(([cmd]: [string]) => String(cmd).includes('loongsuite-pilot'))
        .map(([, args]) => args);
      expect(loongsuitePilotCalls).toContainEqual(['restart-collector']);
      expect(loongsuitePilotCalls).toContainEqual(['monitor', 'stop']);
      expect(loongsuitePilotCalls).toContainEqual(['monitor', 'start']);

      killSpy.mockRestore();
      process.kill = realKill;
    });
  });

  // ─── check(): reentry protection ─────────────────────

  describe('check - reentry protection', () => {
    it('returns immediately when another check is in progress', async () => {
      const updater = new Updater(makeConfig(), tmpDir);
      // Simulate a check already in progress
      (updater as any).checking = true;

      await updater.check();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('resets checking flag after check completes', async () => {
      mockFetch.mockResolvedValueOnce(makeResponseJson(null, 500));
      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      expect((updater as any).checking).toBe(false);
    });
  });

  // ─── Backoff & retry ──────────────────────────────────

  describe('backoff and retry', () => {
    it('applies exponential backoff after failure', async () => {
      mockFetch
        .mockResolvedValueOnce(makeResponseJson(makeManifest()))
        .mockResolvedValueOnce(makeResponseStream(500)); // download fails

      const config = makeConfig({ checkIntervalMs: 10_000 });
      const updater = new Updater(config, tmpDir);

      await updater.check(); // fails → consecutiveFailures = 1

      // Next check should be skipped due to backoff
      mockFetch.mockClear();
      await updater.check();
      expect(mockFetch).not.toHaveBeenCalled(); // skipped
    });

    it('resets backoff counter on success', async () => {
      // First call: up to date (success)
      mockFetch.mockResolvedValueOnce(
        makeResponseJson(makeManifest({ version: '1.0.2', git_commit: 'aaa' })),
      );
      mockFsReadFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('/current')) return Promise.resolve('1.0.2_aaa\n');
        if (filePath.endsWith('/VERSION')) return Promise.resolve('version=1.0.2\ngit_commit=aaa\n');
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsAccess.mockResolvedValue(undefined);

      const updater = new Updater(makeConfig(), tmpDir);

      // Manually set failure state
      (updater as any).consecutiveFailures = 5;
      (updater as any).nextCheckAt = 0; // allow check

      await updater.check();
      expect((updater as any).consecutiveFailures).toBe(0);
    });

    it('keeps updater alive in degraded retry after MAX_CONSECUTIVE_FAILURES', async () => {
      const updater = new Updater(makeConfig(), tmpDir);

      // Simulate 9 prior failures
      (updater as any).consecutiveFailures = 9;
      (updater as any).nextCheckAt = 0;

      // 10th failure
      mockFetch
        .mockResolvedValueOnce(makeResponseJson(makeManifest()))
        .mockResolvedValueOnce(makeResponseStream(500));

      updater.start();
      await updater.check();

      expect((updater as any).timer).not.toBeNull();
      const heartbeatCall = mockWriteJsonFile.mock.calls.find(([, value]) => (
        typeof value === 'object'
        && value !== null
        && (value as any).status === 'degraded'
      ));
      expect(heartbeatCall?.[0]).toEqual(expect.stringContaining('updater-runtime.json'));
    });

    it('backoff duration respects max cap (6 hours)', async () => {
      const updater = new Updater(makeConfig({ checkIntervalMs: 60_000 }), tmpDir);

      (updater as any).consecutiveFailures = 99;
      (updater as any).nextCheckAt = 0;

      mockFetch
        .mockResolvedValueOnce(makeResponseJson(makeManifest()))
        .mockResolvedValueOnce(makeResponseStream(500));

      const before = Date.now();
      await updater.check();
      const nextCheck = (updater as any).nextCheckAt;

      // Max backoff is 6 hours = 21_600_000ms
      expect(nextCheck - before).toBeLessThanOrEqual(6 * 60 * 60_000 + 1000);
    });
  });

  // ─── GC ────────────────────────────────────────────────

  describe('gcOldVersions (via full check cycle)', () => {
    it('preserves current and previous, removes others', async () => {
      // We test gc indirectly — it runs at end of successful check()
      // Setup a successful update cycle
      mockFsReadFile.mockImplementation((p: string) => {
        if (p.endsWith('/current')) return Promise.resolve('1.0.2_bbb\n');
        if (p.endsWith('/previous')) return Promise.resolve('1.0.1_aaa\n');
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsReaddir.mockImplementation((dir: string) => {
        if (dir.endsWith('/versions')) {
          return Promise.resolve(['1.0.0_old', '1.0.1_aaa', '1.0.2_bbb']);
        }
        return Promise.resolve([]);
      });
      mockFsStat.mockResolvedValue({ isDirectory: () => true });

      // Create updater and call gc directly via private access
      const updater = new Updater(makeConfig(), tmpDir);
      await (updater as any).gcOldVersions();

      // Should only rm 1.0.0_old
      const rmCalls = mockFsRm.mock.calls.filter(
        ([p]: [string]) => p.includes('versions/'),
      );
      expect(rmCalls).toHaveLength(1);
      expect(rmCalls[0][0]).toContain('1.0.0_old');
    });
  });

  // ─── Version resolution ────────────────────────────────

  describe('resolveCurrentVersionDir', () => {
    it('returns version dir when current pointer is valid', async () => {
      mockFsReadFile.mockImplementation((p: string) => {
        if (p.endsWith('/current')) return Promise.resolve('1.0.2_abc\n');
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsAccess.mockResolvedValue(undefined);

      const updater = new Updater(makeConfig(), tmpDir);
      const dir = await (updater as any).resolveCurrentVersionDir();
      expect(dir).toContain('versions/1.0.2_abc');
    });

    it('falls back to legacy package/ when current pointer missing', async () => {
      mockFsReadFile.mockRejectedValue(new Error('ENOENT'));
      mockFsAccess.mockImplementation((p: string) => {
        if (p.includes('package/dist/index.js')) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      const updater = new Updater(makeConfig(), tmpDir);
      const dir = await (updater as any).resolveCurrentVersionDir();
      expect(dir).toContain('/package');
    });

    it('returns null when nothing is available', async () => {
      mockFsReadFile.mockRejectedValue(new Error('ENOENT'));
      mockFsAccess.mockRejectedValue(new Error('ENOENT'));

      const updater = new Updater(makeConfig(), tmpDir);
      const dir = await (updater as any).resolveCurrentVersionDir();
      expect(dir).toBeNull();
    });
  });
});

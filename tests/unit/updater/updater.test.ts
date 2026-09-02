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
const mockFsMkdtemp = vi.fn<[string], Promise<string>>();

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
  mkdtemp: (...args: [string]) => mockFsMkdtemp(...args),
}));

// --- Mock node:fs (createWriteStream) ---
vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => ({ fake: true })),
  createReadStream: vi.fn(),
  readdirSync: vi.fn(() => []),
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

import { Updater, buildPaths } from '../../../src/updater/updater.js';
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

function pilotCommandArgs(call: [string, string[]]): string[] {
  const [cmd, args] = call;
  if (String(cmd).toLowerCase().includes('powershell')) {
    const fileIndex = args.indexOf('-File');
    return fileIndex >= 0 ? args.slice(fileIndex + 2) : [];
  }
  return args;
}

function pilotCommands(): string[] {
  return mockExecFile.mock.calls
    .map((call: [string, string[]]) => pilotCommandArgs(call)[0])
    .filter(Boolean);
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
    // Default: mkdtemp returns a deterministic child of the requested prefix.
    mockFsMkdtemp.mockImplementation((prefix: string) => Promise.resolve(prefix + 'XXXXXX'));
    // Default: no current pointer file → first deployment
    mockFsReadFile.mockRejectedValue(new Error('ENOENT'));
    // Default: access checks fail (nothing exists)
    mockFsAccess.mockRejectedValue(new Error('ENOENT'));
    // Default: execFile succeeds
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    // Default: config reads return an empty object; collector health reads see
    // the freshly started target version so existing successful-upgrade tests
    // exercise the health gate without waiting for a timer.
    mockReadJsonFile.mockImplementation((filePath: string) => {
      if (String(filePath).endsWith('/logs/runtime.json')) {
        return Promise.resolve({
          status: 'active',
          packageVersion: '1.0.2',
          pid: process.pid,
          updatedAt: new Date().toISOString(),
        });
      }
      return Promise.resolve({});
    });
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

    it('repairs an unhealthy collector even when the target is already current', async () => {
      mockFetch.mockResolvedValueOnce(makeResponseJson(
        makeManifest({ version: '1.0.2', git_commit: 'aaa' }),
      ));
      mockFsReadFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('/current')) return Promise.resolve('1.0.2_aaa\n');
        if (filePath.endsWith('/VERSION')) {
          return Promise.resolve('version=1.0.2\ngit_commit=aaa\n');
        }
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsAccess.mockResolvedValue(undefined);
      let runtimeReads = 0;
      mockReadJsonFile.mockImplementation((filePath: string) => {
        if (!String(filePath).endsWith('/logs/runtime.json')) return Promise.resolve({});
        runtimeReads++;
        return Promise.resolve(runtimeReads === 1 ? null : {
          status: 'active',
          packageVersion: '1.0.2',
          pid: process.pid,
          updatedAt: new Date().toISOString(),
        });
      });
      const metrics = {
        writeEvent: vi.fn().mockResolvedValue(undefined),
        writeAlarm: vi.fn().mockResolvedValue(undefined),
      };
      const updater = new Updater(makeConfig(), tmpDir);
      updater.setMetrics(metrics as any);

      await updater.check();

      expect(pilotCommands()).toEqual(['start-collector', 'schedule-updater-restart']);
      expect(metrics.writeEvent).toHaveBeenCalledWith('collector_restarted', {
        latest_version: '1.0.2',
      });
      expect((updater as any).consecutiveFailures).toBe(0);
    });

    it('keeps failure state when already-current collector recovery never becomes healthy', async () => {
      mockFetch.mockResolvedValueOnce(makeResponseJson(
        makeManifest({ version: '1.0.2', git_commit: 'aaa' }),
      ));
      mockFsReadFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('/current')) return Promise.resolve('1.0.2_aaa\n');
        if (filePath.endsWith('/VERSION')) {
          return Promise.resolve('version=1.0.2\ngit_commit=aaa\n');
        }
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsAccess.mockResolvedValue(undefined);
      mockReadJsonFile.mockImplementation((filePath: string) => (
        String(filePath).endsWith('/logs/runtime.json')
          ? Promise.resolve(null)
          : Promise.resolve({})
      ));
      const updater = new Updater(makeConfig(), tmpDir);
      const gc = vi.spyOn(updater as any, 'gcOldVersions');

      const checkPromise = updater.check();
      await vi.runAllTimersAsync();
      await checkPromise;

      expect(pilotCommands()).toContain('start-collector');
      expect(pilotCommands()).not.toContain('schedule-updater-restart');
      expect(gc).not.toHaveBeenCalled();
      expect((updater as any).consecutiveFailures).toBe(1);
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

    it('runs the staged package postinstall, pointed at this install data dir', async () => {
      // scripts/postinstall.js is the only thing that fills <dataDir>/{hooks,skills,
      // plugins}, so this call is also how an install broken by the Windows fs.cpSync
      // fail-fast heals itself -- the trees get rebuilt on the next auto-upgrade with no
      // reinstall. Nothing else covered it: the other deploy tests stub it absent, so
      // deleting the call left every test green.
      setupForDownload();
      mockFsAccess.mockImplementation((p: string) => {
        if (p.includes('package.json')) return Promise.resolve();
        if (p.includes('dist/index.js')) return Promise.resolve();
        if (p.includes('dist/updater/index.js')) return Promise.resolve();
        if (p.includes('scripts/collector-daemon.js')) return Promise.resolve();
        if (p.includes('scripts/updater-daemon.js')) return Promise.resolve();
        if (p.includes('scripts/loongsuite-pilot.sh')) return Promise.resolve();
        if (p.includes('postinstall.js')) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      const call = mockExecFile.mock.calls.find((c: unknown[]) =>
        Array.isArray(c[1]) && (c[1] as string[]).some(a => String(a).includes('postinstall.js')));
      expect(call, 'postinstall.js was never executed').toBeTruthy();
      // The NEW package's copy, run out of the staging dir: the point is to install the
      // assets that shipped with the version being activated.
      expect(String((call![1] as string[])[0])).toContain('.candidate');
      // And told which tree to fill. Unset, postinstall falls back to
      // $HOME/.loongsuite-pilot, which is the wrong one for a custom data dir.
      const env = (call![2] as { env?: Record<string, string> }).env ?? {};
      expect(env.LOONGSUITE_PILOT_DATA_DIR).toBe(tmpDir);
    });

    it('adopts the managed node runtime + prebuilt modules and pins node-bin', async () => {
      const expOs = process.platform === 'win32' ? 'win' : process.platform;
      const expArch = process.arch;
      const supported = ['darwin', 'linux', 'win'].includes(expOs)
        && ['x64', 'arm64'].includes(expArch)
        && !(expOs === 'win' && expArch === 'arm64');
      // On an unsupported host the updater keeps the system node; nothing to assert.
      if (!supported) return;

      const nodeArchive = `node-v22.22.2-${expOs}-${expArch}.${expOs === 'win' ? 'zip' : 'tar.gz'}`;
      const modulesArchive = `node-modules-${expOs}-${expArch}.tar.gz`;
      const nodeLeaf = expOs === 'win' ? 'node.exe' : 'node';
      const nodeBin = `${tmpDir}/runtime/node-v22.22.2-${expOs}-${expArch}/bin/${nodeLeaf}`;

      mockFetch
        .mockResolvedValueOnce(makeResponseJson(makeManifest()))  // manifest
        .mockResolvedValueOnce(makeResponseStream())              // package
        .mockResolvedValueOnce(makeResponseStream())              // node archive
        .mockResolvedValueOnce(makeResponseStream())              // node SHASUMS
        .mockResolvedValueOnce(makeResponseStream())              // modules archive
        .mockResolvedValueOnce(makeResponseStream());             // modules SHASUMS
      mockComputeSha256.mockResolvedValue('SHA');

      mockFsReaddir.mockImplementation((dir: string) => {
        if (dir.includes('download-tmp')) return Promise.resolve(['loongsuite-pilot']);
        return Promise.resolve([]);
      });
      mockFsStat.mockResolvedValue({ isDirectory: () => true });
      mockFsAccess.mockImplementation((p: string) => {
        if (p.includes('postinstall.js')) return Promise.reject(new Error('ENOENT'));
        if (p.includes('package.json')) return Promise.resolve();
        if (p.includes('dist/index.js')) return Promise.resolve();
        if (p.includes('dist/updater/index.js')) return Promise.resolve();
        if (p.includes('collector-daemon.js')) return Promise.resolve();
        if (p.includes('updater-daemon.js')) return Promise.resolve();
        if (p.includes('loongsuite-pilot.')) return Promise.resolve();
        // Managed node binary + staged prebuilt modules exist after extraction.
        if (p.includes('/runtime/') && (p.endsWith(`/${nodeLeaf}`))) return Promise.resolve();
        if (p.includes('.pilot-nm-') && p.endsWith('node_modules')) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsReadFile.mockImplementation((filePath: string) => {
        if (String(filePath).includes('SHASUMS256')) {
          return Promise.resolve(`SHA  ${nodeArchive}\nSHA  ${modulesArchive}\n` as unknown as string);
        }
        if (String(filePath).includes('/scripts/')) {
          return Promise.resolve(Buffer.from('script') as unknown as string);
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      // node-bin pin repointed at the managed runtime (atomic tmp + rename).
      expect(mockFsWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('node-bin.tmp'),
        nodeBin + '\n',
      );
      expect(mockFsRename).toHaveBeenCalledWith(
        expect.stringContaining('node-bin.tmp'),
        expect.stringContaining('node-bin'),
      );

      // Prebuilt modules were adopted, so npm install must be skipped.
      const execCommands = mockExecFile.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(execCommands).not.toContain('npm');
    });

    it('rolls pointers back when pinning the managed node runtime fails', async () => {
      const expOs = process.platform === 'win32' ? 'win' : process.platform;
      const expArch = process.arch;
      const supported = ['darwin', 'linux', 'win'].includes(expOs)
        && ['x64', 'arch'].includes(expArch === 'arm64' ? 'arch' : expArch)
        && !(expOs === 'win' && expArch === 'arm64');
      // On an unsupported host the managed runtime is never adopted, so there is no
      // pin step to fail; the ABI-consistency hazard this guards does not arise.
      if (!supported) return;

      const nodeArchive = `node-v22.22.2-${expOs}-${expArch}.${expOs === 'win' ? 'zip' : 'tar.gz'}`;
      const modulesArchive = `node-modules-${expOs}-${expArch}.tar.gz`;
      const nodeLeaf = expOs === 'win' ? 'node.exe' : 'node';

      mockFetch
        .mockResolvedValueOnce(makeResponseJson(makeManifest()))  // manifest
        .mockResolvedValueOnce(makeResponseStream())              // package
        .mockResolvedValueOnce(makeResponseStream())              // node archive
        .mockResolvedValueOnce(makeResponseStream())              // node SHASUMS
        .mockResolvedValueOnce(makeResponseStream())              // modules archive
        .mockResolvedValueOnce(makeResponseStream());             // modules SHASUMS
      mockComputeSha256.mockResolvedValue('SHA');

      mockFsReaddir.mockImplementation((dir: string) => {
        if (dir.includes('download-tmp')) return Promise.resolve(['loongsuite-pilot']);
        return Promise.resolve([]);
      });
      mockFsStat.mockResolvedValue({ isDirectory: () => true });
      mockFsAccess.mockImplementation((p: string) => {
        if (p.includes('postinstall.js')) return Promise.reject(new Error('ENOENT'));
        if (p.includes('package.json')) return Promise.resolve();
        if (p.includes('dist/index.js')) return Promise.resolve();
        if (p.includes('dist/updater/index.js')) return Promise.resolve();
        if (p.includes('collector-daemon.js')) return Promise.resolve();
        if (p.includes('updater-daemon.js')) return Promise.resolve();
        if (p.includes('loongsuite-pilot.')) return Promise.resolve();
        if (p.includes('/runtime/') && p.endsWith(`/${nodeLeaf}`)) return Promise.resolve();
        if (p.includes('.pilot-nm-') && p.endsWith('node_modules')) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsReadFile.mockImplementation((filePath: string) => {
        if (String(filePath).includes('SHASUMS256')) {
          return Promise.resolve(`SHA  ${nodeArchive}\nSHA  ${modulesArchive}\n` as unknown as string);
        }
        if (String(filePath).endsWith('/current')) return Promise.resolve('1.0.1_aaa\n' as unknown as string);
        if (String(filePath).endsWith('/previous')) return Promise.resolve('1.0.0_zzz\n' as unknown as string);
        if (String(filePath).endsWith('/VERSION')) return Promise.resolve('version=1.0.1\ngit_commit=aaa\n' as unknown as string);
        if (String(filePath).includes('/scripts/')) {
          return Promise.resolve(Buffer.from('script') as unknown as string);
        }
        return Promise.reject(new Error('ENOENT'));
      });
      // The managed runtime is adopted, but repointing the CLI wrapper fails.
      mockFsWriteFile.mockImplementation((filePath: string) => {
        if (String(filePath).includes('node-bin.tmp')) {
          return Promise.reject(new Error('EACCES: pin dir not writable'));
        }
        return Promise.resolve();
      });

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      // The pin was attempted (managed runtime adopted)...
      expect(mockFsWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('node-bin.tmp'),
        expect.any(String),
      );
      // ...and because it failed, the previous pointers were restored instead of
      // leaving the new (managed-ABI) version active on the old system-node pin.
      expect(mockFsWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('/current.tmp'),
        '1.0.1_aaa\n',
      );
      expect(mockFsWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('/previous.tmp'),
        '1.0.0_zzz\n',
      );
      // The upgrade must not report success: no collector restart was executed.
      const execCommands = mockExecFile.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(execCommands).not.toContain('npm');
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

    it('syncs Windows CLI as -service.ps1 and removes legacy loongsuite-pilot.ps1', async () => {
      const realPlatform = process.platform;
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
      try {
        expect(buildPaths(tmpDir).loongsuitePilotBin).toMatch(/loongsuite-pilot-service\.ps1$/);

        setupForDownload();
        mockFsAccess.mockImplementation((p: string) => {
          if (p.includes('package.json')) return Promise.resolve();
          if (p.includes('dist/index.js')) return Promise.resolve();
          if (p.includes('dist/updater/index.js')) return Promise.resolve();
          if (p.includes('postinstall.js')) return Promise.reject(new Error('ENOENT'));
          if (p.includes('collector-daemon.js')) return Promise.resolve();
          if (p.includes('updater-daemon.js')) return Promise.resolve();
          if (p.includes('loongsuite-pilot.ps1')) return Promise.resolve();
          return Promise.reject(new Error('ENOENT'));
        });

        const updater = new Updater(makeConfig(), tmpDir);
        await updater.check();

        expect(mockFsCopyFile).toHaveBeenCalledWith(
          expect.stringContaining('/scripts/loongsuite-pilot.ps1'),
          expect.stringMatching(/loongsuite-pilot-service\.ps1\.tmp$/),
        );
        expect(mockFsRm).toHaveBeenCalledWith(
          expect.stringMatching(/[/\\]loongsuite-pilot\.ps1$/),
          expect.objectContaining({ force: true }),
        );
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: realPlatform });
      }
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

    it('removes stale versions after a successful automatic upgrade', async () => {
      setupForDownload();
      let currentReads = 0;
      let previousReads = 0;

      mockFsReadFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('/current')) {
          currentReads++;
          return Promise.resolve(currentReads <= 2 ? '1.0.1_aaa\n' : '1.0.2_bbb\n');
        }
        if (filePath.endsWith('/previous')) {
          previousReads++;
          return Promise.resolve(previousReads === 1 ? '1.0.0_zzz\n' : '1.0.1_aaa\n');
        }
        if (filePath.includes('/versions/1.0.1_aaa/VERSION')) {
          return Promise.resolve('version=1.0.1\ngit_commit=aaa\n');
        }
        if (filePath.includes('/versions/1.0.2_bbb/VERSION')) {
          return Promise.resolve('version=1.0.2\ngit_commit=bbb\n');
        }
        if (filePath.includes('/scripts/')) return Promise.resolve(Buffer.from('script'));
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsReaddir.mockImplementation((dir: string) => {
        if (dir.includes('download-tmp')) return Promise.resolve(['loongsuite-pilot']);
        if (dir.endsWith('/versions')) {
          return Promise.resolve(['1.0.0_old', '1.0.1_aaa', '1.0.2_bbb']);
        }
        return Promise.resolve([]);
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

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      expect(mockFsRm).toHaveBeenCalledWith(
        expect.stringContaining('/versions/1.0.0_old'),
        expect.objectContaining({ recursive: true, force: true }),
      );
      const staleRmIndex = mockFsRm.mock.calls.findIndex(
        ([p]: [string]) => p.includes('/versions/1.0.0_old'),
      );
      const restartCallIndex = mockExecFile.mock.calls.findIndex(
        (call: [string, string[]]) => pilotCommandArgs(call)[0] === 'restart-collector',
      );
      expect(mockFsRm.mock.invocationCallOrder[staleRmIndex]).toBeGreaterThan(
        mockExecFile.mock.invocationCallOrder[restartCallIndex],
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

    it('restarts only the collector because the dashboard shares its lifecycle', async () => {
      setupForDownload();
      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      const commandArgs = mockExecFile.mock.calls
        .map((call: [string, string[]]) => pilotCommandArgs(call))
        .filter(([command]: string[]) => [
          'restart-collector', 'start-collector', 'schedule-updater-restart',
        ].includes(command));
      expect(commandArgs).toContainEqual([
        'restart-collector', '--defer-updater-restart',
      ]);
      expect(commandArgs).toContainEqual([
        'schedule-updater-restart',
      ]);
      expect(commandArgs.flat()).not.toContain('monitor');
    });

    it('recovers a timed-out restart with the start-only command before reporting success', async () => {
      setupForDownload();
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('restart-collector')) {
          const error = new Error('Command timed out');
          (error as any).killed = true;
          return Promise.reject(error);
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });
      const metrics = {
        writeEvent: vi.fn().mockResolvedValue(undefined),
        writeAlarm: vi.fn().mockResolvedValue(undefined),
      };
      const updater = new Updater(makeConfig(), tmpDir);
      updater.setMetrics(metrics as any);

      await updater.check();

      const commands = pilotCommands();
      expect(commands).toContain('restart-collector');
      expect(commands).toContain('start-collector');
      expect(metrics.writeEvent).toHaveBeenCalledWith('collector_restarted', {
        latest_version: '1.0.2',
      });
      expect((updater as any).consecutiveFailures).toBe(0);
    });

    it('does not report restart success or run GC when collector health never appears', async () => {
      setupForDownload();
      mockReadJsonFile.mockImplementation((filePath: string) => {
        if (String(filePath).endsWith('/logs/runtime.json')) return Promise.resolve(null);
        return Promise.resolve({});
      });
      const metrics = {
        writeEvent: vi.fn().mockResolvedValue(undefined),
        writeAlarm: vi.fn().mockResolvedValue(undefined),
      };
      const updater = new Updater(makeConfig(), tmpDir);
      updater.setMetrics(metrics as any);
      const gc = vi.spyOn(updater as any, 'gcOldVersions');

      const checkPromise = updater.check();
      await vi.runAllTimersAsync();
      await checkPromise;

      const commands = pilotCommands();
      expect(commands).toContain('restart-collector');
      expect(commands).toContain('start-collector');
      expect(metrics.writeEvent).not.toHaveBeenCalledWith(
        'collector_restarted', expect.anything(),
      );
      expect(metrics.writeEvent).toHaveBeenCalledWith(
        'update_failure', expect.objectContaining({ consecutive_failures: 1 }),
      );
      expect(gc).not.toHaveBeenCalled();
      expect((updater as any).consecutiveFailures).toBe(1);
    });
  });

  describe('collector health validation', () => {
    it('requires the target version, a fresh heartbeat, and a new PID for rebuilds', () => {
      const updater = new Updater(makeConfig(), tmpDir);
      const now = Date.now();
      const runtime = {
        status: 'active',
        packageVersion: '1.0.2',
        pid: process.pid,
        updatedAt: new Date(now).toISOString(),
      };

      expect((updater as any).collectorHealthFailure(
        { ...runtime, packageVersion: '1.0.1' }, '1.0.2', now, null,
      )).toContain('expected 1.0.2');
      expect((updater as any).collectorHealthFailure(
        { ...runtime, updatedAt: new Date(now - 1).toISOString() }, '1.0.2', now, null,
      )).toBe('runtime record predates restart');
      expect((updater as any).collectorHealthFailure(
        runtime, '1.0.2', now, process.pid,
      )).toBe('collector PID did not change');
      expect((updater as any).collectorHealthFailure(
        runtime, '1.0.2', now, null,
      )).toBe('');
    });
  });

  describe('collector command invocation', () => {
    it('passes Windows commands after -File and defers the updater handoff', async () => {
      const realPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const updater = new Updater(makeConfig(), tmpDir);
        await (updater as any).runCollectorCommand('restart-collector');
        await (updater as any).runCollectorCommand('start-collector');
        await (updater as any).runCollectorCommand('schedule-updater-restart');

        expect(mockExecFile.mock.calls).toHaveLength(3);
        expect(mockExecFile.mock.calls.map((call: [string, string[]]) => call[0]))
          .toEqual(['powershell.exe', 'powershell.exe', 'powershell.exe']);
        expect(mockExecFile.mock.calls.map((call: [string, string[]]) => pilotCommandArgs(call)))
          .toEqual([
            ['restart-collector', '--defer-updater-restart'],
            ['start-collector'],
            ['schedule-updater-restart'],
          ]);
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform });
      }
    });

    it('preserves child-process diagnostics when start-only recovery fails', async () => {
      const restartError = Object.assign(new Error('restart timed out'), {
        stdout: 'restart output',
        killed: true,
        signal: 'SIGTERM',
      });
      const recoveryError = Object.assign(new Error('start failed'), {
        stdout: 'start output',
        stderr: 'permission denied',
        code: 1,
        killed: false,
      });
      mockExecFile.mockRejectedValueOnce(recoveryError);
      const updater = new Updater(makeConfig(), tmpDir);

      await expect((updater as any).startCollectorForRecovery(restartError)).rejects.toThrow(
        /stdout="restart output".*killed=true.*signal=SIGTERM.*stdout="start output".*stderr="permission denied".*code=1.*killed=false/,
      );
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

  describe('gcOldVersions', () => {
    it('preserves current and previous while removing one stale version', async () => {
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

    it('removes only the oldest stale version per cleanup run', async () => {
      mockFsReadFile.mockImplementation((p: string) => {
        if (p.endsWith('/current')) return Promise.resolve('1.0.2_bbb\n');
        if (p.endsWith('/previous')) return Promise.resolve('1.0.1_aaa\n');
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsReaddir.mockImplementation((dir: string) => {
        if (dir.endsWith('/versions')) {
          return Promise.resolve(['1.0.0_old', '0.9.9_older', '1.0.1_aaa', '1.0.2_bbb']);
        }
        return Promise.resolve([]);
      });
      mockFsStat.mockImplementation((p: string) => Promise.resolve({
        isDirectory: () => true,
        mtimeMs: p.includes('0.9.9_older') ? 10 : 20,
      }));

      const updater = new Updater(makeConfig(), tmpDir);
      await (updater as any).gcOldVersions();

      const rmCalls = mockFsRm.mock.calls.filter(
        ([p]: [string]) => p.includes('versions/'),
      );
      expect(rmCalls).toHaveLength(1);
      expect(rmCalls[0][0]).toContain('0.9.9_older');
      expect(rmCalls[0][0]).not.toContain('1.0.0_old');
    });

    it('cleans stale versions during an already up-to-date check', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponseJson(makeManifest({ version: '1.0.2', git_commit: 'bbb' })),
      );
      mockFsReadFile.mockImplementation((p: string) => {
        if (p.endsWith('/current')) return Promise.resolve('1.0.2_bbb\n');
        if (p.endsWith('/previous')) return Promise.resolve('1.0.1_aaa\n');
        if (p.endsWith('/VERSION')) return Promise.resolve('version=1.0.2\ngit_commit=bbb\n');
        return Promise.reject(new Error('ENOENT'));
      });
      mockFsAccess.mockResolvedValue(undefined);
      mockFsReaddir.mockImplementation((dir: string) => {
        if (dir.endsWith('/versions')) {
          return Promise.resolve(['1.0.0_old', '1.0.1_aaa', '1.0.2_bbb']);
        }
        return Promise.resolve([]);
      });
      mockFsStat.mockResolvedValue({ isDirectory: () => true });

      const updater = new Updater(makeConfig(), tmpDir);
      await updater.check();

      expect(mockFsRm).toHaveBeenCalledWith(
        expect.stringContaining('/versions/1.0.0_old'),
        expect.objectContaining({ recursive: true, force: true }),
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('skips cleanup when current pointer is missing', async () => {
      mockFsReadFile.mockRejectedValue(new Error('ENOENT'));
      mockFsReaddir.mockImplementation((dir: string) => {
        if (dir.endsWith('/versions')) {
          return Promise.resolve(['1.0.0_old']);
        }
        return Promise.resolve([]);
      });

      const updater = new Updater(makeConfig(), tmpDir);
      await (updater as any).gcOldVersions();

      const rmCalls = mockFsRm.mock.calls.filter(
        ([p]: [string]) => p.includes('versions/'),
      );
      expect(rmCalls).toHaveLength(0);
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

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../src/core/config-loader.js';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { Updater } from '../../../src/updater/updater.js';
import { resolveHome } from '../../../src/utils/fs-utils.js';
import { getHookRestoreRequestPath, writeHookRestoreRequest } from '../../../src/utils/hook-restore-request.js';
import { redownloadCurrentHookAssets, repairRequestedHookAssets } from '../../../src/updater/hook-asset-repair.js';

const stagingOverride = vi.hoisted(() => ({
  dir: '',
  duringDeploy: null as null | (() => Promise<void>),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const makeTemp = actual.mkdtemp as (prefix: string, options?: unknown) => Promise<string>;
  const mkdtemp = (async (prefix: string, options?: unknown) => {
    if (stagingOverride.dir) return stagingOverride.dir;
    return makeTemp(prefix, options);
  }) as typeof actual.mkdtemp;
  const chmod = (async (target: string, mode: string | number) => {
    await actual.chmod(target, mode);
    if (stagingOverride.duringDeploy && String(target).endsWith('claude-code-loongsuite-pilot-hook.sh')) {
      const hook = stagingOverride.duringDeploy;
      stagingOverride.duringDeploy = null;
      await hook();
    }
  }) as typeof actual.chmod;
  return { ...actual, mkdtemp, chmod };
});

vi.mock('../../../src/core/hook-asset-manifest.js', () => ({
  HOOK_ASSET_MANIFEST: {
    'claude-code-loongsuite-pilot-hook.sh': createHash('sha256').update('#!/bin/sh\necho ok\n').digest('hex'),
  },
}));

const execFileAsync = promisify(execFile);
const scriptName = 'claude-code-loongsuite-pilot-hook.sh';
const scriptText = '#!/bin/sh\necho ok\n';

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('hook asset repair', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    stagingOverride.duringDeploy = null;
    vi.unstubAllEnvs();
    await cleanupTempDir(tmpDir);
  });

  async function install(version = 'v1'): Promise<{ cacheDir: string; dataDir: string; pilotDir: string }> {
    const cacheDir = path.join(tmpDir, 'cache');
    const dataDir = path.join(tmpDir, 'data');
    const pilotDir = path.join(cacheDir, 'versions', version);
    await fs.mkdir(path.join(pilotDir, 'assets', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(pilotDir, 'assets', 'hooks', scriptName), scriptText, { mode: 0o755 });
    await fs.writeFile(path.join(pilotDir, 'VERSION'), 'version=1.0.0\ngit_commit=abc\n');
    await fs.writeFile(path.join(cacheDir, 'current'), `${version}\n`);
    return { cacheDir, dataDir, pilotDir };
  }

  async function request(cacheDir: string, pilotDir: string, paths: string[]): Promise<void> {
    await writeHookRestoreRequest(cacheDir, {
      schema: 1,
      pilotDir,
      paths,
    });
  }

  it('copies the install file onto the deployed path and clears the request', async () => {
    const { cacheDir, dataDir, pilotDir } = await install();
    const deployed = path.join(dataDir, 'hooks', scriptName);
    await fs.mkdir(path.dirname(deployed), { recursive: true });
    await fs.writeFile(deployed, 'tampered\n');
    await request(cacheDir, pilotDir, [scriptName]);

    await repairRequestedHookAssets({
      cacheDir,
      dataDir,
      expected: { [scriptName]: hashText(scriptText) },
    });

    expect(await fs.readFile(deployed, 'utf8')).toBe(scriptText);
    await expect(fs.readFile(getHookRestoreRequestPath(cacheDir))).rejects.toThrow();
  });

  it('keeps a request written while the claimed copy is being restored', async () => {
    const { cacheDir, dataDir, pilotDir } = await install();
    const deployed = path.join(dataDir, 'hooks', scriptName);
    await fs.mkdir(path.dirname(deployed), { recursive: true });
    await fs.writeFile(deployed, 'tampered\n');
    await request(cacheDir, pilotDir, [scriptName]);
    stagingOverride.duringDeploy = () => request(cacheDir, pilotDir, ['other.sh']);

    await repairRequestedHookAssets({
      cacheDir,
      dataDir,
      expected: { [scriptName]: hashText(scriptText) },
    });

    expect(await fs.readFile(deployed, 'utf8')).toBe(scriptText);
    expect(JSON.parse(await fs.readFile(getHookRestoreRequestPath(cacheDir), 'utf8')).paths).toEqual(['other.sh']);
    await expect(fs.stat(path.join(cacheDir, `hook-restore-request.${process.pid}.json`))).rejects.toThrow();
  });

  async function deployedRequest(dataDir: string): Promise<{ cacheDir: string; pilotDir: string }> {
    const cacheDir = path.join(tmpDir, 'cache');
    const pilotDir = path.join(cacheDir, 'versions', 'v1');
    await fs.mkdir(path.join(pilotDir, 'assets', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(pilotDir, 'assets', 'hooks', scriptName), scriptText, { mode: 0o755 });
    await fs.writeFile(path.join(cacheDir, 'current'), 'v1\n');
    await fs.mkdir(path.join(dataDir, 'hooks'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'hooks', scriptName), 'tampered\n');
    await fs.mkdir(path.join(cacheDir, 'hooks'), { recursive: true });
    await fs.writeFile(path.join(cacheDir, 'hooks', 'sentinel.txt'), 'cache\n');
    await request(cacheDir, pilotDir, [scriptName]);
    vi.stubEnv('LOONGSUITE_PILOT_CACHE_DIR', cacheDir);
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', path.join(tmpDir, 'config.json'));
    return { cacheDir, pilotDir };
  }

  async function defaultScript(): Promise<string | null> {
    try {
      return await fs.readFile(path.join(os.homedir(), '.loongsuite-pilot', 'hooks', scriptName), 'utf8');
    } catch {
      return null;
    }
  }

  it('restores the config-file dataDir and leaves the default directory alone', async () => {
    const dataDir = path.join(tmpDir, 'from-config');
    await fs.writeFile(path.join(tmpDir, 'config.json'), JSON.stringify({ dataDir }), 'utf8');
    const { cacheDir } = await deployedRequest(dataDir);
    vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', '');
    const defaultBefore = await defaultScript();

    const updater = new Updater({ enabled: false, checkIntervalMs: 60_000, tamperProtection: true });
    await updater.check();

    expect(resolveHome((await loadConfig()).dataDir)).toBe(dataDir);
    expect(await fs.readFile(path.join(dataDir, 'hooks', scriptName), 'utf8')).toBe(scriptText);
    expect(await fs.readFile(path.join(cacheDir, 'hooks', 'sentinel.txt'), 'utf8')).toBe('cache\n');
    expect(await defaultScript()).toBe(defaultBefore);
    await expect(fs.readFile(getHookRestoreRequestPath(cacheDir))).rejects.toThrow();
  });

  it('lets LOONGSUITE_PILOT_DATA_DIR win over the config-file dataDir', async () => {
    const fromConfig = path.join(tmpDir, 'from-config');
    const fromEnv = path.join(tmpDir, 'from-env');
    await fs.writeFile(path.join(tmpDir, 'config.json'), JSON.stringify({ dataDir: fromConfig }), 'utf8');
    const { cacheDir } = await deployedRequest(fromEnv);
    vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', fromEnv);

    const updater = new Updater({ enabled: false, checkIntervalMs: 60_000, tamperProtection: true });
    await updater.check();

    expect(resolveHome((await loadConfig()).dataDir)).toBe(fromEnv);
    expect(await fs.readFile(path.join(fromEnv, 'hooks', scriptName), 'utf8')).toBe(scriptText);
    await expect(fs.stat(fromConfig)).rejects.toThrow();
    expect(await fs.readFile(path.join(cacheDir, 'hooks', 'sentinel.txt'), 'utf8')).toBe('cache\n');
  });

  it('drops a request whose version is no longer current', async () => {
    const { cacheDir, dataDir, pilotDir } = await install();
    await fs.mkdir(path.join(cacheDir, 'versions', 'v2'), { recursive: true });
    await fs.writeFile(path.join(cacheDir, 'current'), 'v2\n');
    const deployed = path.join(dataDir, 'hooks', scriptName);
    await fs.mkdir(path.dirname(deployed), { recursive: true });
    await fs.writeFile(deployed, 'tampered\n');
    await request(cacheDir, pilotDir, [scriptName]);

    await repairRequestedHookAssets({
      cacheDir,
      dataDir,
      expected: { [scriptName]: hashText(scriptText) },
    });

    expect(await fs.readFile(deployed, 'utf8')).toBe('tampered\n');
    await expect(fs.readFile(getHookRestoreRequestPath(cacheDir))).rejects.toThrow();
  });

  it('leaves the request in place while an upgrade marker is fresh', async () => {
    const { cacheDir, dataDir, pilotDir } = await install();
    await fs.writeFile(path.join(cacheDir, 'hook-upgrade-in-progress'), `${Date.now()}\n`);
    const deployed = path.join(dataDir, 'hooks', scriptName);
    await fs.mkdir(path.dirname(deployed), { recursive: true });
    await fs.writeFile(deployed, 'tampered\n');
    await request(cacheDir, pilotDir, [scriptName]);

    await repairRequestedHookAssets({
      cacheDir,
      dataDir,
      expected: { [scriptName]: hashText(scriptText) },
    });

    expect(await fs.readFile(deployed, 'utf8')).toBe('tampered\n');
    expect(JSON.parse(await fs.readFile(getHookRestoreRequestPath(cacheDir), 'utf8')).paths).toContain(scriptName);
  });

  it('downloads when the install copy does not match', async () => {
    const { cacheDir, dataDir, pilotDir } = await install();
    await fs.writeFile(path.join(pilotDir, 'assets', 'hooks', scriptName), 'changed-asset\n');
    const deployed = path.join(dataDir, 'hooks', scriptName);
    await fs.mkdir(path.dirname(deployed), { recursive: true });
    await fs.writeFile(deployed, 'tampered\n');
    await request(cacheDir, pilotDir, [scriptName]);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await repairRequestedHookAssets({
        cacheDir,
        dataDir,
        manifestUrl: 'https://example.com/latest.json',
        expected: { [scriptName]: hashText(scriptText) },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalled();
    expect(await fs.readFile(deployed, 'utf8')).toBe('tampered\n');
    expect(JSON.parse(await fs.readFile(getHookRestoreRequestPath(cacheDir), 'utf8')).paths).toContain(scriptName);
  });

  it('downloads when the install copy is a directory', async () => {
    const { cacheDir, dataDir, pilotDir } = await install();
    const asset = path.join(pilotDir, 'assets', 'hooks', scriptName);
    await fs.rm(asset);
    await fs.mkdir(asset);
    const deployed = path.join(dataDir, 'hooks', scriptName);
    await fs.mkdir(path.dirname(deployed), { recursive: true });
    await fs.writeFile(deployed, 'tampered\n');
    await request(cacheDir, pilotDir, [scriptName]);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await repairRequestedHookAssets({
        cacheDir,
        dataDir,
        manifestUrl: 'https://example.com/latest.json',
        expected: { [scriptName]: hashText(scriptText) },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalled();
    expect((await fs.lstat(asset)).isDirectory()).toBe(true);
    expect(await fs.readFile(deployed, 'utf8')).toBe('tampered\n');
    expect(JSON.parse(await fs.readFile(getHookRestoreRequestPath(cacheDir), 'utf8')).paths).toContain(scriptName);
  });

  it('does not download when the install copy sits under a symlink', async () => {
    const { cacheDir, dataDir, pilotDir } = await install();
    const relativePath = 'shared/common.sh';
    const realDir = path.join(pilotDir, 'real-shared');
    await fs.mkdir(realDir);
    await fs.writeFile(path.join(realDir, 'common.sh'), 'changed\n');
    await fs.symlink(realDir, path.join(pilotDir, 'assets', 'hooks', 'shared'));
    const deployed = path.join(dataDir, 'hooks', relativePath);
    await fs.mkdir(path.dirname(deployed), { recursive: true });
    await fs.writeFile(deployed, 'tampered\n');
    await request(cacheDir, pilotDir, [relativePath]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await repairRequestedHookAssets({
        cacheDir,
        dataDir,
        manifestUrl: 'https://example.com/latest.json',
        expected: { [relativePath]: hashText(scriptText) },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fs.readFile(deployed, 'utf8')).toBe('tampered\n');
    expect(await fs.readFile(path.join(realDir, 'common.sh'), 'utf8')).toBe('changed\n');
    expect(JSON.parse(await fs.readFile(getHookRestoreRequestPath(cacheDir), 'utf8')).paths).toContain(relativePath);
  });

  it('downloads when the install copy is missing', async () => {
    const { cacheDir, dataDir, pilotDir } = await install();
    await fs.rm(path.join(pilotDir, 'assets', 'hooks', scriptName));
    const deployed = path.join(dataDir, 'hooks', scriptName);
    await fs.mkdir(path.dirname(deployed), { recursive: true });
    await fs.writeFile(deployed, 'tampered\n');
    await request(cacheDir, pilotDir, [scriptName]);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await repairRequestedHookAssets({
        cacheDir,
        dataDir,
        manifestUrl: 'https://example.com/latest.json',
        expected: { [scriptName]: hashText(scriptText) },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(getHookRestoreRequestPath(cacheDir), 'utf8')).paths).toContain(scriptName);
  });

  it('leaves the deployed file when the install copy does not match and no package is available', async () => {
    const { cacheDir, dataDir, pilotDir } = await install();
    const asset = path.join(pilotDir, 'assets', 'hooks', scriptName);
    await fs.writeFile(asset, 'changed-asset\n');
    const deployed = path.join(dataDir, 'hooks', scriptName);
    await fs.mkdir(path.dirname(deployed), { recursive: true });
    await fs.writeFile(deployed, 'tampered\n');
    await request(cacheDir, pilotDir, [scriptName]);

    await repairRequestedHookAssets({
      cacheDir,
      dataDir,
      expected: { [scriptName]: hashText(scriptText) },
    });

    expect(await fs.readFile(deployed, 'utf8')).toBe('tampered\n');
    expect(await fs.readFile(asset, 'utf8')).toBe('changed-asset\n');
    expect(JSON.parse(await fs.readFile(getHookRestoreRequestPath(cacheDir), 'utf8')).paths).toContain(scriptName);
  });

  it('leaves the request when current cannot be read', async () => {
    const { cacheDir, dataDir, pilotDir } = await install();
    await fs.rm(path.join(cacheDir, 'current'));
    const deployed = path.join(dataDir, 'hooks', scriptName);
    await fs.mkdir(path.dirname(deployed), { recursive: true });
    await fs.writeFile(deployed, 'tampered\n');
    await request(cacheDir, pilotDir, [scriptName]);

    await repairRequestedHookAssets({
      cacheDir,
      dataDir,
      expected: { [scriptName]: hashText(scriptText) },
    });

    expect(await fs.readFile(deployed, 'utf8')).toBe('tampered\n');
    expect(JSON.parse(await fs.readFile(getHookRestoreRequestPath(cacheDir), 'utf8')).paths).toContain(scriptName);
  });

  it('replaces a deployed directory with the script and restores the other path', async () => {
    const { cacheDir, dataDir, pilotDir } = await install();
    const other = 'shared/common.sh';
    const otherText = '#!/bin/sh\necho other\n';
    await fs.mkdir(path.join(pilotDir, 'assets', 'hooks', 'shared'), { recursive: true });
    await fs.writeFile(path.join(pilotDir, 'assets', 'hooks', other), otherText, { mode: 0o755 });
    const deployed = path.join(dataDir, 'hooks', scriptName);
    await fs.mkdir(deployed, { recursive: true });
    await fs.writeFile(path.join(deployed, 'nested.txt'), 'inside\n');
    const sibling = path.join(dataDir, 'hooks', 'sibling.txt');
    await fs.writeFile(sibling, 'stay\n');
    const otherDeployed = path.join(dataDir, 'hooks', other);
    await fs.mkdir(path.dirname(otherDeployed), { recursive: true });
    await fs.writeFile(otherDeployed, 'tampered\n');
    await request(cacheDir, pilotDir, [scriptName, other]);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await repairRequestedHookAssets({
        cacheDir,
        dataDir,
        manifestUrl: 'https://example.com/latest.json',
        expected: {
          [scriptName]: hashText(scriptText),
          [other]: hashText(otherText),
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fs.readFile(otherDeployed, 'utf8')).toBe(otherText);
    expect(await fs.readFile(deployed, 'utf8')).toBe(scriptText);
    expect((await fs.lstat(deployed)).isFile()).toBe(true);
    expect(await fs.readFile(sibling, 'utf8')).toBe('stay\n');
    await expect(fs.readFile(getHookRestoreRequestPath(cacheDir))).rejects.toThrow();
  });
});

describe('redownloadCurrentHookAssets', () => {
  let tmpDir: string;

  afterEach(async () => {
    vi.unstubAllGlobals();
    stagingOverride.dir = '';
    if (tmpDir) await cleanupTempDir(tmpDir);
  });

  it('replaces hook originals from the running release and does not mark an upgrade', async () => {
    tmpDir = await createTempDir('hook-redownload-');
    const pilotDir = path.join(tmpDir, 'pilot');
    const asset = path.join(pilotDir, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(path.dirname(asset), { recursive: true });
    await fs.writeFile(asset, 'tampered\n');
    await fs.writeFile(path.join(pilotDir, 'VERSION'), 'version=1.2.0\ngit_commit=abc\n');

    const pkg = path.join(tmpDir, 'src', 'pkg');
    const packed = path.join(pkg, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(path.dirname(packed), { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), '{}\n');
    await fs.writeFile(packed, '#!/bin/sh\necho ok\n');
    const tarball = path.join(tmpDir, 'package.tar.gz');
    await execFileAsync('tar', ['-czf', tarball, '-C', path.dirname(pkg), 'pkg']);
    const sha256 = createHash('sha256').update(await fs.readFile(tarball)).digest('hex');
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('latest.json')) {
        return new Response(JSON.stringify({
          version: '1.2.0',
          git_commit: 'abc',
          package_url: 'https://example.test/package.tar.gz',
          sha256,
        }), { status: 200 });
      }
      return new Response(new Uint8Array(await fs.readFile(tarball)));
    });

    const good = '#!/bin/sh\necho ok\n';
    const ok = await redownloadCurrentHookAssets({
      pilotDir,
      manifestUrl: 'https://example.test/latest.json',
      expected: { 'hook.sh': createHash('sha256').update(good).digest('hex') },
    });

    expect(ok).toBe(true);
    expect(calls).toEqual([
      'https://example.test/latest.json',
      'https://example.test/package.tar.gz',
    ]);
    expect(await fs.readFile(asset, 'utf8')).toBe('#!/bin/sh\necho ok\n');
  });

  it('replaces an install directory with the script from the running release', async () => {
    tmpDir = await createTempDir('hook-redownload-');
    const pilotDir = path.join(tmpDir, 'pilot');
    const asset = path.join(pilotDir, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(asset, { recursive: true });
    await fs.writeFile(path.join(asset, 'nested.txt'), 'inside\n');
    const sibling = path.join(pilotDir, 'assets', 'hooks', 'sibling.txt');
    await fs.writeFile(sibling, 'stay\n');
    await fs.writeFile(path.join(pilotDir, 'VERSION'), 'version=1.2.0\ngit_commit=abc\n');

    const pkg = path.join(tmpDir, 'src', 'pkg');
    const packed = path.join(pkg, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(path.dirname(packed), { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), '{}\n');
    const good = '#!/bin/sh\necho ok\n';
    await fs.writeFile(packed, good);
    const tarball = path.join(tmpDir, 'package.tar.gz');
    await execFileAsync('tar', ['-czf', tarball, '-C', path.dirname(pkg), 'pkg']);
    const sha256 = createHash('sha256').update(await fs.readFile(tarball)).digest('hex');
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('latest.json')) {
        return new Response(JSON.stringify({
          version: '1.2.0',
          git_commit: 'abc',
          package_url: 'https://example.test/package.tar.gz',
          sha256,
        }), { status: 200 });
      }
      return new Response(new Uint8Array(await fs.readFile(tarball)));
    });

    const ok = await redownloadCurrentHookAssets({
      pilotDir,
      manifestUrl: 'https://example.test/latest.json',
      expected: { 'hook.sh': createHash('sha256').update(good).digest('hex') },
    });

    expect(ok).toBe(true);
    expect(await fs.readFile(asset, 'utf8')).toBe(good);
    expect((await fs.lstat(asset)).isFile()).toBe(true);
    expect(await fs.readFile(sibling, 'utf8')).toBe('stay\n');
  });

  it('replaces a symlinked install hooks directory with the downloaded scripts', async () => {
    tmpDir = await createTempDir('hook-redownload-');
    const pilotDir = path.join(tmpDir, 'pilot');
    const linked = path.join(tmpDir, 'linked-hooks');
    const linkedScript = path.join(linked, 'hook.sh');
    await fs.mkdir(linkedScript, { recursive: true });
    await fs.writeFile(path.join(linkedScript, 'notes.txt'), 'keep\n');
    await fs.mkdir(path.join(pilotDir, 'assets'), { recursive: true });
    await fs.symlink(linked, path.join(pilotDir, 'assets', 'hooks'));
    await fs.writeFile(path.join(pilotDir, 'VERSION'), 'version=1.2.0\ngit_commit=abc\n');

    const pkg = path.join(tmpDir, 'src', 'pkg');
    const packed = path.join(pkg, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(path.dirname(packed), { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), '{}\n');
    const good = '#!/bin/sh\necho ok\n';
    await fs.writeFile(packed, good);
    const tarball = path.join(tmpDir, 'package.tar.gz');
    await execFileAsync('tar', ['-czf', tarball, '-C', path.dirname(pkg), 'pkg']);
    const sha256 = createHash('sha256').update(await fs.readFile(tarball)).digest('hex');
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('latest.json')) {
        return new Response(JSON.stringify({
          version: '1.2.0',
          git_commit: 'abc',
          package_url: 'https://example.test/package.tar.gz',
          sha256,
        }), { status: 200 });
      }
      return new Response(new Uint8Array(await fs.readFile(tarball)));
    });

    const hooksRoot = path.join(pilotDir, 'assets', 'hooks');
    const ok = await redownloadCurrentHookAssets({
      pilotDir,
      manifestUrl: 'https://example.test/latest.json',
      expected: { 'hook.sh': createHash('sha256').update(good).digest('hex') },
    });

    expect(ok).toBe(true);
    expect((await fs.lstat(hooksRoot)).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(hooksRoot)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(hooksRoot, 'hook.sh'), 'utf8')).toBe(good);
    expect(await fs.readFile(path.join(linkedScript, 'notes.txt'), 'utf8')).toBe('keep\n');
    expect((await fs.lstat(linkedScript)).isDirectory()).toBe(true);
  });

  it('does not download a different version over the running tree', async () => {
    tmpDir = await createTempDir('hook-redownload-');
    const pilotDir = path.join(tmpDir, 'pilot');
    const asset = path.join(pilotDir, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(path.dirname(asset), { recursive: true });
    await fs.writeFile(asset, 'tampered\n');
    await fs.writeFile(path.join(pilotDir, 'VERSION'), 'version=1.2.0\ngit_commit=abc\n');
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        version: '9.9.9',
        git_commit: 'zzz',
        package_url: 'https://example.test/package.tar.gz',
      }), { status: 200 });
    });

    const ok = await redownloadCurrentHookAssets({
      pilotDir,
      manifestUrl: 'https://example.test/latest.json',
      expected: { 'hook.sh': createHash('sha256').update('#!/bin/sh\necho ok\n').digest('hex') },
    });

    expect(ok).toBe(false);
    expect(calls).toEqual(['https://example.test/latest.json']);
    expect(await fs.readFile(asset, 'utf8')).toBe('tampered\n');
  });

  it('fails when a downloaded hook hash does not match this version', async () => {
    tmpDir = await createTempDir('hook-redownload-');
    const pilotDir = path.join(tmpDir, 'pilot');
    const asset = path.join(pilotDir, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(path.dirname(asset), { recursive: true });
    await fs.writeFile(asset, 'tampered\n');
    await fs.writeFile(path.join(pilotDir, 'VERSION'), 'version=1.2.0\ngit_commit=abc\n');

    const pkg = path.join(tmpDir, 'src', 'pkg');
    await fs.mkdir(path.join(pkg, 'assets', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), '{}\n');
    await fs.writeFile(path.join(pkg, 'assets', 'hooks', 'hook.sh'), 'still-wrong\n');
    const tarball = path.join(tmpDir, 'package.tar.gz');
    await execFileAsync('tar', ['-czf', tarball, '-C', path.dirname(pkg), 'pkg']);
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('latest.json')) {
        return new Response(JSON.stringify({
          version: '1.2.0',
          git_commit: 'abc',
          package_url: 'https://example.test/package.tar.gz',
        }), { status: 200 });
      }
      return new Response(new Uint8Array(await fs.readFile(tarball)));
    });

    const ok = await redownloadCurrentHookAssets({
      pilotDir,
      manifestUrl: 'https://example.test/latest.json',
      expected: { 'hook.sh': createHash('sha256').update('#!/bin/sh\necho ok\n').digest('hex') },
    });

    expect(ok).toBe(false);
    expect(await fs.readFile(asset, 'utf8')).toBe('tampered\n');
  });

  it('does not replace hooks when the package sha256 does not match', async () => {
    tmpDir = await createTempDir('hook-redownload-');
    const pilotDir = path.join(tmpDir, 'pilot');
    const asset = path.join(pilotDir, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(path.dirname(asset), { recursive: true });
    await fs.writeFile(asset, 'tampered\n');
    await fs.writeFile(path.join(pilotDir, 'VERSION'), 'version=1.2.0\ngit_commit=abc\n');

    const pkg = path.join(tmpDir, 'src', 'pkg');
    await fs.mkdir(path.join(pkg, 'assets', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), '{}\n');
    await fs.writeFile(path.join(pkg, 'assets', 'hooks', 'hook.sh'), '#!/bin/sh\necho ok\n');
    const tarball = path.join(tmpDir, 'package.tar.gz');
    await execFileAsync('tar', ['-czf', tarball, '-C', path.dirname(pkg), 'pkg']);
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('latest.json')) {
        return new Response(JSON.stringify({
          version: '1.2.0',
          git_commit: 'abc',
          package_url: 'https://example.test/package.tar.gz',
          sha256: '0'.repeat(64),
        }), { status: 200 });
      }
      return new Response(new Uint8Array(await fs.readFile(tarball)));
    });

    const ok = await redownloadCurrentHookAssets({
      pilotDir,
      manifestUrl: 'https://example.test/latest.json',
      expected: { 'hook.sh': createHash('sha256').update('#!/bin/sh\necho ok\n').digest('hex') },
    });

    expect(ok).toBe(false);
    expect(await fs.readFile(asset, 'utf8')).toBe('tampered\n');
  });

  it('stops a download that exceeds the time limit', async () => {
    tmpDir = await createTempDir('hook-redownload-');
    const pilotDir = path.join(tmpDir, 'pilot');
    const asset = path.join(pilotDir, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(path.dirname(asset), { recursive: true });
    await fs.writeFile(asset, 'tampered\n');
    await fs.writeFile(path.join(pilotDir, 'VERSION'), 'version=1.2.0\ngit_commit=abc\n');
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (String(url).endsWith('latest.json')) {
        return Promise.resolve(new Response(JSON.stringify({
          version: '1.2.0',
          git_commit: 'abc',
          package_url: 'https://example.test/package.tar.gz',
        }), { status: 200 }));
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('timeout')));
      });
    });

    const ok = await redownloadCurrentHookAssets({
      pilotDir,
      manifestUrl: 'https://example.test/latest.json',
      expected: { 'hook.sh': 'abc' },
      downloadTimeoutMs: 20,
    });

    expect(ok).toBe(false);
    expect(await fs.readFile(asset, 'utf8')).toBe('tampered\n');
  });

  it('downloads the nested canary package that matches the running release', async () => {
    tmpDir = await createTempDir('hook-redownload-');
    const pilotDir = path.join(tmpDir, 'pilot');
    const asset = path.join(pilotDir, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(path.dirname(asset), { recursive: true });
    await fs.writeFile(asset, 'tampered\n');
    await fs.writeFile(path.join(pilotDir, 'VERSION'), 'version=1.5.3\ngit_commit=canary123\n');

    const good = '#!/bin/sh\necho canary\n';
    const canaryTar = await packHook(tmpDir, 'canary-pkg', good);
    const stableTar = await packHook(tmpDir, 'stable-pkg', '#!/bin/sh\necho stable\n');
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('latest.json')) {
        return new Response(JSON.stringify({
          version: '1.5.2',
          git_commit: 'stable123',
          package_url: 'https://example.test/stable.tar.gz',
          sha256: createHash('sha256').update(await fs.readFile(stableTar)).digest('hex'),
          canary: {
            version: '1.5.3',
            git_commit: 'canary123',
            package_url: 'https://example.test/canary.tar.gz',
            sha256: createHash('sha256').update(await fs.readFile(canaryTar)).digest('hex'),
          },
        }), { status: 200 });
      }
      const file = String(url).endsWith('canary.tar.gz') ? canaryTar : stableTar;
      return new Response(new Uint8Array(await fs.readFile(file)));
    });

    const ok = await redownloadCurrentHookAssets({
      pilotDir,
      manifestUrl: 'https://example.test/latest.json',
      expected: { 'hook.sh': createHash('sha256').update(good).digest('hex') },
    });

    expect(ok).toBe(true);
    expect(calls).toEqual([
      'https://example.test/latest.json',
      'https://example.test/canary.tar.gz',
    ]);
    expect(await fs.readFile(asset, 'utf8')).toBe(good);
  });

  it('does not download when neither the stable nor the canary entry matches', async () => {
    tmpDir = await createTempDir('hook-redownload-');
    const pilotDir = path.join(tmpDir, 'pilot');
    const asset = path.join(pilotDir, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(path.dirname(asset), { recursive: true });
    await fs.writeFile(asset, 'tampered\n');
    await fs.writeFile(path.join(pilotDir, 'VERSION'), 'version=1.5.3\ngit_commit=canary123\n');
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        version: '1.5.2',
        git_commit: 'stable123',
        package_url: 'https://example.test/stable.tar.gz',
        canary: {
          version: '1.5.4',
          git_commit: 'canary999',
          package_url: 'https://example.test/canary.tar.gz',
        },
      }), { status: 200 });
    });

    const ok = await redownloadCurrentHookAssets({
      pilotDir,
      manifestUrl: 'https://example.test/latest.json',
      expected: { 'hook.sh': createHash('sha256').update('#!/bin/sh\necho ok\n').digest('hex') },
    });

    expect(ok).toBe(false);
    expect(calls).toEqual(['https://example.test/latest.json']);
    expect(await fs.readFile(asset, 'utf8')).toBe('tampered\n');
  });

  it('does not follow a package.tar.gz symlink planted in the staging directory', async () => {
    tmpDir = await createTempDir('hook-redownload-');
    const pilotDir = path.join(tmpDir, 'pilot');
    const asset = path.join(pilotDir, 'assets', 'hooks', 'hook.sh');
    await fs.mkdir(path.dirname(asset), { recursive: true });
    await fs.writeFile(asset, 'tampered\n');
    await fs.writeFile(path.join(pilotDir, 'VERSION'), 'version=1.2.0\ngit_commit=abc\n');
    const staging = await fs.mkdtemp(path.join(tmpDir, 'staging-'));
    const sentinel = path.join(tmpDir, 'sentinel');
    await fs.writeFile(sentinel, 'keep-me');
    await fs.symlink(sentinel, path.join(staging, 'package.tar.gz'));
    stagingOverride.dir = staging;
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('latest.json')) {
        return new Response(JSON.stringify({
          version: '1.2.0',
          git_commit: 'abc',
          package_url: 'https://example.test/package.tar.gz',
        }), { status: 200 });
      }
      return new Response(new Uint8Array(Buffer.from('not-a-tar')));
    });

    const ok = await redownloadCurrentHookAssets({
      pilotDir,
      manifestUrl: 'https://example.test/latest.json',
      expected: { 'hook.sh': createHash('sha256').update('#!/bin/sh\necho ok\n').digest('hex') },
    });

    expect(ok).toBe(false);
    expect(await fs.readFile(sentinel, 'utf8')).toBe('keep-me');
  });
});

async function packHook(root: string, name: string, script: string): Promise<string> {
  const pkg = path.join(root, 'src', name);
  await fs.mkdir(path.join(pkg, 'assets', 'hooks'), { recursive: true });
  await fs.writeFile(path.join(pkg, 'package.json'), '{}\n');
  await fs.writeFile(path.join(pkg, 'assets', 'hooks', 'hook.sh'), script);
  const tarball = path.join(root, `${name}.tar.gz`);
  await execFileAsync('tar', ['-czf', tarball, '-C', path.dirname(pkg), name]);
  return tarball;
}

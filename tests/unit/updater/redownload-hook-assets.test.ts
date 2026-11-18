import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { redownloadCurrentHookAssets } from '../../../src/updater/redownload-hook-assets.js';

const execFileAsync = promisify(execFile);

describe('redownloadCurrentHookAssets', () => {
  let tmpDir: string;

  afterEach(async () => {
    vi.unstubAllGlobals();
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
});

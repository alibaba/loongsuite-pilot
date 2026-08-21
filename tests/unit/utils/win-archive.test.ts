/**
 * Node-side counterpart of tests/unit/scripts/ps1-nonascii-windows-paths.test.mjs.
 *
 * tar.exe re-encodes its arguments through the machine's ANSI codepage, so a path under
 * C:\Users\<CJK name> reaches it as C:\Users\???\... and the extraction fails. Measured
 * from node on a CJK-profile box: child_process passed the path with 4 non-ASCII chars
 * and 0 '?', and tar still reported "Failed to open 'C:\Users\??.HOST\...'". Every tar
 * call in the updater must therefore stage under an ASCII root and go through
 * extractTarGz (which also dodges Git-for-Windows' GNU tar), not through a bare
 * execFile('tar', ...). The ratchet below pins that; the unit tests pin the helper.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAsciiPath, makeTarStagingDir, replaceDirWith } from '../../../src/utils/win-archive.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('isAsciiPath', () => {
  it('accepts printable ASCII and rejects anything else', () => {
    expect(isAsciiPath('C:\\Users\\lee\\.loongsuite-pilot')).toBe(true);
    expect(isAsciiPath('/tmp/pilot-node-modules')).toBe(true);
    expect(isAsciiPath('C:\\Users\\张三\\.loongsuite-pilot')).toBe(false);
    expect(isAsciiPath('C:\\Users\\太业.IZ1QMOR6W7C4BKZ\\versions')).toBe(false);
    // A tab is unrepresentable in a command line the same way: not printable ASCII.
    expect(isAsciiPath('C:\\a\tb')).toBe(false);
  });
});

describe('makeTarStagingDir', () => {
  it('keeps an ASCII preference as-is, so the caller can still rename within one volume', async () => {
    const preferred = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-ascii-')), 'download-tmp');
    try {
      const dir = await makeTarStagingDir(preferred);
      expect(dir).toBe(preferred);
      expect((await fs.stat(dir)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(path.dirname(preferred), { recursive: true, force: true });
    }
  });

  it('redirects a non-ASCII preference to an ASCII root', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-cjk-'));
    const preferred = path.join(base, '李四', 'download-tmp');
    let dir = '';
    try {
      dir = await makeTarStagingDir(preferred);
      expect(dir).not.toBe(preferred);
      expect(isAsciiPath(dir)).toBe(true);
      expect((await fs.stat(dir)).isDirectory()).toBe(true);
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe('replaceDirWith', () => {
  it('replaces an existing destination with the staged tree', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-replace-'));
    try {
      const staged = path.join(base, 'stage', 'node_modules');
      await fs.mkdir(staged, { recursive: true });
      await fs.writeFile(path.join(staged, 'new.txt'), 'new');

      const dest = path.join(base, 'node_modules');
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, 'stale.txt'), 'stale');

      await replaceDirWith(staged, dest);

      expect(await fs.readFile(path.join(dest, 'new.txt'), 'utf8')).toBe('new');
      await expect(fs.access(path.join(dest, 'stale.txt'))).rejects.toThrow();
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe('updater tar ratchet', () => {
  it('routes every tar call through extractTarGz', async () => {
    const src = await fs.readFile(path.join(repoRoot, 'src/updater/updater.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

    // A bare 'tar' resolves through PATH: on Windows that can be Git's GNU tar, which
    // reads the colon in -f C:\... as rsh host:path syntax.
    expect(code).not.toMatch(/execFileAsync\(\s*'tar'/);
    expect(code).not.toMatch(/spawn(?:Sync)?\(\s*'tar'/);

    const uses = code.match(/extractTarGz\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it('stages tar input under an ASCII root and never deletes a live version dir in place', async () => {
    const src = await fs.readFile(path.join(repoRoot, 'src/updater/updater.ts'), 'utf8');

    // download-tmp and the prebuilt node_modules scratch dir are the two tar inputs.
    const staged = src.match(/makeTarStagingDir\(/g) ?? [];
    expect(staged.length).toBeGreaterThanOrEqual(2);

    // Redeploying the same version must land in a suffixed sibling instead of
    // rm -rf'ing the directory `current` still points at (phase=module_load crashes).
    expect(src).not.toMatch(/fs\.rm\(targetDir,[\s\S]{0,60}\)\s*;\s*\n\s*await fs\.rename\(stagingDir, targetDir\)/);
    expect(src).toMatch(/dirName = `\$\{baseDirName\}_\$\{suffix\}`/);
  });
});

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const resolver = path.resolve('assets/hooks/shared/node-runtime.sh');

describe.runIf(process.platform !== 'win32')('shared Hook Node runtime resolver', () => {
  let root;
  let home;
  let dataDir;
  let cacheDir;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-node-runtime-'));
    home = path.join(root, 'home');
    dataDir = path.join(root, 'data');
    cacheDir = path.join(root, 'cache');
    await Promise.all([
      fs.mkdir(home, { recursive: true }),
      fs.mkdir(dataDir, { recursive: true }),
      fs.mkdir(cacheDir, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('prefers the runtime pinned under the custom cache directory', async () => {
    const node = await fakeNode(path.join(root, 'custom-node'), 20);
    await fs.writeFile(path.join(cacheDir, 'node-bin'), `${node}\n`);
    expect(await resolveNode()).toBe(node);
  });

  it('skips an unsupported pinned Node and uses the next valid pin', async () => {
    const oldNode = await fakeNode(path.join(root, 'old-node'), 16);
    const validNode = await fakeNode(path.join(root, 'valid-node'), 18);
    await fs.writeFile(path.join(cacheDir, 'node-bin'), oldNode);
    await fs.writeFile(path.join(dataDir, 'node-bin'), validNode);
    expect(await resolveNode()).toBe(validNode);
  });

  it('rejects a Node executable embedded in a macOS app bundle', async () => {
    const appNode = await fakeNode(path.join(root, 'QwenWork.app', 'Contents', 'MacOS', 'node'), 99);
    const validNode = await fakeNode(path.join(root, 'standalone-node'), 20);
    await fs.writeFile(path.join(cacheDir, 'node-bin'), appNode);
    await fs.writeFile(path.join(dataDir, 'node-bin'), validNode);
    expect(await resolveNode()).toBe(validNode);
  });

  it('prefers the newest managed runtime using numeric version order', async () => {
    await fakeNode(path.join(dataDir, 'runtime', 'node-v22.9.0', 'bin', 'node'), 22);
    const newest = await fakeNode(path.join(dataDir, 'runtime', 'node-v22.22.2', 'bin', 'node'), 22);
    expect(await resolveNode()).toBe(newest);
  });

  it('accepts a managed runtime by its directory version without probing --version', async () => {
    // The installer validated this binary before writing it; the hook must not
    // pay a `node --version` boot per event. A stub whose --version fails proves
    // the directory-name fast path is what resolved it.
    const node = await brokenNode(path.join(dataDir, 'runtime', 'node-v20.5.1', 'bin', 'node'));
    await fs.writeFile(path.join(cacheDir, 'node-bin'), `${node}\n`);
    expect(await resolveNode()).toBe(node);
  });

  it('rejects a managed runtime whose directory version is unsupported', async () => {
    // node-v16 lives under runtime/, so the fast path reads major=16 and rejects
    // it outright rather than probing.
    const oldManaged = await brokenNode(path.join(dataDir, 'runtime', 'node-v16.20.0', 'bin', 'node'));
    const validNode = await fakeNode(path.join(root, 'valid-node'), 20);
    await fs.writeFile(path.join(cacheDir, 'node-bin'), oldManaged);
    await fs.writeFile(path.join(dataDir, 'node-bin'), validNode);
    expect(await resolveNode()).toBe(validNode);
  });

  it('rejects a pinned path that no longer exists and uses the next valid pin', async () => {
    const validNode = await fakeNode(path.join(root, 'valid-node'), 20);
    await fs.writeFile(path.join(cacheDir, 'node-bin'), path.join(root, 'runtime', 'node-v20.0.0', 'bin', 'node'));
    await fs.writeFile(path.join(dataDir, 'node-bin'), validNode);
    expect(await resolveNode()).toBe(validNode);
  });

  async function resolveNode() {
    const { stdout } = await execFileAsync('/bin/bash', [
      '-c',
      'source "$1"; resolve_pilot_node_bin',
      '_',
      resolver,
    ], {
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin',
        LOONGSUITE_PILOT_DATA_DIR: dataDir,
        LOONGSUITE_PILOT_CACHE_DIR: cacheDir,
      },
    });
    return stdout.trim();
  }
});

async function fakeNode(file, major) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `#!/bin/sh\necho v${major}.0.0\n`);
  await fs.chmod(file, 0o755);
  return file;
}

// An executable whose --version fails. Resolving it proves the caller read the
// version from the managed-runtime directory name rather than booting the binary.
async function brokenNode(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '#!/bin/sh\nexit 1\n');
  await fs.chmod(file, 0o755);
  return file;
}

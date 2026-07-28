import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkerManifestSupervisor } from '../../../src/deployment/worker-manifest-supervisor.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('WorkerManifestSupervisor', () => {
  let tmpDir: string;
  let bundleRoot: string;
  let stateDir: string;
  let logDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-manifest-supervisor-'));
    bundleRoot = path.join(tmpDir, 'bundle 测试 with spaces');
    stateDir = path.join(tmpDir, '状态 state');
    logDir = path.join(tmpDir, '日志 logs');
    await fs.mkdir(bundleRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeManifest(command: string[], extra: Record<string, unknown> = {}): Promise<void> {
    await fs.writeFile(
      path.join(bundleRoot, 'worker.manifest.json'),
      JSON.stringify({
        name: 'fake-worker',
        version: '1.2.3',
        command,
        paths: {
          pid: '${instance:stateDir}/worker.pid',
          status: '${instance:stateDir}/supervisor-status.json',
          log: '${instance:logDir}/worker.log',
        },
        ...extra,
      }),
      'utf-8',
    );
  }

  function options() {
    return {
      instance: { stateDir, logDir },
    };
  }

  async function readStatus(): Promise<Record<string, unknown>> {
    return JSON.parse(
      await fs.readFile(path.join(stateDir, 'supervisor-status.json'), 'utf-8'),
    ) as Record<string, unknown>;
  }

  it('resolves the controlled pilot node placeholder to the running Pilot node', async () => {
    const capture = path.join(tmpDir, 'capture.json');
    const entry = path.join(bundleRoot, 'worker-entrypoint.mjs');
    await fs.writeFile(
      entry,
      `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], JSON.stringify({
        execPath: process.execPath,
        value: process.argv[3]
      }));`,
      'utf-8',
    );
    await writeManifest(['${pilot:node}', entry, capture, '保留 空格']);

    const supervisor = new WorkerManifestSupervisor();
    expect(await supervisor.startIfPresent('local-worker:test', bundleRoot, process.env as Record<string, string>, options()))
      .toBe(true);

    await vi.waitFor(async () => {
      const captured = JSON.parse(await fs.readFile(capture, 'utf-8')) as Record<string, string>;
      expect(captured).toEqual({ execPath: process.execPath, value: '保留 空格' });
    }, { timeout: 20_000 });
    await vi.waitFor(async () => {
      expect(await readStatus()).toMatchObject({ state: 'exited', exitCode: 0 });
    }, { timeout: 20_000 });
  }, 30_000);

  it('rejects unknown and interpolated pilot placeholders', async () => {
    await writeManifest(['${pilot:other}']);
    const supervisor = new WorkerManifestSupervisor();

    expect(await supervisor.startIfPresent('local-worker:test', bundleRoot, {}, options())).toBe(false);
    await expect(readStatus()).resolves.toMatchObject({
      state: 'failed',
      reason: 'WorkerManifestPlaceholderInvalid',
    });

    await writeManifest(['prefix-${pilot:node}']);
    expect(await supervisor.startIfPresent('local-worker:test', bundleRoot, {}, options())).toBe(false);
    await expect(readStatus()).resolves.toMatchObject({
      state: 'failed',
      reason: 'WorkerManifestPlaceholderInvalid',
    });
  });

  it('rejects Unix shell bundle entrypoints on Windows without invoking a compatibility shell', async () => {
    const entry = path.join(bundleRoot, 'worker-entrypoint.sh');
    await fs.writeFile(entry, '#!/usr/bin/env bash\nexit 0\n', 'utf-8');
    await writeManifest([entry]);
    const supervisor = new WorkerManifestSupervisor({ platform: 'win32' });

    expect(await supervisor.startIfPresent('local-worker:test', bundleRoot, {}, options())).toBe(false);
    await expect(readStatus()).resolves.toMatchObject({
      state: 'failed',
      reason: 'RuntimeBundlePlatformUnsupported',
      platform: 'win32',
      bundleVersion: '1.2.3',
      entryType: 'unix-shell',
    });
  });

  it('detects a Unix shell shebang even when the Windows bundle entrypoint has no extension', async () => {
    const entry = path.join(bundleRoot, 'worker-entrypoint');
    await fs.writeFile(entry, '#!/usr/bin/env bash\nexit 0\n', 'utf-8');
    await writeManifest([entry]);
    const supervisor = new WorkerManifestSupervisor({ platform: 'win32' });

    expect(await supervisor.startIfPresent('local-worker:test', bundleRoot, {}, options())).toBe(false);
    await expect(readStatus()).resolves.toMatchObject({
      state: 'failed',
      reason: 'RuntimeBundlePlatformUnsupported',
      entryType: 'unix-shell',
    });
  });

  it('rejects pilot node resolution when Pilot is not running from an absolute executable path', async () => {
    await writeManifest(['${pilot:node}', path.join(bundleRoot, 'worker-entrypoint.mjs')]);
    const supervisor = new WorkerManifestSupervisor({ nodeExecutable: 'relative-node' });

    expect(await supervisor.startIfPresent('local-worker:test', bundleRoot, {}, options())).toBe(false);
    await expect(readStatus()).resolves.toMatchObject({
      state: 'failed',
      reason: 'WorkerManifestPlaceholderInvalid',
    });
  });

  it('maps USERPROFILE to HOME only in the Windows worker child environment', async () => {
    const capture = path.join(tmpDir, 'home.txt');
    const entry = path.join(bundleRoot, 'worker-entrypoint.mjs');
    await fs.writeFile(
      entry,
      `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], process.env.HOME ?? '');`,
      'utf-8',
    );
    await writeManifest(['${pilot:node}', entry, capture]);

    const supervisor = new WorkerManifestSupervisor({ platform: 'win32' });
    expect(await supervisor.startIfPresent(
      'local-worker:test',
      bundleRoot,
      { USERPROFILE: 'C:\\Users\\测试 用户' },
      options(),
    )).toBe(true);

    await vi.waitFor(async () => {
      expect(await fs.readFile(capture, 'utf-8')).toBe('C:\\Users\\测试 用户');
    }, { timeout: 20_000 });
    await vi.waitFor(async () => {
      expect(await readStatus()).toMatchObject({ state: 'exited', exitCode: 0 });
    }, { timeout: 20_000 });
  }, 30_000);

  it.runIf(process.platform === 'win32')('stops the complete Windows worker process tree', async () => {
    const childPidFile = path.join(tmpDir, 'child.pid');
    const entry = path.join(bundleRoot, 'worker-entrypoint.mjs');
    await fs.writeFile(
      entry,
      `import fs from 'node:fs';
       import { spawn } from 'node:child_process';
       const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
         detached: false,
         stdio: 'ignore'
       });
       fs.writeFileSync(process.argv[2], String(child.pid));
       setInterval(() => {}, 1000);`,
      'utf-8',
    );
    await writeManifest(['${pilot:node}', entry, childPidFile]);

    const supervisor = new WorkerManifestSupervisor();
    expect(await supervisor.startIfPresent('local-worker:test', bundleRoot, {}, options())).toBe(true);

    let childPid = 0;
    await vi.waitFor(async () => {
      childPid = Number.parseInt(await fs.readFile(childPidFile, 'utf-8'), 10);
      expect(childPid).toBeGreaterThan(0);
      process.kill(childPid, 0);
    });

    expect(await supervisor.stopIfPresent('local-worker:test', bundleRoot, options())).toBe(true);
    await vi.waitFor(() => {
      expect(() => process.kill(childPid, 0)).toThrow();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  WorkerManifestSupervisor,
  type WindowsProcessIdentity,
  type WindowsProcessOperations,
} from '../../../src/deployment/worker-manifest-supervisor.js';

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
    await fs.rm(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
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

  function processIdentity(pid: number, creationTime = '2026-07-30T00:00:00.0000000Z'): WindowsProcessIdentity {
    return {
      pid,
      creationTime,
      executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    };
  }

  async function writeTrackedWindowsWorker(pid: number, identity = processIdentity(pid)): Promise<void> {
    await writeManifest(['unused']);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'worker.pid'), `${pid}\n`, 'utf-8');
    await fs.writeFile(
      path.join(stateDir, 'worker.pid.identity.json'),
      JSON.stringify(identity),
      'utf-8',
    );
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
    await expect(readStatus()).resolves.toMatchObject({
      state: 'running',
      processIdentity: {
        pid: expect.any(Number),
        creationTime: expect.any(String),
        executablePath: expect.any(String),
      },
    });

    expect(await supervisor.stopIfPresent('local-worker:test', bundleRoot, options())).toBe(true);
    await vi.waitFor(() => {
      expect(() => process.kill(childPid, 0)).toThrow();
    });
  });

  it.runIf(process.platform === 'win32')('does not require process identity for non-instance manifest workers', async () => {
    const entry = path.join(bundleRoot, 'worker-entrypoint.mjs');
    const pidPath = path.join(bundleRoot, '.legacy-worker', 'worker.pid');
    await fs.writeFile(entry, 'setInterval(() => {}, 1000);', 'utf-8');
    await writeManifest(['${pilot:node}', entry], {
      paths: {
        pid: '.legacy-worker/worker.pid',
        status: '.legacy-worker/supervisor-status.json',
        log: '.legacy-worker/worker.log',
      },
    });

    const supervisor = new WorkerManifestSupervisor();
    expect(await supervisor.startIfPresent('collection:test', bundleRoot, {}, {})).toBe(true);

    const pid = Number.parseInt(await fs.readFile(pidPath, 'utf-8'), 10);
    try {
      expect(pid).toBeGreaterThan(0);
      await expect(fs.stat(`${pidPath}.identity.json`)).rejects.toThrow();
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The test process may already have exited.
      }
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
      });
    }
  });

  it('checks worker health without querying Windows process identity', async () => {
    const pidPath = path.join(stateDir, 'worker.pid');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(pidPath, `${process.pid}\n`, 'utf-8');
    await writeManifest(['unused']);

    const supervisor = new WorkerManifestSupervisor({ platform: 'win32' });
    const internals = supervisor as unknown as {
      readWindowsProcessIdentity(pid: number): Promise<unknown>;
    };
    const identityQuery = vi.spyOn(internals, 'readWindowsProcessIdentity');

    expect(await supervisor.isWorkerRunning(bundleRoot, options())).toBe(true);
    expect(identityQuery).not.toHaveBeenCalled();
  });

  it('persists the managed Windows worker pid before process identity lookup completes', async () => {
    const entry = path.join(bundleRoot, 'worker-entrypoint.mjs');
    await fs.writeFile(entry, 'setInterval(() => {}, 1000);', 'utf-8');
    await writeManifest(['${pilot:node}', entry]);

    let resolveIdentity!: (identity: WindowsProcessIdentity) => void;
    const identity = new Promise<WindowsProcessIdentity>(resolve => {
      resolveIdentity = resolve;
    });
    const windowsProcessOperations: WindowsProcessOperations = {
      readProcessIdentity: vi.fn(() => identity),
      listDescendantPids: vi.fn(async () => []),
      taskkill: vi.fn(async () => {}),
    };
    const supervisor = new WorkerManifestSupervisor({
      platform: 'win32',
      windowsProcessOperations,
    });
    const start = supervisor.startIfPresent('local-worker:test', bundleRoot, {}, options());

    let workerPid = 0;
    try {
      await vi.waitFor(() => {
        expect(windowsProcessOperations.readProcessIdentity).toHaveBeenCalledOnce();
      });
      workerPid = Number(vi.mocked(windowsProcessOperations.readProcessIdentity).mock.calls[0][0]);
      await expect(fs.readFile(path.join(stateDir, 'worker.pid'), 'utf-8')).resolves.toBe(`${workerPid}\n`);
    } finally {
      if (workerPid > 0) resolveIdentity(processIdentity(workerPid));
      await start;
      if (workerPid > 0) {
        try {
          process.kill(workerPid, 'SIGKILL');
        } catch {
          // The worker may already have exited.
        }
        await vi.waitFor(() => {
          expect(() => process.kill(workerPid, 0)).toThrow();
        });
      }
    }
  });

  it('cleans a stale managed Windows pid when its identity file is missing and the process is gone', async () => {
    const rootPid = 40_001;
    const windowsProcessOperations: WindowsProcessOperations = {
      readProcessIdentity: vi.fn(async () => undefined),
      listDescendantPids: vi.fn(async () => []),
      taskkill: vi.fn(async () => {}),
    };
    await writeManifest(['unused']);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'worker.pid'), `${rootPid}\n`, 'utf-8');

    const supervisor = new WorkerManifestSupervisor({
      platform: 'win32',
      windowsProcessOperations,
    });

    expect(await supervisor.stopIfPresent('local-worker:test', bundleRoot, options())).toBe(true);
    expect(windowsProcessOperations.readProcessIdentity).toHaveBeenCalledWith(rootPid);
    expect(windowsProcessOperations.taskkill).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(stateDir, 'worker.pid'))).rejects.toThrow();
    await expect(readStatus()).resolves.toMatchObject({
      state: 'stopped',
      reason: 'WorkerProcessNotFound',
      pid: rootPid,
    });
  });

  it('refuses to stop a live managed Windows pid when its identity file is missing', async () => {
    const rootPid = 40_002;
    const windowsProcessOperations: WindowsProcessOperations = {
      readProcessIdentity: vi.fn(async pid => processIdentity(pid)),
      listDescendantPids: vi.fn(async () => []),
      taskkill: vi.fn(async () => {}),
    };
    await writeManifest(['unused']);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'worker.pid'), `${rootPid}\n`, 'utf-8');

    const supervisor = new WorkerManifestSupervisor({
      platform: 'win32',
      windowsProcessOperations,
    });

    expect(await supervisor.stopIfPresent('local-worker:test', bundleRoot, options())).toBe(false);
    expect(windowsProcessOperations.readProcessIdentity).toHaveBeenCalledWith(rootPid);
    expect(windowsProcessOperations.taskkill).not.toHaveBeenCalled();
    await expect(readStatus()).resolves.toMatchObject({
      state: 'failed',
      reason: 'WorkerProcessIdentityMissing',
      pid: rootPid,
    });
  });

  it('gracefully stops and verifies the complete managed Windows process tree', async () => {
    const rootPid = 41_001;
    const childPid = 41_002;
    const alivePids = new Set([rootPid, childPid]);
    const windowsProcessOperations: WindowsProcessOperations = {
      readProcessIdentity: vi.fn(async pid => processIdentity(pid)),
      listDescendantPids: vi.fn(async () => [childPid]),
      taskkill: vi.fn(async (pid, force) => {
        if (force) alivePids.delete(pid);
      }),
    };
    await writeTrackedWindowsWorker(rootPid);

    const supervisor = new WorkerManifestSupervisor({
      platform: 'win32',
      windowsProcessOperations,
    });
    const internals = supervisor as unknown as {
      isAlive(pid: number): boolean;
      waitForExit(pid: number, timeoutMs: number): Promise<void>;
      waitForPidsExit(pids: number[], timeoutMs: number): Promise<void>;
    };
    vi.spyOn(internals, 'isAlive').mockImplementation(pid => alivePids.has(pid));
    vi.spyOn(internals, 'waitForExit').mockResolvedValue();
    vi.spyOn(internals, 'waitForPidsExit').mockResolvedValue();

    expect(await supervisor.stopIfPresent('local-worker:test', bundleRoot, options())).toBe(true);
    expect(windowsProcessOperations.listDescendantPids).toHaveBeenCalledWith(rootPid);
    expect(windowsProcessOperations.taskkill).toHaveBeenNthCalledWith(1, rootPid, false);
    expect(windowsProcessOperations.taskkill).toHaveBeenCalledWith(rootPid, true);
    expect(windowsProcessOperations.taskkill).toHaveBeenCalledWith(childPid, true);
    expect(alivePids).toEqual(new Set());
    await expect(readStatus()).resolves.toMatchObject({ state: 'stopped', pid: rootPid });
  });

  it('reports WorkerProcessTreeStopFailed when a managed Windows descendant remains alive', async () => {
    const rootPid = 42_001;
    const childPid = 42_002;
    const windowsProcessOperations: WindowsProcessOperations = {
      readProcessIdentity: vi.fn(async pid => processIdentity(pid)),
      listDescendantPids: vi.fn(async () => [childPid]),
      taskkill: vi.fn(async () => {
        throw new Error('simulated taskkill failure');
      }),
    };
    await writeTrackedWindowsWorker(rootPid);

    const supervisor = new WorkerManifestSupervisor({
      platform: 'win32',
      windowsProcessOperations,
    });
    const internals = supervisor as unknown as {
      isAlive(pid: number): boolean;
      waitForExit(pid: number, timeoutMs: number): Promise<void>;
      waitForPidsExit(pids: number[], timeoutMs: number): Promise<void>;
    };
    vi.spyOn(internals, 'isAlive').mockReturnValue(true);
    vi.spyOn(internals, 'waitForExit').mockResolvedValue();
    vi.spyOn(internals, 'waitForPidsExit').mockResolvedValue();

    expect(await supervisor.stopIfPresent('local-worker:test', bundleRoot, options())).toBe(false);
    await expect(readStatus()).resolves.toMatchObject({
      state: 'failed',
      reason: 'WorkerProcessTreeStopFailed',
      remainingPids: [rootPid, childPid],
    });
  });

  it('uses injected Windows process identity checks without requiring a Windows test host', async () => {
    const rootPid = 43_001;
    const windowsProcessOperations: WindowsProcessOperations = {
      readProcessIdentity: vi.fn(async pid => processIdentity(pid, '2026-07-30T00:00:01.0000000Z')),
      listDescendantPids: vi.fn(async () => []),
      taskkill: vi.fn(async () => {}),
    };
    await writeTrackedWindowsWorker(rootPid);

    const supervisor = new WorkerManifestSupervisor({
      platform: 'win32',
      windowsProcessOperations,
    });

    expect(await supervisor.stopIfPresent('local-worker:test', bundleRoot, options())).toBe(true);
    expect(windowsProcessOperations.readProcessIdentity).toHaveBeenCalledWith(rootPid);
    expect(windowsProcessOperations.taskkill).not.toHaveBeenCalled();
    await expect(readStatus()).resolves.toMatchObject({
      state: 'stopped',
      reason: 'WorkerPidIdentityMismatch',
      pid: rootPid,
    });
  });

  it.runIf(process.platform === 'win32')('does not stop a reused Windows pid with a different creation time', async () => {
    const entry = path.join(bundleRoot, 'worker-entrypoint.mjs');
    await fs.writeFile(entry, 'setInterval(() => {}, 1000);', 'utf-8');
    await writeManifest(['${pilot:node}', entry]);

    const supervisor = new WorkerManifestSupervisor();
    expect(await supervisor.startIfPresent('local-worker:test', bundleRoot, {}, options())).toBe(true);

    let workerPid = 0;
    try {
      const running = await readStatus();
      workerPid = Number(running.pid);
      expect(workerPid).toBeGreaterThan(0);
      expect(running.processIdentity).toMatchObject({
        pid: workerPid,
        creationTime: expect.any(String),
      });

      await fs.writeFile(
        path.join(stateDir, 'worker.pid.identity.json'),
        JSON.stringify({
          ...(running.processIdentity as Record<string, unknown>),
          creationTime: '2000-01-01T00:00:00.0000000Z',
        }),
        'utf-8',
      );

      expect(await supervisor.stopIfPresent('local-worker:test', bundleRoot, options())).toBe(true);
      expect(() => process.kill(workerPid, 0)).not.toThrow();
      await expect(readStatus()).resolves.toMatchObject({
        state: 'stopped',
        reason: 'WorkerPidIdentityMismatch',
        pid: workerPid,
      });
    } finally {
      if (workerPid > 0) {
        try {
          process.kill(workerPid, 'SIGKILL');
        } catch {
          // The test process may already have exited.
        }
        await vi.waitFor(() => {
          expect(() => process.kill(workerPid, 0)).toThrow();
        });
      }
    }
  });

});

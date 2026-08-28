import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { StatusBarAppManager } from '../../../src/status-bar/status-bar-app-manager.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

type ManagerInternals = {
  findRunningPids(): Promise<number[]>;
  isProcessRunning(pid: number, executablePath: string): Promise<boolean>;
  resolveExecutable(): string | null;
  resolveSourceDir(): string | null;
  buildExecutable(): Promise<string | null>;
  sendSignal(pid: number, signal: NodeJS.Signals): void;
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
};

describe('StatusBarAppManager', () => {
  let tmpDir: string;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const executablePath = '/test/LoongSuitePilotMenuBarApp';

  function createManager() {
    const manager = new StatusBarAppManager({ dataDir: tmpDir, packageVersion: '1.0.0' });
    const internals = manager as unknown as ManagerInternals;
    return { manager, internals };
  }

  function runtimePath() {
    return path.join(tmpDir, 'logs', 'status-bar-app-runtime.json');
  }

  async function writeRuntime(pid: number) {
    await fs.writeFile(runtimePath(), JSON.stringify({ executablePath, packageVersion: '1.0.0', pid }));
  }

  beforeEach(async () => {
    tmpDir = await createTempDir('status-bar-mgr-test-');
    await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.stubEnv('LOONGSUITE_PILOT_CACHE_DIR', tmpDir);
    // Never discover or signal the developer's real menu bar app in unit tests.
    const prototype = StatusBarAppManager.prototype as unknown as ManagerInternals;
    vi.spyOn(prototype, 'findRunningPids').mockResolvedValue([]);
    vi.spyOn(prototype, 'isProcessRunning').mockResolvedValue(false);
    vi.spyOn(prototype, 'sendSignal').mockImplementation(() => {});
    vi.spyOn(prototype, 'waitForExit').mockResolvedValue(true);
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { pid: 12345, unref: vi.fn() });
      queueMicrotask(() => child.emit('spawn'));
      return child as ReturnType<typeof spawn>;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', originalPlatform);
    await cleanupTempDir(tmpDir);
  });

  it('skips on non-darwin platforms', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    try {
      const manager = new StatusBarAppManager({ dataDir: tmpDir, packageVersion: '1.0.0' });
      await manager.syncDesiredState(true);

      const runtimePath = path.join(tmpDir, 'logs', 'status-bar-app-runtime.json');
      const exists = await fs.access(runtimePath).then(() => true, () => false);
      expect(exists).toBe(false);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    }
  });

  it('stop removes runtime record if it exists', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    try {
      const runtimePath = path.join(tmpDir, 'logs', 'status-bar-app-runtime.json');
      await fs.writeFile(runtimePath, JSON.stringify({
        executablePath: '/nonexistent/binary',
        packageVersion: '1.0.0',
        pid: 99999999,
        updatedAt: new Date().toISOString(),
      }));

      const manager = new StatusBarAppManager({ dataDir: tmpDir, packageVersion: '1.0.0' });
      await manager.stop('test');

      const exists = await fs.access(runtimePath).then(() => true, () => false);
      expect(exists).toBe(false);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    }
  });

  it('syncDesiredState(false) calls stop', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    try {
      const runtimePath = path.join(tmpDir, 'logs', 'status-bar-app-runtime.json');
      await fs.writeFile(runtimePath, JSON.stringify({
        executablePath: '/nonexistent/binary',
        packageVersion: '1.0.0',
        pid: 99999999,
        updatedAt: new Date().toISOString(),
      }));

      const manager = new StatusBarAppManager({ dataDir: tmpDir, packageVersion: '1.0.0' });
      await manager.syncDesiredState(false);

      const exists = await fs.access(runtimePath).then(() => true, () => false);
      expect(exists).toBe(false);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    }
  });

  it('starts a detached app, records its PID, and does not duplicate a second start', async () => {
    const { manager, internals } = createManager();
    vi.spyOn(internals, 'resolveExecutable').mockReturnValue(executablePath);
    vi.mocked(internals.isProcessRunning).mockResolvedValue(true);

    expect(await manager.start()).toEqual({ status: 'started', pid: 12345 });
    expect(await manager.start()).toEqual({ status: 'already-running', pid: 12345 });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(executablePath, [], expect.objectContaining({
      detached: true,
      env: expect.objectContaining({ LOONGSUITE_PILOT_DATA_DIR: tmpDir }),
    }));
    expect(JSON.parse(await fs.readFile(runtimePath(), 'utf8'))).toMatchObject({ pid: 12345, executablePath });
    await expect(fs.access(path.join(tmpDir, 'status-bar-app-start.lock'))).rejects.toThrow();
  });

  it('relaunches after the recorded app exited', async () => {
    const { manager, internals } = createManager();
    await writeRuntime(99999999);
    vi.spyOn(internals, 'resolveExecutable').mockReturnValue(executablePath);
    vi.mocked(internals.isProcessRunning).mockResolvedValueOnce(false).mockResolvedValue(true);

    expect(await manager.start()).toEqual({ status: 'started', pid: 12345 });
    expect(JSON.parse(await fs.readFile(runtimePath(), 'utf8')).pid).toBe(12345);
  });

  it('adopts an existing app when its runtime record is missing', async () => {
    const { manager, internals } = createManager();
    vi.spyOn(internals, 'resolveExecutable').mockReturnValue(executablePath);
    vi.mocked(internals.findRunningPids).mockResolvedValue([54321]);
    vi.mocked(internals.isProcessRunning).mockResolvedValue(true);

    expect(await manager.start()).toEqual({ status: 'already-running', pid: 54321 });
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(runtimePath(), 'utf8')).pid).toBe(54321);
  });

  it('serializes collector and CLI launches with a shared lock', async () => {
    const { manager, internals } = createManager();
    vi.spyOn(internals, 'resolveExecutable').mockReturnValue(executablePath);
    vi.mocked(internals.isProcessRunning).mockResolvedValue(true);

    const first = manager.start();
    await expect(createManager().manager.start()).rejects.toThrow('control lock');
    await expect(first).resolves.toEqual({ status: 'started', pid: 12345 });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reports asynchronous spawn errors without writing a successful runtime record', async () => {
    const { manager, internals } = createManager();
    vi.spyOn(internals, 'resolveExecutable').mockReturnValue(executablePath);
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('spawn EACCES')));
      return child as ReturnType<typeof spawn>;
    });

    await expect(manager.start()).rejects.toThrow('EACCES');
    await expect(fs.access(runtimePath())).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, 'status-bar-app-start.lock'))).rejects.toThrow();
  });

  it('does not report success if the app immediately exits', async () => {
    const { manager, internals } = createManager();
    vi.spyOn(internals, 'resolveExecutable').mockReturnValue(executablePath);

    expect(await manager.start()).toBeNull();
    await expect(fs.access(runtimePath())).rejects.toThrow();
  });

  it('returns unavailable when the binary is missing and cannot be built', async () => {
    const { manager, internals } = createManager();
    vi.spyOn(internals, 'resolveExecutable').mockReturnValue(null);
    vi.spyOn(internals, 'buildExecutable').mockResolvedValue(null);

    expect(await manager.start()).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('resolves installed binaries from a cache directory separate from the data directory', async () => {
    const cacheDir = path.join(tmpDir, 'package cache');
    const sourceDir = path.join(cacheDir, 'versions', 'v1', 'app', 'macos-status-bar');
    const binary = path.join(sourceDir, 'bin', 'darwin-universal', 'LoongSuitePilotMenuBarApp');
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(path.join(cacheDir, 'current'), 'v1\n');
    await fs.writeFile(path.join(sourceDir, 'Package.swift'), '');
    await fs.writeFile(binary, '');
    vi.stubEnv('LOONGSUITE_PILOT_CACHE_DIR', cacheDir);

    expect(createManager().internals.resolveExecutable()).toBe(binary);
  });

  it('finds the source package independently of the terminal working directory', () => {
    const sourceDir = path.resolve('app', 'macos-status-bar');
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    expect(createManager().internals.resolveSourceDir()).toBe(sourceDir);
  });

  it('stops a recorded app once and succeeds on a repeated stop', async () => {
    const { manager, internals } = createManager();
    await writeRuntime(54321);
    vi.mocked(internals.isProcessRunning).mockResolvedValue(true);

    expect(await manager.stop('cli-request')).toEqual({ status: 'stopped', pids: [54321] });
    expect(await manager.stop('cli-request')).toEqual({ status: 'already-stopped', pids: [] });
    expect(vi.mocked(internals.sendSignal).mock.calls).toEqual([[54321, 'SIGTERM']]);
    await expect(fs.access(runtimePath())).rejects.toThrow();
  });

  it('stops matching orphans without signaling another installation', async () => {
    const { manager, internals } = createManager();
    vi.spyOn(internals, 'resolveExecutable').mockReturnValue(executablePath);
    vi.mocked(internals.findRunningPids).mockResolvedValue([54321, 67890]);
    vi.mocked(internals.isProcessRunning).mockImplementation(async (pid, candidate) => pid === 54321 && candidate === executablePath);

    expect(await manager.stop('cli-request')).toEqual({ status: 'stopped', pids: [54321] });
    expect(vi.mocked(internals.sendSignal).mock.calls).toEqual([[54321, 'SIGTERM']]);
  });

  it('does not signal a reused PID that no longer matches the recorded executable', async () => {
    const { manager, internals } = createManager();
    await writeRuntime(54321);
    vi.mocked(internals.findRunningPids).mockResolvedValue([54321]);

    expect(await manager.stop('cli-request')).toEqual({ status: 'already-stopped', pids: [] });
    expect(internals.sendSignal).not.toHaveBeenCalled();
  });

  it('force stops an app that ignores graceful termination', async () => {
    const { manager, internals } = createManager();
    await writeRuntime(54321);
    vi.mocked(internals.isProcessRunning).mockResolvedValue(true);
    vi.mocked(internals.waitForExit).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await manager.stop('cli-request')).toEqual({ status: 'stopped', pids: [54321] });
    expect(vi.mocked(internals.sendSignal).mock.calls).toEqual([[54321, 'SIGTERM'], [54321, 'SIGKILL']]);
    await expect(fs.access(runtimePath())).rejects.toThrow();
  });

  it('keeps the runtime record and reports failure when the process cannot be stopped', async () => {
    const { manager, internals } = createManager();
    await writeRuntime(54321);
    vi.mocked(internals.isProcessRunning).mockResolvedValue(true);
    vi.mocked(internals.waitForExit).mockResolvedValue(false);

    await expect(manager.stop('cli-request')).rejects.toThrow('did not stop');
    expect(JSON.parse(await fs.readFile(runtimePath(), 'utf8')).pid).toBe(54321);
    await expect(fs.access(path.join(tmpDir, 'status-bar-app-start.lock'))).rejects.toThrow();
  });

  it('does not let a stop race an in-progress launch', async () => {
    const { manager, internals } = createManager();
    vi.spyOn(internals, 'resolveExecutable').mockReturnValue(executablePath);
    vi.mocked(internals.isProcessRunning).mockResolvedValue(true);

    const first = manager.start();
    await expect(createManager().manager.stop('cli-request')).rejects.toThrow('control lock');
    await expect(first).resolves.toEqual({ status: 'started', pid: 12345 });
    expect(internals.sendSignal).not.toHaveBeenCalled();
  });

  it('can replace an old version while holding the lifecycle lock', async () => {
    const { manager, internals } = createManager();
    await fs.writeFile(runtimePath(), JSON.stringify({ executablePath, packageVersion: '0.9.0', pid: 54321 }));
    vi.spyOn(internals, 'resolveExecutable').mockReturnValue(executablePath);
    vi.mocked(internals.isProcessRunning).mockResolvedValue(true);

    expect(await manager.start()).toEqual({ status: 'started', pid: 12345 });
    expect(vi.mocked(internals.sendSignal).mock.calls).toEqual([[54321, 'SIGTERM']]);
    expect(JSON.parse(await fs.readFile(runtimePath(), 'utf8'))).toMatchObject({ pid: 12345, packageVersion: '1.0.0' });
  });
});

import { existsSync, closeSync, openSync, readFileSync, readdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFileCb);
import { createHash } from 'node:crypto';
import { writeJsonFile, readJsonFile, ensureDir, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { acquireSingleInstanceLock, type SingleInstanceLock } from '../utils/single-instance-lock.js';

const logger = createLogger('StatusBarAppManager');

const BINARY_NAME = 'LoongSuitePilotMenuBarApp';
const STOP_TIMEOUT_MS = 3000;
const FORCE_STOP_TIMEOUT_MS = 1500;
const STOP_LOCK_WAIT_MS = 5000;
const LOCK_RETRY_INTERVAL_MS = 100;
const DEFAULT_XCODE_DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

type ProcessCommandReader = (pid: number) => Promise<string | null>;

interface StatusBarAppRuntime {
  executablePath: string;
  packageVersion: string;
  pid: number | null;
  executableFingerprint: string | null;
  updatedAt: string;
}

export interface StatusBarAppStartResult {
  status: 'started' | 'already-running';
  pid: number;
}

export interface StatusBarAppStopResult {
  status: 'stopped' | 'already-stopped';
  pids: number[];
}

export class StatusBarAppManager {
  private readonly dataDir: string;
  private readonly cacheDir: string;
  private readonly packageVersion: string;
  private readonly processCommandReader: ProcessCommandReader;

  constructor(options: {
    dataDir: string;
    packageVersion: string;
    processCommandReader?: ProcessCommandReader;
  }) {
    this.dataDir = options.dataDir;
    this.cacheDir = resolveHome(process.env.LOONGSUITE_PILOT_CACHE_DIR || options.dataDir);
    this.packageVersion = options.packageVersion;
    this.processCommandReader = options.processCommandReader ?? (async pid => {
      try {
        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 });
        return stdout.trim() || null;
      } catch {
        return null;
      }
    });
  }

  async syncDesiredState(enabled: boolean): Promise<void> {
    if (process.platform !== 'darwin') return;

    if (enabled) {
      await this.start();
    } else {
      await this.stop('config-disabled');
    }
  }

  async start(): Promise<StatusBarAppStartResult | null> {
    if (process.platform !== 'darwin') return null;
    // Swift compilation can take minutes on a source checkout. Keep it outside
    // the lifecycle lock so a collector shutdown can still stop an existing app.
    const executablePath = await this.prepareExecutable();
    return this.withLifecycleLock(() => this.ensureStarted(executablePath));
  }

  async stop(reason: string): Promise<StatusBarAppStopResult> {
    if (process.platform !== 'darwin') return { status: 'already-stopped', pids: [] };
    return this.withLifecycleLock(() => this.stopProcesses(reason), STOP_LOCK_WAIT_MS);
  }

  private async withLifecycleLock<T>(action: () => Promise<T>, waitMs = 0): Promise<T> {
    // Shared by collector and CLI start/stop. Keep the existing lock filename
    // so a stop cannot race an older launcher and remove its new runtime record.
    const lockPath = path.join(this.dataDir, 'status-bar-app-start.lock');
    const deadline = Date.now() + waitMs;
    let holderPid: number | undefined;
    let lock: SingleInstanceLock | null = null;
    do {
      const acquired = acquireSingleInstanceLock(lockPath);
      lock = acquired.lock;
      holderPid = acquired.holderPid;
      if (lock || Date.now() >= deadline) break;
      await sleep(Math.min(LOCK_RETRY_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    } while (!lock);

    if (!lock) {
      const holder = holderPid ? ` (holder PID ${holderPid})` : '';
      throw new Error(`Cannot acquire menu bar control lock${holder}; another start or stop may be in progress. Retry shortly.`);
    }
    try {
      return await action();
    } finally {
      lock.release();
    }
  }

  private async prepareExecutable(): Promise<string | null> {
    const executablePath = this.resolveExecutable();
    if (executablePath) return executablePath;

    // Avoid an unnecessary build if a current recorded process is still alive.
    const runtime = await this.readRuntimeRecord();
    if (
      runtime?.pid
      && runtime.packageVersion === this.packageVersion
      && await this.isProcessRunning(runtime.pid, runtime.executablePath)
    ) {
      return null;
    }

    logger.info('status bar app binary not available, attempting build');
    const builtPath = await this.buildExecutable();
    if (!builtPath) {
      logger.warn('status bar app not available (no binary, build failed or not possible)');
    }
    return builtPath;
  }

  private async stopProcesses(reason: string): Promise<StatusBarAppStopResult> {
    const runtime = await this.readRuntimeRecord();
    const stoppedPids = new Set<number>();

    // Start and stop share the same managed path set: the recorded executable,
    // every bundled architecture across retained installed versions, and the
    // local fallback build. This lets us clean up an old process after a version
    // switch or a lost runtime record without touching another installation.
    const executablePaths = this.resolveManagedExecutablePaths(runtime?.executablePath);
    const candidatePids = new Set(await this.findRunningPids());
    if (runtime?.pid) candidatePids.add(runtime.pid);
    for (const pid of candidatePids) {
      for (const executablePath of executablePaths) {
        if (await this.isProcessRunning(pid, executablePath)) {
          this.sendSignal(pid, 'SIGTERM');
          stoppedPids.add(pid);
          break;
        }
      }
    }

    // Wait for graceful shutdown, then force kill
    for (const pid of stoppedPids) {
      const exited = await this.waitForExit(pid, STOP_TIMEOUT_MS);
      if (!exited) {
        this.sendSignal(pid, 'SIGKILL');
        if (!await this.waitForExit(pid, FORCE_STOP_TIMEOUT_MS)) {
          throw new Error(`Menu bar app did not stop (PID ${pid}); keeping its runtime record for retry.`);
        }
      }
    }

    await this.removeRuntimeRecord();

    if (stoppedPids.size > 0) {
      logger.info(`status bar app stopped (${reason})`, { pids: Array.from(stoppedPids) });
    }
    return {
      status: stoppedPids.size > 0 ? 'stopped' : 'already-stopped',
      pids: Array.from(stoppedPids),
    };
  }

  private async ensureStarted(preparedExecutablePath: string | null): Promise<StatusBarAppStartResult | null> {
    const runtime = await this.readRuntimeRecord();
    const executablePath = preparedExecutablePath ?? this.resolveExecutable();

    // Already running with the current version and preferred executable?
    if (runtime?.pid && await this.isProcessRunning(runtime.pid, runtime.executablePath)) {
      if (
        runtime.packageVersion === this.packageVersion
        && (!executablePath || runtime.executablePath === executablePath)
      ) {
        logger.debug('status bar app already running', { pid: runtime.pid });
        return { status: 'already-running', pid: runtime.pid };
      }
      if (!executablePath) {
        logger.warn('cannot replace stale status bar app because no current executable is available', {
          pid: runtime.pid,
          executablePath: runtime.executablePath,
        });
        return null;
      }
      logger.info('replacing stale status bar app', {
        oldVersion: runtime.packageVersion,
        newVersion: this.packageVersion,
      });
      // start() already holds the lifecycle lock.
      await this.stopProcesses('version-upgrade');
    }

    if (!executablePath) {
      return null;
    }

    // Recover a directly launched app or a lost runtime record without adding a
    // second icon. A process from a retained older version is managed too, but
    // must be replaced by the current preferred binary rather than mislabeled as
    // the current package version.
    const managedPaths = this.resolveManagedExecutablePaths(runtime?.executablePath);
    const runningPids = await this.findRunningPids();
    const managedProcesses: Array<{ pid: number; executablePath: string }> = [];
    const unmanagedPids: number[] = [];
    for (const pid of runningPids) {
      let matchedPath: string | null = null;
      for (const candidate of managedPaths) {
        if (await this.isProcessRunning(pid, candidate)) {
          matchedPath = candidate;
          break;
        }
      }
      if (matchedPath) {
        managedProcesses.push({ pid, executablePath: matchedPath });
      } else {
        const command = await this.processCommandReader(pid);
        if (command) unmanagedPids.push(pid);
      }
    }

    if (
      managedProcesses.length === 1
      && managedProcesses[0].executablePath === executablePath
    ) {
      const [{ pid }] = managedProcesses;
      await this.recordProcess(executablePath, pid);
      return { status: 'already-running', pid };
    }

    if (unmanagedPids.length > 0) {
      throw new Error(
        `Found same-named menu bar process outside this Pilot installation (PID ${unmanagedPids.join(', ')}); refusing to start a duplicate.`,
      );
    }

    if (managedProcesses.length > 0) {
      logger.info('replacing old or duplicate status bar app processes', {
        pids: managedProcesses.map(process => process.pid),
      });
      await this.stopProcesses('replace-old-or-duplicate');
    }

    return this.spawnProcess(executablePath);
  }

  private async spawnProcess(executablePath: string): Promise<StatusBarAppStartResult | null> {
    const logPath = await this.prepareLogPath();
    let child;
    const logFd = openSync(logPath, 'a');
    try {
      child = spawn(executablePath, [], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: {
          ...process.env,
          HOME: process.env.HOME,
          LOONGSUITE_PILOT_DATA_DIR: this.dataDir,
        },
      });
    } finally {
      closeSync(logFd);
    }

    // spawn errors are asynchronous (e.g. EACCES/ENOENT); handle them before
    // reporting success or writing a runtime record.
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });

    if (!child.pid) return null;
    child.unref();

    await sleep(250);
    if (!await this.isProcessRunning(child.pid, executablePath)) {
      logger.warn('status bar app exited during startup', { executablePath, logPath });
      return null;
    }

    await this.recordProcess(executablePath, child.pid);
    logger.info('status bar app started', { pid: child.pid, executablePath });
    return { status: 'started', pid: child.pid };
  }

  private async recordProcess(executablePath: string, pid: number): Promise<void> {
    await this.writeRuntimeRecord({
      executablePath,
      packageVersion: this.packageVersion,
      pid,
      executableFingerprint: await this.fingerprint(executablePath),
      updatedAt: new Date().toISOString(),
    });
  }

  private resolveExecutable(): string | null {
    return this.resolveExecutableCandidates(false).find(candidate => existsSync(candidate)) ?? null;
  }

  private resolveManagedExecutablePaths(recordedPath?: string): string[] {
    const currentPath = this.resolveExecutable();
    return uniquePaths([
      ...(recordedPath ? [recordedPath] : []),
      ...(currentPath ? [currentPath] : []),
      ...this.resolveExecutableCandidates(true),
    ]);
  }

  private resolveExecutableCandidates(includeHistoricalVersions: boolean): string[] {
    const currentArchBundle = process.arch === 'x64' ? 'darwin-x64' : 'darwin-arm64';
    const bundles = includeHistoricalVersions
      ? ['darwin-universal', 'darwin-arm64', 'darwin-x64']
      : ['darwin-universal', currentArchBundle];
    const candidates = this.resolveSourceDirs(includeHistoricalVersions).flatMap(sourceDir => (
      bundles.map(bundle => path.join(sourceDir, 'bin', bundle, BINARY_NAME))
    ));
    candidates.push(path.join(this.dataDir, 'apps', 'macos-status-bar', 'build', BINARY_NAME));
    return uniquePaths(candidates);
  }

  private async buildExecutable(): Promise<string | null> {
    const sourceDir = this.resolveSourceDir();
    if (!sourceDir) return null;

    const swiftSourceDir = path.join(sourceDir, 'Sources', 'LoongSuitePilotMenuBarApp');
    if (!existsSync(swiftSourceDir)) return null;

    const outDir = path.join(this.dataDir, 'apps', 'macos-status-bar', 'build');
    await ensureDir(outDir);
    const outPath = path.join(outDir, BINARY_NAME);

    const sdkCandidates = [
      '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk',
      '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk',
    ];
    const sdk = sdkCandidates.find(s => existsSync(s));
    if (!sdk) {
      logger.warn('no macOS SDK found, cannot build status bar app');
      return null;
    }

    let sourceFiles: string[];
    try {
      sourceFiles = (await fs.readdir(swiftSourceDir))
        .filter(f => f.endsWith('.swift'))
        .map(f => path.join(swiftSourceDir, f));
    } catch {
      return null;
    }
    if (sourceFiles.length === 0) return null;

    const archTarget = process.arch === 'x64' ? 'x86_64-apple-macosx13.0' : 'arm64-apple-macosx13.0';
    const swiftcCandidates = this.resolveSwiftcPaths();

    for (const { swiftc, label, env: cmdEnv } of swiftcCandidates) {
      try {
        logger.info(`building status bar app with ${label}`);

        const args = [
          '-O', '-target', archTarget, '-sdk', sdk, '-o', outPath,
          '-framework', 'AppKit', '-framework', 'SwiftUI',
          '-framework', 'Charts', '-framework', 'Combine',
          ...sourceFiles,
        ];
        await execFileAsync(swiftc, args, {
          env: { ...process.env, ...cmdEnv },
          timeout: 180_000,
        });

        if (existsSync(outPath)) {
          logger.info('status bar app built successfully', { path: outPath });
          return outPath;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`swiftc build failed (${label})`, { error: message.slice(0, 500) });
      }
    }

    return null;
  }

  private resolveSwiftcPaths(): Array<{ swiftc: string; label: string; env: Record<string, string> }> {
    const candidates: Array<{ swiftc: string; label: string; env: Record<string, string> }> = [];

    if (process.env.DEVELOPER_DIR) {
      candidates.push({ swiftc: 'swiftc', label: 'env-DEVELOPER_DIR', env: {} });
      return candidates;
    }

    const xcodeSwiftc = path.join(DEFAULT_XCODE_DEVELOPER_DIR, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'bin', 'swiftc');
    if (existsSync(xcodeSwiftc)) {
      candidates.push({
        swiftc: xcodeSwiftc,
        env: { DEVELOPER_DIR: DEFAULT_XCODE_DEVELOPER_DIR },
        label: 'xcode-default',
      });
    }

    candidates.push({ swiftc: 'swiftc', label: 'default-path', env: {} });
    return candidates;
  }

  private resolveSourceDir(): string | null {
    return this.resolveSourceDirs(false)[0] ?? null;
  }

  private resolveSourceDirs(includeHistoricalVersions: boolean): string[] {
    const candidates: string[] = [];

    // Look relative to the installed version directory
    const currentFile = path.join(this.cacheDir, 'current');
    try {
      const current = readFileSync(currentFile, 'utf8').trim();
      if (current) {
        candidates.push(path.join(this.cacheDir, 'versions', current, 'app', 'macos-status-bar'));
      }
    } catch {
      // ignore
    }

    // Legacy installs and source/bundled CLI entrypoints must also work when
    // launched from a terminal whose working directory is outside the package.
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const roots = [
      path.join(this.cacheDir, 'package'),
      path.resolve(moduleDir, '..'),
      path.resolve(moduleDir, '../..'),
      process.cwd(),
    ];
    for (const root of roots) {
      candidates.push(path.join(root, 'app', 'macos-status-bar'));
    }

    if (includeHistoricalVersions) {
      try {
        const versionsDir = path.join(this.cacheDir, 'versions');
        for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            candidates.push(path.join(versionsDir, entry.name, 'app', 'macos-status-bar'));
          }
        }
      } catch {
        // No retained versions directory.
      }
    }

    return uniquePaths(candidates).filter(candidate => existsSync(path.join(candidate, 'Package.swift')));
  }

  private async isProcessRunning(pid: number, executablePath: string): Promise<boolean> {
    const command = await this.processCommandReader(pid);
    return commandMatchesExecutable(command, executablePath);
  }

  private async findRunningPids(): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-u', String(process.getuid!()), '-x', BINARY_NAME], { timeout: 5000 });
      return stdout
        .split('\n')
        .map(l => Number(l.trim()))
        .filter(n => Number.isInteger(n) && n > 0 && n !== process.pid);
    } catch {
      return [];
    }
  }

  private sendSignal(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await sleep(200);
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  private async fingerprint(executablePath: string): Promise<string | null> {
    try {
      const buffer = await fs.readFile(executablePath);
      return createHash('sha256').update(buffer).digest('hex');
    } catch {
      return null;
    }
  }

  private async prepareLogPath(): Promise<string> {
    const logDir = path.join(this.dataDir, 'logs', 'app-status-bar');
    await ensureDir(logDir);
    const today = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return path.join(logDir, `status-bar-app-${today}.log`);
  }

  private runtimeRecordPath(): string {
    return path.join(this.dataDir, 'logs', 'status-bar-app-runtime.json');
  }

  private async readRuntimeRecord(): Promise<StatusBarAppRuntime | null> {
    return readJsonFile<StatusBarAppRuntime>(this.runtimeRecordPath());
  }

  private async writeRuntimeRecord(record: StatusBarAppRuntime): Promise<void> {
    await ensureDir(path.dirname(this.runtimeRecordPath()));
    await writeJsonFile(this.runtimeRecordPath(), record);
  }

  private async removeRuntimeRecord(): Promise<void> {
    try {
      await fs.rm(this.runtimeRecordPath(), { force: true });
    } catch {
      // ignore
    }
  }
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map(candidate => path.resolve(candidate))));
}

function commandMatchesExecutable(command: string | null, executablePath: string): boolean {
  if (!command) return false;
  const normalized = command.trim();
  return normalized === executablePath || normalized.startsWith(`${executablePath} `);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

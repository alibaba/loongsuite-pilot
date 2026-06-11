import { existsSync, closeSync, openSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);
import { createHash } from 'node:crypto';
import { writeJsonFile, readJsonFile, ensureDir } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('StatusBarAppManager');

const BINARY_NAME = 'LoongSuitePilotMenuBarApp';
const STOP_TIMEOUT_MS = 3000;
const FORCE_STOP_TIMEOUT_MS = 1500;
const DEFAULT_XCODE_DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

interface StatusBarAppRuntime {
  executablePath: string;
  packageVersion: string;
  pid: number | null;
  executableFingerprint: string | null;
  updatedAt: string;
}

export class StatusBarAppManager {
  private readonly dataDir: string;
  private readonly packageVersion: string;

  constructor(options: { dataDir: string; packageVersion: string }) {
    this.dataDir = options.dataDir;
    this.packageVersion = options.packageVersion;
  }

  async syncDesiredState(enabled: boolean): Promise<void> {
    if (process.platform !== 'darwin') return;

    if (enabled) {
      await this.ensureStarted();
    } else {
      await this.stop('config-disabled');
    }
  }

  async stop(reason: string): Promise<void> {
    if (process.platform !== 'darwin') return;

    const runtime = await this.readRuntimeRecord();
    const stoppedPids = new Set<number>();

    if (runtime?.pid) {
      if (await this.isProcessRunning(runtime.pid, runtime.executablePath)) {
        this.sendSignal(runtime.pid, 'SIGTERM');
        stoppedPids.add(runtime.pid);
      }
    }

    // Also clean up any orphan processes
    const orphans = await this.findRunningPids();
    for (const pid of orphans) {
      if (!stoppedPids.has(pid)) {
        this.sendSignal(pid, 'SIGTERM');
        stoppedPids.add(pid);
      }
    }

    // Wait for graceful shutdown, then force kill
    for (const pid of stoppedPids) {
      const exited = await this.waitForExit(pid, STOP_TIMEOUT_MS);
      if (!exited) {
        this.sendSignal(pid, 'SIGKILL');
        await this.waitForExit(pid, FORCE_STOP_TIMEOUT_MS);
      }
    }

    await this.removeRuntimeRecord();

    if (stoppedPids.size > 0) {
      logger.info(`status bar app stopped (${reason})`, { pids: Array.from(stoppedPids) });
    }
  }

  private async ensureStarted(): Promise<void> {
    const runtime = await this.readRuntimeRecord();

    // Already running with correct version?
    if (runtime?.pid && await this.isProcessRunning(runtime.pid, runtime.executablePath)) {
      if (runtime.packageVersion === this.packageVersion) {
        logger.debug('status bar app already running', { pid: runtime.pid });
        return;
      }
      logger.info('replacing stale status bar app', {
        oldVersion: runtime.packageVersion,
        newVersion: this.packageVersion,
      });
      await this.stop('version-upgrade');
    }

    // Check if binary is available
    const executablePath = this.resolveExecutable();
    if (!executablePath) {
      logger.info('status bar app binary not available, attempting build');
      const built = await this.buildExecutable();
      if (!built) {
        logger.warn('status bar app not available (no binary, build failed or not possible)');
        return;
      }
      return this.spawnProcess(built);
    }

    return this.spawnProcess(executablePath);
  }

  private async spawnProcess(executablePath: string): Promise<void> {
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

    if (!child.pid) {
      logger.warn('spawn returned no pid, status bar app may not have started');
      return;
    }

    child.unref();

    await this.writeRuntimeRecord({
      executablePath,
      packageVersion: this.packageVersion,
      pid: child.pid,
      executableFingerprint: await this.fingerprint(executablePath),
      updatedAt: new Date().toISOString(),
    });

    logger.info('status bar app started', { pid: child.pid, executablePath });
  }

  private resolveExecutable(): string | null {
    const sourceDir = this.resolveSourceDir();
    if (!sourceDir || !existsSync(path.join(sourceDir, 'Package.swift'))) {
      return null;
    }

    // Check bundled binaries
    const arch = process.arch;
    const candidates = ['darwin-universal'];
    if (arch === 'arm64') candidates.push('darwin-arm64');
    else if (arch === 'x64') candidates.push('darwin-x64');

    for (const bundle of candidates) {
      const candidate = path.join(sourceDir, 'bin', bundle, BINARY_NAME);
      if (existsSync(candidate)) return candidate;
    }

    // Check previously built binary
    const builtPath = path.join(this.dataDir, 'apps', 'macos-status-bar', 'build', BINARY_NAME);
    if (existsSync(builtPath)) return builtPath;

    return null;
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
    // Look relative to the installed version directory
    const currentFile = path.join(this.dataDir, 'current');
    try {
      const current = readFileSync(currentFile, 'utf8').trim();
      if (current) {
        const candidate = path.join(this.dataDir, 'versions', current, 'app', 'macos-status-bar');
        if (existsSync(path.join(candidate, 'Package.swift'))) return candidate;
      }
    } catch {
      // ignore
    }

    // Fallback: relative to CWD (dev mode)
    const cwdCandidate = path.resolve(process.cwd(), 'app', 'macos-status-bar');
    if (existsSync(path.join(cwdCandidate, 'Package.swift'))) return cwdCandidate;

    return null;
  }

  private async isProcessRunning(pid: number, executablePath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 });
      return stdout.includes(executablePath) || stdout.includes(BINARY_NAME);
    } catch {
      return false;
    }
  }

  private async findRunningPids(): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-x', BINARY_NAME], { timeout: 5000 });
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

import * as fs from 'node:fs/promises';
import { createWriteStream, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import { ensureDir, fileExists } from '../utils/fs-utils.js';

const logger = createLogger('WorkerManifestSupervisor');

export interface WorkerManifest {
  name: string;
  runtime?: string;
  version?: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  paths?: {
    pid?: string;
    status?: string;
    log?: string;
  };
  restartPolicy?: {
    type?: 'never' | 'on-failure';
    maxRestarts?: number;
    backoffSeconds?: number;
  };
}

interface ManifestLocation {
  manifestPath: string;
  bundleRoot: string;
}

interface WorkerRuntime {
  restarts: number;
  stopping: boolean;
}

export interface WorkerManifestOptions {
  instance?: Record<string, string>;
  runtimeOptions?: Record<string, string | boolean>;
}

export class WorkerManifestSupervisor {
  private readonly runtimes = new Map<string, WorkerRuntime>();

  async startIfPresent(
    agentId: string,
    installDir: string,
    env: Record<string, string>,
    options: WorkerManifestOptions = {},
  ): Promise<boolean> {
    const location = await this.findManifest(installDir);
    if (!location) return true;

    await this.stopIfPresent(agentId, installDir, options);

    const manifest = await this.readManifest(location.manifestPath);
    if (!manifest) return false;

    return this.start(agentId, location.bundleRoot, manifest, env, options);
  }

  async stopIfPresent(
    agentId: string,
    installDir: string,
    options: WorkerManifestOptions = {},
  ): Promise<boolean> {
    const location = await this.findManifest(installDir);
    if (!location) return true;

    const manifest = await this.readManifest(location.manifestPath);
    if (!manifest) return false;

    return this.stop(agentId, location.bundleRoot, manifest, options);
  }

  async hasManifest(installDir: string): Promise<boolean> {
    return !!await this.findManifest(installDir);
  }

  async isWorkerRunning(installDir: string, options: WorkerManifestOptions = {}): Promise<boolean> {
    const location = await this.findManifest(installDir);
    if (!location) return false;

    const manifest = await this.readManifest(location.manifestPath);
    if (!manifest) return false;

    const paths = this.resolvePaths(location.bundleRoot, manifest, options);
    const pid = await this.readPid(paths.pid);
    return !!pid && this.isAlive(pid);
  }

  private async findManifest(installDir: string): Promise<ManifestLocation | undefined> {
    const direct = path.join(installDir, 'worker.manifest.json');
    if (await fileExists(direct)) {
      return { manifestPath: direct, bundleRoot: installDir };
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(installDir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bundleRoot = path.join(installDir, entry.name);
      const manifestPath = path.join(bundleRoot, 'worker.manifest.json');
      if (await fileExists(manifestPath)) {
        return { manifestPath, bundleRoot };
      }
    }

    return undefined;
  }

  private async readManifest(manifestPath: string): Promise<WorkerManifest | undefined> {
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as WorkerManifest;
      if (!parsed.name || !Array.isArray(parsed.command) || parsed.command.length === 0) {
        logger.warn('invalid worker manifest', { manifestPath });
        return undefined;
      }
      return parsed;
    } catch (err) {
      logger.warn('failed to read worker manifest', { manifestPath, error: String(err) });
      return undefined;
    }
  }

  private async start(
    agentId: string,
    bundleRoot: string,
    manifest: WorkerManifest,
    env: Record<string, string>,
    options: WorkerManifestOptions = {},
    runtime?: WorkerRuntime,
  ): Promise<boolean> {
    const paths = this.resolvePaths(bundleRoot, manifest, options);
    await ensureDir(path.dirname(paths.pid));
    await ensureDir(path.dirname(paths.status));
    await ensureDir(path.dirname(paths.log));

    const command = manifest.command.map(part => this.expand(part, bundleRoot, env, options));
    const executable = this.resolveCommand(bundleRoot, command[0]);
    const args = command.slice(1);
    const cwd = this.resolvePath(bundleRoot, this.expand(manifest.cwd ?? '.', bundleRoot, env, options));
    const workerEnv = {
      ...env,
      ...this.expandEnv(manifest.env ?? {}, bundleRoot, env, options),
    };
    const log = createWriteStream(paths.log, { flags: 'a' });

    await this.writeStatus(paths.status, {
      state: 'starting',
      name: manifest.name,
      agentId,
      startedAt: new Date().toISOString(),
      restartCount: 0,
    });

    try {
      const child = spawn(executable, args, {
        cwd,
        env: workerEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let settled = false;
      let startPersisted = false;
      let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const failStart = async (err: unknown): Promise<void> => {
        if (settled) return;
        settled = true;
        log.end();
        await fs.rm(paths.pid, { force: true });
        this.runtimes.delete(paths.pid);
        await this.writeStatus(paths.status, {
          state: 'failed',
          name: manifest.name,
          agentId,
          error: String(err),
          updatedAt: new Date().toISOString(),
        });
        logger.error('worker start failed', { agentId, error: String(err) });
      };

      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      child.once('error', err => {
        void failStart(err);
      });
      child.once('exit', (code, signal) => {
        if (settled) return;
        if (!startPersisted) {
          earlyExit = { code, signal };
          return;
        }
        settled = true;
        log.end();
        const activeRuntime = this.runtimes.get(paths.pid);
        if (activeRuntime) {
          void this.handleExit(agentId, bundleRoot, manifest, env, options, paths.pid, activeRuntime, code, signal);
        }
      });

      if (!child.pid) {
        await failStart(new Error('worker process did not expose a pid'));
        return false;
      }

      child.unref();
      if (settled) return false;

      const activeRuntime = runtime ?? { restarts: 0, stopping: false };
      this.runtimes.set(paths.pid, activeRuntime);
      await fs.writeFile(paths.pid, `${child.pid}\n`, 'utf-8');
      if (settled) return false;
      await this.writeStatus(paths.status, {
        state: 'running',
        name: manifest.name,
        agentId,
        pid: child.pid,
        startedAt: new Date().toISOString(),
        restartCount: runtime?.restarts ?? 0,
      });
      if (settled) return false;
      startPersisted = true;

      if (earlyExit) {
        settled = true;
        log.end();
        void this.handleExit(
          agentId,
          bundleRoot,
          manifest,
          env,
          options,
          paths.pid,
          activeRuntime,
          earlyExit.code,
          earlyExit.signal,
        );
      }

      logger.info('worker started', { agentId, pid: child.pid, manifest: manifest.name });
      return true;
    } catch (err) {
      log.end();
      await this.writeStatus(paths.status, {
        state: 'failed',
        name: manifest.name,
        agentId,
        error: String(err),
        updatedAt: new Date().toISOString(),
      });
      logger.error('worker start failed', { agentId, error: String(err) });
      return false;
    }
  }

  private async stop(
    agentId: string,
    bundleRoot: string,
    manifest: WorkerManifest,
    options: WorkerManifestOptions = {},
  ): Promise<boolean> {
    const paths = this.resolvePaths(bundleRoot, manifest, options);
    const runtime = this.runtimes.get(paths.pid);
    if (runtime) runtime.stopping = true;

    const pid = await this.readPid(paths.pid);
    if (!pid) return true;

    await this.writeStatus(paths.status, {
      state: 'stopping',
      name: manifest.name,
      agentId,
      pid,
      updatedAt: new Date().toISOString(),
    });

    try {
      this.signalProcessGroup(pid, 'SIGTERM');
    } catch (err) {
      logger.warn('failed to stop worker', { agentId, pid, error: String(err) });
      return false;
    }

    await this.waitForExit(pid, 5000);
    try {
      this.signalProcessGroup(pid, 'SIGKILL');
    } catch {
      // Process group may have exited between checks.
    }

    await fs.rm(paths.pid, { force: true });
    await this.writeStatus(paths.status, {
      state: 'stopped',
      name: manifest.name,
      agentId,
      pid,
      stoppedAt: new Date().toISOString(),
    });
    logger.info('worker stopped', { agentId, pid });
    return true;
  }

  private async handleExit(
    agentId: string,
    bundleRoot: string,
    manifest: WorkerManifest,
    env: Record<string, string>,
    options: WorkerManifestOptions,
    runtimeKey: string,
    runtime: WorkerRuntime,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const paths = this.resolvePaths(bundleRoot, manifest, options);
    await fs.rm(paths.pid, { force: true });

    const failed = code !== 0 || signal !== null;
    const policy = manifest.restartPolicy ?? {};
    const shouldRestart = !runtime.stopping
      && failed
      && policy.type === 'on-failure'
      && runtime.restarts < (policy.maxRestarts ?? 0);

    await this.writeStatus(paths.status, {
      state: shouldRestart ? 'restarting' : 'exited',
      name: manifest.name,
      agentId,
      exitCode: code,
      signal,
      restartCount: runtime.restarts,
      exitedAt: new Date().toISOString(),
    });

    if (!shouldRestart) {
      this.runtimes.delete(runtimeKey);
      return;
    }

    runtime.restarts += 1;
    const delayMs = Math.max(0, policy.backoffSeconds ?? 0) * 1000;
    setTimeout(() => {
      if (runtime.stopping) return;
      void this.start(agentId, bundleRoot, manifest, env, options, runtime);
    }, delayMs).unref();
  }

  private resolvePaths(
    bundleRoot: string,
    manifest: WorkerManifest,
    options: WorkerManifestOptions = {},
  ): { pid: string; status: string; log: string } {
    const defaults = {
      pid: '.agent-worker/worker.pid',
      status: '.agent-worker/status.json',
      log: '.agent-worker/worker.log',
    };
    return {
      pid: this.resolvePath(bundleRoot, this.expand(manifest.paths?.pid ?? defaults.pid, bundleRoot, {}, options)),
      status: this.resolvePath(bundleRoot, this.expand(manifest.paths?.status ?? defaults.status, bundleRoot, {}, options)),
      log: this.resolvePath(bundleRoot, this.expand(manifest.paths?.log ?? defaults.log, bundleRoot, {}, options)),
    };
  }

  private expandEnv(
    source: Record<string, string>,
    bundleRoot: string,
    env: Record<string, string>,
    options: WorkerManifestOptions,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      result[key] = this.expand(value, bundleRoot, env, options);
    }
    return result;
  }

  private expand(
    value: string,
    bundleRoot: string,
    env: Record<string, string>,
    options: WorkerManifestOptions = {},
  ): string {
    return value
      .replace(/\$\{destDir\}/g, bundleRoot)
      .replace(/\$\{instance:([^}]+)\}/g, (_match, name: string) => this.expandInstanceValue(name, options));
  }

  private expandInstanceValue(name: string, options: WorkerManifestOptions): string {
    const fixedValue = options.instance?.[name];
    if (fixedValue !== undefined) return fixedValue;

    const direct = options.runtimeOptions?.[name];
    if (direct !== undefined) return String(direct);

    const kebab = camelToKebab(name);
    const runtimeValue = options.runtimeOptions?.[kebab];
    return runtimeValue !== undefined ? String(runtimeValue) : '';
  }

  private resolveCommand(bundleRoot: string, command: string): string {
    if (path.isAbsolute(command)) return command;
    if (command.includes(path.sep) || command.startsWith('.')) {
      return path.join(bundleRoot, command);
    }
    return command;
  }

  private resolvePath(bundleRoot: string, value: string): string {
    return path.isAbsolute(value) ? value : path.join(bundleRoot, value);
  }

  private async readPid(pidPath: string): Promise<number | undefined> {
    try {
      const raw = await fs.readFile(pidPath, 'utf-8');
      const pid = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeStatus(statusPath: string, payload: Record<string, unknown>): Promise<void> {
    await ensureDir(path.dirname(statusPath));
    await fs.writeFile(statusPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
    try {
      // start() uses detached=true, so the child becomes the process-group leader on Linux/macOS.
      process.kill(-pgid, signal);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw err;
    }
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!this.isAlive(pid)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

function camelToKebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

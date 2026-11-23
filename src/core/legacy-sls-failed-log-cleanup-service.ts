import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LegacySlsFailureCleanup');

export const LEGACY_SLS_CLEANUP_STARTUP_DELAY_MS = 30_000;
export const LEGACY_SLS_CLEANUP_FILE_DELAY_MS = 100;
export const LEGACY_SLS_CLEANUP_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

export interface CleanupFileSystem {
  lstat(filePath: string): Promise<Stats>;
  rename(oldPath: string, newPath: string): Promise<void>;
  readdir(directory: string): Promise<Dirent[]>;
  unlink(filePath: string): Promise<void>;
  rmdir(directory: string): Promise<void>;
}

const defaultFileSystem: CleanupFileSystem = {
  lstat: filePath => fs.lstat(filePath),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  readdir: directory => fs.readdir(directory, { withFileTypes: true }),
  unlink: filePath => fs.unlink(filePath),
  rmdir: directory => fs.rmdir(directory),
};

export interface LegacySlsFailedLogCleanupOptions {
  startupDelayMs?: number;
  fileDelayMs?: number;
  retryDelaysMs?: readonly number[];
  fileSystem?: CleanupFileSystem;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface LegacySlsFailedLogCleanupResult {
  renamed: boolean;
  deleted: number;
  skipped: number;
  errors: number;
  logicalBytes: number;
}

export class LegacySlsFailedLogCleanupService {
  private readonly legacyDir: string;
  private readonly pendingDir: string;
  private readonly startupDelayMs: number;
  private readonly fileDelayMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly fileSystem: CleanupFileSystem;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<LegacySlsFailedLogCleanupResult> | null = null;

  constructor(dataDir: string, options: LegacySlsFailedLogCleanupOptions = {}) {
    this.legacyDir = path.join(dataDir, 'sls-failed-logs');
    this.pendingDir = path.join(dataDir, 'sls-failed-logs.delete-pending');
    this.startupDelayMs = options.startupDelayMs ?? LEGACY_SLS_CLEANUP_STARTUP_DELAY_MS;
    this.fileDelayMs = options.fileDelayMs ?? LEGACY_SLS_CLEANUP_FILE_DELAY_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? LEGACY_SLS_CLEANUP_RETRY_DELAYS_MS;
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.delay = options.delay ?? unrefDelay;
  }

  start(): void {
    if (this.startupTimer || this.running) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.runCleanup();
    }, this.startupDelayMs);
    this.startupTimer.unref();
  }

  stop(): void {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  async runCleanup(): Promise<LegacySlsFailedLogCleanupResult> {
    if (this.running) return this.running;
    this.running = this.runOnce()
      .catch(err => {
        logger.warn('legacy SLS failure cleanup failed', { error: String(err) });
        return emptyResult(1);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async runOnce(): Promise<LegacySlsFailedLogCleanupResult> {
    const result = emptyResult();
    const pendingErrors = result.errors;
    const pendingStat = await this.safeLstat(this.pendingDir, result);

    if (pendingStat) {
      if (pendingStat.isSymbolicLink() || !pendingStat.isDirectory()) {
        logger.warn('legacy pending path is not a regular directory; skipping', {
          path: path.basename(this.pendingDir),
        });
        result.skipped++;
        return result;
      }
      await this.cleanPendingDirectory(result);
      this.logResult(result);
      return result;
    }
    if (result.errors > pendingErrors) return result;

    const legacyErrors = result.errors;
    const legacyStat = await this.safeLstat(this.legacyDir, result);
    if (result.errors > legacyErrors) return result;
    if (!legacyStat) return result;
    if (legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) {
      logger.warn('legacy SLS failure path is not a regular directory; skipping', {
        path: path.basename(this.legacyDir),
      });
      result.skipped++;
      return result;
    }

    const renamed = await this.retryTransient(
      () => this.fileSystem.rename(this.legacyDir, this.pendingDir),
      path.basename(this.legacyDir),
      'rename',
    );
    if (!renamed) {
      result.errors++;
      return result;
    }
    result.renamed = true;

    await this.cleanPendingDirectory(result);
    this.logResult(result);
    return result;
  }

  private async cleanPendingDirectory(result: LegacySlsFailedLogCleanupResult): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await this.fileSystem.readdir(this.pendingDir);
    } catch (err) {
      result.errors++;
      logger.warn('failed to enumerate legacy SLS failure directory', {
        error: errorCode(err),
      });
      return;
    }

    const candidates = entries.filter(entry => isLegacyJsonlName(entry.name));
    for (const entry of entries) {
      if (isLegacyJsonlName(entry.name)) continue;
      result.skipped++;
      logger.warn('skipping unknown legacy SLS failure entry', {
        file: entry.name,
        reason: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'name',
      });
    }

    for (let index = 0; index < candidates.length; index++) {
      const entry = candidates[index];
      const fullPath = path.join(this.pendingDir, entry.name);
      let stat: Stats;
      try {
        stat = await this.fileSystem.lstat(fullPath);
      } catch (err) {
        result.errors++;
        logger.warn('failed to inspect legacy SLS failure file', {
          file: entry.name,
          error: errorCode(err),
        });
        continue;
      }

      if (stat.isSymbolicLink() || !stat.isFile()) {
        result.skipped++;
        logger.warn('skipping non-regular legacy SLS failure entry', { file: entry.name });
        continue;
      }

      const deleted = await this.retryTransient(
        () => this.fileSystem.unlink(fullPath),
        entry.name,
        'unlink',
        stat.size,
      );
      if (deleted) {
        result.deleted++;
        result.logicalBytes += stat.size;
      } else {
        result.errors++;
      }

      if (index < candidates.length - 1 && this.fileDelayMs > 0) {
        await this.delay(this.fileDelayMs);
      }
    }

    try {
      const remaining = await this.fileSystem.readdir(this.pendingDir);
      if (remaining.length === 0) await this.fileSystem.rmdir(this.pendingDir);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        result.errors++;
        logger.warn('failed to remove empty legacy pending directory', {
          error: errorCode(err),
        });
      }
    }
  }

  private async retryTransient(
    operation: () => Promise<void>,
    basename: string,
    operationName: 'rename' | 'unlink',
    logicalBytes?: number,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await operation();
        return true;
      } catch (err) {
        const code = errorCode(err);
        const retryDelay = this.retryDelaysMs[attempt];
        if (!isTransientFileError(code) || retryDelay === undefined) {
          logger.warn('legacy SLS failure cleanup operation failed', {
            operation: operationName,
            file: basename,
            logicalBytes,
            error: code,
            attempts: attempt + 1,
          });
          return false;
        }
        await this.delay(retryDelay);
      }
    }
  }

  private async safeLstat(
    filePath: string,
    result: LegacySlsFailedLogCleanupResult,
  ): Promise<Stats | null> {
    try {
      return await this.fileSystem.lstat(filePath);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        result.errors++;
        logger.warn('failed to inspect legacy SLS failure path', {
          path: path.basename(filePath),
          error: errorCode(err),
        });
      }
      return null;
    }
  }

  private logResult(result: LegacySlsFailedLogCleanupResult): void {
    if (!result.renamed && result.deleted === 0 && result.skipped === 0 && result.errors === 0) return;
    logger.info('legacy SLS failure cleanup complete', { ...result });
  }
}

export function isLegacyJsonlName(name: string): boolean {
  return !name.startsWith('.') && name.length > '.jsonl'.length && name.endsWith('.jsonl');
}

function emptyResult(errors = 0): LegacySlsFailedLogCleanupResult {
  return { renamed: false, deleted: 0, skipped: 0, errors, logicalBytes: 0 };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code) return code;
  }
  return String(error);
}

function isTransientFileError(code: string): boolean {
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function unrefDelay(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

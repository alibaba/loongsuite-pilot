import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { StatusBarConfig } from '../types/index.js';
import { writeJsonFile, ensureDir } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RuntimeWriter');

export interface RuntimeRecord {
  status: string;
  packageVersion: string;
  gitCommit?: string;
  pid: number;
  updatedAt: string;
}

export class RuntimeWriter {
  private readonly filePath: string;
  private readonly config: StatusBarConfig;
  private readonly packageVersion: string;
  private readonly gitCommit: string;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private pendingWrite: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;

  constructor(dataDir: string, config: StatusBarConfig, packageVersion: string, gitCommit = '') {
    this.filePath = path.join(dataDir, 'logs', 'runtime.json');
    this.config = config;
    this.packageVersion = packageVersion;
    this.gitCommit = gitCommit;
  }

  start(): void {
    if (this.intervalTimer || this.stopping) return;
    this.intervalTimer = setInterval(
      () => this.refresh(),
      this.config.runtimeRefreshIntervalMs,
    );
    this.refresh();

    logger.info('runtime writer started', {
      path: this.filePath,
      intervalMs: this.config.runtimeRefreshIntervalMs,
    });
  }

  stop(): Promise<void> {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.stopping ??= this.removeAfterWrite().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async removeAfterWrite(): Promise<void> {
    // An atomic write that has already started can publish after the timer stops.
    await this.pendingWrite;
    try {
      await fs.rm(this.filePath, { force: true });
    } catch {
      // Cleanup is best-effort if the file cannot be removed.
    }
    logger.info('runtime writer stopped');
  }

  private refresh(): void {
    if (!this.intervalTimer || this.pendingWrite) return;
    this.pendingWrite = this.write().finally(() => { this.pendingWrite = null; });
  }

  private async write(): Promise<void> {
    try {
      const record: RuntimeRecord = {
        status: 'active',
        packageVersion: this.packageVersion,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      };
      if (this.gitCommit) record.gitCommit = this.gitCommit;
      await ensureDir(path.dirname(this.filePath));
      await writeJsonFile(this.filePath, record);
    } catch (err) {
      logger.warn('failed to write runtime.json', { error: String(err) });
    }
  }
}

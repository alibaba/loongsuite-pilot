import * as fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import type { StatusBarConfig } from '../types/index.js';
import { writeJsonFile, ensureDir } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RuntimeWriter');

export interface RuntimeRecord {
  status: string;
  packageVersion: string;
  pid: number;
  updatedAt: string;
}

export class RuntimeWriter {
  private readonly filePath: string;
  private readonly config: StatusBarConfig;
  private readonly packageVersion: string;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string, config: StatusBarConfig, packageVersion: string) {
    this.filePath = path.join(dataDir, 'logs', 'runtime.json');
    this.config = config;
    this.packageVersion = packageVersion;
  }

  start(): void {
    if (!this.config.enabled) {
      logger.info('runtime writer disabled');
      return;
    }

    void this.write();

    this.intervalTimer = setInterval(
      () => void this.write(),
      this.config.runtimeRefreshIntervalMs,
    );

    logger.info('runtime writer started', {
      path: this.filePath,
      intervalMs: this.config.runtimeRefreshIntervalMs,
    });
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // ignore — file may not exist
    }
    logger.info('runtime writer stopped');
  }

  private async write(): Promise<void> {
    try {
      const record: RuntimeRecord = {
        status: 'active',
        packageVersion: this.packageVersion,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      };
      await ensureDir(path.dirname(this.filePath));
      await writeJsonFile(this.filePath, record);
    } catch (err) {
      logger.warn('failed to write runtime.json', { error: String(err) });
    }
  }
}

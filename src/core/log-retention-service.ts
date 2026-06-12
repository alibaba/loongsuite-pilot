import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LogRetentionConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LogRetention');

const DATE_REGEX = /(\d{4}-\d{2}-\d{2})\.\w+$/;
const STARTUP_DELAY_MS = 30_000;

type Category = 'history' | 'errors' | 'debug' | 'output' | 'sls-failed-logs';

const CATEGORY_DIR_MAP: Record<string, Category> = {
  history: 'history',
  errors: 'errors',
  debug: 'debug',
  output: 'output',
  'sls-failed-logs': 'sls-failed-logs',
};

export class LogRetentionService {
  private readonly logsDir: string;
  private readonly config: LogRetentionConfig;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string, config: LogRetentionConfig) {
    this.logsDir = path.join(dataDir, 'logs');
    this.config = config;
  }

  start(): void {
    if (!this.config.enabled) {
      logger.info('log retention disabled');
      return;
    }
    logger.info('scheduling log retention', {
      intervalMs: this.config.intervalMs,
      hookHistoryDays: this.config.hookHistoryDays,
      hookErrorDays: this.config.hookErrorDays,
      hookDebugDays: this.config.hookDebugDays,
      outputDays: this.config.outputDays,
      slsFailedDays: this.config.slsFailedDays,
    });

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.runCleanup();
      this.intervalTimer = setInterval(() => void this.runCleanup(), this.config.intervalMs);
    }, STARTUP_DELAY_MS);
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  async runCleanup(): Promise<{ deleted: number; errors: number }> {
    const today = new Date().toISOString().slice(0, 10);
    let deleted = 0;
    let errors = 0;

    try {
      const topEntries = await readdir(this.logsDir);

      for (const entry of topEntries) {
        const entryPath = path.join(this.logsDir, entry);
        const stat = await safeStat(entryPath);
        if (!stat?.isDirectory()) continue;

        const category = CATEGORY_DIR_MAP[entry];
        if (category) {
          const result = await this.cleanDirectory(entryPath, category, today);
          deleted += result.deleted;
          errors += result.errors;
        } else {
          const subResult = await this.cleanSubdirectories(entryPath, today);
          deleted += subResult.deleted;
          errors += subResult.errors;
        }
      }
    } catch (err) {
      logger.warn('log retention scan failed', { error: String(err) });
      errors++;
    }

    if (deleted > 0 || errors > 0) {
      logger.info('log retention complete', { deleted, errors });
    }

    return { deleted, errors };
  }

  private async cleanSubdirectories(
    parentDir: string,
    today: string,
  ): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;

    const subEntries = await readdir(parentDir);
    for (const sub of subEntries) {
      const category = CATEGORY_DIR_MAP[sub];
      if (!category) continue;

      const subPath = path.join(parentDir, sub);
      const stat = await safeStat(subPath);
      if (!stat?.isDirectory()) continue;

      const result = await this.cleanDirectory(subPath, category, today);
      deleted += result.deleted;
      errors += result.errors;
    }

    return { deleted, errors };
  }

  private async cleanDirectory(
    dir: string,
    category: Category,
    today: string,
  ): Promise<{ deleted: number; errors: number }> {
    const retentionDays = this.getRetentionDays(category);
    const cutoff = dateCutoff(retentionDays);
    let deleted = 0;
    let errors = 0;

    const files = await readdir(dir);
    for (const file of files) {
      const dateStr = extractDate(file);
      if (!dateStr) continue;
      if (dateStr === today) continue;
      if (dateStr >= cutoff) continue;

      try {
        await fs.unlink(path.join(dir, file));
        deleted++;
      } catch (err) {
        logger.warn('failed to delete log file', { file: path.join(dir, file), error: String(err) });
        errors++;
      }
    }

    return { deleted, errors };
  }

  private getRetentionDays(category: Category): number {
    switch (category) {
      case 'history': return this.config.hookHistoryDays;
      case 'errors': return this.config.hookErrorDays;
      case 'debug': return this.config.hookDebugDays;
      case 'output': return this.config.outputDays;
      case 'sls-failed-logs': return this.config.slsFailedDays;
    }
  }
}

export function extractDate(filename: string): string | null {
  const match = DATE_REGEX.exec(filename);
  if (!match) return null;
  const d = match[1];
  const parts = d.split('-').map(Number);
  if (parts.length !== 3) return null;
  const [y, m, day] = parts;
  if (y < 2020 || y > 2099 || m < 1 || m > 12 || day < 1 || day > 31) return null;
  return d;
}

function dateCutoff(retentionDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - retentionDays);
  return d.toISOString().slice(0, 10);
}

async function readdir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function safeStat(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

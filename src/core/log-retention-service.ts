import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LogRetentionConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LogRetention');

const DATE_REGEX = /(\d{4}-\d{2}-\d{2})\.\w+$/;
const STARTUP_DELAY_MS = 30_000;
const MEBIBYTE = 1024 * 1024;

export const OUTPUT_RETENTION_MAX_TOTAL_BYTES = 2 * 1024 * MEBIBYTE;
export const OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES = 512 * MEBIBYTE;
export const OUTPUT_RETENTION_LARGE_FILE_DAYS = 2;
export const OUTPUT_RETENTION_PRESSURE_MIN_KEEP_DAYS = 1;

type Category = 'history' | 'errors' | 'debug' | 'output' | 'sls-failed-logs';

interface DatedLogFile {
  file: string;
  fullPath: string;
  dateStr: string;
  size: number;
}

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
      outputMaxTotalBytes: OUTPUT_RETENTION_MAX_TOTAL_BYTES,
      outputLargeFileThresholdBytes: OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES,
      outputLargeFileDays: OUTPUT_RETENTION_LARGE_FILE_DAYS,
      outputPressureMinKeepDays: OUTPUT_RETENTION_PRESSURE_MIN_KEEP_DAYS,
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
    let deleted = 0;
    let errors = 0;

    const files = await readdir(dir);
    if (category === 'output') {
      return this.cleanOutputDirectory(dir, files, today);
    }

    const retentionDays = this.getRetentionDays(category);
    const cutoff = dateCutoff(retentionDays);
    for (const file of files) {
      const dateStr = extractDate(file);
      if (!dateStr) continue;
      if (dateStr === today) continue;
      if (dateStr >= cutoff) continue;

      if (await this.deleteFile(path.join(dir, file))) {
        deleted++;
      } else {
        errors++;
      }
    }

    return { deleted, errors };
  }

  private async cleanOutputDirectory(
    dir: string,
    files: string[],
    today: string,
  ): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    let remaining = await this.collectDatedOutputFiles(dir, files);

    const regularCutoff = dateCutoff(this.config.outputDays);
    const regularResult = await this.deleteDatedFiles(
      remaining,
      file => file.dateStr !== today && file.dateStr < regularCutoff,
    );
    deleted += regularResult.deleted;
    errors += regularResult.errors;
    remaining = remaining.filter(file => !regularResult.attemptedPaths.has(file.fullPath));

    const largeFileCutoff = dateCutoff(OUTPUT_RETENTION_LARGE_FILE_DAYS);
    const largeFileResult = await this.deleteDatedFiles(
      remaining,
      file => file.dateStr !== today
        && file.dateStr < largeFileCutoff
        && file.size > OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES,
    );
    deleted += largeFileResult.deleted;
    errors += largeFileResult.errors;
    remaining = remaining.filter(file => !largeFileResult.attemptedPaths.has(file.fullPath));

    const pressureResult = await this.enforceOutputSizeLimit(remaining, today);
    deleted += pressureResult.deleted;
    errors += pressureResult.errors;

    return { deleted, errors };
  }

  private async collectDatedOutputFiles(dir: string, files: string[]): Promise<DatedLogFile[]> {
    const result: DatedLogFile[] = [];
    for (const file of files) {
      const dateStr = extractDate(file);
      if (!dateStr) continue;

      const fullPath = path.join(dir, file);
      const stat = await safeStat(fullPath);
      if (!stat?.isFile()) continue;

      result.push({
        file,
        fullPath,
        dateStr,
        size: stat.size,
      });
    }
    return result;
  }

  private async deleteDatedFiles(
    files: DatedLogFile[],
    shouldDelete: (file: DatedLogFile) => boolean,
  ): Promise<{ deleted: number; errors: number; attemptedPaths: Set<string> }> {
    let deleted = 0;
    let errors = 0;
    const attemptedPaths = new Set<string>();

    for (const file of files) {
      if (!shouldDelete(file)) continue;

      attemptedPaths.add(file.fullPath);
      if (await this.deleteFile(file.fullPath)) {
        deleted++;
      } else {
        errors++;
      }
    }

    return { deleted, errors, attemptedPaths };
  }

  private async enforceOutputSizeLimit(
    files: DatedLogFile[],
    today: string,
  ): Promise<{ deleted: number; errors: number }> {
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes <= OUTPUT_RETENTION_MAX_TOTAL_BYTES) {
      return { deleted: 0, errors: 0 };
    }

    const minKeepCutoff = dateCutoff(OUTPUT_RETENTION_PRESSURE_MIN_KEEP_DAYS);
    const candidates = files
      .filter(file => file.dateStr !== today && file.dateStr < minKeepCutoff)
      .sort((a, b) => a.dateStr.localeCompare(b.dateStr)
        || b.size - a.size
        || a.file.localeCompare(b.file));

    let deleted = 0;
    let errors = 0;
    for (const file of candidates) {
      if (totalBytes <= OUTPUT_RETENTION_MAX_TOTAL_BYTES) break;

      if (await this.deleteFile(file.fullPath)) {
        deleted++;
        totalBytes -= file.size;
      } else {
        errors++;
      }
    }

    return { deleted, errors };
  }

  private async deleteFile(file: string): Promise<boolean> {
    try {
      await fs.unlink(file);
      return true;
    } catch (err) {
      logger.warn('failed to delete log file', { file, error: String(err) });
      return false;
    }
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

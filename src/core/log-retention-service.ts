import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LogRetentionConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { SLS_FAILURE_LOG_MAX_TOTAL_BYTES } from '../flushers/sls-failure-log-writer.js';
import { parseOutputSegment } from '../utils/jsonl-output-file.js';
import { LOCAL_LOG_EMERGENCY_FILE_BYTES, withJsonlFileLock } from '../utils/segmented-jsonl-writer.js';
import type { StateStore } from '../checkpoints/state-store.js';

const logger = createLogger('LogRetention');

const DATE_REGEX = /(\d{4}-\d{2}-\d{2})\.\w+$/;
const STARTUP_DELAY_MS = 30_000;
export const LOCAL_MIRROR_PRESSURE_INTERVAL_MS = 60_000;
const MEBIBYTE = 1024 * 1024;

export const OUTPUT_RETENTION_MAX_TOTAL_BYTES = 2 * 1024 * MEBIBYTE;
export const RAW_SOURCE_RETENTION_MAX_TOTAL_BYTES = 2 * 1024 * MEBIBYTE;
export const OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES = 512 * MEBIBYTE;
export const OUTPUT_RETENTION_LARGE_FILE_DAYS = 2;
export const OUTPUT_RETENTION_PRESSURE_MIN_KEEP_DAYS = 1;
export const SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES = SLS_FAILURE_LOG_MAX_TOTAL_BYTES;
export const OTLP_FAILED_RETENTION_MAX_TOTAL_BYTES = 512 * MEBIBYTE;
export const METRIC_ALARM_RETENTION_MAX_TOTAL_BYTES = 256 * MEBIBYTE;
export const LOCAL_OBSERVABILITY_PRESSURE_MIN_KEEP_DAYS = 1;

const METRIC_ALARM_STREAM_NAMES = new Set([
  'pilot-metrics',
  'pilot-agent-metrics',
  'pilot-flusher-metrics',
  'pilot-input-metrics',
  'pilot-hook-metrics',
  'pilot-alarm-metrics',
  'pilot-alarms',
  'pilot-updater-events',
]);

type Category =
  | 'history'
  | 'errors'
  | 'debug'
  | 'output'
  | 'otlp-debug'
  | 'sls-failed-logs'
  | 'otlp-failed'
  | 'metric_alarm';

interface DatedLogFile {
  file: string;
  fullPath: string;
  dateStr: string;
  size: number;
  mtimeMs: number;
}

const CATEGORY_DIR_MAP: Record<string, Category> = {
  history: 'history',
  errors: 'errors',
  debug: 'debug',
  output: 'output',
  'otlp-debug': 'otlp-debug',
  'sls-failed-logs': 'sls-failed-logs',
  'otlp-failed': 'otlp-failed',
  metric_alarm: 'metric_alarm',
};

export class LogRetentionService {
  private readonly logsDir: string;
  private readonly config: LogRetentionConfig;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private pressureTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupPromise: Promise<{ deleted: number; errors: number }> | null = null;
  private pressureOnlyCleanup = false;
  private deletedBytes = 0;

  constructor(dataDir: string, config: LogRetentionConfig, private readonly stateStore?: StateStore) {
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
      otlpFailedDays: this.config.otlpFailedDays,
      metricAlarmDays: this.config.metricAlarmDays,
      outputMaxTotalBytes: OUTPUT_RETENTION_MAX_TOTAL_BYTES,
      outputLargeFileThresholdBytes: OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES,
      outputLargeFileDays: OUTPUT_RETENTION_LARGE_FILE_DAYS,
      outputPressureMinKeepDays: OUTPUT_RETENTION_PRESSURE_MIN_KEEP_DAYS,
      mirrorEmergencyFileBytes: LOCAL_LOG_EMERGENCY_FILE_BYTES,
      mirrorPressureIntervalMs: LOCAL_MIRROR_PRESSURE_INTERVAL_MS,
      slsFailedMaxTotalBytes: SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES,
      otlpFailedMaxTotalBytes: OTLP_FAILED_RETENTION_MAX_TOTAL_BYTES,
      metricAlarmMaxTotalBytes: METRIC_ALARM_RETENTION_MAX_TOTAL_BYTES,
      localObservabilityPressureMinKeepDays: LOCAL_OBSERVABILITY_PRESSURE_MIN_KEEP_DAYS,
    });

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.runCleanup();
      this.intervalTimer = setInterval(() => void this.runCleanup(), this.config.intervalMs);
      if (this.config.intervalMs > LOCAL_MIRROR_PRESSURE_INTERVAL_MS) {
        this.pressureTimer = setInterval(() => void this.runPressureCleanup(), LOCAL_MIRROR_PRESSURE_INTERVAL_MS);
      }
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
    if (this.pressureTimer) {
      clearInterval(this.pressureTimer);
      this.pressureTimer = null;
    }
  }

  runCleanup(): Promise<{ deleted: number; errors: number }> {
    return this.scheduleCleanup(false);
  }

  /** Fast pressure checks scan only managed output/debug/failed directories. */
  runPressureCleanup(): Promise<{ deleted: number; errors: number }> {
    return this.scheduleCleanup(true);
  }

  private scheduleCleanup(pressureOnly: boolean): Promise<{ deleted: number; errors: number }> {
    if (this.cleanupPromise) {
      if (!pressureOnly && this.pressureOnlyCleanup) return this.cleanupPromise.then(() => this.runCleanup());
      return this.cleanupPromise;
    }
    this.pressureOnlyCleanup = pressureOnly;
    this.cleanupPromise = this.runCleanupOnce(pressureOnly).finally(() => { this.cleanupPromise = null; });
    return this.cleanupPromise;
  }

  private async runCleanupOnce(pressureOnly: boolean): Promise<{ deleted: number; errors: number }> {
    this.deletedBytes = 0;
    const today = localDateString(new Date());
    let deleted = 0;
    let errors = 0;
    const raw = await this.cleanRawHookSources(pressureOnly);
    deleted += raw.deleted;
    errors += raw.errors;
    const sessions = await this.cleanRawSessionSources();
    deleted += sessions.deleted;
    errors += sessions.errors;

    try {
      const topEntries = await readdir(this.logsDir);

      for (const entry of topEntries) {
        if (pressureOnly && entry !== 'output' && entry !== 'otlp-debug' && entry !== 'otlp-failed') continue;
        const entryPath = path.join(this.logsDir, entry);
        const stat = await safeLstat(entryPath);
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
      logger.info('log retention complete', { deleted, deletedBytes: this.deletedBytes, errors });
    }

    return { deleted, errors };
  }

  /**
   * Raw input is not a diagnostic mirror. Only the input's durable cursor can
   * authorize reclamation; age/pressure alone never authorizes data loss.
   */
  private async cleanRawHookSources(pressureOnly: boolean): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    if (!this.stateStore) return { deleted, errors };
    for (const id of this.stateStore.keys()) {
      const extra = this.stateStore.get(id).extra;
      const dir = extra?.hookLogDir;
      const prefix = extra?.hookLogPrefix;
      if (typeof dir !== 'string' || typeof prefix !== 'string'
        || path.dirname(dir) !== this.logsDir || !this.stateStore.isPersisted(id)) continue;
      try {
        // Never traverse a substituted symlink, even if the checkpoint names it.
        if (await fs.realpath(dir) !== path.resolve(dir)) continue;
        const files = (await fs.readdir(dir)).filter(file =>
          file.startsWith(prefix + '-') && /\.jsonl$/.test(file));
        let totalBytes = 0;
        for (const file of files) totalBytes += (await safeLstat(path.join(dir, file)))?.size ?? 0;
        for (const file of files.sort()) {
          const date = /-(\d{4}-\d{2}-\d{2})(?:\.segment-\d{12}-[a-f0-9]{32})?\.jsonl$/.exec(file)?.[1];
          const expired = date !== undefined && date < dateCutoff(this.config.hookHistoryDays);
          if ((pressureOnly || !expired) && totalBytes <= RAW_SOURCE_RETENTION_MAX_TOTAL_BYTES) continue;
          const base = file.replace(/\.segment-\d{12}-[a-f0-9]{32}(?=\.jsonl$)/, '');
          const fullPath = path.join(dir, file);
          // This is the writer's cross-process lock, not the collector-local
          // promise lock used for output mirrors. A busy writer is skipped.
          const lock = await fs.open(path.join(dir, base + '.lock'), 'wx').catch(error => {
            if (error.code === 'EEXIST') return null;
            throw error;
          });
          if (!lock) continue;
          try {
            await lock.writeFile(String(process.pid));
            const state = this.stateStore.get(id);
            if (!this.stateStore.isPersisted(id)) continue;
            const offsets = state.extra?.hookLogOffsets as Record<string, number> | undefined;
            const identities = state.extra?.hookLogIdentities as Record<string, string> | undefined;
            const stat = await safeLstat(fullPath);
            if (!stat?.isFile() || offsets?.[file] !== stat.size
              || identities?.[file] !== `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`) continue;
            const active = await fs.readFile(path.join(dir, base + '.active'), 'utf8').catch(error => {
              if (error.code === 'ENOENT') return undefined;
              throw error;
            });
            // Daily writers compute the date at every append. Keep two whole
            // days for timezone skew/late writers before treating an old,
            // quiet daily file as closed. Segment closure requires its pointer.
            const legacyClosed = !active && file === base && date !== undefined
              && date < dateCutoff(2) && localDateString(new Date(stat.mtimeMs)) < dateCutoff(2);
            if (!legacyClosed && !isPublishedSuccessor(file, base, active)) continue;
            await fs.unlink(fullPath);
            deleted++;
            totalBytes -= stat.size;
            this.deletedBytes += stat.size;
          } finally {
            await lock.close();
            await fs.unlink(path.join(dir, base + '.lock'));
          }
        }
        if (totalBytes > RAW_SOURCE_RETENTION_MAX_TOTAL_BYTES) {
          logger.warn('Raw input disk budget exceeded; preserving active or unconsumed source', {
            input: id, bytes: totalBytes, maxBytes: RAW_SOURCE_RETENTION_MAX_TOTAL_BYTES,
          });
        }
      } catch (error) {
        errors++;
        logger.warn('raw source retention failed', { input: id, error: String(error) });
      }
    }
    return { deleted, errors };
  }

  private async cleanRawSessionSources(): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    if (!this.stateStore) return { deleted, errors };
    for (const [input, family] of [['dsh-log', 'dsh'], ['hermes-agent-log', 'hermes-agent']]) {
      const dir = path.join(this.logsDir, family);
      const sources = this.stateStore.keys().filter(key => key.startsWith(input + ':'));
      const stats = new Map<string, Awaited<ReturnType<typeof safeLstat>>>();
      for (const key of sources) {
        const file = key.slice(input.length + 1);
        if (path.dirname(file) === dir) stats.set(file, await safeLstat(file));
      }
      let totalBytes = [...stats.values()].reduce((sum, stat) => sum + (stat?.size ?? 0), 0);
      for (const [file, observed] of stats) {
        if (!observed?.isFile() || !sources.length) continue;
        if (observed.mtimeMs >= Date.now() - this.config.hookHistoryDays * 86400_000
          && totalBytes <= RAW_SOURCE_RETENTION_MAX_TOTAL_BYTES) continue;
        const key = input + ':' + file;
        const base = file.replace(/\.segment-\d{12}-[a-f0-9]{32}(?=\.jsonl$)/, '');
        let lock: Awaited<ReturnType<typeof fs.open>> | null = null;
        try {
          if (await fs.realpath(dir) !== path.resolve(dir)) continue;
          lock = await fs.open(base + '.lock', 'wx').catch(error => {
            if (error.code === 'EEXIST') return null;
            throw error;
          });
          if (!lock) continue;
          await lock.writeFile(String(process.pid));
          const current = await safeLstat(file);
          const state = this.stateStore.get(key);
          if (!current?.isFile() || !this.stateStore.isPersisted(key)
            || current.ino !== observed.ino || current.birthtimeMs !== observed.birthtimeMs
            || state.extra?.inode !== current.ino || state.extra?.sourceBirthtimeMs !== current.birthtimeMs
            || state.lastOffset !== current.size) continue;
          const active = await fs.readFile(base + '.active', 'utf8').catch(error => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
          // Session age does not prove closure; DSH can resume an old session.
          let legacyProcessExited = false;
          const pid = !active && family === 'hermes-agent'
            ? /^hermes-agent-(\d+)-\d+-[a-f0-9]+\.jsonl$/.exec(path.basename(file))?.[1] : undefined;
          if (pid) {
            try { process.kill(Number(pid), 0); }
            catch (error) { legacyProcessExited = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
          }
          if (!legacyProcessExited && !isPublishedSuccessor(path.basename(file), path.basename(base), active)) continue;
          await fs.unlink(file);
          deleted++;
          this.deletedBytes += current.size;
          totalBytes -= current.size;
        } catch (error) {
          errors++;
          logger.warn('raw session retention failed', { input, error: String(error) });
        } finally {
          if (lock) {
            try {
              await lock.close();
              await fs.unlink(base + '.lock');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                errors++;
                logger.warn('raw session retention lock release failed', { input, error: String(error) });
              }
            }
          }
        }
      }
      if (totalBytes > RAW_SOURCE_RETENTION_MAX_TOTAL_BYTES) {
        logger.warn('Raw session disk budget exceeded; preserving active or unconsumed source', {
          input, bytes: totalBytes, maxBytes: RAW_SOURCE_RETENTION_MAX_TOTAL_BYTES,
        });
      }
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
      const stat = await safeLstat(subPath);
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
    if (category === 'output' || category === 'otlp-debug') {
      return this.cleanOutputDirectory(dir, files, today);
    }
    if (category === 'sls-failed-logs') {
      return this.cleanSlsFailedDirectory(dir, files, today);
    }
    if (category === 'otlp-failed' || category === 'metric_alarm') {
      return this.cleanLocalObservabilityDirectory(dir, files, category);
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

  private async cleanSlsFailedDirectory(
    dir: string,
    files: string[],
    today: string,
  ): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    let remaining = await this.collectDatedOutputFiles(dir, files);

    const cutoff = dateCutoff(this.config.slsFailedDays);
    const expiredResult = await this.deleteDatedFiles(
      remaining,
      file => file.dateStr !== today && file.dateStr < cutoff,
    );
    deleted += expiredResult.deleted;
    errors += expiredResult.errors;

    remaining = await this.collectDatedOutputFiles(dir, await readdir(dir));
    let totalBytes = remaining.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes <= SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES) {
      return { deleted, errors };
    }

    const activePaths = findActiveSlsFailureSegments(remaining, today);
    const candidates = remaining
      .filter(file => !activePaths.has(file.fullPath))
      .sort((a, b) => a.dateStr.localeCompare(b.dateStr)
        || a.file.localeCompare(b.file));

    for (const file of candidates) {
      if (totalBytes <= SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES) break;
      if (await this.deleteFile(file.fullPath)) {
        deleted++;
        totalBytes -= file.size;
      } else {
        errors++;
      }
    }

    return { deleted, errors };
  }

  private async cleanLocalObservabilityDirectory(
    dir: string,
    files: string[],
    category: 'otlp-failed' | 'metric_alarm',
  ): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    let remaining = await this.collectLocalObservabilityFiles(dir, files, category);
    if (category === 'otlp-failed') {
      const emergency = await this.reclaimOversizedFiles(remaining, true);
      deleted += emergency.deleted; errors += emergency.errors;
      remaining = await this.collectLocalObservabilityFiles(dir, await readdir(dir), category);
    }

    const retentionCutoff = dateCutoff(this.getRetentionDays(category));
    // Age cleanup protects recent failed evidence; closed failed segments can
    // still be discarded under pressure with an explicit warning below.
    const protectedFrom = dateCutoff(LOCAL_OBSERVABILITY_PRESSURE_MIN_KEEP_DAYS);
    const expired = await this.deleteDatedFiles(
      remaining,
      file => file.dateStr < protectedFrom && file.dateStr < retentionCutoff,
    );
    deleted += expired.deleted;
    errors += expired.errors;

    // Re-read after deletion so a failed unlink still contributes to pressure.
    remaining = await this.collectLocalObservabilityFiles(dir, await readdir(dir), category);
    let totalBytes = remaining.reduce((sum, file) => sum + file.size, 0);
    const maxTotalBytes = category === 'otlp-failed'
      ? OTLP_FAILED_RETENTION_MAX_TOTAL_BYTES
      : METRIC_ALARM_RETENTION_MAX_TOTAL_BYTES;
    if (totalBytes <= maxTotalBytes) return { deleted, errors };

    // Ordinary active files remain protected; closed failed segments do not.
    const candidates = remaining
      .filter(file => (category === 'otlp-failed' && parseOutputSegment(file.file) !== undefined)
        || file.dateStr < protectedFrom)
      .sort((a, b) => a.dateStr.localeCompare(b.dateStr)
        || a.mtimeMs - b.mtimeMs
        || a.file.localeCompare(b.file));

    for (const file of candidates) {
      if (totalBytes <= maxTotalBytes) break;
      if (await this.deleteFile(file.fullPath)) {
        deleted++;
        totalBytes -= file.size;
        if (category === 'otlp-failed') logger.warn('Discarded failed trace evidence under disk pressure', { file: file.fullPath, bytes: file.size });
      } else {
        errors++;
      }
    }

    return { deleted, errors };
  }

  private async collectLocalObservabilityFiles(
    dir: string,
    files: string[],
    category: 'otlp-failed' | 'metric_alarm',
  ): Promise<DatedLogFile[]> {
    const result: DatedLogFile[] = [];
    for (const file of files) {
      if (file.startsWith('.') || !file.endsWith('.jsonl')) continue;

      const extractedDate = extractDate(file);
      const dated = extractedDate !== null && this.isManagedDatedFile(file, extractedDate, category);
      const legacy = extractedDate === null && this.isManagedLegacyFile(file, category);
      if (!dated && !legacy) continue;

      const fullPath = path.join(dir, file);
      const stat = await safeLstat(fullPath);
      if (!stat?.isFile()) continue;
      result.push({
        file,
        fullPath,
        dateStr: extractedDate ?? localDateString(new Date(stat.mtimeMs)),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
    return result;
  }

  private isManagedDatedFile(
    file: string,
    dateStr: string,
    category: 'otlp-failed' | 'metric_alarm',
  ): boolean {
    if (category === 'otlp-failed') return true;
    const suffix = `-${dateStr}.jsonl`;
    if (!file.endsWith(suffix)) return false;
    return METRIC_ALARM_STREAM_NAMES.has(file.slice(0, -suffix.length));
  }

  private isManagedLegacyFile(
    file: string,
    category: 'otlp-failed' | 'metric_alarm',
  ): boolean {
    if (category === 'otlp-failed') return true;
    return METRIC_ALARM_STREAM_NAMES.has(file.slice(0, -'.jsonl'.length));
  }

  private async cleanOutputDirectory(
    dir: string,
    files: string[],
    today: string,
  ): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    let remaining = await this.collectDatedOutputFiles(dir, files);
    const emergency = await this.reclaimOversizedFiles(remaining, false);
    deleted += emergency.deleted; errors += emergency.errors;
    remaining = await this.collectDatedOutputFiles(dir, await readdir(dir));

    const regularCutoff = dateCutoff(this.config.outputDays);
    const regularResult = await this.deleteDatedFiles(
      remaining,
      file => file.dateStr !== today && file.dateStr < regularCutoff,
    );
    deleted += regularResult.deleted;
    errors += regularResult.errors;
    remaining = await this.collectDatedOutputFiles(dir, await readdir(dir));

    const largeFileCutoff = dateCutoff(OUTPUT_RETENTION_LARGE_FILE_DAYS);
    const largeFileResult = await this.deleteDatedFiles(
      remaining,
      file => file.dateStr !== today
        && file.dateStr < largeFileCutoff
        && file.size > OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES,
    );
    deleted += largeFileResult.deleted;
    errors += largeFileResult.errors;
    remaining = await this.collectDatedOutputFiles(dir, await readdir(dir));

    const pressureResult = await this.enforceOutputSizeLimit(remaining, today);
    deleted += pressureResult.deleted;
    errors += pressureResult.errors;

    return { deleted, errors };
  }

  private async reclaimOversizedFiles(files: DatedLogFile[], failedData: boolean): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    for (const file of files) {
      if (file.size <= LOCAL_LOG_EMERGENCY_FILE_BYTES) continue;
      try {
        const removed = await withJsonlFileLock(file.fullPath, async () => {
          const stat = await safeLstat(file.fullPath);
          if (!stat?.isFile() || stat.size <= LOCAL_LOG_EMERGENCY_FILE_BYTES) return false;
          await fs.unlink(file.fullPath);
          this.deletedBytes += stat.size;
          logger.warn('Deleted oversized local JSONL file', { file: file.fullPath, bytes: stat.size, discardedFailedData: failedData });
          return true;
        });
        if (removed) deleted++;
      } catch (error) {
        errors++;
        logger.warn('failed to delete oversized local JSONL file', { file: file.fullPath, error: String(error) });
      }
    }
    return { deleted, errors };
  }

  private async collectDatedOutputFiles(dir: string, files: string[]): Promise<DatedLogFile[]> {
    const result: DatedLogFile[] = [];
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = await safeLstat(fullPath);
      if (!stat?.isFile()) continue;
      const segment = parseOutputSegment(file);
      const dateStr = extractDate(file) ?? (segment?.date === 'all' ? localDateString(new Date(stat.mtimeMs))
        : file.endsWith('-all.jsonl') ? localDateString(new Date(stat.mtimeMs)) : null);
      if (!dateStr) continue;

      result.push({
        file,
        fullPath,
        dateStr,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
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
      .filter(file => parseOutputSegment(file.file) !== undefined
        || (file.dateStr !== today && file.dateStr < minKeepCutoff))
      .sort((a, b) => a.dateStr.localeCompare(b.dateStr)
        || a.mtimeMs - b.mtimeMs
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
      await withJsonlFileLock(file, async () => {
        const stat = await fs.lstat(file);
        await fs.unlink(file);
        this.deletedBytes += stat.size;
      });
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
      case 'otlp-debug': return this.config.outputDays;
      case 'sls-failed-logs': return this.config.slsFailedDays;
      case 'otlp-failed': return this.config.otlpFailedDays;
      case 'metric_alarm': return this.config.metricAlarmDays;
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

function isPublishedSuccessor(file: string, base: string, active: string | undefined): boolean {
  if (!active || path.basename(active) !== active || !active.startsWith(base.slice(0, -6) + '.segment-')) return false;
  const next = /\.segment-(\d{12})-[a-f0-9]{32}\.jsonl$/.exec(active);
  const current = /\.segment-(\d{12})-[a-f0-9]{32}\.jsonl$/.exec(file);
  return next !== null && Number(next[1]) > Number(current?.[1] ?? 0);
}

function dateCutoff(retentionDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - retentionDays);
  return localDateString(d);
}

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

async function safeLstat(p: string) {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

function findActiveSlsFailureSegments(files: DatedLogFile[], today: string): Set<string> {
  const latestByEndpoint = new Map<string, { segment: number; path: string }>();
  for (const file of files) {
    if (file.dateStr !== today) continue;
    const match = /^(.*)-(\d+)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file.file);
    if (!match || match[3] !== today) continue;
    const segment = Number(match[2]);
    const current = latestByEndpoint.get(match[1]);
    if (!current || segment > current.segment) {
      latestByEndpoint.set(match[1], { segment, path: file.fullPath });
    }
  }
  return new Set([...latestByEndpoint.values()].map(value => value.path));
}

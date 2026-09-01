import * as fs from 'node:fs/promises';
import type { Dir, Dirent, Stats } from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DiskUsageSampler');
export const DISK_USAGE_STALE_MS = 20 * 60_000;

export type DiskUsageStatus = 'pending' | 'ok' | 'partial' | 'timeout' | 'error' | 'stale';

export interface DiskUsageSnapshot {
  status: DiskUsageStatus;
  sampledAt?: number;
  scanMs?: number;
  dataBytes?: number;
  logsBytes?: number;
}

export interface DiskUsageSamplerOptions {
  dataDir: string;
  onSample?: (snapshot: DiskUsageSnapshot) => void;
  initialDelayMs?: number;
  intervalMs?: number;
  batchSize?: number;
  batchPauseMs?: number;
  maxDepth?: number;
  maxEntries?: number;
  budgetMs?: number;
}

interface DirectoryFrame {
  dir: Dir;
  path: string;
  identity: Stats;
  inLogs: boolean;
}

interface InFlightSample {
  generation: number;
  promise: Promise<void>;
}

class ScanInterrupted extends Error {
  constructor(readonly status: 'partial' | 'timeout' | 'error' | 'cancelled') {
    super(status);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function sameDirectory(actual: Stats, expected: Stats): boolean {
  return actual.isDirectory() && !actual.isSymbolicLink()
    && actual.dev === expected.dev && actual.ino === expected.ino;
}

/** Low-rate, bounded metadata traversal. It never reads file contents. */
export class DiskUsageSampler {
  private readonly options: Required<DiskUsageSamplerOptions>;
  private snapshot: DiskUsageSnapshot = { status: 'pending' };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelPause: (() => void) | null = null;
  private inFlight: InFlightSample | null = null;
  private active = false;
  private stopped = false;
  private generation = 0;
  private failures = 0;
  private nextAttemptAt = 0;

  constructor(options: DiskUsageSamplerOptions) {
    this.options = {
      initialDelayMs: 30_000,
      intervalMs: 10 * 60_000,
      batchSize: 100,
      batchPauseMs: 20,
      maxDepth: 32,
      maxEntries: 200_000,
      budgetMs: 60_000,
      onSample: () => {},
      ...options,
    };
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.stopped = false;
    this.nextAttemptAt = 0;
    this.schedule(this.options.initialDelayMs);
  }

  stop(): void {
    this.active = false;
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cancelPause?.();
    // An in-flight OS request cannot be cancelled; its continuation closes the
    // owned handles serially without publishing results or scheduling more IO.
  }

  getSnapshot(): DiskUsageSnapshot {
    const snapshot = { ...this.snapshot };
    if (snapshot.status === 'ok' && snapshot.sampledAt !== undefined
      && Date.now() - snapshot.sampledAt > DISK_USAGE_STALE_MS) {
      snapshot.status = 'stale';
    }
    return snapshot;
  }

  sample(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const generation = this.generation;
    const current = this.inFlight;
    if (current) {
      if (current.generation === generation) return current.promise;
      const retry = (): Promise<void> => this.sample();
      return current.promise.then(retry, retry);
    }
    const attempt = this.runSample(this.generation).finally(() => {
      if (this.inFlight?.promise === attempt) this.inFlight = null;
    });
    this.inFlight = { generation, promise: attempt };
    return attempt;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.active) return;
      if (Date.now() >= this.nextAttemptAt) void this.sample();
      // A fixed cadence skips busy scans instead of queuing catch-up work.
      this.schedule(this.options.intervalMs);
    }, delay);
    this.timer.unref();
  }

  private pause(): Promise<void> {
    return new Promise(resolve => {
      const finish = (): void => {
        clearTimeout(timer);
        this.cancelPause = null;
        resolve();
      };
      const timer = setTimeout(finish, this.options.batchPauseMs);
      timer.unref();
      this.cancelPause = finish;
    });
  }

  private async runSample(generation: number): Promise<void> {
    const startedAt = Date.now();
    const startedTick = performance.now();
    const frames: DirectoryFrame[] = [];
    let status: DiskUsageStatus = 'ok';
    let dataBytes = 0;
    let logsBytes = 0;
    let entries = 0;
    let rootOpened = false;
    let completed = false;

    const check = (): void => {
      if (generation !== this.generation) throw new ScanInterrupted('cancelled');
      if (performance.now() - startedTick >= this.options.budgetMs) {
        throw new ScanInterrupted('timeout');
      }
    };
    const io = async <T>(operation: () => Promise<T>): Promise<T> => {
      check();
      const result = await operation();
      check();
      return result;
    };
    const validateIdentity = async (frame: DirectoryFrame): Promise<void> => {
      const current = await io(() => fs.lstat(frame.path));
      if (!sameDirectory(current, frame.identity)) throw new ScanInterrupted('partial');
    };
    const validatePath = async (directory: string): Promise<void> => {
      const resolved = await io(() => fs.realpath(directory));
      if (path.relative(directory, resolved) !== '') throw new ScanInterrupted('partial');
    };
    const openDirectory = async (directory: string, identity: Stats, inLogs: boolean): Promise<void> => {
      await validatePath(directory);
      await io(async () => {
        // Node may synchronously lstat DT_UNKNOWN entries while converting its
        // read buffer. Keep that fallback bounded to one entry per read.
        const dir = await fs.opendir(directory, { bufferSize: 1 });
        // Register ownership before checking the budget: even a late open must
        // close its handle when timeout/stop is noticed after the OS returns.
        frames.push({ dir, path: directory, identity, inLogs });
      });
      await validateIdentity(frames[frames.length - 1]);
      await validatePath(directory);
    };
    const closeTop = async (): Promise<void> => {
      const frame = frames.pop()!;
      try {
        await frame.dir.close();
      } catch (error) {
        if (!hasCode(error, 'ERR_DIR_CLOSED')) {
          // Make one bounded cleanup retry, but do not hide the failed close.
          try { await frame.dir.close(); } catch { /* best effort */ }
          throw error;
        }
      }
    };
    const readEntry = async (frame: DirectoryFrame): Promise<Dirent | null> => {
      try {
        return await io(() => frame.dir.read());
      } catch (error) {
        if (error instanceof ScanInterrupted) throw error;
        if (hasCode(error, 'ENOENT') && frame === frames[0]) {
          try {
            await validateIdentity(frame);
          } catch (validationError) {
            if (hasCode(validationError, 'ENOENT')) throw new ScanInterrupted('error');
            throw validationError;
          }
        }
        // read() can fail while Node converts buffered DT_UNKNOWN entries and
        // discard entries not yet delivered. Unlike a child's lstat ENOENT,
        // continuing this directory stream cannot establish a complete total.
        throw new ScanInterrupted('partial');
      }
    };

    try {
      // A configured root may itself be a link; nested links are never followed.
      const root = await io(() => fs.realpath(this.options.dataDir));
      const identity = await io(() => fs.lstat(root));
      if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Invalid data directory');
      await openDirectory(root, identity, false);
      rootOpened = true;
      while (frames.length > 0) {
        check();
        if (entries >= this.options.maxEntries) throw new ScanInterrupted('partial');
        const frame = frames[frames.length - 1];
        try {
          // Check the open directory's identity before resolving child paths.
          // Node lacks portable openat/O_NOFOLLOW traversal: these checks detect
          // persistent replacements, not an atomic sandbox against hostile races.
          await validateIdentity(frame);
          const entry = await readEntry(frame);
          if (!entry) {
            await validatePath(frame.path);
            await closeTop();
            if (frames.length === 0) completed = true;
            else check();
            continue;
          }
          entries++;
          if (entries % this.options.batchSize === 0) {
            await this.pause();
            check();
          }
          if (entry.isSymbolicLink()) continue;
          const childPath = path.join(frame.path, entry.name);
          // Dirent can be stale; lstat also rejects a newly substituted link.
          const child = await io(() => fs.lstat(childPath));
          if (child.isSymbolicLink()) continue;
          if (child.isDirectory()) {
            if (frames.length >= this.options.maxDepth) throw new ScanInterrupted('partial');
            await openDirectory(childPath, child, frame.inLogs
              || path.relative(path.join(root, 'logs'), childPath) === '');
          } else if (child.isFile()) {
            // Recheck after the path-based lookup so an observed replacement
            // cannot turn an external file's metadata into a valid sample.
            await validateIdentity(frame);
            dataBytes += child.size;
            if (frame.inLogs) logsBytes += child.size;
          }
        } catch (error) {
          if (hasCode(error, 'ENOENT')) {
            // Ordinary churn is expected. A vanished open directory must be
            // removed too, otherwise retrying it would spin until timeout.
            try {
              await validateIdentity(frame);
            } catch (validationError) {
              if (!hasCode(validationError, 'ENOENT')) throw validationError;
              if (frame.path === root) throw new ScanInterrupted('error');
              while (frames.includes(frame)) await closeTop();
            }
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof ScanInterrupted) {
        status = error.status === 'cancelled' ? 'error' : error.status;
      } else {
        status = rootOpened ? 'partial' : 'error';
      }
    } finally {
      while (frames.length > 0) {
        try {
          await closeTop();
        } catch {
          if (status === 'ok') status = 'partial';
        }
      }
    }
    if (generation !== this.generation) return;
    if (status === 'ok' && !completed
      && performance.now() - startedTick >= this.options.budgetMs) status = 'timeout';
    const scanMs = Math.max(0, Math.round(performance.now() - startedTick));
    this.snapshot = status === 'ok'
      ? { status, dataBytes, logsBytes, sampledAt: Date.now(), scanMs }
      : { ...this.snapshot, status, scanMs };
    this.failures = status === 'ok' ? 0 : this.failures + 1;
    const multiplier = this.failures < 2 ? 1 : Math.min(6, 2 ** Math.min(this.failures - 1, 3));
    this.nextAttemptAt = startedAt + this.options.intervalMs * multiplier;
    if (status !== 'ok') logger.debug('Directory usage scan incomplete', { status, scanMs });
    try {
      this.options.onSample(this.getSnapshot());
    } catch (error) {
      logger.warn('Directory usage sample callback failed', { err: error });
    }
  }
}

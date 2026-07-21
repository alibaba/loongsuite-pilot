import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { UpstreamLinkConfig } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AcpCorrelateRetention');

const STARTUP_DELAY_MS = 30_000;
const INTERVAL_MS = 21_600_000; // 6h scan cadence

/** In-memory state that should be evicted on the same TTL as the disk files. */
export interface IdlePrunable {
  pruneIdle(cutoffMs: number): void;
}

/**
 * Cleans up stale correlation files/locks under `${dataDir}/acp-correlate/`.
 * Files older than `config.ttlMs` (by mtime) are removed. If a prunable is
 * given (the TraceLinker), its idle in-memory state is evicted on the same
 * cadence/TTL so the per-session maps stay bounded. Runs periodically with an
 * unref'd timer so it never keeps the process alive.
 */
export class AcpCorrelateRetentionService {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly prunable?: IdlePrunable;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string, config: UpstreamLinkConfig, prunable?: IdlePrunable) {
    this.dir = path.join(dataDir, 'acp-correlate');
    this.ttlMs = config.ttlMs;
    this.prunable = prunable;
  }

  start(): void {
    logger.info('scheduling acp-correlate retention', { ttlMs: this.ttlMs });
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.runCleanup();
      this.intervalTimer = setInterval(() => void this.runCleanup(), INTERVAL_MS);
      this.intervalTimer.unref();
    }, STARTUP_DELAY_MS);
    this.startupTimer.unref();
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
    const cutoff = Date.now() - this.ttlMs;
    let deleted = 0;
    let errors = 0;

    // Evict idle in-memory state on the same TTL (independent of file presence).
    try {
      this.prunable?.pruneIdle(cutoff);
    } catch (err) {
      logger.warn('failed to prune idle upstream-link state', { error: String(err) });
    }

    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return { deleted, errors }; // dir absent → nothing to do
    }

    for (const file of files) {
      const full = path.join(this.dir, file);
      try {
        const stat = await fs.stat(full);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        await fs.unlink(full);
        deleted++;
      } catch (err) {
        logger.warn('failed to clean correlation file', { file: full, error: String(err) });
        errors++;
      }
    }

    if (deleted > 0 || errors > 0) {
      logger.info('acp-correlate retention complete', { deleted, errors });
    }
    return { deleted, errors };
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HOOK_METRICS_SPOOL_MAX_BYTES,
  hookMetricsSpoolDir,
  isHookMetricName,
  rotateHookTimingSpool,
} from '../../assets/hooks/shared/hook-metrics.mjs';
import { createLogger } from '../utils/logger.js';
import type { HookTimingStats } from './metrics-collector.js';

const logger = createLogger('HookMetricsSpool');

/** At most 64 agent/event combinations per cycle so anomalous samples cannot inflate the reported row count. */
const MAX_TIMING_KEYS = 64;
/** A duration beyond one day is treated as a corrupted sample. */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const SPOOL_FILE_PATTERN = /^(.+)\.jsonl(?:\.draining)?$/;

/**
 * Consume the hooks' timing files, aggregated per agent/event into one L2 cycle's stats.
 *
 * The file is moved away under the write lock before reading; later hooks append to
 * a fresh active file. Samples count only after the pending file is deleted
 * successfully; on read or delete failure it is kept for the next cycle. This is
 * best-effort accounting and does not promise exactly-once after a process crash
 * or a failed send.
 */
export class HookMetricsSpool {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = hookMetricsSpoolDir(dataDir);
  }

  drain(): HookTimingStats[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      // The directory may not exist before the first call; keep diagnostics for other failures.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('hook timing spool directory unreadable', { error: String(err) });
      }
      return [];
    }

    const agents = new Set<string>();
    for (const name of names) {
      const agent = SPOOL_FILE_PATTERN.exec(name)?.[1];
      if (isHookMetricName(agent)) agents.add(agent);
    }

    const totals = new Map<string, HookTimingStats>();
    for (const agent of agents) {
      const spool = path.join(this.dir, `${agent}.jsonl`);
      const draining = `${spool}.draining`;
      try {
        // Handle the file left over from a previous interrupted run first.
        this.consume(draining, agent, totals);
        // Must not overwrite samples that have not been consumed successfully.
        if (!fs.existsSync(draining) && rotateHookTimingSpool(spool, draining)) {
          this.consume(draining, agent, totals);
        }
      } catch (err) {
        logger.warn('hook timing spool drain failed', { agent, error: String(err) });
      }
    }
    return [...totals.values()];
  }

  private consume(file: string, agent: string, totals: Map<string, HookTimingStats>): void {
    let content: string;
    try {
      // The producer has a size cap; never load an oversized file into memory so a
      // malformed file cannot block the collector.
      if (fs.statSync(file).size > HOOK_METRICS_SPOOL_MAX_BYTES) {
        fs.unlinkSync(file);
        logger.warn('discarded oversized hook timing spool', { agent });
        return;
      }
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    fs.unlinkSync(file);

    let rejected = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const sample = parseSample(line);
      if (!sample) {
        rejected++;
        continue;
      }
      const key = `${agent}\n${sample.hookEvent}`;
      let acc = totals.get(key);
      if (!acc) {
        if (totals.size >= MAX_TIMING_KEYS) {
          rejected++;
          continue;
        }
        acc = { agent, hookEvent: sample.hookEvent, calls: 0, totalDurationMs: 0, maxDurationMs: 0 };
        totals.set(key, acc);
      }
      acc.calls++;
      acc.totalDurationMs += sample.durationMs;
      if (sample.durationMs > acc.maxDurationMs) acc.maxDurationMs = sample.durationMs;
    }
    if (rejected > 0) logger.warn('skipped invalid hook timing samples', { agent, rejected });
  }
}

function parseSample(line: string): { hookEvent: string; durationMs: number } | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  const { hook_event: hookEvent, duration_ms: durationMs } = record as Record<string, unknown>;
  if (!isHookMetricName(hookEvent)) return null;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return null;
  if (durationMs < 0 || durationMs > MAX_DURATION_MS) return null;
  return { hookEvent, durationMs };
}

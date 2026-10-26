// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook call timing spool.
 *
 * Hooks only append timing samples to <dataDir>/state/hook-metrics/<agentId>.jsonl;
 * the collector then consumes them into the L2 type=hook self-monitoring rows.
 * Both sides share the path, lock, and capacity contract. Hooks run on the
 * host's interactive path, so recording must stay low-overhead and fail-open:
 * on failure only the sample is dropped.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { withSyncFileLock } from './sync-file-lock.mjs';

/** Cap for an agent's active sample file; once full, new samples are dropped without touching the host. */
export const HOOK_METRICS_SPOOL_MAX_BYTES = 1024 * 1024;

// Bounded lock wait, stale locks are reclaimable; self-monitoring must not block the host for long.
const LOCK_WAIT_MS = 50;
const LOCK_STALE_MS = 10_000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Agent and event names become dimensions and path fragments, so they must be bounded-length identifiers. */
export function isHookMetricName(value) {
  return typeof value === 'string' && NAME_PATTERN.test(value);
}

export function hookMetricsSpoolDir(dataDir) {
  return path.join(dataDir, 'state', 'hook-metrics');
}

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

/**
 * Sampled after the response is written, from Node's timeOrigin until processing ends.
 * Excludes wrapper-script startup, Node lookup, spool write, and process-exit time.
 */
export function recordHookTiming({ agentId, hookEvent, durationMs = performance.now() }) {
  try {
    if (!isHookMetricName(agentId)) return;
    const line = `${JSON.stringify({
      hook_event: isHookMetricName(hookEvent) ? hookEvent : 'unknown',
      duration_ms: Math.round(durationMs),
    })}\n`;
    const file = path.join(hookMetricsSpoolDir(pilotDataDir()), `${agentId}.jsonl`);
    withSyncFileLock(`${file}.lock`, LOCK_WAIT_MS, LOCK_STALE_MS, () => {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch (error) {
        // Treat only ENOENT as an empty file; drop the sample if the size cannot be confirmed.
        if (error?.code !== 'ENOENT') throw error;
      }
      if (size + Buffer.byteLength(line) > HOOK_METRICS_SPOOL_MAX_BYTES) return;
      fs.appendFileSync(file, line, 'utf8');
    });
  } catch {
    // fail-open: a failed self-monitoring write must not affect the host.
  }
}

/**
 * The collector moves the active file away under the write lock; later hooks append
 * to a fresh file. Never waits for the lock: if a pending file exists or the lock is
 * busy, leave it to the next cycle.
 */
export function rotateHookTimingSpool(spoolFile, drainingFile) {
  const result = withSyncFileLock(`${spoolFile}.lock`, 0, LOCK_STALE_MS, () => {
    if (fs.existsSync(drainingFile)) return false;
    try {
      fs.renameSync(spoolFile, drainingFile);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  });
  return result.acquired && result.value === true;
}

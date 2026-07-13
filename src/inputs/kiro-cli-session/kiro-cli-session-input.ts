// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * KiroCliSessionInput — delayed sidecar scan scheduler for Kiro CLI.
 *
 * Background
 *   Kiro CLI's interactive sessions write timing data into a sidecar JSON file
 *   (`~/.kiro/sessions/cli/<session_id>.json` → `user_turn_metadatas[]`)
 *   asynchronously after the stop hook fires. A naive synchronous read in the
 *   stop hook frequently observes `user_turn_metadatas: []` or missing turns,
 *   resulting in step records with `time_unix_nano=0`.
 *
 * Strategy
 *   The stop hook no longer reads anything: it just enqueues a "pending stop"
 *   record (cwd + offsets + assistant_response + userId) into
 *   `$PILOT_DATA/state/kiro-cli/pending-stops/ready/`, then sends SIGUSR1 to
 *   the daemon (PID read from `$PILOT_DATA/loongsuite-pilot.pid`) and returns
 *   `{}` immediately so kiro-cli never blocks on us.
 *
 *   On SIGUSR1, this input schedules a collect() after `MATURE_DELAY_MS`
 *   (default 10s) — enough time for the sidecar's `user_turn_metadatas[]` to
 *   be fully flushed. The collect cycle atomically claims each mature pending
 *   record (rename ready/ → inflight/) and spawns
 *   `node kiro-cli-hook-processor.mjs delayedCollect <pending-file>`. The
 *   subprocess reads the (now-mature) sidecar, builds full timing-aware
 *   records, and appends them to the daily hook-jsonl, picked up by
 *   KiroCliLogInput via the standard hook-jsonl pipeline.
 *
 *   A low-frequency poll (default 60s) runs as fallback in case the SIGUSR1
 *   signal is lost (e.g. PID file stale, daemon restarted without updating it).
 *
 *   Records older than `MAX_AGE_MS` (default 5 min) are processed with
 *   `--allow-fallback`, accepting whatever timing is available rather than
 *   discarding indefinitely.
 *
 *   On startup, any inflight markers left over from a previous run are
 *   recovered (renamed back to ready/) so we don't lose pending work.
 *
 *   This input itself never emits entries — it returns an empty array from
 *   collect(). All visible records flow out through KiroCliLogInput's
 *   standard pipeline once the subprocess finishes writing the JSONL.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';

const DEFAULT_MATURE_DELAY_MS = 10_000;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_SUBPROCESS_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_PROCESSES = 4;

export interface KiroCliSessionInputOptions extends InputOptions {
  /** Absolute path to the hook processor mjs (e.g. <pilotDir>/hooks/kiro-cli-hook-processor.mjs). */
  hookProcessorPath: string;
  /** Root data directory (e.g. ~/.loongsuite-pilot). */
  dataDir: string;
  /** ms a pending record must age before being processed (default 10s). */
  matureDelayMs?: number;
  /** ms after which we force --allow-fallback (default 5 min). */
  maxAgeMs?: number;
  /** subprocess wall-clock budget per pending file. */
  subprocessTimeoutMs?: number;
  /** how many pending files we'll spawn in parallel per cycle. */
  maxConcurrent?: number;
}

interface PendingRecord {
  schemaVersion?: number;
  enqueueMs?: number;
  cwd?: string;
  stopUnixMs?: number;
  sinceMs?: number;
  sessionSinceMs?: number;
  assistantResponse?: string | null;
  userId?: string;
}

interface PendingItem {
  readyPath: string;
  record: PendingRecord;
}

export class KiroCliSessionInput extends BaseInput {
  readonly id = 'kiro-cli-session';
  readonly agentType = ClientType.KiroCli;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  private readonly hookProcessorPath: string;
  private readonly readyDir: string;
  private readonly inflightDir: string;
  private readonly pidFilePath: string;
  private readonly matureDelayMs: number;
  private readonly maxAgeMs: number;
  private readonly subprocessTimeoutMs: number;
  private readonly maxConcurrent: number;
  private pendingCollectTimer: ReturnType<typeof setTimeout> | null = null;
  private signalHandler: (() => void) | null = null;

  constructor(opts: KiroCliSessionInputOptions) {
    super({
      stateStore: opts.stateStore,
      pollIntervalMs: opts.pollIntervalMs ?? 60_000,
    });
    this.hookProcessorPath = opts.hookProcessorPath;
    const pendingRoot = path.join(opts.dataDir, 'state', 'kiro-cli', 'pending-stops');
    this.readyDir = path.join(pendingRoot, 'ready');
    this.inflightDir = path.join(pendingRoot, 'inflight');
    this.pidFilePath = path.join(opts.dataDir, 'loongsuite-pilot.pid');
    this.matureDelayMs = opts.matureDelayMs ?? DEFAULT_MATURE_DELAY_MS;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.subprocessTimeoutMs = opts.subprocessTimeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_PROCESSES;
  }

  static getWatchPaths(dataDir = resolveHome('~/.loongsuite-pilot')): string[] {
    return [path.join(dataDir, 'state', 'kiro-cli', 'pending-stops')];
  }

  static async checkAvailability(
    hookProcessorPath: string,
  ): Promise<boolean> {
    try {
      await fs.access(hookProcessorPath);
      return true;
    } catch {
      return false;
    }
  }

  protected override async onStart(): Promise<void> {
    await this.ensureDirs();
    // Recover any inflight markers from a crashed previous run.
    const recovered = await this.recoverInflight();
    if (recovered > 0) {
      this.logger.info('recovered inflight pending-stops', { count: recovered });
    }
    // Register SIGUSR1 handler: stop hook sends this signal after enqueueing
    // a pending record. We debounce with a single timer so rapid-fire signals
    // don't stack multiple collect() calls.
    // Use requestCollection() (not collect() directly) to go through runCycle
    // serialization — ensures poll and signal don't run concurrently, and
    // onStop()'s cyclePromise await covers signal-triggered cycles too.
    //
    // Signal contract: SIGUSR1 is process-global — Node fires ALL registered
    // listeners on every signal. We only register here (and detach on stop),
    // so there's no contention today. If a future component also needs
    // SIGUSR1, it will fire on every kiro stop event too; at that point
    // switch to a targeted IPC channel (e.g. named pipe / file flag) instead.
    this.signalHandler = () => {
      if (this.pendingCollectTimer) clearTimeout(this.pendingCollectTimer);
      this.pendingCollectTimer = setTimeout(() => {
        this.pendingCollectTimer = null;
        this.requestCollection();
      }, this.matureDelayMs);
    };
    process.on('SIGUSR1', this.signalHandler);
  }

  protected override async onStop(): Promise<void> {
    if (this.signalHandler) {
      process.off('SIGUSR1', this.signalHandler);
      this.signalHandler = null;
    }
    if (this.pendingCollectTimer) {
      clearTimeout(this.pendingCollectTimer);
      this.pendingCollectTimer = null;
    }
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    // Guard against signal-triggered collect after stop() — requestCollection()
    // checks this.running internally, but the timer callback could fire in the
    // window between stop() clearing _running and the timer being cleared.
    if (!this.running) return [];
    await this.ensureDirs();
    const items = await this.listReady();
    if (items.length === 0) return [];

    const now = Date.now();
    const due: PendingItem[] = [];
    for (const item of items) {
      const stopMs = item.record.stopUnixMs ?? item.record.enqueueMs ?? 0;
      if (stopMs > 0 && now - stopMs < this.matureDelayMs) continue;
      due.push(item);
      if (due.length >= this.maxConcurrent) break;
    }
    if (due.length === 0) return [];

    await Promise.all(due.map((item) => this.processOne(item, now)));
    // This input never emits entries; downstream visibility comes from
    // KiroCliLogInput reading the daily-jsonl appended by the subprocess.
    return [];
  }

  private async processOne(item: PendingItem, nowMs: number): Promise<void> {
    const claimed = await this.claim(item.readyPath);
    if (!claimed) return; // someone else (or restart cleanup) took it

    const stopMs = item.record.stopUnixMs ?? item.record.enqueueMs ?? nowMs;
    const allowFallback = nowMs - stopMs >= this.maxAgeMs;
    const args: string[] = ['delayedCollect', claimed];
    if (allowFallback) args.push('--allow-fallback');

    try {
      const status = await this.spawnProcessor(args);
      if (status === 'ok' || status === 'no_data') {
        await this.discardInflight(claimed);
      } else if (status === 'timing_pending') {
        await this.releaseInflight(claimed);
      } else {
        // Unknown status — release so we retry next cycle, but cap retries
        // via stop age (eventually --allow-fallback kicks in).
        await this.releaseInflight(claimed);
      }
    } catch (err) {
      this.logger.warn('delayedCollect spawn failed', {
        file: claimed,
        error: String(err),
      });
      // Release for retry; if it keeps failing, MAX_AGE_MS branch will
      // force fallback emission eventually.
      await this.releaseInflight(claimed);
    }
  }

  private spawnProcessor(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.hookProcessorPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        reject(new Error(`delayedCollect timeout after ${this.subprocessTimeoutMs}ms`));
      }, this.subprocessTimeoutMs);

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`delayedCollect exit ${code}: ${stderr.trim().slice(0, 200)}`));
          return;
        }
        resolve(parseStatus(stdout));
      });
    });
  }

  private async listReady(): Promise<PendingItem[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.readyDir);
    } catch {
      return [];
    }
    const items: PendingItem[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const readyPath = path.join(this.readyDir, name);
      try {
        const raw = await fs.readFile(readyPath, 'utf-8');
        const record = JSON.parse(raw) as PendingRecord;
        items.push({ readyPath, record });
      } catch {
        // Corrupt record — discard so it doesn't keep poisoning the queue.
        try { await fs.unlink(readyPath); } catch { /* ignore */ }
      }
    }
    items.sort((a, b) => (a.record.enqueueMs ?? 0) - (b.record.enqueueMs ?? 0));
    return items;
  }

  private async claim(readyPath: string): Promise<string | null> {
    const base = path.basename(readyPath);
    const inflightPath = path.join(this.inflightDir, base);
    try {
      await fs.rename(readyPath, inflightPath);
      return inflightPath;
    } catch {
      return null;
    }
  }

  private async discardInflight(inflightPath: string): Promise<void> {
    try { await fs.unlink(inflightPath); } catch { /* ignore */ }
  }

  private async releaseInflight(inflightPath: string): Promise<void> {
    const base = path.basename(inflightPath);
    const readyPath = path.join(this.readyDir, base);
    try {
      await fs.rename(inflightPath, readyPath);
    } catch {
      try { await fs.unlink(inflightPath); } catch { /* ignore */ }
    }
  }

  private async recoverInflight(): Promise<number> {
    let names: string[];
    try {
      names = await fs.readdir(this.inflightDir);
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const inflightPath = path.join(this.inflightDir, name);
      const readyPath = path.join(this.readyDir, name);
      try {
        await fs.rename(inflightPath, readyPath);
        n++;
      } catch {
        try { await fs.unlink(inflightPath); } catch { /* ignore */ }
      }
    }
    return n;
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.readyDir, { recursive: true });
    await fs.mkdir(this.inflightDir, { recursive: true });
  }
}

function parseStatus(stdout: string): string {
  // Hook processor dispatcher writes `{status:<s>}\n` from the subcommand itself,
  // then its `finally` block unconditionally appends a trailing `{}` as the
  // fail-open default for every hook event. Reading the *last* line therefore
  // yielded `{}` (no `status` field) and every cycle was mis-classified as
  // 'unknown' → released back to ready/. Scan lines and pick the first real
  // status-bearing object.
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.status === 'string') return obj.status;
    } catch {
      // ignore parse error — keep scanning
    }
  }
  return 'unknown';
}

// Re-export to satisfy `directoryExists` import if needed elsewhere.
export { directoryExists };

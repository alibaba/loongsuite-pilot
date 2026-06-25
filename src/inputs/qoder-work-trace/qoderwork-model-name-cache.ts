/**
 * Cache that maps QoderWork modelKey → displayName by tail-reading
 * `qodercli.log` files for `StreamResponse <json>` lines.
 *
 * Why this exists:
 *   - Trace-input enrichment uses segments to recover the canonical modelKey
 *     (e.g. `qwork-ultimate`) but the user-facing display name (e.g. "Premium")
 *     only appears in the qodercli runtime log.
 *   - Display name is dynamically assigned by the Qoder service, so a static
 *     mapping table is not safe. A tail-read sidecar keeps the cache fresh
 *     without participating in timing-sensitive segment FIFO matching.
 *
 * The cache is lossy by design: legacy lines without a displayName are simply
 * skipped so they cannot poison a previously-known mapping. Truncation /
 * inode rotation resets the read offset so we never blindly skip ahead.
 *
 * Layout supported (2026 QoderWork):
 *   - Legacy single-file: `qodercli.log` at the configured path.
 *   - Per-run multi-file: a directory containing `runs/<ts>-<id>/qodercli.log`
 *     with a `latest` symlink. We scan up to MAX_RUN_FILES most-recent run
 *     directories by mtime and tail each independently (keyed by absolute
 *     path). This catches sessions even when the root aggregated file is
 *     stale.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface CacheOptions {
  /** Primary log path — may be a single file OR a directory containing runs/. */
  logFile: string;
  /** Cap on how many recent run directories we tail concurrently. */
  maxRunFiles?: number;
}

interface CacheEntry {
  displayName: string;
  updatedAtMs: number;
}

interface CacheStats {
  linesParsed: number;
  bytesRead: number;
  resets: number;
  watchedFiles: number;
}

const STREAM_RESPONSE_MARKER = 'StreamResponse ';
const DEFAULT_MAX_RUN_FILES = 4;

interface WatchState {
  offset: number;
  /** Inode (on macOS/Linux) — if changed we treat as rotation. */
  ino: number;
}

export class QoderWorkModelNameCache {
  private readonly primaryPath: string;
  private readonly maxRunFiles: number;
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly watchStates: Map<string, WatchState> = new Map();
  private stats: CacheStats = { linesParsed: 0, bytesRead: 0, resets: 0, watchedFiles: 0 };

  constructor(opts: CacheOptions) {
    this.primaryPath = opts.logFile;
    this.maxRunFiles = opts.maxRunFiles ?? DEFAULT_MAX_RUN_FILES;
  }

  async refresh(): Promise<void> {
    const targets = await this.discoverTargets();
    this.stats.watchedFiles = targets.length;
    for (const target of targets) {
      await this.tailFile(target);
    }
  }

  /**
   * Return the list of log files to tail this cycle.
   * If primaryPath is a regular file → [primaryPath].
   * If primaryPath is a directory → scan runs/<ts>/qodercli.log by mtime, top-N.
   * If neither → empty.
   */
  private async discoverTargets(): Promise<string[]> {
    let stat;
    try { stat = await fs.stat(this.primaryPath); } catch { return []; }

    if (stat.isFile()) return [this.primaryPath];

    if (stat.isDirectory()) {
      const runsDir = path.join(this.primaryPath, 'runs');
      try {
        const entries = await fs.readdir(runsDir, { withFileTypes: true });
        const runDirs = entries
          .filter(e => e.isDirectory())
          .map(e => ({
            name: e.name,
            dirPath: path.join(runsDir, e.name),
          }));
        // Resolve mtime of qodercli.log inside each run dir; skip missing.
        const withMtime: Array<{ dirPath: string; mtimeMs: number; logPath: string }> = [];
        await Promise.all(runDirs.map(async r => {
          const logPath = path.join(r.dirPath, 'qodercli.log');
          try {
            const s = await fs.stat(logPath);
            withMtime.push({ dirPath: r.dirPath, mtimeMs: s.mtimeMs, logPath });
          } catch { /* no log in this run */ }
        }));
        withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return withMtime.slice(0, this.maxRunFiles).map(w => w.logPath);
      } catch {
        return [];
      }
    }
    return [];
  }

  private async tailFile(filePath: string): Promise<void> {
    let stat;
    try { stat = await fs.stat(filePath); } catch { return; }

    const prev = this.watchStates.get(filePath);
    const ino = stat.ino ?? 0;
    let offset = prev?.offset ?? 0;

    if (prev && prev.ino !== ino) {
      // Inode changed — file was replaced; reset.
      offset = 0;
      this.stats.resets += 1;
    }
    if (stat.size < offset) {
      // Truncated or rotated; reset.
      offset = 0;
      this.stats.resets += 1;
    }
    if (stat.size === offset) {
      this.watchStates.set(filePath, { offset, ino });
      return;
    }

    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(filePath, 'r');
      const length = stat.size - offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const slice = buffer.slice(0, bytesRead).toString('utf-8');
      offset += bytesRead;
      this.stats.bytesRead += bytesRead;

      // Avoid splitting a half-written final line: only consume up to the
      // last newline; the leftover stays unread and will be picked up on the
      // next refresh once it's terminated.
      const lastNl = slice.lastIndexOf('\n');
      if (lastNl < 0) {
        offset -= bytesRead;
        this.watchStates.set(filePath, { offset, ino });
        return;
      }
      const consumable = slice.slice(0, lastNl);
      const leftover = slice.slice(lastNl + 1);
      offset -= Buffer.byteLength(leftover, 'utf-8');

      for (const line of consumable.split('\n')) {
        if (!line.includes(STREAM_RESPONSE_MARKER)) continue;
        this.stats.linesParsed += 1;
        const idx = line.indexOf(STREAM_RESPONSE_MARKER);
        const jsonPart = line.slice(idx + STREAM_RESPONSE_MARKER.length).trim();
        if (!jsonPart) continue;
        let payload: unknown;
        try { payload = JSON.parse(jsonPart); } catch { continue; }
        if (!payload || typeof payload !== 'object') continue;
        const obj = payload as Record<string, unknown>;
        const modelKey = typeof obj.modelKey === 'string' ? obj.modelKey : undefined;
        const displayName = typeof obj.displayName === 'string' ? obj.displayName : undefined;
        if (!modelKey) continue;
        if (!displayName) continue; // legacy lines: skip silently
        this.cache.set(modelKey, { displayName, updatedAtMs: Date.now() });
      }
    } finally {
      await handle?.close();
      this.watchStates.set(filePath, { offset, ino });
    }
  }

  resolve(modelKey: string): { displayName?: string } {
    const entry = this.cache.get(modelKey);
    return entry ? { displayName: entry.displayName } : {};
  }

  /** Returns the set of currently-known (modelKey → displayName) pairs. Test/debug only. */
  snapshot(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [k, v] of this.cache) out.set(k, v.displayName);
    return out;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }
}

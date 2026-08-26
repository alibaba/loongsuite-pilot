import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';

/**
 * Upper bound on per-path ownership warnings remembered for dedup. The set is
 * keyed by path and the condition is stable, so in practice it holds a handful
 * of entries; the cap only guards against unbounded growth if a writer keeps
 * recreating files under fresh names.
 */
const OWNERSHIP_WARN_CAP = 512;

export interface SessionInputOptions extends InputOptions {
  /** Glob-like base directory to scan for session files. */
  sessionDir: string;
  /** File name pattern (e.g. "rollout-*.jsonl"). */
  filePattern: string;
}

/**
 * Base input for session file polling (e.g. Codex CLI, OpenCode).
 * Reads JSONL session files with offset tracking per file (inode-aware rotation).
 *
 * Subclass must implement:
 *   - discoverSessionFiles(): list session files to process
 *   - processSessionLine(): handle a single JSONL line from a session file
 */
export abstract class BaseSessionInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  protected readonly sessionDir: string;
  protected readonly filePattern: string;

  /** Paths already reported by diagnoseUnreadablePath (dedup across cycles). */
  private readonly ownershipWarned = new Set<string>();

  constructor(opts: SessionInputOptions) {
    super(opts);
    this.sessionDir = opts.sessionDir;
    this.filePattern = opts.filePattern;
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const allEntries: AgentActivityEntry[] = [];

    for (const filePath of files) {
      const entries = await this.processFile(filePath);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  private async processFile(filePath: string): Promise<AgentActivityEntry[]> {
    const stateKey = `${this.id}:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }

    const prevOffset = this.stateStore.getOffset(stateKey);
    const prevState = this.stateStore.get(stateKey);
    const prevInode = prevState.extra?.inode as number | undefined;

    // Detect file rotation via inode change
    if (prevInode !== undefined && prevInode !== (stat as any).ino) {
      this.stateStore.setOffset(stateKey, 0);
      this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });
    }

    let offset = this.stateStore.getOffset(stateKey);
    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated or rotated, resetting offset', {
        file: filePath,
        recorded: offset,
        actual: stat.size,
      });
      offset = 0;
      this.stateStore.setOffset(stateKey, 0);
      this.stateStore.update(stateKey, { extra: { inode: Number((stat as any).ino) } });
    }
    if (stat.size <= offset) return [];

    let handle: FileHandle;
    try {
      handle = await fs.open(filePath, 'r');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return []; // rotated away between discovery and open
      if (code === 'EACCES' || code === 'EPERM') {
        // Almost always an ownership mismatch: a process running as a different
        // uid (commonly root) loaded the plugin and wrote this file 0600. One
        // unreadable file must not abort the whole cycle — diagnose it once and
        // keep collecting the remaining files.
        await this.diagnoseUnreadablePath(filePath, 'event file');
        return [];
      }
      throw err;
    }
    try {
      const buf = Buffer.alloc(stat.size - offset);
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      const bytes = buf.subarray(0, bytesRead);
      const lastNewline = bytes.lastIndexOf(0x0a);
      this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });
      if (lastNewline < 0) return [];

      const completeBytes = bytes.subarray(0, lastNewline + 1);
      const text = completeBytes.toString('utf-8');
      this.stateStore.setOffset(stateKey, offset + completeBytes.length);

      const entries: AgentActivityEntry[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const entry = await this.processSessionLine(parsed, filePath);
          if (entry) entries.push(entry);
        } catch (err) {
          this.logger.warn('invalid session line', { file: filePath, error: String(err) });
        }
      }
      return entries;
    } finally {
      await handle.close();
    }
  }

  /**
   * Diagnose an EACCES/EPERM on a session path by comparing the path's owner
   * uid with this daemon's own uid, and warn at most once per path.
   *
   * The ownership invariant behind this: the in-process plugin writes its event
   * files 0600 inside whatever process loaded it, so every process loading the
   * plugin must run as the same uid as this daemon — otherwise the daemon can
   * neither list the session directory nor read the files. A mismatch means a
   * second, differently-privileged process (in practice: a root helper or a
   * second gateway that never dropped privileges) loaded the plugin. Nothing
   * this daemon does after the fact fixes that; the remediation is dropping the
   * offending process's privileges, and the warning says exactly that.
   */
  protected async diagnoseUnreadablePath(
    targetPath: string,
    kind: 'event file' | 'session directory',
  ): Promise<void> {
    const warnKey = `${kind}:${targetPath}`;
    if (this.ownershipWarned.has(warnKey)) return;
    if (this.ownershipWarned.size >= OWNERSHIP_WARN_CAP) this.ownershipWarned.clear();
    this.ownershipWarned.add(warnKey);

    let ownerUid: number | undefined;
    try {
      ownerUid = (await fs.stat(targetPath)).uid;
    } catch {
      // Path vanished between the failed read and this stat; warn without the
      // owner detail rather than not at all.
    }
    const daemonUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const meta = { path: targetPath, kind, ownerUid, daemonUid };

    if (daemonUid === undefined) {
      this.logger.warn(
        `ownership-mismatch: cannot read ${kind} (EACCES); this platform exposes no ` +
          'process uid, so ensure the process writing agent events runs as the same user as this daemon',
        meta,
      );
      return;
    }
    if (ownerUid !== undefined && ownerUid !== daemonUid) {
      this.logger.warn(
        `ownership-mismatch: cannot read ${kind} (EACCES): owned by uid ${ownerUid}, but this ` +
          `daemon runs as uid ${daemonUid}. A process running as a different uid loaded the pilot ` +
          'plugin and writes event files this daemon cannot read. Fix: run every process that loads ' +
          `the plugin as uid ${daemonUid} (drop the privileges of the uid-${ownerUid} process, ` +
          'e.g. via su or runAsUser)',
        meta,
      );
      return;
    }
    this.logger.warn(
      `ownership-mismatch: cannot read ${kind} (EACCES) despite matching uid ${daemonUid}; ` +
        'check the surrounding directory permissions or security modules (SELinux/AppArmor/ACLs)',
      meta,
    );
  }

  /** Discover session files to process. */
  protected abstract discoverSessionFiles(): Promise<string[]>;

  /** Process a single parsed JSON line from a session file. Return null to skip. */
  protected abstract processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null>;
}

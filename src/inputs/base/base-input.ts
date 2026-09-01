import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { type BoundLogger, createLogger } from '../../utils/logger.js';
import type { StateStore } from '../../checkpoints/state-store.js';

export interface InputOptions {
  stateStore: StateStore;
  pollIntervalMs?: number;
}

/**
 * Raw source volume observed before parsing, filtering, deduplication, or
 * normalization. `bytes` is the checkpointed source payload, while
 * `maxBatchBytes` is the largest temporary read buffer used by this report.
 */
export interface RawInputStats {
  records: number;
  bytes: number;
  maxBatchBytes: number;
}

/**
 * Upper bound on per-path ownership warnings remembered for dedup. The set is
 * keyed by path and the condition is stable, so in practice it holds a handful
 * of entries; the cap only guards against unbounded growth if a writer keeps
 * recreating files under fresh names.
 */
const OWNERSHIP_WARN_CAP = 512;

/**
 * Abstract base for every input.
 * Subclass one of the specialised bases (IdeInput, SqliteInput, etc.)
 * rather than this directly, unless you need a fully custom lifecycle.
 */
export abstract class BaseInput extends EventEmitter {
  abstract readonly id: string;
  abstract readonly agentType: ClientType;
  abstract readonly collectionMethod: CollectionMethod;

  protected readonly logger: BoundLogger;
  protected readonly stateStore: StateStore;
  protected pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cyclePromise: Promise<void> | null = null;
  private _running = false;
  /** Paths already reported by diagnoseUnreadablePath (dedup across cycles). */
  private readonly ownershipWarned = new Set<string>();

  constructor(opts: InputOptions) {
    super();
    this.stateStore = opts.stateStore;
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.logger = createLogger(this.constructor.name);
  }

  get running(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this.logger.info('starting');

    await this.onStart();
    await this.runCycle();

    this.timer = setInterval(() => void this.runCycle(), this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.cyclePromise;
    await this.onStop();
    this.logger.info('stopped');
  }

  /** Override to implement collection logic; return agent activity entries. */
  protected abstract collect(): Promise<AgentActivityEntry[]>;

  getAgentVersion?(): string;

  /** Optional hook called once on start. */
  protected async onStart(): Promise<void> {}
  /** Optional hook called once on stop. */
  protected async onStop(): Promise<void> {}

  /** Request an immediate serialized collection cycle from an input-owned watcher. */
  protected requestCollection(): void {
    if (this._running) void this.runCycle();
  }

  private runCycle(): Promise<void> {
    if (this.cyclePromise) return this.cyclePromise;
    this.cyclePromise = this.runCycleOnce().finally(() => {
      this.cyclePromise = null;
    });
    return this.cyclePromise;
  }

  private async runCycleOnce(): Promise<void> {
    try {
      const entries = await this.collect();
      if (entries.length > 0) {
        this.emit('entries', entries);
        this.logger.debug('cycle produced entries', { count: entries.length });
      }
      await this.stateStore.save();
    } catch (err) {
      this.logger.error('collection cycle failed', { error: String(err) });
      this.emit('collect-error', err);
    }
  }

  protected getState(): InputState {
    return this.stateStore.get(this.id);
  }

  protected setState(state: Partial<InputState>): void {
    this.stateStore.update(this.id, state);
  }

  /** Report one raw-source read without coupling it to normalized entries. */
  protected reportRawInput(stats: RawInputStats): void {
    this.emit('raw-input-stats', stats);
  }

  /** Whether an error is a permission failure (EACCES/EPERM) on a path. */
  protected isUnreadableError(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EACCES' || code === 'EPERM';
  }

  /**
   * Diagnose an EACCES/EPERM on an input path by comparing the path's owner uid
   * with this daemon's own uid, and warn at most once per path.
   *
   * The ownership invariant behind this: the in-process plugin writes its event
   * files 0600 inside whatever process loaded it, so every process loading the
   * plugin must run as the same uid as this daemon — otherwise the daemon can
   * neither list the session directory nor read the files. A mismatch means a
   * second, differently-privileged process (in practice: a root helper or a
   * second gateway that never dropped privileges) loaded the plugin. Nothing
   * this daemon does after the fact fixes that; the remediation is dropping the
   * offending process's privileges, and the warning says exactly that.
   *
   * Lives on BaseInput (not just BaseSessionInput) because inputs that override
   * collect() with their own fs.open (dsh-log, qoder-work-*) need the same
   * contain-and-diagnose behaviour instead of aborting the whole cycle.
   */
  protected async diagnoseUnreadablePath(
    targetPath: string,
    kind: 'event file' | 'session directory',
  ): Promise<void> {
    const warnKey = `${kind}:${targetPath}`;
    if (this.ownershipWarned.has(warnKey)) return;
    if (this.ownershipWarned.size >= OWNERSHIP_WARN_CAP) {
      // Evict the single oldest entry (Set iterates in insertion order) rather
      // than clearing the whole set: clear() would let every still-unreadable
      // path be re-warned on the next cycle, the exact log/SLS-cardinality
      // explosion the cap exists to prevent.
      const oldest = this.ownershipWarned.values().next();
      if (!oldest.done) this.ownershipWarned.delete(oldest.value);
    }
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
}

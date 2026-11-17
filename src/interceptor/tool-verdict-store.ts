import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import type { HookEventName } from './types.js';
import type { GuardrailSnapshot } from './guardrail.js';

export type ToolVerdictAction = 'allow' | 'block';
export type ToolInterceptPhase = Extract<HookEventName, 'PreToolUse' | 'PostToolUse'>;

export interface ToolVerdictKey {
  sessionId?: string;
  toolUseId: string;
  phase: ToolInterceptPhase;
}

export interface ToolVerdictSnapshot extends GuardrailSnapshot {}

export interface ToolVerdictRecord extends ToolVerdictKey, ToolVerdictSnapshot {
  recordedAt: string;
}

export const TOOL_VERDICT_TTL_MS = 30 * 60 * 1000;
export const TOOL_VERDICT_CHECKPOINT_INTERVAL_MS = 15_000;
export const TOOL_VERDICT_MAX_RECORDS = 10_000;

interface StoredVerdict extends ToolVerdictSnapshot {
  recordedAtMs: number;
}

/**
 * In-process interceptor verdicts. The outer object can grow another structure
 * later; today it only holds the tool-phase map.
 */
export class ToolVerdictStore {
  private readonly toolVerdicts = new Map<string, StoredVerdict>();
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private revision = 0;
  private persistedRevision = 0;
  private checkpointPromise: Promise<void> | null = null;
  private lastPruneMs = -Infinity;

  constructor(private readonly checkpointPath: string) {}

  put(key: ToolVerdictKey, verdict: ToolVerdictAction | ToolVerdictSnapshot, now = new Date()): void {
    if (!key.toolUseId) return;
    const recordedAtMs = now.getTime();
    if (recordedAtMs - this.lastPruneMs >= 1000) this.prune(recordedAtMs);
    const snapshot = typeof verdict === 'string' ? { action: verdict } : verdict;
    this.toolVerdicts.delete(verdictKey(key));
    this.toolVerdicts.set(verdictKey(key), { ...snapshot, recordedAtMs });
    this.revision++;
    while (this.toolVerdicts.size > TOOL_VERDICT_MAX_RECORDS) {
      this.toolVerdicts.delete(this.toolVerdicts.keys().next().value!);
    }
  }

  get(key: ToolVerdictKey, now = new Date()): ToolVerdictAction | null {
    return this.getSnapshot(key, now)?.action ?? null;
  }

  getSnapshot(key: ToolVerdictKey, now = new Date()): ToolVerdictSnapshot | null {
    if (!key.toolUseId) return null;
    const id = verdictKey(key);
    const stored = this.toolVerdicts.get(id);
    if (!stored) return null;
    if (now.getTime() - stored.recordedAtMs > TOOL_VERDICT_TTL_MS) {
      this.toolVerdicts.delete(id);
      this.revision++;
      return null;
    }
    return stripTime(stored);
  }

  restore(now = new Date()): void {
    this.toolVerdicts.clear();
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8'));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const body = parsed as { schema?: unknown; records?: unknown };
    if (body.schema !== 1 || !Array.isArray(body.records)) return;
    this.mergeRecords(body.records, now.getTime());
    this.persistedRevision = this.revision;
  }

  records(now = new Date()): ToolVerdictRecord[] {
    this.prune(now.getTime());
    return Array.from(this.toolVerdicts, ([key, value]) => ({
      ...parseKey(key)!, ...stripTime(value), recordedAt: new Date(value.recordedAtMs).toISOString(),
    }));
  }

  /** Merge IPC/restart records without extending their original lifetime. */
  merge(records: readonly ToolVerdictRecord[]): void {
    this.mergeRecords(records, Date.now());
  }

  private mergeRecords(records: readonly unknown[], nowMs: number): void {
    this.prune(nowMs);
    let changed = false;
    for (const item of records) {
      const record = parseRecord(item);
      if (!record) continue;
      const recordedAtMs = Date.parse(record.recordedAt);
      if (nowMs - recordedAtMs > TOOL_VERDICT_TTL_MS) continue;
      const id = verdictKey(record);
      const previous = this.toolVerdicts.get(id);
      // A restored checkpoint wins ties with an older main-thread mirror.
      if (previous && previous.recordedAtMs >= recordedAtMs) continue;
      this.toolVerdicts.set(id, { ...stripTime(record), recordedAtMs });
      changed = true;
    }
    if (!changed) return;
    // Trim once after deduplication. Incremental eviction lets stale mirror keys
    // repeatedly displace newer checkpoint records before their duplicates arrive.
    // Stable newest-first selection keeps checkpoint records ahead of newly
    // merged mirror keys when their millisecond timestamps are identical.
    const retained = Array.from(this.toolVerdicts).sort((a, b) => b[1].recordedAtMs - a[1].recordedAtMs)
      .slice(0, TOOL_VERDICT_MAX_RECORDS).reverse();
    this.toolVerdicts.clear();
    for (const [id, stored] of retained) this.toolVerdicts.set(id, stored);
    this.revision++;
  }

  replace(records: readonly ToolVerdictRecord[]): void {
    this.toolVerdicts.clear();
    this.revision++;
    this.merge(records);
  }

  /** Serialized, dirty-only asynchronous checkpoint; the worker owns the file. */
  checkpoint(): Promise<void> {
    if (this.checkpointPromise) return this.checkpointPromise;
    this.checkpointPromise = (async () => {
      this.prune(Date.now());
      if (this.revision === this.persistedRevision) return;
      const revision = this.revision;
      const text = `${JSON.stringify({ schema: 1, records: this.records() })}\n`;
      const tmp = `${this.checkpointPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fsp.mkdir(path.dirname(this.checkpointPath), { recursive: true, mode: 0o700 });
        await fsp.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
        await fsp.rename(tmp, this.checkpointPath);
        this.persistedRevision = revision;
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
    })().finally(() => { this.checkpointPromise = null; });
    return this.checkpointPromise;
  }

  dump(now = new Date()): void {
    this.prune(now.getTime());
    const records: ToolVerdictRecord[] = [];
    for (const [key, value] of this.toolVerdicts) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      records.push({
        ...parsed,
        ...stripTime(value),
        recordedAt: new Date(value.recordedAtMs).toISOString(),
      });
    }
    const text = `${JSON.stringify({ schema: 1, records }, null, 2)}\n`;
    const dir = path.dirname(this.checkpointPath);
    const tmp = `${this.checkpointPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.checkpointPath);
  }

  startCheckpointLoop(intervalMs = TOOL_VERDICT_CHECKPOINT_INTERVAL_MS): void {
    if (this.checkpointTimer) return;
    // Only the single writer starts this loop, after the previous Worker exits.
    // Readers also restore(), so cleanup there could delete an active write.
    if (!this.checkpointPromise) this.cleanAbandonedTemporaryFiles();
    this.checkpointTimer = setInterval(() => {
      try {
        void this.checkpoint().catch(() => {});
      } catch {
        // The next tick retries. A dump failure must not affect evaluation.
      }
    }, intervalMs);
    this.checkpointTimer.unref();
  }

  async stopCheckpointLoop(): Promise<void> {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    await this.checkpoint();
    // A write already in flight may have captured an older revision.
    await this.checkpoint();
  }

  private prune(nowMs: number): void {
    this.lastPruneMs = nowMs;
    for (const [key, value] of this.toolVerdicts) {
      if (nowMs - value.recordedAtMs > TOOL_VERDICT_TTL_MS) {
        this.toolVerdicts.delete(key);
        this.revision++;
      }
    }
  }

  private cleanAbandonedTemporaryFiles(): void {
    const dir = path.dirname(this.checkpointPath);
    const prefix = `${path.basename(this.checkpointPath)}.`;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const match = /^([1-9]\d*)\.[a-f0-9]{12}\.tmp$/.exec(name.slice(prefix.length));
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid !== process.pid) {
        try {
          process.kill(pid, 0);
          continue;
        } catch (error) {
          // EPERM and unrecognized/invalid PIDs do not prove the writer exited.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        }
      }
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // A concurrent removal or an inaccessible temporary must not stop startup.
      }
    }
  }
}

export function isToolInterceptPhase(event: HookEventName): event is ToolInterceptPhase {
  return event === 'PreToolUse' || event === 'PostToolUse';
}

function verdictKey(key: ToolVerdictKey): string {
  return JSON.stringify([key.sessionId ?? '', key.toolUseId, key.phase]);
}

function parseKey(key: string): ToolVerdictKey | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [sessionId, toolUseId, phase] = parsed;
    if (typeof toolUseId !== 'string' || !toolUseId) return null;
    if (phase !== 'PreToolUse' && phase !== 'PostToolUse') return null;
    if (sessionId !== '' && typeof sessionId !== 'string') return null;
    return {
      sessionId: sessionId || undefined,
      toolUseId,
      phase,
    };
  } catch {
    return null;
  }
}

function parseRecord(value: unknown): ToolVerdictRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<ToolVerdictRecord>;
  if (typeof record.toolUseId !== 'string' || !record.toolUseId) return null;
  if (record.phase !== 'PreToolUse' && record.phase !== 'PostToolUse') return null;
  if (record.action !== 'allow' && record.action !== 'block') return null;
  if (typeof record.recordedAt !== 'string' || Number.isNaN(Date.parse(record.recordedAt))) return null;
  if (record.sessionId !== undefined && typeof record.sessionId !== 'string') return null;
  return {
    sessionId: record.sessionId || undefined,
    toolUseId: record.toolUseId,
    phase: record.phase,
    action: record.action,
    recordedAt: record.recordedAt,
    ...optionalMeta(record),
  };
}

function stripTime(value: ToolVerdictSnapshot): ToolVerdictSnapshot {
  return {
    action: value.action,
    ...optionalMeta(value),
  };
}

function optionalMeta(value: Partial<Omit<ToolVerdictSnapshot, 'action'>>): Omit<ToolVerdictSnapshot, 'action'> {
  return {
    ...(typeof value.matched === 'boolean' ? { matched: value.matched } : {}),
    ...(value.enforcement === 'enforce' || value.enforcement === 'audit' ? { enforcement: value.enforcement } : {}),
    ...(value.failOpen === true ? { failOpen: true } : {}),
    ...(nonEmpty(value.ruleId) ? { ruleId: value.ruleId } : {}),
    ...(nonEmpty(value.ruleVersion) ? { ruleVersion: value.ruleVersion } : {}),
    ...(nonEmpty(value.reason) ? { reason: value.reason } : {}),
    ...(nonEmpty(value.title) ? { title: value.title } : {}),
    ...(nonEmpty(value.message) ? { message: value.message } : {}),
  };
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import type { HookEventName } from './types.js';
import type { GuardrailSnapshot } from './guardrail.js';
import { PROMPT_MATCH_WINDOW_MS, type PromptLookup } from './prompt-verdict.js';

export type ToolVerdictAction = GuardrailSnapshot['action'];
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

export interface PromptVerdictKey {
  phase: 'UserPromptSubmit';
  sessionId: string;
  agentType: string;
  promptHash: string;
  requestId: string;
  /** Provenance from a new Hook observation, never inferred from an old UUID. */
  missingRequestId?: true;
  missingAgentType?: true;
}

/** An observed prompt whose evaluation is pending, failed or blocked. Never exported as telemetry. */
export type PromptVerdictSnapshot = ToolVerdictSnapshot | { action: 'unknown' };
export type InterceptorVerdictKey = ToolVerdictKey | PromptVerdictKey;
export type InterceptorVerdictRecord = ToolVerdictRecord
  | (PromptVerdictKey & PromptVerdictSnapshot & { recordedAt: string; binding?: PromptBinding });

interface PromptBinding { requestId: string; agentType: string; at: number }

export const TOOL_VERDICT_TTL_MS = 30 * 60 * 1000;
export const TOOL_VERDICT_CHECKPOINT_INTERVAL_MS = 15_000;
export const TOOL_VERDICT_MAX_RECORDS = 10_000;

type StoredVerdict = PromptVerdictSnapshot & { recordedAtMs: number; binding?: PromptBinding };

/**
 * Prompt and tool verdicts share bounded retention and the same IPC/checkpoint lifecycle.
 */
export class ToolVerdictStore {
  private readonly toolVerdicts = new Map<string, StoredVerdict>();
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private revision = 0;
  private persistedRevision = 0;
  private checkpointPromise: Promise<void> | null = null;
  private lastPruneMs = -Infinity;
  onPromptBinding?: (record: InterceptorVerdictRecord) => void;

  constructor(private readonly checkpointPath: string) {}

  put(key: InterceptorVerdictKey, verdict: ToolVerdictAction | PromptVerdictSnapshot, now = new Date()): void {
    if (key.phase === 'UserPromptSubmit' ? !key.sessionId || !key.requestId : !key.toolUseId) return;
    if (typeof verdict !== 'string' && verdict.action === 'unknown' && key.phase !== 'UserPromptSubmit') return;
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
    return knownSnapshot(stored);
  }

  getPromptSnapshot(lookup: PromptLookup, now = new Date()): ToolVerdictSnapshot | null {
    if (lookup.requestId) {
      const stored = this.toolVerdicts.get(verdictKey({ ...lookup, phase: 'UserPromptSubmit', requestId: lookup.requestId }));
      if (stored) return now.getTime() - stored.recordedAtMs <= TOOL_VERDICT_TTL_MS ? observablePromptSnapshot(stored) : null;
    }
    const matches: Array<{ key: PromptVerdictKey; value: StoredVerdict }> = [];
    const exact: StoredVerdict[] = [];
    for (const [encoded, value] of this.toolVerdicts) {
      if (now.getTime() - value.recordedAtMs > TOOL_VERDICT_TTL_MS) continue;
      const key = parseKey(encoded);
      if (key?.phase !== 'UserPromptSubmit' || key.sessionId !== lookup.sessionId
        || !promptAgentsCompatible(key, lookup) || key.promptHash !== lookup.promptHash) continue;
      if (lookup.requestId && ((key.requestId === lookup.requestId)
        || (value.binding?.requestId === lookup.requestId && value.binding.agentType === lookup.agentType))) {
        exact.push(value);
      }
      if (Math.abs(value.recordedAtMs - lookup.at) > PROMPT_MATCH_WINDOW_MS) continue;
      // A prior successful binding proves this attempt belongs to a different
      // native request. Unbound pending/failed/blocked attempts remain ambiguous.
      if (lookup.requestId && value.binding && (value.binding.requestId !== lookup.requestId
        || value.binding.agentType !== lookup.agentType)) continue;
      matches.push({ key, value });
    }
    // Pending and failed attempts also count: absence of a known verdict cannot identify an older turn.
    // Reads never consume records, so exact-id lookups remain stable for output retries.
    if (lookup.requestId) {
      if (exact.length) return exact.length === 1 ? observablePromptSnapshot(exact[0]!) : null;
    }
    if (matches.length !== 1) return null;
    const match = matches[0]!;
    // An explicit mismatching identity must never be downgraded. Only an
    // observation explicitly missing its request identity permits a time join.
    if (lookup.requestId && !match.key.missingRequestId) return null;
    const snapshot = observablePromptSnapshot(match.value);
    if (!snapshot) return null;
    if (match.key.missingRequestId && lookup.requestId) {
      const binding = { requestId: lookup.requestId, agentType: lookup.agentType, at: lookup.at };
      if (match.value.binding && JSON.stringify(match.value.binding) !== JSON.stringify(binding)) return null;
      if (!match.value.binding) {
        match.value.binding = binding;
        this.revision++;
        // The worker remains the only checkpoint writer; the mirror forwards
        // this private ownership claim over the same FIFO transport.
        try {
          this.onPromptBinding?.({ ...match.key, ...snapshot, binding,
            recordedAt: new Date(match.value.recordedAtMs).toISOString() });
        } catch { /* Keep local ownership if the worker is restarting; spawn carries the mirror. */ }
      }
    } else if (match.value.binding) return null;
    return snapshot;
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

  /** Caller must confirm every previous checkpoint writer has exited. */
  async checkpointAfterWriterExit(): Promise<void> {
    const records = this.records();
    if (!records.some(record => 'binding' in record && record.binding)) return;
    const finalWriter = new ToolVerdictStore(this.checkpointPath);
    await finalWriter.mergeCheckpoint();
    finalWriter.merge(records);
    await finalWriter.checkpoint();
  }

  /** Import the last writer's checkpoint during an exclusive shutdown handoff.
   * Unlike best-effort startup restore, unreadable/corrupt data must not be overwritten.
   */
  private async mergeCheckpoint(now = new Date()): Promise<void> {
    let text: string;
    try {
      text = await fsp.readFile(this.checkpointPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const body = JSON.parse(text) as { schema?: unknown; records?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || body.schema !== 1 || !Array.isArray(body.records) || body.records.some(record => !parseRecord(record))) {
      throw new Error('invalid interceptor verdict checkpoint during shutdown');
    }
    this.mergeRecords(body.records, now.getTime());
  }

  records(now = new Date()): InterceptorVerdictRecord[] {
    this.prune(now.getTime());
    return Array.from(this.toolVerdicts, ([key, value]) => ({
      ...parseKey(key)!, ...stripTime(value), recordedAt: new Date(value.recordedAtMs).toISOString(),
      ...(value.binding ? { binding: value.binding } : {}),
    } as InterceptorVerdictRecord));
  }

  /** Merge IPC/restart records without extending their original lifetime. */
  merge(records: readonly InterceptorVerdictRecord[]): void {
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
      const binding = 'binding' in record ? record.binding : undefined;
      if (previous && previous.recordedAtMs === recordedAtMs && binding && !previous.binding) {
        previous.binding = binding;
        changed = true;
      }
      // A final verdict may arrive in the same millisecond as its pending marker.
      // Otherwise a restored checkpoint wins ties with an older main-thread mirror.
      if (previous && (previous.recordedAtMs > recordedAtMs
        || (previous.recordedAtMs === recordedAtMs
          && !(previous.action === 'unknown' && record.action !== 'unknown')))) continue;
      this.toolVerdicts.set(id, { ...stripTime(record), recordedAtMs,
        ...(binding ? { binding } : previous?.binding ? { binding: previous.binding } : {}) });
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

  replace(records: readonly InterceptorVerdictRecord[]): void {
    const bindings = this.records().filter(record => 'binding' in record && record.binding);
    this.toolVerdicts.clear();
    this.revision++;
    this.merge(records);
    this.merge(bindings);
  }

  /** Serialized, dirty-only checkpoint; callers must hold exclusive writer ownership. */
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
    const records: InterceptorVerdictRecord[] = [];
    for (const [key, value] of this.toolVerdicts) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      records.push({
        ...parsed,
        ...stripTime(value),
        recordedAt: new Date(value.recordedAtMs).toISOString(),
        ...(value.binding ? { binding: value.binding } : {}),
      } as InterceptorVerdictRecord);
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

export function verdictKey(key: InterceptorVerdictKey): string {
  if (key.phase === 'UserPromptSubmit') {
    const fields: unknown[] = [key.sessionId, key.requestId, key.phase, key.agentType, key.promptHash];
    if (key.missingRequestId || key.missingAgentType) fields.push(key.missingRequestId === true, key.missingAgentType === true);
    return JSON.stringify(fields);
  }
  return JSON.stringify([key.sessionId ?? '', key.toolUseId, key.phase]);
}

function parseKey(key: string): InterceptorVerdictKey | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed)) return null;
    if ((parsed.length === 5 || parsed.length === 7) && parsed[2] === 'UserPromptSubmit') {
      const [sessionId, requestId, phase, agentType, promptHash, missingRequestId, missingAgentType] = parsed;
      if (parsed.length === 7 && (typeof missingRequestId !== 'boolean' || typeof missingAgentType !== 'boolean')) return null;
      if (typeof sessionId !== 'string' || !sessionId || typeof requestId !== 'string' || !requestId
        || requestId.length > 512 || typeof agentType !== 'string' || !agentType
        || typeof promptHash !== 'string' || !/^[a-f0-9]{64}$/.test(promptHash)) return null;
      if ((missingRequestId || missingAgentType) && !['qoder', 'qoder-cli', 'qoder-app', 'qoder-cn'].includes(agentType)) return null;
      if (missingAgentType && agentType !== 'qoder') return null;
      return { sessionId, requestId, phase, agentType, promptHash,
        ...(missingRequestId ? { missingRequestId: true } : {}), ...(missingAgentType ? { missingAgentType: true } : {}) };
    }
    if (parsed.length !== 3) return null;
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

function parseRecord(value: unknown): InterceptorVerdictRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ((record.missingRequestId !== undefined && record.missingRequestId !== true)
    || (record.missingAgentType !== undefined && record.missingAgentType !== true)) return null;
  const key = parseKey(JSON.stringify(record.phase === 'UserPromptSubmit'
    ? [record.sessionId, record.requestId, record.phase, record.agentType, record.promptHash,
      record.missingRequestId === true, record.missingAgentType === true]
    : [record.sessionId ?? '', record.toolUseId, record.phase]));
  if (!key) return null;
  if (record.action !== 'allow' && record.action !== 'block' && record.action !== 'log'
    && !(key.phase === 'UserPromptSubmit' && record.action === 'unknown')) return null;
  if (typeof record.recordedAt !== 'string' || Number.isNaN(Date.parse(record.recordedAt))) return null;
  if (record.sessionId !== undefined && typeof record.sessionId !== 'string') return null;
  let binding: PromptBinding | undefined;
  if (record.binding !== undefined) {
    if (key.phase !== 'UserPromptSubmit' || !key.missingRequestId
      || !record.binding || typeof record.binding !== 'object' || Array.isArray(record.binding)) return null;
    const b = record.binding as Record<string, unknown>;
    if (typeof b.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(b.requestId)
      || typeof b.agentType !== 'string' || !promptAgentsCompatible(key, { agentType: b.agentType } as PromptLookup)
      || typeof b.at !== 'number' || !Number.isFinite(b.at)) return null;
    binding = { requestId: b.requestId, agentType: b.agentType, at: b.at };
  }
  return {
    ...key,
    action: record.action,
    recordedAt: record.recordedAt,
    ...optionalMeta(record),
    ...(binding ? { binding } : {}),
  } as InterceptorVerdictRecord;
}

function stripTime(value: PromptVerdictSnapshot): PromptVerdictSnapshot {
  if (value.action === 'unknown') return { action: 'unknown' };
  return {
    action: value.action,
    ...optionalMeta(value),
  };
}

function knownSnapshot(value: PromptVerdictSnapshot): ToolVerdictSnapshot | null {
  return value.action === 'unknown' ? null : stripTime(value) as ToolVerdictSnapshot;
}

function observablePromptSnapshot(value: PromptVerdictSnapshot): ToolVerdictSnapshot | null {
  return value.action === 'block' ? null : knownSnapshot(value);
}

function optionalMeta(value: Partial<Omit<ToolVerdictSnapshot, 'action'>>): Omit<ToolVerdictSnapshot, 'action'> {
  return {
    ...(value.failOpen === true ? { failOpen: true } : {}),
    ...(nonEmpty(value.ruleId) ? { ruleId: value.ruleId } : {}),
    ...(typeof value.ruleVersion === 'string' ? { ruleVersion: value.ruleVersion } : {}),
  };
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function promptAgentsCompatible(key: PromptVerdictKey, lookup: PromptLookup): boolean {
  return key.agentType === lookup.agentType || (key.missingAgentType === true
    && ['qoder', 'qoder-cli', 'qoder-app'].includes(lookup.agentType));
}

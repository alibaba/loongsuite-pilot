import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookEventName } from './types.js';

export type ToolVerdictAction = 'allow' | 'block';
export type ToolInterceptPhase = Extract<HookEventName, 'PreToolUse' | 'PostToolUse'>;

export interface ToolVerdictKey {
  sessionId?: string;
  toolUseId: string;
  phase: ToolInterceptPhase;
}

export interface ToolVerdictRecord extends ToolVerdictKey {
  action: ToolVerdictAction;
  recordedAt: string;
}

export const TOOL_VERDICT_TTL_MS = 30 * 60 * 1000;
export const TOOL_VERDICT_CHECKPOINT_INTERVAL_MS = 15_000;

interface StoredVerdict {
  action: ToolVerdictAction;
  recordedAtMs: number;
}

/**
 * In-process interceptor verdicts. The outer object can grow another structure
 * later; today it only holds the tool-phase map.
 */
export class ToolVerdictStore {
  private readonly toolVerdicts = new Map<string, StoredVerdict>();
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly checkpointPath: string) {}

  put(key: ToolVerdictKey, action: ToolVerdictAction, now = new Date()): void {
    if (!key.toolUseId) return;
    const recordedAtMs = now.getTime();
    this.prune(recordedAtMs);
    this.toolVerdicts.set(verdictKey(key), { action, recordedAtMs });
  }

  get(key: ToolVerdictKey, now = new Date()): ToolVerdictAction | null {
    if (!key.toolUseId) return null;
    this.prune(now.getTime());
    return this.toolVerdicts.get(verdictKey(key))?.action ?? null;
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
    for (const item of body.records) {
      const record = parseRecord(item);
      if (!record) continue;
      this.toolVerdicts.set(verdictKey(record), {
        action: record.action,
        recordedAtMs: Date.parse(record.recordedAt),
      });
    }
    this.prune(now.getTime());
  }

  dump(now = new Date()): void {
    this.prune(now.getTime());
    const records: ToolVerdictRecord[] = [];
    for (const [key, value] of this.toolVerdicts) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      records.push({
        ...parsed,
        action: value.action,
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
    this.checkpointTimer = setInterval(() => {
      try {
        this.dump();
      } catch {
        // The next tick retries. A dump failure must not affect evaluation.
      }
    }, intervalMs);
    this.checkpointTimer.unref();
  }

  stopCheckpointLoop(): void {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    this.dump();
  }

  private prune(nowMs: number): void {
    for (const [key, value] of this.toolVerdicts) {
      if (nowMs - value.recordedAtMs > TOOL_VERDICT_TTL_MS) {
        this.toolVerdicts.delete(key);
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
  };
}

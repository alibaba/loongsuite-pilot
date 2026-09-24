import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { interceptorToolVerdictDir } from './paths.js';
import type { HookEventName, InterceptorAgent } from './types.js';

export type ToolInterceptResult = 'allow' | 'deny' | 'unknown';
export type ToolInterceptPhase = Extract<HookEventName, 'PreToolUse' | 'PostToolUse'>;

export interface ToolVerdictKey {
  agent: InterceptorAgent;
  sessionId?: string;
  toolUseId: string;
  phase: ToolInterceptPhase;
}

export interface ToolVerdictRecord extends ToolVerdictKey {
  schema: 1;
  result: ToolInterceptResult;
  recordedAt: string;
}

export const TOOL_VERDICT_RETENTION_DAYS = 7;
export const TOOL_VERDICT_MAX_RECORDS = 100_000;
export const TOOL_VERDICT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isToolInterceptPhase(event: HookEventName): event is ToolInterceptPhase {
  return event === 'PreToolUse' || event === 'PostToolUse';
}

export function writeToolVerdict(
  key: ToolVerdictKey,
  result: ToolInterceptResult,
  root = interceptorToolVerdictDir(),
  now = new Date(),
): boolean {
  if (!key.toolUseId) return false;
  const record: ToolVerdictRecord = {
    schema: 1,
    ...key,
    sessionId: key.sessionId || undefined,
    result,
    recordedAt: now.toISOString(),
  };
  const bucket = path.join(root, utcBucket(now));
  const dest = path.join(bucket, `${keyHash(key)}.json`);
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(bucket, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, dest);
    maybeCleanupToolVerdicts(root, now);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return false;
  }
}

export function readToolVerdict(
  key: ToolVerdictKey,
  root = interceptorToolVerdictDir(),
  now = new Date(),
): ToolVerdictRecord | null {
  if (!key.toolUseId) return null;
  const filename = `${keyHash(key)}.json`;
  for (let age = 0; age < TOOL_VERDICT_RETENTION_DAYS; age += 1) {
    const bucketDate = new Date(now.getTime() - age * DAY_MS);
    const file = path.join(root, utcBucket(bucketDate), filename);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ToolVerdictRecord>;
      if (
        parsed.schema === 1
        && parsed.agent === key.agent
        && (parsed.sessionId ?? '') === (key.sessionId ?? '')
        && parsed.toolUseId === key.toolUseId
        && parsed.phase === key.phase
        && (parsed.result === 'allow' || parsed.result === 'deny' || parsed.result === 'unknown')
        && typeof parsed.recordedAt === 'string'
      ) {
        return parsed as ToolVerdictRecord;
      }
    } catch {
      // Missing, truncated, or concurrently cleaned records are a normal miss.
    }
  }
  return null;
}

export function maybeCleanupToolVerdicts(
  root = interceptorToolVerdictDir(),
  now = new Date(),
): void {
  const marker = path.join(root, '.cleanup-marker');
  const lock = path.join(root, '.cleanup-lock');
  try {
    const markerStat = fs.statSync(marker);
    if (now.getTime() - markerStat.mtimeMs < TOOL_VERDICT_CLEANUP_INTERVAL_MS) return;
  } catch {
    // First cleanup.
  }

  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(lock, 'wx', 0o600);
    fs.closeSync(fd);
  } catch {
    return;
  }

  try {
    cleanupToolVerdicts(root, now);
    fs.writeFileSync(marker, now.toISOString(), { encoding: 'utf8', mode: 0o600 });
  } finally {
    try { fs.unlinkSync(lock); } catch { /* best effort */ }
  }
}

export function cleanupToolVerdicts(
  root = interceptorToolVerdictDir(),
  now = new Date(),
  maxRecords = TOOL_VERDICT_MAX_RECORDS,
): { deleted: number; kept: number } {
  let deleted = 0;
  const keptFiles: Array<{ file: string; mtimeMs: number }> = [];
  const retainedBuckets = new Set<string>();
  for (let age = 0; age < TOOL_VERDICT_RETENTION_DAYS; age += 1) {
    retainedBuckets.add(utcBucket(new Date(now.getTime() - age * DAY_MS)));
  }

  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return { deleted, kept: 0 };
  }

  for (const name of names) {
    const full = path.join(root, name);
    if (BUCKET_RE.test(name) && !retainedBuckets.has(name)) {
      try {
        deleted += countJsonFiles(full);
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        // Best effort; the next cleanup retries.
      }
      continue;
    }
    if (!retainedBuckets.has(name)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const filename of files) {
      const file = path.join(full, filename);
      if (filename.endsWith('.tmp')) {
        try {
          fs.unlinkSync(file);
          deleted += 1;
        } catch { /* best effort */ }
        continue;
      }
      if (!filename.endsWith('.json')) continue;
      try {
        keptFiles.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {
        // Concurrent cleanup/write.
      }
    }
  }

  if (keptFiles.length > maxRecords) {
    keptFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const overflow = keptFiles.length - maxRecords;
    for (let i = 0; i < overflow; i += 1) {
      try {
        fs.unlinkSync(keptFiles[i].file);
        deleted += 1;
      } catch { /* best effort */ }
    }
  }
  return { deleted, kept: Math.min(keptFiles.length, maxRecords) };
}

function keyHash(key: ToolVerdictKey): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify([key.agent, key.sessionId ?? '', key.toolUseId, key.phase]))
    .digest('hex');
}

function utcBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function countJsonFiles(dir: string): number {
  try {
    return fs.readdirSync(dir).filter(name => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

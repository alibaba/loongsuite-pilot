import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveHome } from './fs-utils.js';

export type StartupCrashPhase = 'module_load' | 'startup' | 'runtime';

export interface StartupCrashBreadcrumb {
  schema: 1;
  ts: number;
  phase: StartupCrashPhase;
  version: string;
  pid: number;
  error_message: string;
  error_stack_head: string;
}

const FILE_NAME = 'last-startup-crash.json';
const STACK_HEAD_MAX_LINES = 10;
const STACK_HEAD_MAX_CHARS = 4000;

export function startupCrashPath(dataDir: string): string {
  return path.join(dataDir, 'logs', FILE_NAME);
}

/**
 * The single data dir the breadcrumb lives in. It MUST match where the updater (the
 * reader, src/updater/index.ts) and the bootstrap (scripts/collector-daemon.js, the
 * earliest writer) look — both use env-or-default, NOT config.dataDir. Aligning the
 * writer, clearer and reader on this one directory is what makes the "lingering
 * breadcrumb = most recent failed startup" invariant hold even when config.json
 * overrides dataDir.
 */
export function resolveBreadcrumbDataDir(): string {
  return resolveHome(process.env.LOONGSUITE_PILOT_DATA_DIR ?? '~/.loongsuite-pilot');
}

function truncateStackHead(stack: string | undefined): string {
  if (!stack) return '';
  const head = stack.split(/\r?\n/).slice(0, STACK_HEAD_MAX_LINES).join('\n');
  return head.length > STACK_HEAD_MAX_CHARS ? head.slice(0, STACK_HEAD_MAX_CHARS) : head;
}

/**
 * Persists the cause of an abnormal collector exit as a breadcrumb the updater can
 * read later. Synchronous and best-effort: a write failure must never mask the
 * original error or alter the exit code.
 */
export function writeStartupCrash(opts: {
  dataDir: string;
  phase: StartupCrashPhase;
  version: string;
  error: unknown;
}): void {
  try {
    const { error } = opts;
    const breadcrumb: StartupCrashBreadcrumb = {
      schema: 1,
      ts: Math.floor(Date.now() / 1000),
      phase: opts.phase,
      version: opts.version || 'unknown',
      pid: process.pid,
      error_message: error instanceof Error ? error.message : String(error),
      error_stack_head: truncateStackHead(error instanceof Error ? error.stack : undefined),
    };
    const file = startupCrashPath(opts.dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(breadcrumb, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // best-effort
  }
}

/**
 * Removes the breadcrumb after a healthy startup so a lingering file always means
 * the most recent startup attempt failed (PID/version-independent correlation).
 */
export function clearStartupCrash(dataDir: string): void {
  try {
    fs.rmSync(startupCrashPath(dataDir), { force: true });
  } catch {
    // ignore
  }
}

/**
 * Reads the last-startup-crash breadcrumb, or null when absent/unreadable/unknown schema.
 */
export function readStartupCrash(dataDir: string): StartupCrashBreadcrumb | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(startupCrashPath(dataDir), 'utf8')) as StartupCrashBreadcrumb;
    return parsed && parsed.schema === 1 ? parsed : null;
  } catch {
    return null;
  }
}

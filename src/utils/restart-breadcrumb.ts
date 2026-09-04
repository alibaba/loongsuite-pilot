import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonFile } from './fs-utils.js';

export type RestartTarget = 'collector' | 'updater';

/**
 * Stage labels the service scripts write. Stable, ASCII, never localized: they are
 * aggregation keys in the alarm stream, so renaming one breaks every saved query.
 *
 * `timeout` is the one label node produces itself — the script was killed before it
 * could write anything, so nobody else can report it.
 */
export const RESTART_STAGES = [
  'node-missing',
  'bootstrap-missing',
  'task-missing',
  'task-query-failed',
  'register-denied',
  'start-failed',
  'not-running-after-start',
  'selfheal-register-failed',
  'selfheal-not-running',
  'service-manager-refused',
  'timeout',
] as const;

export interface RestartFailureBreadcrumb {
  schema: 1;
  /** Epoch seconds, matching writeStartupCrash. */
  ts: number;
  target: RestartTarget;
  stage: string;
  init_type?: string;
  detail?: string;
  /** Flat string map — the scripts cannot emit nested JSON safely under CLM. */
  diag?: Record<string, string>;
}

const DETAIL_MAX_CHARS = 300;
const VALUE_MAX_CHARS = 200;
const SUMMARY_MAX_CHARS = 900;

/**
 * Diag keys worth carrying into the alarm message, most diagnostic first. Anything
 * else the script recorded still reaches the log (the full breadcrumb is logged); the
 * order here only decides what survives the SUMMARY_MAX_CHARS budget.
 */
const DIAG_KEY_ORDER = [
  'task_state',
  'exists_ps',
  'exists_schtasks',
  'query_error',
  'last_task_result',
  'last_run_time',
  'missed_runs',
  'register_error',
  'start_error',
  'selfheal_error',
  'principal_user',
  'logon_type',
  'run_level',
  'definition_owner',
  'action_exe',
  'node_bin',
  'pid_state',
  'service_state',
  'unit_state',
  'log_tail',
];

export function restartFailurePath(dataDir: string, target: RestartTarget): string {
  return path.join(dataDir, 'logs', `last-restart-failure-${target}.json`);
}

/**
 * Reads the breadcrumb the service script left behind, or null when absent,
 * unreadable, or written by an unknown schema.
 *
 * Goes through readJsonFile because the writer is PowerShell 5.1, whose
 * `Set-Content -Encoding UTF8` always emits a BOM — JSON.parse rejects it.
 */
export async function readRestartFailure(
  dataDir: string,
  target: RestartTarget,
): Promise<RestartFailureBreadcrumb | null> {
  const parsed = await readJsonFile<RestartFailureBreadcrumb>(restartFailurePath(dataDir, target));
  if (!parsed || parsed.schema !== 1 || !parsed.stage) return null;
  return parsed;
}

/**
 * Removes the breadcrumb, so a file that is present always describes the most recent
 * restart attempt rather than some earlier one (same invariant as clearStartupCrash).
 * The scripts clear it on entry; this exists for callers that recover by other means.
 */
export function clearRestartFailure(dataDir: string, target: RestartTarget): void {
  try {
    fs.rmSync(restartFailurePath(dataDir, target), { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Whether the breadcrumb belongs to the attempt that started at `attemptStartMs`.
 *
 * Without this check a script that never ran at all (powershell.exe missing, the
 * process killed before its first statement) would be explained by whatever the
 * previous failure left on disk — the most misleading possible outcome for an alarm.
 * `skewMs` absorbs the one-second resolution of the epoch-seconds timestamp plus any
 * clock jitter between the two processes.
 */
export function isRestartFailureFresh(
  breadcrumb: RestartFailureBreadcrumb,
  attemptStartMs: number,
  skewMs = 5_000,
): boolean {
  const ts = Number(breadcrumb.ts);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return ts * 1000 >= attemptStartMs - skewMs;
}

/**
 * Renders the breadcrumb as an alarm-message suffix — message only, no schema change,
 * same approach as UpdaterMetrics.buildNotRunningMessage.
 */
export function summarizeRestartFailure(breadcrumb: RestartFailureBreadcrumb): string {
  const parts = [`stage=${sanitizeAlarmText(breadcrumb.stage, 60)}`];
  if (breadcrumb.detail) {
    parts.push(`reason="${sanitizeAlarmText(breadcrumb.detail, DETAIL_MAX_CHARS)}"`);
  }
  if (breadcrumb.init_type) parts.push(`init_type=${sanitizeAlarmText(breadcrumb.init_type, 40)}`);

  const diag = breadcrumb.diag ?? {};
  const keys = Object.keys(diag);
  const ordered = [
    ...DIAG_KEY_ORDER.filter(k => keys.includes(k)),
    ...keys.filter(k => !DIAG_KEY_ORDER.includes(k)).sort(),
  ];
  let rendered = parts.join(' ');
  for (const key of ordered) {
    const value = sanitizeAlarmText(String(diag[key] ?? ''), VALUE_MAX_CHARS);
    if (!value) continue;
    const next = `${rendered} ${sanitizeAlarmText(key, 40)}="${value}"`;
    if (next.length > SUMMARY_MAX_CHARS) break;
    rendered = next;
  }
  return rendered;
}

/**
 * Keeps a value safe to embed in `key="..."`: no quotes or control characters that
 * would break downstream parsing, and bounded so one huge log tail cannot push the
 * stage out of a truncated alarm message.
 *
 * Exported because the restart callers embed their own fields (exec error text,
 * captured stdout) into the same message and must bound them the same way.
 */
export function sanitizeAlarmText(text: string, maxChars: number): string {
  return text.replace(/["\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/** The parts of a child_process error the restart callers report on. */
export interface RestartCommandError {
  message?: string;
  killed?: boolean;
  signal?: string | null;
  code?: number | string | null;
  stdout?: string;
  stderr?: string;
}

/**
 * Whether the command was killed by its own timeout rather than exiting on its own.
 * A killed script cannot have written a breadcrumb, so this is the only stage node
 * has to infer by itself.
 */
export function isRestartCommandTimeout(err: unknown): boolean {
  const e = (err ?? {}) as RestartCommandError;
  return e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
}

/**
 * Renders a failed restart command as bounded `key="value"` fields.
 *
 * Both stream tails are included on purpose: the service scripts print their
 * diagnostics with Write-Host / echo, and node's own `err.message` carries stderr
 * only — which is exactly how the original production report ended up as a single
 * unexplained "Command failed" line. Tails rather than heads, because the useful
 * part of a restart transcript is always at the end.
 */
export function describeRestartCommandError(err: unknown): string {
  const e = (err ?? {}) as RestartCommandError;
  const parts: string[] = [];
  if (e.killed === true || e.signal) parts.push(`killed=${e.killed === true} signal=${e.signal ?? 'none'}`);
  if (e.code !== undefined && e.code !== null) parts.push(`exit=${e.code}`);
  const stderr = tailText(e.stderr, DETAIL_MAX_CHARS);
  const stdout = tailText(e.stdout, DETAIL_MAX_CHARS);
  if (stderr) parts.push(`stderr="${stderr}"`);
  if (stdout) parts.push(`stdout="${stdout}"`);
  if (parts.length === 0) {
    const message = sanitizeAlarmText(String(e.message ?? err ?? ''), DETAIL_MAX_CHARS);
    if (message) parts.push(`err="${message}"`);
  }
  return parts.join(' ') || 'no error detail';
}

function tailText(text: string | undefined, maxChars: number): string {
  const clean = sanitizeAlarmText(String(text ?? ''), Number.MAX_SAFE_INTEGER);
  return clean.length > maxChars ? clean.slice(clean.length - maxChars) : clean;
}

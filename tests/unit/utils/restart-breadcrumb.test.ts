import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearRestartFailure,
  describeRestartCommandError,
  isRestartCommandTimeout,
  isRestartFailureFresh,
  readRestartFailure,
  restartFailurePath,
  sanitizeAlarmText,
  summarizeRestartFailure,
  type RestartFailureBreadcrumb,
} from '../../../src/utils/restart-breadcrumb.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-restart-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Writes the file the way a service script does, optionally with a UTF-8 BOM. */
function writeBreadcrumb(
  target: 'collector' | 'updater',
  payload: unknown,
  { bom = false }: { bom?: boolean } = {},
): void {
  const file = restartFailurePath(dataDir, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${bom ? '﻿' : ''}${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

describe('restart-breadcrumb reader', () => {
  it('reads a breadcrumb written with a BOM', async () => {
    // PowerShell 5.1 has no utf8NoBOM: `Set-Content -Encoding UTF8` always writes one,
    // and JSON.parse rejects it. Because readJsonFile swallows parse errors, a BOM would
    // degrade to "no diagnostics" -- silently, which is the whole thing being fixed here.
    writeBreadcrumb('updater', {
      schema: 1,
      ts: 1_700_000_000,
      target: 'updater',
      stage: 'register-denied',
      init_type: 'taskscheduler',
      detail: 'Access is denied.',
      diag: { definition_owner: 'BUILTIN\\Administrators' },
    }, { bom: true });

    const bc = await readRestartFailure(dataDir, 'updater');
    expect(bc).not.toBeNull();
    expect(bc!.stage).toBe('register-denied');
    expect(bc!.diag?.definition_owner).toBe('BUILTIN\\Administrators');
  });

  it('returns null for a missing file, an unknown schema, and a stage-less payload', async () => {
    expect(await readRestartFailure(dataDir, 'collector')).toBeNull();

    writeBreadcrumb('collector', { schema: 2, ts: 1, target: 'collector', stage: 'task-missing' });
    expect(await readRestartFailure(dataDir, 'collector')).toBeNull();

    writeBreadcrumb('collector', { schema: 1, ts: 1, target: 'collector' });
    expect(await readRestartFailure(dataDir, 'collector')).toBeNull();
  });

  it('returns null for a truncated file instead of throwing', async () => {
    const file = restartFailurePath(dataDir, 'updater');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"schema": 1, "stage": "task-mis');
    expect(await readRestartFailure(dataDir, 'updater')).toBeNull();
  });

  it('clears the file and tolerates a second clear', async () => {
    writeBreadcrumb('updater', { schema: 1, ts: 1, target: 'updater', stage: 'timeout' });
    clearRestartFailure(dataDir, 'updater');
    expect(await readRestartFailure(dataDir, 'updater')).toBeNull();
    expect(() => clearRestartFailure(dataDir, 'updater')).not.toThrow();
  });

  it('places the file under logs/ per target', () => {
    expect(restartFailurePath('/d', 'updater')).toBe(path.join('/d', 'logs', 'last-restart-failure-updater.json'));
    expect(restartFailurePath('/d', 'collector')).toBe(path.join('/d', 'logs', 'last-restart-failure-collector.json'));
  });
});

describe('isRestartFailureFresh', () => {
  const at = (ts: number): RestartFailureBreadcrumb =>
    ({ schema: 1, ts, target: 'updater', stage: 'start-failed' });

  it('accepts a breadcrumb written during the attempt', () => {
    const start = 1_700_000_000_000;
    expect(isRestartFailureFresh(at(start / 1000 + 3), start)).toBe(true);
  });

  it('accepts one written just before the attempt started, within the skew', () => {
    // The script's epoch-seconds resolution alone can place its own write up to a second
    // before the millisecond timestamp node took when it spawned the command.
    const start = 1_700_000_000_000;
    expect(isRestartFailureFresh(at(start / 1000 - 2), start)).toBe(true);
    expect(isRestartFailureFresh(at(start / 1000 - 60), start)).toBe(false);
  });

  it('rejects a missing or nonsensical timestamp', () => {
    const start = 1_700_000_000_000;
    expect(isRestartFailureFresh(at(0), start)).toBe(false);
    expect(isRestartFailureFresh(at(Number.NaN), start)).toBe(false);
    expect(isRestartFailureFresh({ schema: 1, target: 'updater', stage: 'x' } as RestartFailureBreadcrumb, start)).toBe(false);
  });
});

describe('summarizeRestartFailure', () => {
  it('leads with the stage and quotes the reason', () => {
    const summary = summarizeRestartFailure({
      schema: 1,
      ts: 1,
      target: 'updater',
      stage: 'register-denied',
      init_type: 'taskscheduler',
      detail: 'Register-ScheduledTask failed',
      diag: { task_state: 'Ready', definition_owner: 'BUILTIN\\Administrators' },
    });
    expect(summary.startsWith('stage=register-denied')).toBe(true);
    expect(summary).toContain('reason="Register-ScheduledTask failed"');
    expect(summary).toContain('init_type=taskscheduler');
    expect(summary).toContain('task_state="Ready"');
    expect(summary).toContain('definition_owner="BUILTIN\\Administrators"');
  });

  it('drops empty diag values so the script can emit placeholder keys', () => {
    const summary = summarizeRestartFailure({
      schema: 1, ts: 1, target: 'updater', stage: 'task-missing',
      diag: { start_error: '', selfheal_error: '   ', task_state: 'Ready' },
    });
    expect(summary).not.toContain('start_error');
    expect(summary).not.toContain('selfheal_error');
    expect(summary).toContain('task_state="Ready"');
  });

  it('keeps the stage readable no matter how large the diagnostics are', () => {
    const summary = summarizeRestartFailure({
      schema: 1, ts: 1, target: 'updater', stage: 'not-running-after-start',
      detail: 'x'.repeat(5_000),
      diag: {
        log_tail: 'y'.repeat(5_000),
        task_state: 'Ready',
        extra_one: 'z'.repeat(5_000),
        extra_two: 'w'.repeat(5_000),
      },
    });
    expect(summary.startsWith('stage=not-running-after-start')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(1_000);
    // The ordered keys win the budget over the alphabetical extras.
    expect(summary).toContain('task_state="Ready"');
  });

  it('strips quotes, newlines and tabs that would break key="value" parsing', () => {
    const summary = summarizeRestartFailure({
      schema: 1, ts: 1, target: 'collector', stage: 'start-failed',
      detail: 'boom "quoted"\nsecond line\tafter tab',
    });
    expect(summary).toBe('stage=start-failed reason="boom quoted second line after tab"');
  });
});

describe('describeRestartCommandError', () => {
  it('reports both stream tails, because the scripts print diagnostics on stdout', () => {
    const detail = describeRestartCommandError({
      message: 'Command failed: powershell.exe ...',
      code: 1,
      stdout: '[restart-failure] target=updater stage=register-denied',
      stderr: 'Cmd-RestartUpdater : Service manager failed to restart updater',
    });
    expect(detail).toContain('exit=1');
    expect(detail).toContain('stdout="[restart-failure] target=updater stage=register-denied"');
    expect(detail).toContain('stderr="Cmd-RestartUpdater : Service manager failed to restart updater"');
  });

  it('keeps the end of a long stream, where the failure actually is', () => {
    const detail = describeRestartCommandError({ code: 1, stdout: `${'a'.repeat(5_000)}THE-REAL-REASON` });
    expect(detail).toContain('THE-REAL-REASON');
    expect(detail.length).toBeLessThan(1_000);
  });

  it('falls back to the error message when there is no output at all', () => {
    const detail = describeRestartCommandError(new Error('spawn powershell.exe ENOENT'));
    expect(detail).toContain('spawn powershell.exe ENOENT');
    expect(describeRestartCommandError(undefined)).toBe('no error detail');
  });

  it('recognises a timeout kill', () => {
    expect(isRestartCommandTimeout({ killed: true, signal: 'SIGTERM' })).toBe(true);
    expect(isRestartCommandTimeout({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRestartCommandTimeout({ code: 1 })).toBe(false);
    expect(isRestartCommandTimeout(new Error('nope'))).toBe(false);
  });
});

describe('sanitizeAlarmText', () => {
  it('collapses whitespace and truncates', () => {
    expect(sanitizeAlarmText('  a\t b \n c  ', 100)).toBe('a b c');
    expect(sanitizeAlarmText('abcdef', 3)).toBe('abc');
  });
});

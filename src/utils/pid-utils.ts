import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export type ProcessLivenessSource = 'pid-file' | 'process-scan' | 'none';
export type PidFileState = 'missing' | 'invalid' | 'stale' | 'matched';
export type ProcessCommandPattern = string | RegExp;

export interface ProcessLiveness {
  running: boolean;
  pid?: number;
  source: ProcessLivenessSource;
  reason: string;
  pidFileState?: PidFileState;
  pidFileProcessAlive?: boolean;
  pidFileCommand?: string;
  pidFileCommandMatched?: boolean;
}

export const COLLECTOR_PROCESS_PATTERNS: readonly ProcessCommandPattern[] = [
  'collector-daemon.js',
  '/bin/collector-daemon',
  '\\bin\\collector-daemon',
  /(?:^|[\s/\\])loongsuite-pilot(?:\.ps1)?\s+(?:run|run-service)(?:\s|$)/,
];

export const UPDATER_PROCESS_PATTERNS: readonly ProcessCommandPattern[] = [
  'updater-daemon.js',
  '/bin/updater-daemon',
  '\\bin\\updater-daemon',
  /(?:^|[\s/\\])loongsuite-pilot(?:\.ps1)?\s+run-updater(?:\s|$)/,
  'dist/updater/index.js',
];

export function isPidFileRunning(pidFile: string): boolean {
  const pid = readPidFile(pidFile);
  return pid !== null && isProcessAlive(pid);
}

export function readPidFile(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8');
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Write this process's pid to `pidFile` as a bare integer + newline — the exact
 * format the launcher scripts read (`Get-Content .Trim()` / `cat`). Used on Windows,
 * where there is no exec(2) to let the wrapper record the daemon's real pid, so the
 * daemon publishes its own. Best-effort: a write failure must not block startup.
 */
export function writePidFileSync(pidFile: string): void {
  try {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  } catch {
    // Dir may already exist; the write below surfaces any real failure.
  }
  try {
    fs.writeFileSync(pidFile, `${process.pid}\n`);
  } catch {
    // Best-effort: never let pid-file publishing crash the daemon.
  }
}

/**
 * Remove `pidFile`, but only when it still records this process — so a crash-recovery
 * peer that already took over is never clobbered. Idempotent and best-effort.
 */
export function removeOwnPidFileSync(pidFile: string): void {
  try {
    if (readPidFile(pidFile) === process.pid) {
      fs.unlinkSync(pidFile);
    }
  } catch {
    // Best-effort: never let pid-file cleanup crash shutdown.
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return isErrnoCode(err, 'EPERM');
  }
}

export function isCommandMatch(command: string, patterns: readonly ProcessCommandPattern[]): boolean {
  return patterns.some(pattern => typeof pattern === 'string'
    ? command.includes(pattern)
    : pattern.test(command));
}

export function findProcessByCommand(patterns: readonly ProcessCommandPattern[]): ProcessLiveness {
  if (process.platform === 'win32') {
    return findWindowsProcessByCommand(patterns);
  }
  return findUnixProcessByCommand(patterns);
}

export function checkProcessLiveness(pidFile: string, patterns: readonly ProcessCommandPattern[]): ProcessLiveness {
  const pid = readPidFile(pidFile);
  const pidFileStateWhenMissing: PidFileState = fs.existsSync(pidFile) ? 'invalid' : 'missing';
  let pidFileProcessAlive = false;
  let pidFileCommand = '';
  let pidFileCommandMatched: boolean | undefined;

  if (pid !== null) {
    pidFileProcessAlive = isProcessAlive(pid);
    if (pidFileProcessAlive) {
      pidFileCommand = readProcessCommand(pid);
      pidFileCommandMatched = pidFileCommand ? isCommandMatch(pidFileCommand, patterns) : undefined;
      if (pidFileCommandMatched === true) {
        return {
          running: true,
          pid,
          source: 'pid-file',
          reason: 'process is running with matching command',
          pidFileState: 'matched',
          pidFileProcessAlive,
          pidFileCommand,
          pidFileCommandMatched,
        };
      }
    }
  }

  const discovered = findProcessByCommand(patterns);
  if (discovered.running) {
    return {
      ...discovered,
      reason: pid === null
        ? `${discovered.reason}; pid file is ${pidFileStateWhenMissing}`
        : `${discovered.reason}; pid file points to stale or mismatched pid ${pid}`,
      pidFileState: pid === null ? pidFileStateWhenMissing : 'stale',
      pidFileProcessAlive,
      pidFileCommand,
      pidFileCommandMatched,
    };
  }

  return {
    running: false,
    pid: pid ?? undefined,
    source: 'none',
    reason: pid === null
      ? `pid file is ${pidFileStateWhenMissing}; no matching process found`
      : `pid file points to stale or mismatched pid ${pid}; no matching process found`,
    pidFileState: pid === null ? pidFileStateWhenMissing : 'stale',
    pidFileProcessAlive,
    pidFileCommand,
    pidFileCommandMatched,
  };
}

export function readProcessCommand(pid: number): string {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine`,
      ], { timeout: 5000, encoding: 'utf-8', windowsHide: true }).trim();
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Return a stable, boot-scoped identity for one concrete process lifetime.
 *
 * Unlike a pid, this value changes when the OS recycles the pid. Callers must
 * fail closed when it is unavailable: command lines are useful diagnostics but
 * are not strong enough to prove that a pid was reused.
 */
export function readProcessStartToken(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    if (process.platform === 'linux') {
      // /proc/<pid>/stat field 22 is the process start time in clock ticks since
      // boot. Include boot_id so a stale lock cannot accidentally match after a
      // reboot. Locate the final ')' because comm may itself contain spaces or ')'.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const commEnd = stat.lastIndexOf(')');
      if (commEnd < 0) return '';
      const fieldsAfterComm = stat.slice(commEnd + 1).trim().split(/\s+/);
      const startTicks = fieldsAfterComm[19];
      const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
      return startTicks && bootId ? `linux-proc-v1:${bootId}:${startTicks}` : '';
    }
    if (process.platform === 'win32') {
      const creationDate = execFileSync('powershell.exe', [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString("O") }`,
      ], { timeout: 5000, encoding: 'utf-8', windowsHide: true }).trim();
      return creationDate ? `win32-cim-v1:${creationDate}` : '';
    }
    const startedAt = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim().replace(/\s+/g, ' ');
    return startedAt ? `${process.platform}-ps-lstart-v1:${startedAt}` : '';
  } catch {
    return '';
  }
}

function findUnixProcessByCommand(patterns: readonly ProcessCommandPattern[]): ProcessLiveness {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], {
      timeout: 5000,
      encoding: 'utf-8',
    });
    for (const line of out.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2] ?? '';
      if (pid === process.pid || !Number.isInteger(pid) || pid <= 0) continue;
      if (isCommandMatch(command, patterns)) {
        return {
          running: true,
          pid,
          source: 'process-scan',
          reason: 'matching process command found',
        };
      }
    }
  } catch {
    // best effort
  }
  return { running: false, source: 'none', reason: 'no matching process found' };
}

function findWindowsProcessByCommand(patterns: readonly ProcessCommandPattern[]): ProcessLiveness {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile',
      '-WindowStyle',
      'Hidden',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
    ], { timeout: 8000, encoding: 'utf-8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const [pidRaw, command = ''] = line.split(/\t/, 2);
      const pid = Number(pidRaw);
      if (pid === process.pid || !Number.isInteger(pid) || pid <= 0) continue;
      if (isCommandMatch(command, patterns)) {
        return {
          running: true,
          pid,
          source: 'process-scan',
          reason: 'matching process command found',
        };
      }
    }
  } catch {
    // best effort
  }
  return { running: false, source: 'none', reason: 'no matching process found' };
}

function isErrnoCode(err: unknown, code: string): boolean {
  return err !== null
    && typeof err === 'object'
    && 'code' in err
    && (err as NodeJS.ErrnoException).code === code;
}

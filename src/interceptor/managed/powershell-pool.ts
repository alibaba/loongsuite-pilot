import type { ChildProcess } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { createLogger } from '../../utils/logger.js';
import { MAX_SCRIPT_STDOUT_BYTES, type ScriptRunner, type ScriptRunResult } from './runner.js';
import { trackManagedChild } from './child-lifecycle.js';
import { spawnPowerShellGuardian } from './windows-job-guardian.js';

const logger = createLogger('ManagedPowerShellPool');

export const PILOT_END_MARKER = '###PILOT_END###';
const DEFAULT_POOL_SIZE = 2;
const DEFAULT_COMMAND = 'powershell.exe';
const DEFAULT_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'];

/*
 * Everything written to stdin is ASCII: 5.1 decodes `-Command -` input with the
 * console code page, so a CJK prompt or user name would arrive as `?`. The
 * scripts directory therefore comes from the worker's cwd (CreateProcessW is
 * Unicode-safe) and the payload escapes non-ASCII as \uXXXX inside JSON.
 * Each command is a single line because multi-line statements under
 * `-Command -` wait for an extra blank line on 5.1.
 * The bootstrap line is CLM-safe: the OutputEncoding assignment throws under
 * ConstrainedLanguage and is skipped, leaving non-ASCII reasons in the OEM
 * code page while the verdict itself stays readable.
 */
const BOOTSTRAP = [
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$__pilotScripts = (Get-Location).ProviderPath',
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
].join('; ');

export interface PowerShellPoolOptions {
  scriptsDir: string;
  size?: number;
  command?: string;
  args?: string[];
}

interface Job {
  fileName: string;
  payload: string;
  deadline: number;
  resolve: (result: ScriptRunResult) => void;
  queueTimer?: NodeJS.Timeout;
}

/** At most 1-2 owned executors; each is retired with its descendants after one hook. */
export class PowerShellPool implements ScriptRunner {
  private readonly workers: PowerShellWorker[] = [];
  private readonly queue: Job[] = [];
  private readonly size: number;
  private stopped = false;

  constructor(private readonly opts: PowerShellPoolOptions) {
    this.size = Math.max(1, Math.min(opts.size ?? DEFAULT_POOL_SIZE, 2));
  }

  warm(): void {
    if (this.stopped) return;
    this.prune();
    while (this.workers.length < this.size) this.spawnWorker();
  }

  run(file: string, payload: string, timeoutMs: number): Promise<ScriptRunResult> {
    if (this.stopped) return Promise.resolve({ ok: false, error: 'pool stopped' });
    if (path.dirname(file) !== this.opts.scriptsDir) {
      return Promise.resolve({ ok: false, error: 'script outside managed directory' });
    }
    return new Promise((resolve) => {
      const job: Job = {
        fileName: path.basename(file),
        payload: toAsciiJson(payload),
        deadline: Date.now() + Math.max(0, timeoutMs),
        resolve,
      };
      job.queueTimer = setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index < 0) return;
        this.queue.splice(index, 1);
        resolve({ ok: false, error: 'timeout waiting for a powershell worker' });
      }, Math.max(0, timeoutMs));
      this.queue.push(job);
      this.pump();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.queueTimer);
      job.resolve({ ok: false, error: 'pool stopped' });
    }
    for (const worker of this.workers.splice(0)) worker.kill('pool stopped');
  }

  private pump(): void {
    if (this.stopped || this.queue.length === 0) return;
    this.warm();
    while (this.queue.length > 0) {
      const worker = this.workers.find(w => w.idle);
      if (!worker) return;
      const job = this.queue.shift()!;
      clearTimeout(job.queueTimer);
      const remaining = job.deadline - Date.now();
      if (remaining <= 0) {
        job.resolve({ ok: false, error: 'timeout waiting for a powershell worker' });
        continue;
      }
      worker.execute(job.fileName, job.payload, remaining, job.resolve);
    }
  }

  private spawnWorker(): void {
    const worker = new PowerShellWorker(
      this.opts.command ?? DEFAULT_COMMAND,
      this.opts.args ?? DEFAULT_ARGS,
      this.opts.scriptsDir,
      completed => this.onWorkerDead(completed),
    );
    this.workers.push(worker);
  }

  private onWorkerDead(completed: boolean): void {
    this.prune();
    // A capability failure, including slow CLM/WDAC rejection, never creates a
    // background respawn loop. Only a completed hook eagerly replenishes warm capacity.
    if (completed) this.warm();
    this.pump();
  }

  private prune(): void {
    for (let i = this.workers.length - 1; i >= 0; i -= 1) {
      if (this.workers[i].dead) this.workers.splice(i, 1);
    }
  }
}

interface Pending {
  marker: string;
  lines: string[];
  bytes: number;
  timer: NodeJS.Timeout;
  resolve: (result: ScriptRunResult) => void;
}

class PowerShellWorker {
  dead = false;
  private readonly child: ChildProcess;
  private readonly lease: Duplex;
  private pending: Pending | null = null;
  private buffer = '';
  private closing = false;
  private completion: ScriptRunResult | null = null;
  private ownershipError: string | undefined;
  private control = '';

  constructor(
    command: string,
    args: string[],
    cwd: string,
    private readonly onDead: (completed: boolean) => void,
  ) {
    this.child = spawnPowerShellGuardian(command, args, cwd);
    this.lease = this.child.stdio[3] as Duplex;
    trackManagedChild(this.child, process.platform !== 'win32');
    this.lease.on('error', () => {});
    this.lease.on('data', (chunk: Buffer) => {
      this.control += chunk.toString('utf8');
      if (this.control.length > 2048) { this.kill('invalid guardian control'); return; }
      let newline: number;
      while ((newline = this.control.indexOf('\n')) >= 0) {
        const line = this.control.slice(0, newline);
        this.control = this.control.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.error === 'Windows Job Object unavailable') this.ownershipError = message.error;
        } catch { this.kill('invalid guardian control'); }
      }
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    // stderr must be drained or a chatty script blocks the worker on a full pipe.
    this.child.stderr?.on('data', () => {});
    this.child.stdin?.on('error', () => {});
    this.child.on('error', err => this.kill(`spawn failed: ${err.message}`));
    // A replacement is forbidden until the guardian has closed the owned tree.
    this.child.on('close', code => this.markDead(this.ownershipError ?? `worker exited with ${code}`));
    this.write(BOOTSTRAP);
  }

  get idle(): boolean {
    return !this.dead && !this.closing && this.pending === null;
  }

  execute(fileName: string, payload: string, timeoutMs: number, resolve: (result: ScriptRunResult) => void): void {
    const marker = `${PILOT_END_MARKER}${randomBytes(6).toString('hex')}`;
    const timer = setTimeout(() => this.kill('timeout'), timeoutMs);
    this.pending = { marker, lines: [], bytes: 0, timer, resolve };
    this.lease.write(`${JSON.stringify({ timeout: timeoutMs })}\n`);
    // Capture $? before any subsequent command can overwrite it. A script's
    // `exit` updates LASTEXITCODE in its caller; reset it for each request.
    this.write(`$global:LASTEXITCODE = 0; $__pilotOk = $false; $__pilotExit = 1; try { ${psQuote(payload)} | & (Join-Path $__pilotScripts ${psQuote(fileName)}); $__pilotOk = $?; $__pilotExit = $global:LASTEXITCODE } catch { $__pilotOk = $false; $__pilotExit = 1 }; if (-not $__pilotOk -and $__pilotExit -eq 0) { $__pilotExit = 1 }; ${psQuote(`${marker}:`)} + [string]$__pilotExit`);
  }

  kill(reason: string): void {
    if (this.dead) return;
    const alreadyClosing = this.closing;
    this.closing = true;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      // Fail-open follows the hook budget; capacity stays occupied until cleanup.
      pending.resolve({ ok: false, error: reason });
    }
    if (!alreadyClosing) this.endLease();
    if (reason !== 'pool stopped') logger.warn('powershell worker retired', { reason });
  }

  private endLease(): void {
    try { this.lease.end(); } catch {}
    try { this.child.stdin?.end(); } catch {}
  }

  private write(line: string): void {
    try {
      this.child.stdin?.write(`${line}\n`);
    } catch (err) {
      this.kill(`stdin write failed: ${String(err)}`);
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > MAX_SCRIPT_STDOUT_BYTES) {
      this.buffer = '';
      this.kill('stdout too large');
    }
  }

  private onLine(line: string): void {
    const pending = this.pending;
    // Output outside a request (bootstrap noise, a killed run's tail) is ignored.
    if (!pending || this.closing) return;
    const completion = line.trim().match(new RegExp(`^${pending.marker}:(-?\\d+)$`));
    if (completion) {
      this.closing = true;
      this.completion = completion[1] === '0'
        ? { ok: true, stdout: pending.lines.join('\n') }
        : { ok: false, error: `powershell script exited with ${completion[1]}` };
      // Do not reuse an executor while a script-created background process lives.
      this.endLease();
      return;
    }
    pending.bytes += line.length;
    if (pending.bytes > MAX_SCRIPT_STDOUT_BYTES) {
      this.kill('stdout too large');
      return;
    }
    pending.lines.push(line);
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(this.ownershipError
        ? { ok: false, error: this.ownershipError }
        : this.completion ?? { ok: false, error: reason });
    }
    if (!this.closing) logger.warn('powershell worker retired', { reason });
    this.onDead(this.completion !== null);
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function toAsciiJson(json: string): string {
  return json.replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

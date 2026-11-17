import { spawn, type ChildProcess } from 'node:child_process';
import { MAX_SCRIPT_STDOUT_BYTES, scriptEnv, type ScriptRunner, type ScriptRunResult } from './runner.js';
import { trackManagedChild } from './child-lifecycle.js';

/**
 * The guardian stays group leader even when sh exits before its descendants.
 * fd3 is a lifetime lease: the Worker disappearing closes it independently of
 * either collector event loop. Normal completion is sent over the same private
 * pipe before the guardian kills its own group, preserving the script exit code.
 */
const GUARDIAN_SOURCE = `
const { spawn } = require('node:child_process');
const { Socket } = require('node:net');
const [shell, file, budget] = process.argv.slice(1);
const lease = new Socket({ fd: 3, readable: true, writable: true });
let ending = false;
function killGroup() {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
}
lease.on('end', killGroup);
lease.on('close', killGroup);
lease.on('error', killGroup);
lease.resume();
setTimeout(killGroup, Math.max(0, Number(budget) || 0));
process.stdout.on('error', killGroup);
const child = spawn(shell, [file], { stdio: ['pipe', 'pipe', 'ignore'] });
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout, { end: false });
function complete(code, signal) {
  if (ending) return;
  ending = true;
  process.stdout.write('', () => {
    lease.write(JSON.stringify({ code, signal }) + '\\n', killGroup);
  });
}
child.on('error', () => complete(1, null));
child.on('close', complete);
`;

/** Runs `sh <file>` once per hook, with the request JSON on stdin. Never `sh -c`. */
export class ShScriptRunner implements ScriptRunner {
  private readonly running = new Set<ChildProcess>();
  private stopped = false;

  constructor(private readonly shell = 'sh') {}

  run(file: string, payload: string, timeoutMs: number): Promise<ScriptRunResult> {
    return new Promise((resolve) => {
      // Scripts are detached; one started after stop() would outlive the collector.
      if (this.stopped) {
        resolve({ ok: false, error: 'runner stopped' });
        return;
      }
      let child: ChildProcess;
      const guarded = process.platform !== 'win32';
      try {
        child = spawn(guarded ? process.execPath : this.shell,
          guarded ? ['-e', GUARDIAN_SOURCE, this.shell, file, String(timeoutMs)] : [file], {
          env: scriptEnv(),
          stdio: guarded ? ['pipe', 'pipe', 'ignore', 'pipe'] : ['pipe', 'pipe', 'ignore'],
          // Own process group, so a timeout also kills grep/sed children holding stdout open.
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (err) {
        resolve({ ok: false, error: `spawn failed: ${String(err)}` });
        return;
      }
      this.running.add(child);
      trackManagedChild(child, process.platform !== 'win32');

      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      let completion: { code: number | null; signal: string | null } | undefined;
      const lease = guarded ? child.stdio[3] : null;
      let status = '';
      lease?.on('error', () => {});
      lease?.on('data', (chunk: Buffer) => {
        status += chunk.toString('utf8');
        if (status.length > 1024) { killTree(child); return; }
        const newline = status.indexOf('\n');
        if (newline < 0) return;
        try {
          const parsed = JSON.parse(status.slice(0, newline));
          if ((typeof parsed.code === 'number' || parsed.code === null)
            && (typeof parsed.signal === 'string' || parsed.signal === null)) completion = parsed;
        } catch { /* A missing completion fails open like any failed script. */ }
      });
      const finish = (result: ScriptRunResult, kill: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(child);
        if (kill) killTree(child);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }, true), Math.max(0, timeoutMs));

      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_SCRIPT_STDOUT_BYTES) {
          finish({ ok: false, error: 'stdout too large' }, true);
          return;
        }
        chunks.push(chunk);
      });
      child.on('error', err => finish({ ok: false, error: `spawn failed: ${err.message}` }, false));
      child.on('close', (code, signal) => {
        const scriptCode = guarded && completion ? completion.code : code;
        const scriptSignal = guarded && completion ? completion.signal : signal;
        if (scriptCode !== 0) {
          finish({ ok: false, error: `exited with ${scriptSignal ?? scriptCode}` }, false);
          return;
        }
        finish({ ok: true, stdout: Buffer.concat(chunks).toString('utf8') }, false);
      });
      // A script that never reads stdin closes the pipe early; that is not a failure by itself.
      child.stdin?.on('error', () => {});
      child.stdin?.end(payload);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const child of this.running) killTree(child);
    this.running.clear();
  }
}

function killTree(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch {
    // No process group (already reaped or never created): kill the child itself.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

// Bounded subprocess execution for installed-artifact acceptance.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export function runCommand(executable, args, { cwd, env, timeoutMs, logPath, outputLimitBytes = Infinity }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Command timeout must be positive');
  return new Promise(resolve => {
    // Open before spawning: an unwritable log must not leave a detached compiler.
    const fd = fs.openSync(logPath, 'a');
    const log = fs.createWriteStream(logPath, { fd, autoClose: true });
    const logClosed = new Promise(done => log.once('close', done));
    const started = Date.now();
    const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false, interrupted = false, terminating = false, childClosed = false, spawnError, killTimer;
    const terminate = () => {
      terminating = true;
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') spawnError = String(error); }
      killTimer ??= setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }, 5000);
    };
    const onSignal = () => { interrupted = true; terminate(); };
    process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    log.on('error', error => {
      spawnError = `Cannot write command log ${logPath}: ${error.message}`;
      if (!childClosed) terminate();
    });
    let forwarded = 0;
    let outputTruncated = false;
    const capture = chunk => {
      log.write(chunk);
      const count = Math.min(chunk.length, Math.max(0, outputLimitBytes - forwarded));
      if (count) { process.stdout.write(chunk.subarray(0, count)); forwarded += count; }
      if (count < chunk.length && !outputTruncated) {
        outputTruncated = true;
        process.stdout.write(`\n[pilot-smoke] Further output is saved in ${logPath}\n`);
      }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', error => { spawnError = String(error); });
    child.once('close', async (exitCode, signal) => {
      childClosed = true;
      // A parent may exit before a compiler descendant. Reap this process group
      // on timeout/interruption even if its leader has already exited.
      if (terminating && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      }
      clearTimeout(timer); clearTimeout(killTimer);
      process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
      log.end();
      await logClosed;
      resolve({ exit_code: exitCode, signal, timed_out: timedOut, interrupted,
        error: spawnError, output_truncated: outputTruncated, elapsed_ms: Date.now()-started });
    });
  });
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { runCommand } from '../../../scripts/riscv64/run-command.mjs';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-riscv-install-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

it.skipIf(process.platform === 'win32')('bounds the slow log queue while preserving stdout and stderr', async () => {
  const logPath = path.join(tmp, 'slow.log');
  const bytesPerStream = 1024 * 1024;
  let peak = 0;
  const writer = vi.spyOn(fs, 'createWriteStream').mockImplementation((_path, { fd }) => {
    const stream = new Writable({
      highWaterMark: 1024,
      write(chunk, _encoding, done) {
        setTimeout(() => {
          try {
            fs.writeSync(fd, chunk);
            done();
          } catch (error) {
            done(error);
          }
        }, 20);
      },
      destroy(error, done) {
        fs.closeSync(fd);
        done(error);
      },
    });
    const write = stream.write.bind(stream);
    stream.write = (...args) => {
      const accepted = write(...args);
      peak = Math.max(peak, stream.writableLength);
      return accepted;
    };
    return stream;
  });

  try {
    const program = `process.stdout.write(Buffer.alloc(${bytesPerStream},65));process.stderr.write(Buffer.alloc(${bytesPerStream},66));`;
    const result = await runCommand(process.execPath, ['-e', program], {
      cwd: tmp, env: process.env, logPath, timeoutMs: 10_000, outputLimitBytes: 0,
    });
    expect(result.exit_code).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.output_truncated).toBe(true);
    const log = fs.readFileSync(logPath);
    expect(log.length).toBe(2 * bytesPerStream);
    expect(log.reduce((count, byte) => count + Number(byte === 65), 0)).toBe(bytesPerStream);
    // Pipe reads can exceed the writable high-water mark by a chunk.
    expect(peak).toBeLessThan(256 * 1024);
  } finally {
    writer.mockRestore();
  }
});

it.skipIf(process.platform === 'win32').each([
  { label: 'the default', limit: 64 * 1024, options: {} },
  { label: 'a stricter per-call cap', limit: 16, options: { outputLimitBytes: 16 } },
])('bounds a stalled console with $label while retaining the complete log', async ({ limit, options }) => {
  const logPath = path.join(tmp, 'stalled-console.log');
  const bytesPerStream = 1024 * 1024;
  const program = `process.stdout.write(Buffer.alloc(${bytesPerStream},65));process.stderr.write(Buffer.alloc(${bytesPerStream},66));`;
  const moduleUrl = new URL('../../../scripts/riscv64/run-command.mjs', import.meta.url).href;
  const driver = `
    import { runCommand } from ${JSON.stringify(moduleUrl)};
    const result = await runCommand(process.execPath, ['-e', ${JSON.stringify(program)}], {
      cwd: process.cwd(), env: process.env, timeoutMs: 3000, logPath: ${JSON.stringify(logPath)},
      ...${JSON.stringify(options)},
    });
    process.send(result, () => process.disconnect());
  `;
  const runner = spawn(process.execPath, ['--input-type=module', '-e', driver], {
    cwd: tmp, env: process.env, stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });

  try {
    // Wait for command completion over IPC before consuming the console pipe.
    const [result] = await once(runner, 'message', { signal: AbortSignal.timeout(4000) });
    const closed = once(runner, 'close', { signal: AbortSignal.timeout(4000) });
    let consoleBytes = 0;
    runner.stdout.on('data', chunk => { consoleBytes += chunk.length; });
    expect(await closed).toEqual([0, null]);

    expect(result.exit_code).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.output_truncated).toBe(true);
    const notice = `\n[pilot-smoke] Further output is saved in ${logPath}\n`;
    expect(consoleBytes).toBe(limit + Buffer.byteLength(notice));
    expect(fs.statSync(logPath).size).toBe(2 * bytesPerStream);
  } finally {
    runner.stdout.resume();
    if (runner.exitCode === null && runner.signalCode === null) runner.kill();
  }
});

describe.skipIf(process.platform !== 'linux')('RISC-V acceptance subprocess execution', () => {
  it('does not spawn when the diagnostic file cannot be opened', async () => {
    const marker = path.join(tmp, 'must-not-run');
    await expect(runCommand(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`], {
      cwd: tmp, env: process.env, timeoutMs: 1000, logPath: path.join(tmp, 'missing/log'),
    })).rejects.toThrow('ENOENT');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('terminates a running command when its log destination fills up', async () => {
    const pidFile = path.join(tmp, 'writer.pid');
    const result = await runCommand(process.execPath, ['-e',
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('log full');setInterval(()=>{},1000)`], {
      cwd: tmp, env: process.env, timeoutMs: 3000, logPath: '/dev/full',
    });
    expect(result.error).toContain('ENOSPC');
    expect(result.timed_out).toBe(false);
    expect(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0)).toThrow();
  });

  it('retains full diagnostics while bounding captured subprocess output', async () => {
    const logPath = path.join(tmp, 'large.log');
    const result = await runCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(128*1024))"], {
      cwd: tmp, env: process.env, timeoutMs: 3000, logPath, outputLimitBytes: 16,
    });
    expect(result.exit_code).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.output_truncated).toBe(true);
    expect(fs.statSync(logPath).size).toBe(128*1024);
  });
  it('terminates a timed-out subprocess group including a descendant that ignores TERM', async () => {
    const pidFile = path.join(tmp, 'descendant.pid');
    const program = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
    const result = await runCommand(process.execPath, ['-e', program], {
      cwd: tmp, env: process.env, timeoutMs: 1000, logPath: path.join(tmp, 'timeout.log'),
    });
    expect(result.timed_out).toBe(true);
    expect(result.elapsed_ms).toBeLessThan(7000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let running = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { running = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z'; }
      catch (error) { if (error.code !== 'ENOENT') throw error; running = false; }
      if (!running) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(running).toBe(false);
  });
});

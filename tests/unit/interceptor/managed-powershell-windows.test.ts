import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Duplex } from 'node:stream';
import { createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PowerShellPool } from '../../../src/interceptor/managed/powershell-pool.js';
import { spawnPowerShellGuardian, windowsJobBootstrap } from '../../../src/interceptor/managed/windows-job-guardian.js';

const execFileAsync = promisify(execFile);
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const pools: PowerShellPool[] = [];
const dirs: string[] = [];

it('keeps the native helper command within the Windows command-line limit', () => {
  const bootstrap = windowsJobBootstrap('pilot-script-job-1234567890', 'C:\\Program Files\\nodejs\\node.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-']);
  expect(Buffer.from(bootstrap, 'utf16le').toString('base64').length + 200).toBeLessThan(30_000);
});

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'managed-ps-张三-'));
  dirs.push(dir);
  return dir;
}

async function poolFile(body: string): Promise<{ pool: PowerShellPool; file: string; dir: string }> {
  const dir = await directory();
  const file = join(dir, 'rule@1.ps1');
  await writeFile(file, `\uFEFF${body}`);
  const pool = new PowerShellPool({ scriptsDir: dir, size: 1 });
  pools.push(pool);
  return { pool, file, dir };
}

async function waitFile(file: string): Promise<string> {
  for (let i = 0; i < 1500 && !existsSync(file); i++) await new Promise(resolve => setTimeout(resolve, 10));
  return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').trim();
}

async function waitExit(pid: number): Promise<void> {
  for (let i = 0; i < 250; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Windows Job descendant ${pid} survived`);
}

describe.skipIf(process.platform !== 'win32')('Windows PowerShell 5.1 native Job ownership', () => {
  afterEach(async () => {
    for (const pool of pools.splice(0)) pool.stop();
    // Job cleanup is asynchronous on stop; fixture deletion may briefly be locked.
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('runs the same script rejected by process Restricted and preserves Unicode request/path', async () => {
    const version = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    expect(version.stdout.trim()).toMatch(/^5\.1\./);
    const { pool, file } = await poolFile(`if ((Get-ExecutionPolicy -Scope Process) -ne 'Bypass') { throw 'missing process policy' }; $r = $input | Out-String | ConvertFrom-Json; @{matched=$true;reason=$r.prompt} | ConvertTo-Json -Compress`);
    const restricted = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-File', file])
      .then(() => false, () => true);
    expect(restricted).toBe(true);
    const result = await pool.run(file, JSON.stringify({ prompt: '张三保密文本' }), 15_000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.stdout)).toEqual({ matched: true, reason: '张三保密文本' });
  }, 30_000);

  it.each([['exit 3', 3], ["throw 'failed after output'", 1]])('rejects valid JSON followed by %s and allows a fresh success', async (end, code) => {
    const { pool, file, dir } = await poolFile(`'{"matched":true,"reason":"partial"}'; ${end}`);
    expect(await pool.run(file, '{}', 15_000)).toEqual({ ok: false, error: `powershell script exited with ${code}` });
    const next = join(dir, 'next@1.ps1');
    await writeFile(next, `\uFEFF'{"matched":false}'`);
    expect(await pool.run(next, '{}', 15_000)).toEqual({ ok: true, stdout: '{"matched":false}' });
  }, 40_000);

  it.each(['success', 'timeout', 'stop', 'executor-crash'])('reclaims the real native descendant on %s', async scenario => {
    const dir = await directory();
    const pidFile = join(dir, 'descendant.pid');
    const file = join(dir, 'tree@1.ps1');
    const spawnChild = `$p = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList '-e', '"setInterval(()=>{},1000)"' -PassThru; Set-Content -LiteralPath ${quote(pidFile)} -Value ([string]$p.Id) -Encoding UTF8;`;
    const tail = scenario === 'success' ? `'{"matched":false}'`
      : scenario === 'executor-crash' ? 'Stop-Process -Id $PID -Force' : 'Start-Sleep -Seconds 60';
    await writeFile(file, `\uFEFF${spawnChild} ${tail}`);
    const pool = new PowerShellPool({ scriptsDir: dir, size: 1 });
    pools.push(pool);
    const result = pool.run(file, '{}', scenario === 'timeout' ? 8_000 : 20_000);
    const pid = Number(await waitFile(pidFile));
    if (scenario === 'stop') pool.stop();
    expect((await result).ok).toBe(scenario === 'success');
    await waitExit(pid);
  }, 35_000);

  it.each(['deadline', 'lease', 'guardian-crash'])('retains Job ownership independently on %s', async scenario => {
    const dir = await directory();
    const pidFile = join(dir, 'native-child.pid');
    const executor = join(dir, 'executor.cjs');
    await writeFile(executor, `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});require('node:fs').writeFileSync(process.argv[2],String(c.pid));process.stdin.resume();`);
    const guardian = spawnPowerShellGuardian(process.execPath, [executor, pidFile], dir);
    guardian.stdout?.resume(); guardian.stderr?.resume();
    const lease = guardian.stdio[3] as Duplex;
    lease.on('error', () => {});
    const pid = Number(await waitFile(pidFile));
    try {
      if (scenario === 'deadline') lease.write('{"timeout":100}\n');
      else if (scenario === 'lease') lease.end();
      else guardian.kill('SIGKILL');
      await waitExit(pid);
    } finally {
      lease.destroy(); guardian.kill('SIGKILL');
    }
  }, 30_000);

  it('fails open before creating an executor when CLM refuses the native Job capability', async () => {
    const dir = await directory();
    const marker = join(dir, 'must-not-run');
    const script = `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage';\n${windowsJobBootstrap('unused-job-pipe', process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`])}`;
    const result = await new Promise<{ code: number | null; stderr: string }>(resolve => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('close', code => resolve({ code, stderr }));
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('managed Windows Job Object unavailable');
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  it('does not start an executor when the native Job creation attribute is unavailable', async () => {
    const dir = await directory();
    const marker = join(dir, 'must-not-run-unsupported');
    await nativeBootstrapProbe(dir, marker, source => source.replace('new IntPtr(0x0002000D)', 'new IntPtr(0x7FFFFFFF)'), false);
  }, 20_000);

  it('kills an already-created suspended executor if its native helper crashes before ResumeThread', async () => {
    const dir = await directory();
    const marker = join(dir, 'must-not-run-suspended');
    await nativeBootstrapProbe(dir, marker, source => source.replace('Check(ResumeThread(process.Thread)', 'Thread.Sleep(5000); Check(ResumeThread(process.Thread)'), true);
  }, 20_000);

  it('cancels during helper initialization without ever starting the script', async () => {
    const dir = await directory();
    const marker = join(dir, 'must-not-run-cancelled');
    const child = spawnPowerShellGuardian(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`], dir);
    child.stdout?.resume(); child.stderr?.resume();
    const closed = new Promise(resolve => child.once('close', resolve));
    const lease = child.stdio[3] as Duplex;
    lease.on('error', () => {});
    lease.end();
    await closed;
    expect(existsSync(marker)).toBe(false);
  }, 15_000);
});

async function nativeBootstrapProbe(dir: string, marker: string, mutate: (source: string) => string, crashAfterReady: boolean): Promise<void> {
  const pipeName = `pilot-test-${process.pid}-${randomBytes(16).toString('hex')}`;
  const sockets: Socket[] = [];
  let readyResolve!: (pid: number) => void;
  const ready = new Promise<number>(resolve => { readyResolve = resolve; });
  const server = createServer(socket => {
    sockets.push(socket);
    let bytes = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 5 && bytes[0] === 1) readyResolve(bytes.readUInt32LE(1));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${pipeName}`, resolve); });
  const source = mutate(windowsJobBootstrap(pipeName, process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`]));
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  let readyTimer: NodeJS.Timeout | undefined;
  try {
    if (crashAfterReady) {
      const pid = await Promise.race([
        ready,
        closed.then(code => { throw new Error(`native helper exited before readiness (${code}): ${stderr}`); }),
        new Promise<number>((_, reject) => { readyTimer = setTimeout(() => reject(new Error(`native helper readiness timed out: ${stderr}`)), 12_000); }),
      ]);
      process.kill(pid, 0);
      child.kill('SIGKILL');
      await closed;
      await waitExit(pid);
    } else {
      expect(await closed).not.toBe(0);
      expect(stderr).toContain('managed Windows Job Object unavailable');
    }
    expect(existsSync(marker)).toBe(false);
  } finally {
    if (readyTimer) clearTimeout(readyTimer);
    child.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    server.close();
  }
}

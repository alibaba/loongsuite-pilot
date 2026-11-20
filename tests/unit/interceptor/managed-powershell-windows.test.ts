import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PowerShellPool } from '../../../src/interceptor/managed/powershell-pool.js';
import { spawnPowerShellGuardian, windowsJobBootstrap, windowsPowerShellEnv } from '../../../src/interceptor/managed/windows-job-guardian.js';

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const pools: PowerShellPool[] = [];
const dirs: string[] = [];

it('removes inherited PS7 module paths from the restricted Windows PowerShell environment', () => {
  const source = { PATH: 'runtime-path', PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', PRIVATE_API_KEY: 'test-value' };
  const env = windowsPowerShellEnv(source);
  expect(env.PATH).toBe(source.PATH);
  expect(Object.keys(env).some(key => key.toLowerCase() === 'psmodulepath')).toBe(false);
  expect(env.PRIVATE_API_KEY).toBeUndefined();
  expect(source.PSModulePath).toContain('PowerShell');
});

it('preserves allowed Windows runtime keys from a case-sensitive Worker copy', () => {
  const source = {
    SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows', COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    PATH: 'runtime-path', PSMODULEPATH: 'inherited-PS7', PRIVATE_API_KEY: 'secret',
  };
  const env = windowsPowerShellEnv(source);
  expect(env.SystemRoot).toBe(source.SYSTEMROOT);
  expect(env.windir).toBe(source.WINDIR);
  expect(env.ComSpec).toBe(source.COMSPEC);
  expect(env.ProgramFiles).toBe(source.PROGRAMFILES);
  expect(env['ProgramFiles(x86)']).toBe(source['PROGRAMFILES(X86)']);
  expect(env.PATH).toBe(source.PATH);
  expect(Object.keys(env).filter(key => key.toLowerCase() === 'path')).toHaveLength(1);
  expect(Object.keys(env).some(key => key.toLowerCase() === 'psmodulepath')).toBe(false);
  expect(env.PRIVATE_API_KEY).toBeUndefined();
});

function powerShellProbe(args: string[]): Promise<{ code: number | string; stdout: string; stderr: string; timedOut: boolean; elapsedMs: number }> {
  return new Promise(resolve => {
    const started = Date.now();
    const child = execFile('powershell.exe', args, {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 8192, killSignal: 'SIGKILL', windowsHide: true, env: windowsPowerShellEnv(),
    }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? error.signal ?? 'error' : 0, stdout, stderr,
        timedOut: error?.killed === true, elapsedMs: Date.now() - started });
    });
    // execFile leaves stdin open by default. A probe must never wait for input EOF.
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

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

async function waitForPid(file: string, diagnostic = () => ''): Promise<number> {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    try {
      const marker = await readFile(file, 'utf8');
      const match = /^\uFEFF?([1-9]\d*)\r?\n$/.exec(marker);
      if (match) return Number(match[1]);
    } catch (error) {
      // Windows can expose the directory entry while the writer still owns the file.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EBUSY') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`missing complete native test PID marker ${file}; ${diagnostic()}`);
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

  it('keeps the Windows overlapped fd3 duplex while the lease read remains open', async () => {
    const started = Date.now();
    const child = spawn(process.execPath, ['-e', "const s=new(require('node:net').Socket)({fd:3,readable:true,writable:true});s.on('data',()=>s.write('CONTROL_ACK\\n'));s.on('end',()=>process.exit(0));"],
      { stdio: ['ignore', 'ignore', 'pipe', 'overlapped'], windowsHide: true });
    const lease = child.stdio[3] as Duplex;
    const closed = new Promise(resolve => child.once('close', resolve));
    let stderr = '', control = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    lease.on('error', () => {});
    let timer: NodeJS.Timeout | undefined;
    try {
      const ack = new Promise<void>((resolve, reject) => {
        lease.on('data', chunk => { control += String(chunk); if (control.includes('CONTROL_ACK\n')) resolve(); });
        timer = setTimeout(() => reject(new Error(JSON.stringify({ check: 'overlapped-fd3', control, stderr }))), 3000);
      });
      lease.write('KEEP_LEASE_OPEN\n');
      await ack;
      expect(lease.writableEnded).toBe(false);
      console.log(JSON.stringify({ check: 'overlapped-fd3', elapsedMs: Date.now() - started, control, stderr }));
    } finally {
      if (timer) clearTimeout(timer);
      lease.destroy(); child.kill('SIGKILL'); await closed;
    }
  }, 5000);

  it('loads native builtin modules in the same minimal environment as the guardian', async () => {
    const result = await powerShellProbe(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '$ErrorActionPreference="Stop"; Import-Module Microsoft.PowerShell.Security,Microsoft.PowerShell.Utility,Microsoft.PowerShell.Management -ErrorAction Stop; @{Marker="NATIVE_MODULES_READY";Version=$PSVersionTable.PSVersion.ToString();Location=(Get-Location).ProviderPath;Policy=[string](Get-ExecutionPolicy)} | ConvertTo-Json -Compress']);
    const safeNames = /^(systemroot|windir|comspec|programfiles(?:\(x86\))?|programw6432|commonprogramfiles(?:\(x86\))?|commonprogramw6432|psmodulepath)$/i;
    const diagnostic = JSON.stringify({ sourceKeys: Object.keys(process.env).filter(key => safeNames.test(key)), passedKeys: Object.keys(windowsPowerShellEnv()), result });
    expect(result.code, diagnostic).toBe(0);
    expect(result.stdout.trim(), diagnostic).not.toBe('');
    expect(JSON.parse(result.stdout).Marker, diagnostic).toBe('NATIVE_MODULES_READY');
  }, 15_000);

  it.each(['node', 'powershell'])('reports native guardian %s ownership and input delivery timing', async executor => {
    const dir = await directory();
    const command = executor === 'node' ? process.execPath : 'powershell.exe';
    const args = executor === 'node'
      ? ['-e', "require('node:readline').createInterface({input:process.stdin}).on('line', line=>console.log('OWNED_EXECUTOR:'+line))"]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'];
    const input = executor === 'node' ? 'NATIVE_INPUT_PROBE\n' : "[Console]::Out.WriteLine('NATIVE_INPUT_PROBE')\n";
    const started = Date.now();
    const guardian = spawnPowerShellGuardian(command, args, dir);
    const lease = guardian.stdio[3] as Duplex;
    lease.on('error', () => {});
    const evidence: { ownedAtMs?: number; outputAtMs?: number; eofAtMs?: number; stdout: string; stderr: string; control: string } = {
      stdout: '', stderr: '', control: '',
    };
    lease.on('data', chunk => {
      evidence.control = (evidence.control + String(chunk)).slice(-4096);
      if (evidence.ownedAtMs === undefined && evidence.control.includes('"owned":true')) evidence.ownedAtMs = Date.now() - started;
    });
    let outputResolve!: () => void;
    const output = new Promise<void>(resolve => { outputResolve = resolve; });
    guardian.stdout?.on('data', chunk => {
      evidence.stdout = (evidence.stdout + String(chunk)).slice(-4096);
      if (evidence.stdout.includes('NATIVE_INPUT_PROBE')) {
        evidence.outputAtMs = Date.now() - started;
        outputResolve();
      }
    });
    guardian.stderr?.on('data', chunk => { evidence.stderr = (evidence.stderr + String(chunk)).slice(-4096); });
    const closed = new Promise<number | null>(resolve => guardian.once('close', resolve));
    let deadline: NodeJS.Timeout | undefined;
    const eof = setTimeout(() => { evidence.eofAtMs = Date.now() - started; guardian.stdin?.end(); }, 1000);
    try {
      // Send immediately, before ownership is ready: the guardian must retain
      // these bytes for the actual executor rather than its encoded helper.
      lease.write('{"timeout":30000}\n');
      guardian.stdin?.write(input);
      await Promise.race([
        output,
        closed.then(code => { if (!evidence.outputAtMs) throw new Error(`guardian closed (${code}): ${JSON.stringify(evidence)}`); }),
        new Promise<void>((_, reject) => { deadline = setTimeout(() => reject(new Error(`native input timed out: ${JSON.stringify(evidence)}`)), 30_000); }),
      ]);
      console.log(JSON.stringify({ check: `guardian-${executor}-stream`, ...evidence }));
      expect(evidence.ownedAtMs, JSON.stringify(evidence)).toBeDefined();
      expect(evidence.stdout, JSON.stringify(evidence)).toContain('NATIVE_INPUT_PROBE');
    } finally {
      clearTimeout(eof);
      if (deadline) clearTimeout(deadline);
      lease.end();
      guardian.stdin?.end();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000))]);
      guardian.kill('SIGKILL');
    }
  }, 35_000);

  it('rejects a script under process Restricted and preserves Unicode request/path in the pool', async () => {
    const version = await powerShellProbe(['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    expect(version.code, JSON.stringify(version)).toBe(0);
    expect(version.stdout.trim()).toMatch(/^5\.1\./);
    const { pool, file, dir } = await poolFile(`if ((Get-ExecutionPolicy -Scope Process) -ne 'Bypass') { throw 'missing process policy' }; $r = $input | Out-String | ConvertFrom-Json; @{matched=$true;reason=$r.prompt} | ConvertTo-Json -Compress`);
    // Restricted also blocks autoloading the Security module. Load its cmdlets
    // before restricting this probe's process; no persisted policy is changed.
    const policies = await powerShellProbe(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '$ErrorActionPreference="Stop"; Import-Module Microsoft.PowerShell.Security,Microsoft.PowerShell.Utility -ErrorAction Stop; Set-ExecutionPolicy Restricted -Scope Process -Force; @{Effective=[string](Get-ExecutionPolicy);Process=[string](Get-ExecutionPolicy -Scope Process);CurrentUser=[string](Get-ExecutionPolicy -Scope CurrentUser);LocalMachine=[string](Get-ExecutionPolicy -Scope LocalMachine);MachinePolicy=[string](Get-ExecutionPolicy -Scope MachinePolicy);UserPolicy=[string](Get-ExecutionPolicy -Scope UserPolicy)} | ConvertTo-Json -Compress']);
    expect(policies.code, JSON.stringify(policies)).toBe(0);
    expect(policies.stdout.trim(), JSON.stringify(policies)).not.toBe('');
    const policySnapshot = JSON.parse(policies.stdout.trim());
    // This control script does not read $input, even if a higher policy overrides Restricted.
    const restrictedFile = join(dir, 'restricted-control.ps1');
    await writeFile(restrictedFile, '\uFEFF"RESTRICTED_SCRIPT_EXECUTED"');
    const restricted = await powerShellProbe(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-File', restrictedFile]);
    const diagnostic = JSON.stringify({ policies: policySnapshot, probe: restricted });
    expect(restricted.timedOut, diagnostic).toBe(false);
    expect(restricted.code, diagnostic).not.toBe(0);
    expect(restricted.stderr, diagnostic).toMatch(/PSSecurityException|UnauthorizedAccess/);
    expect(restricted.stdout, diagnostic).not.toContain('RESTRICTED_SCRIPT_EXECUTED');
    expect(policySnapshot.Effective, diagnostic).toBe('Restricted');
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
    const pid = await waitForPid(pidFile);
    if (scenario === 'stop') pool.stop();
    expect((await result).ok).toBe(scenario === 'success');
    await waitExit(pid);
  }, 35_000);

  it.each(['deadline', 'lease', 'guardian-crash'])('retains Job ownership independently on %s', async scenario => {
    const dir = await directory();
    const pidFile = join(dir, 'native-child.pid');
    const executor = join(dir, 'executor.cjs');
    await writeFile(executor, `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});require('node:fs').writeFileSync(process.argv[2],String(c.pid)+'\\n');process.stdin.resume();`);
    const guardian = spawnPowerShellGuardian(process.execPath, [executor, pidFile], dir);
    guardian.stdout?.resume();
    let stderr = '';
    guardian.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    const lease = guardian.stdio[3] as Duplex;
    lease.on('error', () => {});
    try {
      const pid = await waitForPid(pidFile, () => stderr);
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
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: windowsPowerShellEnv() });
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
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: windowsPowerShellEnv() });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
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

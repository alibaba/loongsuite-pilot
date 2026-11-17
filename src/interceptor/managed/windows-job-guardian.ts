import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { scriptEnv } from './runner.js';

/*
 * Windows has no Node Job Object API. This helper owns the only, non-inheritable
 * KILL_ON_JOB_CLOSE handle and creates the executor suspended inside the Job
 * using Win10's JOB_LIST process attribute. There is no user-space Create/Assign
 * window; unsupported attributes fail open before any script can run.
 * The entire native capability is inside a try/catch. CLM/WDAC may prohibit
 * Add-Type; that means explicit fail-open unavailable, never an unowned script.
 * https://learn.microsoft.com/windows/win32/procthread/job-objects
 * https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
 */
const JOB_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class PilotManagedScriptJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint Pid, Tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
    public StartupInfo Basic;
    public IntPtr Attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint Faults, Total, Active, Terminated;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, int flags, ref UIntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr key, IntPtr value,
    UIntPtr size, IntPtr previous, IntPtr length);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, ref Accounting info, uint size, IntPtr length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd,
    ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string pipeName, string command) {
    IntPtr job = IntPtr.Zero;
    ProcessInfo process = new ProcessInfo();
    IntPtr attributes = IntPtr.Zero, jobList = IntPtr.Zero;
    bool attributesInitialized = false;
    bool resumed = false;
    object gate = new object();
    using (var lease = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut)) {
      lease.Connect(10000);
      try {
        // NULL attributes: neither this handle nor child process handles inherit.
        job = CreateJobObjectW(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
        UIntPtr length = UIntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref length);
        Check(length != UIntPtr.Zero);
        attributes = Marshal.AllocHGlobal(new IntPtr(unchecked((long)length.ToUInt64())));
        Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref length));
        attributesInitialized = true;
        jobList = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(jobList, job);
        Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobList,
          new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero)); // PROC_THREAD_ATTRIBUTE_JOB_LIST
        var startup = new StartupInfoEx();
        startup.Basic.Size = (uint)Marshal.SizeOf(startup);
        startup.Basic.Flags = 0x00000100; // STARTF_USESTDHANDLES
        startup.Basic.Input = GetStdHandle(-10); startup.Basic.Output = GetStdHandle(-11); startup.Basic.Error = GetStdHandle(-12);
        startup.Attributes = attributes;
        Check(CreateProcessW(null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
          0x08080004, IntPtr.Zero, null, ref startup, out process)); // NO_WINDOW | EXTENDED_STARTUPINFO | SUSPENDED
        var watcher = new Thread(() => {
          try { while (lease.ReadByte() >= 0) {} } catch {} finally {
            lock (gate) { if (job != IntPtr.Zero) TerminateJobObject(job, 1); }
          }
        });
        watcher.IsBackground = true;
        // This synchronous pipe must finish its only write before the blocking
        // lease read starts; both the ready write and watcher precede ResumeThread.
        byte[] ready = new byte[5]; ready[0] = 1;
        Array.Copy(BitConverter.GetBytes(process.Pid), 0, ready, 1, 4);
        lease.Write(ready, 0, ready.Length); lease.Flush();
        watcher.Start();
        Check(ResumeThread(process.Thread) != UInt32.MaxValue);
        resumed = true;
        Check(WaitForSingleObject(process.Process, UInt32.MaxValue) == 0);
        return 0; // Script success is carried by the private per-request marker.
      } finally {
        try {
          // No process is created at all if the Job attribute cannot be established.
          if (!resumed && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
          lock (gate) {
            if (job != IntPtr.Zero) {
              try {
                Check(TerminateJobObject(job, 1));
                var accounting = new Accounting();
                for (int i = 0; ; i++) {
                  Check(QueryInformationJobObject(job, 1, ref accounting, (uint)Marshal.SizeOf(accounting), IntPtr.Zero));
                  if (accounting.Active == 0) break;
                  if (i >= 100) throw new Exception("job cleanup timed out");
                  Thread.Sleep(10);
                }
              } finally { CloseHandle(job); job = IntPtr.Zero; }
            }
          }
        } finally {
          if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
          if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
          if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
          if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
          if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
        }
      }
    }
  }
}
`;

/** Exported for Windows capability/CLM regression tests, never accepts rule text. */
export function windowsJobBootstrap(pipeName: string, command: string, args: string[]): string {
  const commandLine = [command, ...args].map(windowsQuote).join(' ');
  // Resolve the builtin manifest directly: discovering Add-Type by scanning all
  // user/system module directories can dominate a short hook's startup budget.
  return `$ErrorActionPreference = 'Stop'\ntry {\nImport-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop\nAdd-Type -ReferencedAssemblies 'System.Core.dll' -TypeDefinition @'\n${JOB_SOURCE}\n'@\nexit ([PilotManagedScriptJob]::Run(${psQuote(pipeName)}, ${psQuote(commandLine)}))\n} catch {\nWrite-Error 'managed Windows Job Object unavailable' -ErrorAction Continue\nexit 1\n}`;
}

/*
 * This Node guardian outlives the interceptor Worker. fd3 is a private lease;
 * the independent deadline and EOF both reap the executor without depending on
 * either collector event loop. On Windows its named-pipe lease owns the native
 * Job helper. Killing that helper closes the last Job handle as a final fallback.
 * Unix test executors use an owned process group; this is not Windows validation.
 */
const GUARDIAN_SOURCE = String.raw`
const {spawn} = require('node:child_process');
const {Socket, createServer} = require('node:net');
let c;
const lease = new Socket({fd:3, readable:true, writable:true});
let child, server, jobLease, ending = false, timer, bytes = '', inputForwarded = false;
let owned = false;
function status(value) {
  try { lease.write(JSON.stringify(value)+'\n', error => {
    if (error) { process.stderr.write('managed guardian control write failed\n'); end(); }
  }); } catch { process.stderr.write('managed guardian control write failed\n'); end(); }
}
function end() {
  if (ending) return;
  ending = true;
  clearTimeout(timer);
  if (!c || !c.pipeName) { try { process.kill(-process.pid, 'SIGKILL'); } catch {} process.exit(1); }
  try { jobLease?.end(); } catch {}
  try { server?.close(); } catch {}
  // Termination closes the helper's non-inheritable Job handle even if managed
  // cleanup is stalled. The executor cannot retain a copy of that handle.
  if (!owned) { try { child?.kill('SIGKILL'); } catch {} }
  if (!child) process.exit(1);
  const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500);
  force.unref();
}
lease.on('end', end); lease.on('close', end); lease.on('error', end);
lease.on('data', chunk => {
  bytes += chunk.toString('utf8');
  if (bytes.length > 128 * 1024) return end();
  let newline;
  while ((newline = bytes.indexOf('\n')) >= 0) {
    const line = bytes.slice(0,newline); bytes = bytes.slice(newline+1);
    try {
      const message = JSON.parse(line);
      if (message.initialize && !c) {
        c = message.initialize;
        owned = !c.pipeName;
        initialize();
        continue;
      }
      const timeout = message.timeout;
      if (!(Number.isFinite(timeout) && timeout >= 0)) return end();
      clearTimeout(timer); timer = setTimeout(end, timeout);
    } catch { return end(); }
  }
});
process.stdout.on('error', end);
function forwardInput() {
  if (inputForwarded || !child || ending) return;
  inputForwarded = true;
  process.stdin.pipe(child.stdin);
}
function start() {
  if (ending) return;
  child = spawn(c.command, c.args, {stdio:['pipe','pipe','pipe'], windowsHide:true});
  child.stdin.on('error', () => {});
  // Windows input belongs to the suspended executor, not its PowerShell Job
  // helper. Do not expose it until the native private readiness handshake.
  if (!c.pipeName) forwardInput();
  child.stdout.pipe(process.stdout, {end:false});
  child.stderr.resume();
  child.on('error', () => { if (!owned) status({error:'Windows Job Object unavailable'}); end(); });
  child.on('exit', () => {
    if (!owned) status({error:'Windows Job Object unavailable'});
    if (!c.pipeName) end();
  });
  child.on('close', code => {
    const failed = c.pipeName && (!owned || code !== 0);
    clearTimeout(timer);
    try { jobLease?.destroy(); server?.close(); } catch {}
    process.stdout.write('', () => {
      if (failed) lease.end(JSON.stringify({error:'Windows Job Object unavailable'})+'\n', () => process.exit(0));
      else process.exit(0);
    });
  });
  if (owned) status({owned:true});
}
function initialize() {
if (c.unavailable) {
  lease.end(JSON.stringify({error:'Windows Job Object unavailable'})+'\n', () => process.exit(1));
  return;
}
if (c.pipeName) {
  server = createServer(socket => {
    if (jobLease || ending) return socket.destroy();
    jobLease = socket;
    let readiness = Buffer.alloc(0);
    socket.on('data', chunk => {
      readiness = Buffer.concat([readiness,chunk]);
      if (!owned && readiness.length >= 5 && readiness[0] === 1) {
        owned = true; status({owned:true,pid:readiness.readUInt32LE(1)}); forwardInput();
      }
      if (readiness.length > 64) end();
    });
    socket.on('error', end);
  });
  server.on('error', end);
  server.listen('\\\\.\\pipe\\'+c.pipeName, start);
} else start();
}
`;

export function spawnPowerShellGuardian(command: string, args: string[], cwd: string): ChildProcess {
  const pipeName = process.platform === 'win32' ? `pilot-script-job-${process.pid}-${randomBytes(16).toString('hex')}` : undefined;
  let config: { command: string; args: string[]; pipeName?: string; unavailable?: boolean } = pipeName
    ? { pipeName, command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(windowsJobBootstrap(pipeName, command, args), 'utf16le').toString('base64')] }
    : { command, args };
  if (pipeName && [config.command, ...config.args].map(windowsQuote).join(' ').length >= 30_000) {
    config = { command: '', args: [], unavailable: true };
  }
  const child = spawn(process.execPath, ['-e', GUARDIAN_SOURCE], {
    cwd, env: process.platform === 'win32' ? windowsPowerShellEnv() : scriptEnv(),
    // fd3 is duplex: the Node guardian reads lease frames while writing status.
    // A synchronous Windows pipe can serialize that write behind its pending read.
    // https://nodejs.org/api/child_process.html#optionsstdio
    stdio: ['pipe', 'pipe', 'pipe', process.platform === 'win32' ? 'overlapped' : 'pipe'],
    detached: process.platform !== 'win32', windowsHide: true,
  });
  // Private initialization avoids duplicating a UTF-16/Base64 bootstrap inside
  // Node's command line (CreateProcessW has a 32767-character total limit).
  const control = child.stdio[3] as import('node:stream').Duplex;
  control.on('error', () => {});
  control.write(`${JSON.stringify({ initialize: config })}\n`);
  return child;
}

/** Let Windows PowerShell rebuild its module paths instead of inheriting PS7's. */
export function windowsPowerShellEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = scriptEnv(source, 'win32');
  const values = new Map(Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]));
  // Windows PowerShell uses these non-secret runtime locations to rebuild its
  // own module lookup when PSModulePath is absent. Do not inherit PS7's paths.
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
    'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432']) {
    const value = values.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  // PS7 only repairs PSModulePath when it launches powershell.exe directly;
  // an intermediate Node process must remove it from the child environment.
  // https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  return env;
}

function psQuote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

// CreateProcessW parses the command line; quote backslashes before quotes/end.
function windowsQuote(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

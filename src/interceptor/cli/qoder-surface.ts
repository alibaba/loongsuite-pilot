import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { QoderSurface } from '../types.js';

type ExecText = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; timeout: number; stdio: ['ignore', 'pipe', 'ignore']; windowsHide?: boolean },
) => string;

export function resolveQoderSurface(env: NodeJS.ProcessEnv = process.env): QoderSurface | null {
  const fromEnv = classifyConfigDir(env.QODER_CONFIG_DIR);
  if (fromEnv) return fromEnv;

  for (const name of ancestorNames()) {
    const classified = classifyExecutable(name);
    if (classified) return classified;
  }
  return null;
}

export function classifyExecutable(raw: string): QoderSurface | null {
  const name = normalizeName(raw);
  if (!name) return null;
  if (isNonQoderHost(name)) return null;
  if (name.includes('qodercli') || name.includes('qoder-cli') || name.includes('qoder_cli')) {
    return 'qodercli';
  }
  if (name.includes('qoderwork') || name.includes('qoder-work')) return null;
  if (name.includes('qwenwork') || name.includes('qwen-work')) return null;
  if (name.includes('qoder')) return 'qoder';
  return null;
}

function classifyConfigDir(raw: string | undefined): QoderSurface | null {
  if (!raw) return null;
  const normalized = raw.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('.qoderwork')) return null;
  if (normalized.includes('.qoder')) return 'qoder';
  return null;
}

function isNonQoderHost(name: string): boolean {
  return (
    name.includes('node')
    || name.includes('loongsuite-pilot')
    || name.includes('interceptor')
    || name.includes('coding-agent-security')
  );
}

function normalizeName(raw: string): string {
  return path.basename(raw).replace(/\.exe$/i, '').toLowerCase();
}

function ancestorNames(): string[] {
  const names: string[] = [];
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const info = readProcess(pid);
    if (!info) break;
    names.push(info.name);
    pid = info.ppid;
  }
  return names;
}

function readProcess(pid: number): { name: string; ppid: number } | null {
  if (process.platform === 'linux') {
    try {
      const exe = fs.readlinkSync(`/proc/${pid}/exe`);
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const rest = stat.slice(closeParen + 2).split(' ');
      const ppid = Number(rest[1]);
      return { name: exe, ppid: Number.isFinite(ppid) ? ppid : 0 };
    } catch {
      return null;
    }
  }

  try {
    if (process.platform === 'darwin') {
      const comm = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=,comm='], {
        encoding: 'utf8',
        timeout: 500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const match = comm.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      return { name: match[2], ppid: Number(match[1]) };
    }
    if (process.platform === 'win32') {
      return readWindowsProcess(pid);
    }
  } catch {
    return null;
  }
  return null;
}

export function readWindowsProcess(
  pid: number,
  exec: ExecText = execFileSync as ExecText,
): { name: string; ppid: number } | null {
  try {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
      'if ($null -ne $p) {',
      '  [Console]::Out.WriteLine([string]$p.Name)',
      '  [Console]::Out.WriteLine([string]$p.ParentProcessId)',
      '}',
    ].join('; ');
    const out = exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    ).trim();
    const [name, rawPpid] = out.split(/\r?\n/).map(value => value.trim());
    if (!name) return null;
    const ppid = Number(rawPpid);
    return { name, ppid: Number.isFinite(ppid) ? ppid : 0 };
  } catch {
    return null;
  }
}

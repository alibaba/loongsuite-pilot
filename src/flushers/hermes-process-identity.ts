import * as fs from 'node:fs/promises';
import type { AgentActivityEntry } from '../types/index.js';

export interface HermesProcessIdentity {
  pid: number;
  startTicks: string;
  pidNamespace: string;
  bootId: string;
  sourceToken: string;
}

export function hermesProcessIdentity(entry: AgentActivityEntry): HermesProcessIdentity | undefined {
  const processInfo = entry['agent.hermes.process'];
  if (!processInfo || typeof processInfo !== 'object' || Array.isArray(processInfo)) return undefined;
  const pid = processInfo.pid;
  const startTicks = processInfo.start_ticks;
  const pidNamespace = processInfo.pid_namespace;
  const bootId = processInfo.boot_id;
  const sourceToken = processInfo.source_token;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || pid > 2_147_483_647
    || typeof startTicks !== 'string' || !/^\d{1,30}$/.test(startTicks)
    || typeof pidNamespace !== 'string' || !/^pid:\[\d+\]$/.test(pidNamespace)
    || typeof bootId !== 'string' || !/^[a-f0-9-]{36}$/.test(bootId)
    || typeof sourceToken !== 'string' || !/^\d{1,10}-\d{1,24}-[a-f0-9]{8}$/.test(sourceToken)
    || !sourceToken.startsWith(`${pid}-`)) return undefined;
  return { pid, startTicks, pidNamespace, bootId, sourceToken };
}

/** Refuse PID checks when /proc uses another PID namespace or is unavailable. */
export async function currentHermesProcessNamespace(): Promise<{ pidNamespace: string; bootId: string } | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const [pidNamespace, selfPid, status, boot] = await Promise.all([
      fs.readlink('/proc/self/ns/pid'), fs.readlink('/proc/self'), fs.readFile('/proc/self/status', 'utf8'),
      fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ]);
    const bootId = boot.trim();
    // A parent-mounted procfs reports multiple NSpid values; /proc/1 itself
    // may be unreadable to an unprivileged collector. Require one matching
    // PID in both procfs and Node before using this namespace for recovery.
    const namespacePids = /^NSpid:\s*(\d+(?:\s+\d+)*)\s*$/m.exec(status)?.[1].trim().split(/\s+/);
    if (selfPid !== String(process.pid) || namespacePids?.length !== 1
      || namespacePids[0] !== String(process.pid) || !/^pid:\[\d+\]$/.test(pidNamespace)
      || !/^[a-f0-9-]{36}$/.test(bootId)) return undefined;
    return { pidNamespace, bootId };
  } catch {
    return undefined;
  }
}

/** Only return true for an owner proven dead, including PID reuse. */
export async function isHermesProcessDead(
  owner: HermesProcessIdentity,
  current: { pidNamespace: string; bootId: string },
): Promise<boolean> {
  if (owner.pidNamespace !== current.pidNamespace || owner.bootId !== current.bootId) return false;
  try {
    const stat = await fs.readFile(`/proc/${owner.pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return false;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? '')) return false;
    return fields[19] !== owner.startTicks || fields[0] === 'Z' || fields[0] === 'X';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    // hidepid may hide a live PID from /proc. Kernel ESRCH, rather than a
    // missing path alone, establishes that the process no longer exists.
    try { process.kill(owner.pid, 0); return false; }
    catch (probeError) { return (probeError as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
}

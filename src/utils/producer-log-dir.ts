import * as fs from 'node:fs';
import * as path from 'node:path';

export function rootTriggerEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.LOONGSUITE_PILOT_ROOT_TRIGGER || '').trim());
}

// Collector-side policy, aligned with the unbundled JS/Python writers.
export function prepareRootTriggerLogDir(dir: string): boolean {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !rootTriggerEnabled()) return false;
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Pilot log parent is not a real directory');
  if (parentStat.uid === 0) fs.chmodSync(parent, (parentStat.mode & 0o7777) | 0o111);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Pilot event directory is not a real directory');
  if (stat.uid !== 0) return false;
  fs.chmodSync(dir, 0o1777);
  // The gate contains only SQLite locking metadata, never event content. A
  // root-owned sticky directory needs one gate usable by every producer UID
  // and by the root retention service, including after an upgrade.
  const gate = path.join(dir, '.raw-source-gate.sqlite');
  const flags = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let fd: number;
  try {
    fd = fs.openSync(gate, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fd = fs.openSync(gate, flags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  }
  try {
    const gateStat = fs.fstatSync(fd);
    if (!gateStat.isFile() || gateStat.nlink !== 1) throw new Error('Pilot raw source gate is not a private regular file');
    if (gateStat.uid !== 0) fs.fchownSync(fd, 0, 0);
    fs.fchmodSync(fd, 0o666);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

export function prepareRootTriggerLogDirs(dataDir: string): void {
  for (const agent of ['openclaw', 'hermes-agent', 'dsh']) {
    prepareRootTriggerLogDir(path.join(dataDir, 'logs', agent));
  }
}

export function producerReadFlags(): string | number {
  return process.getuid?.() === 0 && rootTriggerEnabled()
    ? fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)
    : 'r';
}

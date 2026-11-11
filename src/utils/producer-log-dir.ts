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

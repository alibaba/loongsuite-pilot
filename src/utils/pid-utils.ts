import * as fs from 'node:fs';

export function isPidFileRunning(pidFile: string): boolean {
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8');
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

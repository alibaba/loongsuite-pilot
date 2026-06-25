import * as fs from 'node:fs';

// EPERM from kill(pid, 0) means the process exists but the caller cannot signal it
// (different uid/capabilities) — treat as alive. This differs from the original inline
// implementation in updater-metrics.ts which returned false on any exception.
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

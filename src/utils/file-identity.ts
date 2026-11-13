import type { Stats } from 'node:fs';

// Linux/libuv may synthesize birthtime from ctime when statx is unavailable.
// Even testing birthtime === ctime per sample is unsafe: that equality can
// change after the first append. Use the same stable representation throughout.
export function fileIdentity(stat: Pick<Stats, 'dev' | 'ino' | 'birthtimeMs'>, platform = process.platform): string {
  const base = `${stat.dev}:${stat.ino}`;
  return platform === 'darwin' || platform === 'win32' ? `${base}:${stat.birthtimeMs}` : base;
}

export function matchesFileIdentity(saved: unknown, stat: Pick<Stats, 'dev' | 'ino' | 'birthtimeMs'>,
  platform = process.platform): boolean {
  const identity = fileIdentity(stat, platform);
  return saved === identity || (platform !== 'darwin' && platform !== 'win32'
    && typeof saved === 'string' && saved.startsWith(identity + ':'));
}

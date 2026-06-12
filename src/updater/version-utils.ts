import * as crypto from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Compare two semver strings numerically (major.minor.patch).
 * Returns  1 if a > b, -1 if a < b, 0 if equal.
 * Falls back to string comparison for non-standard formats.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.some(isNaN) || pb.some(isNaN)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

export function deterministicBucket(installId: string, version: string): number {
  const hash = crypto.createHash('sha256').update(installId + version).digest();
  const num = hash.readUInt32BE(0);
  return num % 100;
}

export async function computeSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

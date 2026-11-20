import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function canTrustOwner(uid: number): boolean {
  return uid === 0 || uid === process.geteuid?.();
}

export function isTrustedCursorSystemFile(stat: Stats): boolean {
  return stat.isFile() && canTrustOwner(stat.uid) && (stat.mode & 0o022) === 0;
}

export async function assertTrustedCursorSystemDirectory(directory: string): Promise<void> {
  let current = path.resolve(directory);
  let leaf = true;
  while (true) {
    const stat = await fs.lstat(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat) {
      if (!canTrustOwner(stat.uid)) throw new Error(`Untrusted Cursor system directory owner: ${current}`);
      if (stat.isSymbolicLink() && !leaf) {
        await assertTrustedCursorSystemDirectory(await fs.realpath(current));
      } else if (!stat.isDirectory() || ((stat.mode & 0o022) !== 0 && (leaf || (stat.mode & 0o1000) === 0))) {
        // A sticky ancestor such as /tmp protects entries owned by the
        // installer, but the managed directory itself must be exclusive.
        throw new Error(`Untrusted Cursor system directory permissions: ${current}`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
    leaf = false;
  }
}

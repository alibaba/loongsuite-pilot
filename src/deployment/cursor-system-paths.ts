import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const CURSOR_SYSTEM_HOOK_SCRIPT = 'cursor-loongsuite-pilot-hook.sh';

function canTrustOwner(uid: number): boolean {
  return uid === 0 || uid === process.geteuid?.();
}

export function isTrustedCursorSystemFile(stat: Stats): boolean {
  return stat.isFile() && canTrustOwner(stat.uid) && (stat.mode & 0o022) === 0;
}

export async function assertTrustedCursorSystemFile(file: string): Promise<void> {
  await assertTrustedCursorSystemDirectory(path.dirname(file));
  if (!isTrustedCursorSystemFile(await fs.lstat(file))) {
    throw new Error(`Untrusted Cursor system runtime file: ${file}`);
  }
}

export async function assertTrustedCursorSystemNodePin(dataDir: string): Promise<void> {
  const pin = path.join(dataDir, 'node-bin');
  await assertTrustedCursorSystemFile(pin);
  const node = (await fs.readFile(pin, 'utf8')).replace(/\r?\n$/, '');
  if (!path.isAbsolute(node) || /[\r\n\0]/.test(node)) throw new Error('Cursor system Node pin must contain one absolute path');
  await assertTrustedCursorSystemDirectory(path.dirname(node));
  const resolved = await fs.realpath(node);
  await assertTrustedCursorSystemFile(resolved);
  await fs.access(resolved, fs.constants.X_OK);
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

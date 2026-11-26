import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const CURSOR_SYSTEM_HOOK_SCRIPT = 'cursor-loongsuite-pilot-hook.sh';
const CURSOR_SYSTEM_CONTAINER_MOUNT = '/mnt/pilot';

export function usesCursorSystemContainerMount(dataDir: string): boolean {
  return process.platform === 'linux' && path.resolve(dataDir) === CURSOR_SYSTEM_CONTAINER_MOUNT;
}

function canTrustOwner(uid: number): boolean {
  return uid === 0 || uid === process.geteuid?.();
}

export function isTrustedCursorSystemFile(stat: Stats): boolean {
  return stat.isFile() && canTrustOwner(stat.uid) && (stat.mode & 0o022) === 0;
}

export async function assertTrustedCursorSystemFile(file: string, allowWritableMount = false): Promise<void> {
  await assertTrustedCursorSystemDirectory(path.dirname(file), allowWritableMount);
  if (!isTrustedCursorSystemFile(await fs.lstat(file))) {
    throw new Error(`Untrusted Cursor system runtime file: ${file}`);
  }
}

export async function assertTrustedCursorSystemNodePin(dataDir: string, allowWritableMount = false): Promise<void> {
  const pin = path.join(dataDir, 'node-bin');
  await assertTrustedCursorSystemFile(pin, allowWritableMount);
  const node = (await fs.readFile(pin, 'utf8')).replace(/\r?\n$/, '');
  if (!path.isAbsolute(node) || /[\r\n\0]/.test(node)) throw new Error('Cursor system Node pin must contain one absolute path');
  await assertTrustedCursorSystemDirectory(path.dirname(node), allowWritableMount);
  const resolved = await fs.realpath(node);
  await assertTrustedCursorSystemFile(resolved, allowWritableMount);
  await fs.access(resolved, fs.constants.X_OK);
}

export async function assertTrustedCursorSystemDirectory(directory: string, allowWritableMount = false): Promise<void> {
  let current = path.resolve(directory);
  let leaf = true;
  while (true) {
    const stat = await fs.lstat(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat) {
      if (!canTrustOwner(stat.uid)) throw new Error(`Untrusted Cursor system directory owner: ${current}`);
      const writableMount = allowWritableMount && current === CURSOR_SYSTEM_CONTAINER_MOUNT;
      // The container bundle exposes its existing hooks via assets/hooks -> ../hooks.
      if (stat.isSymbolicLink() && (!leaf || (allowWritableMount
        && current === path.join(CURSOR_SYSTEM_CONTAINER_MOUNT, 'assets/hooks')
        && await fs.readlink(current) === '../hooks'))) {
        await assertTrustedCursorSystemDirectory(await fs.realpath(current), allowWritableMount);
      } else if (!stat.isDirectory() || (!writableMount && (stat.mode & 0o022) !== 0
        && (leaf || (stat.mode & 0o1000) === 0))) {
        // A sticky ancestor such as /tmp protects entries owned by the
        // installer. Only the designated container mount may itself be writable.
        throw new Error(`Untrusted Cursor system directory permissions: ${current}`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
    leaf = false;
  }
}

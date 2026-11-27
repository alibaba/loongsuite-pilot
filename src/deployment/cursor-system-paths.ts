import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const CURSOR_SYSTEM_HOOK_SCRIPT = 'cursor-loongsuite-pilot-hook.sh';
const CURSOR_SYSTEM_CONTAINER_MOUNT = '/mnt/pilot';

export interface CursorSystemPathOptions {
  allowWritableMount?: boolean;
  bundledHooksRoot?: string;
}

export function cursorSystemRuntimePathOptions(dataDir: string): CursorSystemPathOptions {
  return { allowWritableMount: process.platform === 'linux' && path.resolve(dataDir) === CURSOR_SYSTEM_CONTAINER_MOUNT };
}

function canTrustOwner(uid: number): boolean {
  return uid === 0 || uid === process.geteuid?.();
}

export function isTrustedCursorSystemFile(stat: Stats): boolean {
  return stat.isFile() && canTrustOwner(stat.uid) && (stat.mode & 0o022) === 0;
}

export async function assertTrustedCursorSystemFile(file: string, options?: CursorSystemPathOptions): Promise<void> {
  await assertTrustedCursorSystemDirectory(path.dirname(file), options);
  if (!isTrustedCursorSystemFile(await fs.lstat(file))) {
    throw new Error(`Untrusted Cursor system runtime file: ${file}`);
  }
}

export async function assertTrustedCursorSystemNodePin(dataDir: string, options?: CursorSystemPathOptions): Promise<void> {
  const pin = path.join(dataDir, 'node-bin');
  await assertTrustedCursorSystemFile(pin, options);
  const node = (await fs.readFile(pin, 'utf8')).replace(/\r?\n$/, '');
  if (!path.isAbsolute(node) || /[\r\n\0]/.test(node)) throw new Error('Cursor system Node pin must contain one absolute path');
  await assertTrustedCursorSystemDirectory(path.dirname(node), options);
  const resolved = await fs.realpath(node);
  await assertTrustedCursorSystemFile(resolved, options);
  await fs.access(resolved, fs.constants.X_OK);
}

/** Seed a missing pin from the Node process already running eager injection. */
export async function initializeCursorSystemNodePin(dataDir: string, nodePath: string): Promise<void> {
  const options = cursorSystemRuntimePathOptions(dataDir);
  const pin = path.join(dataDir, 'node-bin');
  try {
    await fs.lstat(pin);
    return; // The normal runtime checks must still reject an untrusted existing pin.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await assertTrustedCursorSystemDirectory(dataDir, options);
  const node = await fs.realpath(nodePath);
  if (!path.isAbsolute(node) || /[\r\n\0]/.test(node)) throw new Error('Cursor system Node pin must contain one absolute path');
  await assertTrustedCursorSystemFile(node, options);
  await fs.access(node, fs.constants.X_OK);

  // Publish complete contents without replacing a pin created concurrently.
  const staging = await fs.mkdtemp(path.join(dataDir, '.cursor-node-pin-'));
  try {
    const file = path.join(staging, 'node-bin');
    await fs.writeFile(file, node + '\n', { mode: 0o644 });
    await fs.link(file, pin).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function assertTrustedCursorSystemDirectory(directory: string, options?: CursorSystemPathOptions): Promise<void> {
  const { allowWritableMount = false, bundledHooksRoot } = options ?? {};
  let current = path.resolve(directory);
  let leaf = true;
  while (true) {
    const stat = await fs.lstat(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat) {
      if (!canTrustOwner(stat.uid)) throw new Error(`Untrusted Cursor system directory owner: ${current}`);
      // Only the bundled source may use assets/hooks -> ../hooks as its
      // immediate parent. Continue to validate the resolved directory and
      // all ancestors of both paths with the same ownership and mode rules.
      const bundledAlias = leaf && bundledHooksRoot && stat.isSymbolicLink()
        && current === path.join(bundledHooksRoot, 'assets', 'hooks')
        && await fs.readlink(current) === '../hooks';
      if (stat.isSymbolicLink() && (!leaf || bundledAlias)) {
        const resolved = await fs.realpath(current);
        if (bundledAlias && bundledHooksRoot && resolved !== await fs.realpath(path.join(bundledHooksRoot, 'hooks'))) {
          throw new Error('Cursor bundled hook source must resolve to the installed hooks directory');
        }
        await assertTrustedCursorSystemDirectory(resolved, { allowWritableMount });
      } else if (!stat.isDirectory() || (!(allowWritableMount && current === CURSOR_SYSTEM_CONTAINER_MOUNT)
        && (stat.mode & 0o022) !== 0 && (leaf || (stat.mode & 0o1000) === 0))) {
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

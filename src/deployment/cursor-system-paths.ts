import { lstatSync, readlinkSync, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const CURSOR_SYSTEM_HOOK_SCRIPT = 'cursor-loongsuite-pilot-hook.sh';

/** The container payload carries assets/hooks -> ../hooks on its data mount.
 * Keep that mount writable, but do not let Cursor execute through it. The
 * sibling belongs to the business container, not to the init container.
 */
export function cursorSystemCompanionDir(dataDir: string): string {
  const root = path.resolve(dataDir);
  return path.join(path.dirname(root), '.' + path.basename(root) + '-cursor-system');
}

export function cursorSystemRuntimeDir(dataDir: string, pilotDir?: string): string {
  if (process.platform !== 'linux') return dataDir;
  const root = path.resolve(dataDir);
  const target = cursorSystemCompanionDir(root);
  try {
    // Keep the repair target stable even if a runtime file has been removed.
    const st = lstatSync(target);
    if (st.isDirectory() && canTrustOwner(st.uid) && (st.mode & 0o077) === 0) return target;
  } catch { /* no existing managed runtime */ }
  if (pilotDir && path.resolve(pilotDir) === root) {
    try {
      if (readlinkSync(path.join(root, 'assets/hooks')) === '../hooks') return target;
    } catch { /* regular installer layout */ }
  }
  return dataDir;
}

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

/**
 * Read an image-provisioned file through open, checked directory handles.
 * The shared mount can replace a top-level entry, but cannot change already
 * opened installer-owned directories or files. Never follow a supplied link.
 */
export async function withCursorPayloadFile<T>(
  root: string, relative: string, use: (file: fs.FileHandle) => Promise<T>,
): Promise<T> {
  const entries = relative.split('/');
  if (entries.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) {
    throw new Error('Invalid Cursor payload path');
  }
  const dirFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const handles: fs.FileHandle[] = [];
  try {
    handles.push(await fs.open(root, dirFlags));
    if (!canTrustOwner((await handles[0].stat()).uid)) throw new Error('Unowned Cursor payload mount');
    for (const [idx, name] of entries.entries()) {
      const dir = idx < entries.length - 1;
      const f = await fs.open('/proc/self/fd/' + handles.at(-1)!.fd + '/' + name,
        dir ? dirFlags : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      handles.push(f);
      const st = await f.stat();
      if (dir
        ? !st.isDirectory() || !canTrustOwner(st.uid) || (st.mode & 0o022) !== 0
        : !isTrustedCursorSystemFile(st)) {
        throw new Error('Untrusted Cursor container payload: ' + relative);
      }
    }
    return await use(handles.at(-1)!);
  } finally {
    await Promise.all(handles.map(f => f.close()));
  }
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

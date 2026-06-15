import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

/**
 * Returns whether `path` exists and is a regular file.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await fsp.stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Returns whether `path` exists and is a directory.
 */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    const st = await fsp.stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads and parses JSON from a file. Returns `null` on missing file or parse errors.
 */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const text = await fsp.readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Writes pretty-printed JSON atomically (write-to-tmp + rename) and ensures
 * parent directories exist. Errors are propagated to the caller.
 */
export async function writeJsonFile(
  path: string,
  data: unknown
): Promise<void> {
  const dir = nodePath.dirname(path);
  await ensureDir(dir);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, path);
  } catch (err: unknown) {
    // Directory may vanish between ensureDir and write/rename (e.g. concurrent cleanup).
    // Retry once after re-creating the directory.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fsp.unlink(tmp).catch(() => {});
      await ensureDir(dir);
      const tmp2 = `${path}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp2, text, 'utf8');
      await fsp.rename(tmp2, path);
    } else {
      throw err;
    }
  }
}

/**
 * Appends a line (with trailing newline) to a file, creating parent dirs as needed.
 */
export async function appendLine(path: string, line: string): Promise<void> {
  try {
    await ensureDir(nodePath.dirname(path));
    await fsp.appendFile(
      path,
      line.endsWith('\n') ? line : `${line}\n`,
      'utf8'
    );
  } catch {}
}

/**
 * Recursively creates a directory if it does not exist.
 */
export async function ensureDir(path: string): Promise<void> {
  if (!path || path === '.' || path === nodePath.parse(path).root) {
    return;
  }
  try {
    await fsp.mkdir(path, { recursive: true });
  } catch {}
}

/**
 * Expands a leading `~` to the user home directory.
 */
export function resolveHome(filepath: string): string {
  if (filepath === '~') {
    return os.homedir();
  }
  if (filepath.startsWith('~/') || filepath.startsWith(`~${nodePath.sep}`)) {
    return nodePath.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}

/**
 * Reads the installed package version from the dataDir's `current` pointer,
 * falling back to the local package.json, then to 'unknown'.
 */
export function readInstalledVersion(dataDir: string): string {
  try {
    const currentFile = nodePath.join(dataDir, 'current');
    const name = fs.readFileSync(currentFile, 'utf-8').trim();
    const versionFile = nodePath.join(dataDir, 'versions', name, 'VERSION');
    const content = fs.readFileSync(versionFile, 'utf-8');
    const match = content.match(/^version=(.+)$/m);
    if (match) return match[1];
  } catch { /* ignore */ }
  try {
    const localPkg = nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json');
    const raw = fs.readFileSync(localPkg, 'utf-8');
    return JSON.parse(raw).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Local calendar date as `YYYY-MM-DD`.
 */
export function getTodayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

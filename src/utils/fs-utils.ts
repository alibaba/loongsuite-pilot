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
 * Writes pretty-printed JSON and ensures parent directories exist.
 */
export async function writeJsonFile(
  path: string,
  data: unknown
): Promise<void> {
  try {
    await ensureDir(nodePath.dirname(path));
    const text = `${JSON.stringify(data, null, 2)}\n`;
    await fsp.writeFile(path, text, 'utf8');
  } catch {}
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
 * Local calendar date as `YYYY-MM-DD`.
 */
export function getTodayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

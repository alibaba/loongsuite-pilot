import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
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
 *
 * A leading UTF-8 BOM is stripped before parsing. `JSON.parse` rejects it, and
 * because this function swallows parse errors a BOM would silently degrade to
 * "file absent" — i.e. deployment state or config reverting to defaults rather
 * than failing loudly. Windows produces BOMs routinely: PowerShell 5.1's
 * `Set-Content -Encoding UTF8` always writes one (there is no utf8NoBOM before
 * PowerShell 6), and so does Notepad. Both touch files we read here
 * (`deployed-agents.json`, `config.json`).
 */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const text = await fsp.readFile(path, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T;
  } catch {
    return null;
  }
}

export type ExpectedFileState =
  | { exists: false }
  | { exists: true; content: string };

export interface AtomicTextWriteOptions {
  /**
   * Optional optimistic concurrency guard. The write is rejected when the
   * target no longer matches the content observed by the caller.
   */
  expected?: ExpectedFileState;
  /**
   * Optional one-time backup path. Existing backups are never overwritten.
   * Only applies when the expected target already exists.
   */
  backupPath?: string;
  /** Optional permissions for the newly-created temporary file. */
  mode?: number;
}

async function assertExpectedFileState(
  path: string,
  expected: ExpectedFileState,
): Promise<void> {
  let current: string | null;
  try {
    current = await fsp.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    current = null;
  }

  const matches = expected.exists
    ? current === expected.content
    : current === null;
  if (!matches) {
    throw new Error(`file changed before write: ${path}`);
  }
}

/**
 * Writes text atomically (write-to-tmp + rename) and ensures the parent
 * directory exists. Errors are propagated to the caller.
 */
export async function writeTextFileAtomic(
  path: string,
  text: string,
  options: AtomicTextWriteOptions = {},
): Promise<void> {
  const dir = nodePath.dirname(path);
  await ensureDir(dir);

  if (options.expected) {
    await assertExpectedFileState(path, options.expected);
  }

  if (options.backupPath && options.expected?.exists) {
    try {
      await fsp.copyFile(path, options.backupPath, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  const tmp = atomicTmpPath(path);
  try {
    await fsp.writeFile(tmp, text, { encoding: 'utf8', mode: options.mode });
    // Re-check after preparing the temporary file. This narrows the remaining
    // race to the final compare-and-rename window.
    if (options.expected) {
      await assertExpectedFileState(path, options.expected);
    }
    await fsp.rename(tmp, path);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // Directory may vanish between ensureDir and write/rename (e.g. concurrent cleanup).
    // Retry once after re-creating the directory.
    if (code === 'ENOENT') {
      await fsp.unlink(tmp).catch(() => {});
      await ensureDir(dir);
      const tmp2 = atomicTmpPath(path);
      try {
        await fsp.writeFile(tmp2, text, { encoding: 'utf8', mode: options.mode });
        if (options.expected) {
          await assertExpectedFileState(path, options.expected);
        }
        await fsp.rename(tmp2, path);
      } catch (retryErr) {
        await fsp.unlink(tmp2).catch(() => {});
        throw retryErr;
      }
    } else if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      // On Windows, rename can fail when the target is briefly locked by
      // antivirus/indexer or concurrent I/O. Retry once after a short delay.
      // If the error came from writeFile (tmp doesn't exist), skip the retry.
      const tmpExists = await fsp.stat(tmp).then(() => true, () => false);
      if (!tmpExists) throw err;
      await new Promise(r => setTimeout(r, 50));
      try {
        if (options.expected) {
          await assertExpectedFileState(path, options.expected);
        }
        await fsp.rename(tmp, path);
      } catch {
        await fsp.unlink(tmp).catch(() => {});
        throw err;
      }
    } else {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }
}

/**
 * Writes pretty-printed JSON atomically. This remains the strict-JSON writer;
 * JSONC callers must preserve and edit the original text instead.
 */
export async function writeJsonFile(
  path: string,
  data: unknown
): Promise<void> {
  await writeTextFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
}

function atomicTmpPath(path: string): string {
  return `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
}

/**
 * Removes stale `.tmp` files left behind by interrupted atomic writes (e.g. process
 * killed mid-rename). Call once at startup for directories that use writeJsonFile.
 *
 * Cleanup is **age-based**, not pid-based: a fresh `.tmp` (any pid) may belong to a
 * concurrent live process — e.g. two daemon instances overlapping during a restart.
 * Deleting it would break that process's `rename(tmp, path)` with ENOENT, failing
 * the collection cycle. Only remove tmp files older than `maxAgeMs` (a tmp that old
 * is definitely not mid-rename, since rename is instantaneous).
 */
export async function cleanStaleTmpFiles(dir: string, maxAgeMs = 60_000): Promise<void> {
  const now = Date.now();
  try {
    const entries = await fsp.readdir(dir);
    for (const f of entries) {
      if (!/\.(\d+)\.\d+(?:\.[^.]+)?\.tmp$/.test(f)) continue;
      const full = nodePath.join(dir, f);
      try {
        const st = await fsp.stat(full);
        if (now - st.mtimeMs < maxAgeMs) continue;
        await fsp.unlink(full).catch(() => {});
      } catch {}
    }
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

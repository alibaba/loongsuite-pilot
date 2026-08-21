/**
 * Windows tar.exe helpers: an ASCII staging root and a tar invocation that survives
 * a Git-for-Windows PATH. The node side of what deploy/installer-opensource.ps1 does in
 * the `pilot-ascii-temp` block and Expand-PilotTarGz — the .ps1 side is pinned by
 * tests/unit/scripts/ps1-nonascii-windows-paths.test.mjs.
 * Two distinct Windows traps, both measured on a CJK-profile box:
 *
 * 1) argv encoding. Node hands arguments to CreateProcessW as UTF-16 (verified:
 *    child_process passes a path with 4 non-ASCII chars and 0 '?'), but bsdtar
 *    (%SystemRoot%\System32\tar.exe) enters through the ANSI CRT and converts them
 *    back through the machine's ANSI codepage. On an en-US box every character that
 *    page cannot represent reaches tar as a literal '?', so both -f and -C point at
 *    paths that do not exist:
 *      tar: Error opening archive: Failed to open 'C:\Users\??.HOST\...\pkg.tar.gz'
 *    Under C:\Users\<CJK name> that fails every auto-update (package extraction) and
 *    every prebuilt node_modules adoption. It is not a console setting: chcp 65001 and
 *    a UTF-8 stdio encoding change stdio decoding, not argv conversion; 8.3 short names
 *    work only where 8dot3 creation is still enabled, so they cannot be relied on.
 *
 * 2) which tar. A bare `tar` resolves through PATH, and with Git for Windows installed
 *    that is Git's bundled GNU tar (MSYS), which reads the colon in `-f C:\...` as rsh
 *    host:path syntax and dies with "Cannot connect to C: resolve failed" (older builds
 *    hang). Prefer System32\tar.exe, then fall back to PATH's tar with --force-local,
 *    which is what makes GNU tar treat the colon as part of a local filename. Never
 *    pass --force-local to bsdtar: it rejects the unknown flag and exits immediately.
 *
 * The staging root can be machine-wide (%SystemRoot%\Temp), so it is for downloaded
 * archives only: never stage credentials or config there, use dataDir.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('WinArchive');

/** Printable ASCII only — the same test the .ps1 blocks use (`-notmatch '[^\x20-\x7E]'`). */
export function isAsciiPath(p: string): boolean {
  return !/[^\x20-\x7E]/.test(p);
}

let asciiTempRoot: string | null = null;

/**
 * A temp root guaranteed to be ASCII. Returns os.tmpdir() unchanged when it is
 * already ASCII (the overwhelmingly common case, and on every non-Windows host).
 */
export async function getAsciiTempRoot(): Promise<string> {
  if (asciiTempRoot) return asciiTempRoot;

  const base = os.tmpdir();
  if (process.platform !== 'win32' || isAsciiPath(base)) {
    asciiTempRoot = base;
    return base;
  }

  const candidates: string[] = [];
  if (process.env.SystemRoot) candidates.push(path.join(process.env.SystemRoot, 'Temp'));
  if (process.env.SystemDrive) candidates.push(`${process.env.SystemDrive}\\loongsuite-pilot-tmp`);
  candidates.push('C:\\Windows\\Temp');

  for (const candidate of candidates) {
    if (!isAsciiPath(candidate)) continue;
    try {
      // Probe by writing: %SystemRoot%\Temp grants Users write by default, but a
      // hardened host may not, and an existence check cannot tell us that.
      await fs.mkdir(candidate, { recursive: true });
      const probe = path.join(candidate, `pilot-w-${process.pid}.tmp`);
      await fs.writeFile(probe, '1');
      await fs.rm(probe, { force: true });
      asciiTempRoot = candidate;
      return candidate;
    } catch {
      // try the next candidate
    }
  }

  // Nothing writable: keep the old behaviour rather than failing outright.
  logger.warn('no writable ASCII temp root found, tar staging may fail', { base });
  asciiTempRoot = base;
  return base;
}

/**
 * Create a scratch directory that tar.exe can address. `preferred` is used as-is
 * when it is already ASCII, so ASCII installs keep staging next to their target
 * (same filesystem, so the caller's final rename cannot hit EXDEV).
 */
export async function makeTarStagingDir(preferred: string): Promise<string> {
  if (isAsciiPath(preferred)) {
    await fs.mkdir(preferred, { recursive: true });
    return preferred;
  }
  const root = await getAsciiTempRoot();
  const dir = path.join(
    root,
    `pilot-${path.basename(preferred).replace(/[^A-Za-z0-9._-]/g, '_')}-${process.pid}-${Math.floor(Math.random() * 1e6)}`,
  );
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Extract a .tar.gz. Both paths must already be ASCII on Windows — stage them with
 * makeTarStagingDir first, then move the result into the real destination (fs.rename
 * and fs.cp are Unicode-safe, unlike tar's arguments).
 */
export async function extractTarGz(
  archive: string,
  destDir: string,
  timeoutMs: number,
): Promise<void> {
  const candidates: Array<{ bin: string; args: string[] }> = [];
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    candidates.push({
      bin: path.join(systemRoot, 'System32', 'tar.exe'),
      args: ['-xzf', archive, '-C', destDir],
    });
    candidates.push({ bin: 'tar', args: ['-xzf', archive, '-C', destDir, '--force-local'] });
  } else {
    candidates.push({ bin: 'tar', args: ['-xzf', archive, '-C', destDir] });
  }

  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate.bin, candidate.args, { timeout: timeoutMs });
      return;
    } catch (err) {
      lastErr = err;
      logger.warn('tar extraction attempt failed', { tar: candidate.bin, error: String(err) });
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Re-inherit the destination's ACL on a tree that was renamed out of the ASCII root.
 * No-op off Windows. Mirrors Reset-PilotInheritedAcl in the installers' `pilot-ascii-temp`
 * block, and exists for the same reason: a rename carries the source's ACEs along
 * unchanged, so a tree staged in %SystemRoot%\Temp lands in the profile holding
 * %SystemRoot%\Temp's permissions — Users get write and traverse but *not* read, the
 * read grant coming from CREATOR OWNER. Whenever the owner of the staged files is not
 * the account that has to read them (anything running elevated, where new files are
 * owned by BUILTIN\Administrators), the moved tree ends up with no usable ACE and node
 * reports the very misleading `ERR_MODULE_NOT_FOUND: Cannot find package 'pino'` even
 * though the file is right there. `icacls /reset` re-inherits from the real parent and,
 * unlike tar.exe, handles a non-ASCII path correctly.
 */
export async function resetInheritedAcl(dir: string): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const icacls = path.join(systemRoot, 'System32', 'icacls.exe');
  try {
    // /T all descendants, /C keep going past a single failure, /Q stay quiet.
    await execFileAsync(icacls, [dir, '/reset', '/T', '/C', '/Q'], { timeout: 120_000 });
    return true;
  } catch (err) {
    logger.warn('could not reset inherited ACL', { dir, error: String(err) });
    return false;
  }
}

/**
 * Move a staged directory onto `dest`, replacing it. Falls back to copy+remove when
 * the staging root turned out to be on another volume (rename gives EXDEV).
 */
export async function replaceDirWith(staged: string, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  let renamed = false;
  try {
    await fs.rename(staged, dest);
    renamed = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    await fs.cp(staged, dest, { recursive: true });
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
  }
  // Only the rename needs this — fs.cp creates new files, which inherit normally.
  if (renamed) await resetInheritedAcl(dest);
}

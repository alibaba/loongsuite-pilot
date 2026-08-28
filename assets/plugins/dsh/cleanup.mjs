#!/usr/bin/env node
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MARKER = 'PILOT-OBSERVABILITY-MANAGED';
const ENABLED_MARKER = '.collection-enabled';
const LOCK_SUFFIX = '.loongsuite-pilot.lock';
const LOCK_GATE_SUFFIX = '.reclaim';
const BEGIN_PREFIX = '# BEGIN ';
const END_PREFIX = '# END ';
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function readBytes(filePath) {
  try { return await fs.readFile(filePath); }
  catch (error) {
    if (error?.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

async function exists(filePath) {
  try { await fs.stat(filePath); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function splitPilotBlock(bytes, marker) {
  const begin = `${BEGIN_PREFIX}${marker}`;
  const end = `${END_PREFIX}${marker}`;
  const beginOffsets = findLineMarkerOffsets(bytes, begin);
  const endOffsets = findLineMarkerOffsets(bytes, end);
  if (beginOffsets.length === 0 && endOffsets.length === 0) {
    return { before: bytes, block: null, after: Buffer.alloc(0), conflict: false };
  }
  if (beginOffsets.length !== 1 || endOffsets.length !== 1) {
    return { before: bytes, block: null, after: Buffer.alloc(0), conflict: true };
  }

  const beginIndex = beginOffsets[0];
  const endIndex = endOffsets[0];
  if (endIndex <= beginIndex) {
    return { before: bytes, block: null, after: Buffer.alloc(0), conflict: true };
  }

  const beginLineEnd = lineEndOffset(bytes, beginIndex);
  const endLineEnd = lineEndOffset(bytes, endIndex);
  const beginLine = bytes.subarray(beginIndex, beginLineEnd).toString('utf-8').replace(/\r$/, '');
  const endLine = bytes.subarray(endIndex, endLineEnd).toString('utf-8').replace(/\r$/, '');
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const validBegin = new RegExp(`^${BEGIN_PREFIX}${escapedMarker}(?: \\(created-file: (?:true|false)\\))?$`)
    .test(beginLine);
  const validEnd = endLine === end;
  let blockEnd = endLineEnd;
  if (bytes[blockEnd] === 0x0a) blockEnd++;
  const block = bytes.subarray(beginIndex, blockEnd).toString('utf-8');
  const lines = block.split(/\r?\n/);
  const conflict = !validBegin
    || !validEnd
    || !lines.includes('# entryId=loongsuite-pilot-observability')
    || !lines.some(line => line.startsWith('# pluginSource=') && line.length > '# pluginSource='.length)
    || !lines.some(line => line.startsWith('# pluginHash=') && line.length > '# pluginHash='.length);
  return {
    before: bytes.subarray(0, beginIndex),
    block,
    after: bytes.subarray(blockEnd),
    conflict,
  };
}

function findLineMarkerOffsets(bytes, marker) {
  const needle = Buffer.from(marker, 'utf-8');
  const offsets = [];
  let from = 0;
  while (from < bytes.length) {
    const index = bytes.indexOf(needle, from);
    if (index < 0) break;
    const atLineStart = index === 0 || bytes[index - 1] === 0x0a;
    const next = index + needle.length;
    const boundary = next === bytes.length
      || bytes[next] === 0x20
      || bytes[next] === 0x09
      || bytes[next] === 0x0d
      || bytes[next] === 0x0a;
    if (atLineStart && boundary) offsets.push(index);
    from = next;
  }
  return offsets;
}

function lineEndOffset(bytes, lineStart) {
  const newline = bytes.indexOf(0x0a, lineStart);
  return newline < 0 ? bytes.length : newline;
}

async function syncDirectory(dir) {
  try {
    const handle = await fs.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch { /* Not supported by every platform/filesystem. */ }
}

async function acquireLock(target) {
  const lockPath = `${target}${LOCK_SUFFIX}`;
  const gatePath = `${lockPath}${LOCK_GATE_SUFFIX}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const gateToken = await acquireOwnerFile(gatePath, deadline);
    if (!gateToken) return null;
    let acquired = false;
    try {
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600);
        try { await handle.write(token); await handle.sync(); } finally { await handle.close(); }
        acquired = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) await fs.unlink(lockPath);
        } catch (statError) {
          if (statError?.code !== 'ENOENT') throw statError;
        }
      }
    } finally {
      await releaseOwnerFile(gatePath, gateToken);
    }
    if (acquired) return token;
    await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
  }
  return null;
}

async function acquireOwnerFile(filePath, deadline) {
  const token = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(filePath, 'wx', 0o600);
      try { await handle.write(token); await handle.sync(); } finally { await handle.close(); }
      return token;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  return null;
}

async function releaseOwnerFile(filePath, token) {
  try {
    if (await fs.readFile(filePath, 'utf-8') === token) await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function releaseLock(target, token) {
  const lockPath = `${target}${LOCK_SUFFIX}`;
  const gatePath = `${lockPath}${LOCK_GATE_SUFFIX}`;
  const gateToken = await acquireOwnerFile(gatePath, Date.now() + LOCK_TIMEOUT_MS);
  if (!gateToken) return;
  try {
    try {
      if (await fs.readFile(lockPath, 'utf-8') === token) await fs.unlink(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } finally {
    await releaseOwnerFile(gatePath, gateToken);
  }
}

async function atomicWriteIfUnchanged(target, nextBytes, expectedHash, mode) {
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    if (sha256(await readBytes(target)) !== expectedHash) return false;
    const handle = await fs.open(tmp, 'wx', mode);
    try { await handle.write(nextBytes); await handle.sync(); } finally { await handle.close(); }
    if (sha256(await readBytes(target)) !== expectedHash) return false;
    await fs.rename(tmp, target);
    await syncDirectory(path.dirname(target));
    return true;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function deleteIfUnchanged(target, expectedHash) {
  if (sha256(await readBytes(target)) !== expectedHash) return false;
  if (sha256(await readBytes(target)) !== expectedHash) return false;
  await fs.unlink(target);
  await syncDirectory(path.dirname(target));
  return true;
}

/** Remove only the Pilot-owned DSH block. Used by both Unix and Windows installers. */
export async function cleanupDshIntegration(options = {}) {
  const pluginDir = options.pluginDir
    ?? path.dirname(fileURLToPath(import.meta.url));
  const patchPath = options.patchPath
    ?? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'cordis.patch.yml');
  const marker = options.marker ?? DEFAULT_MARKER;

  try {
    await fs.unlink(path.join(pluginDir, ENABLED_MARKER));
    await syncDirectory(pluginDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') return { success: false, error: String(error) };
  }

  // A cleanup-only path must not create the DSH home merely to coordinate a
  // no-op. This is especially visible on Windows, where the uninstaller always
  // invokes this helper with %USERPROFILE%\.dsh\cordis.patch.yml even when DSH
  // has never been installed. There is no Pilot-owned block to race when the
  // target is absent, so return before acquireLock() creates the parent.
  try {
    if (!(await exists(patchPath))) return { success: true, changed: false };
  } catch (error) {
    return { success: false, error: String(error) };
  }

  const token = await acquireLock(patchPath);
  if (!token) return { success: false, error: 'timed out waiting for DSH patch lock' };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const original = await readBytes(patchPath);
      if (original.length === 0 && !(await exists(patchPath))) {
        return { success: true, changed: false };
      }
      const originalHash = sha256(original);
      const parsed = splitPilotBlock(original, marker);
      if (parsed.conflict) {
        return { success: false, error: `conflicting or incomplete DSH marker block: ${marker}` };
      }
      if (!parsed.block) return { success: true, changed: false };
      const next = Buffer.concat([parsed.before, parsed.after]);
      const createdFile = /created-file:\s*true/.test(parsed.block);
      if (createdFile && next.toString('utf-8').trim().length === 0) {
        if (await deleteIfUnchanged(patchPath, originalHash)) return { success: true, changed: true };
      } else {
        let mode = 0o644;
        try { mode = (await fs.stat(patchPath)).mode & 0o777; } catch {}
        if (await atomicWriteIfUnchanged(patchPath, next, originalHash, mode)) {
          return { success: true, changed: true };
        }
      }
    }
    return { success: false, error: 'DSH patch changed concurrently; cleanup aborted' };
  } catch (error) {
    return { success: false, error: String(error) };
  } finally {
    await releaseLock(patchPath, token).catch(() => {});
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--patch') options.patchPath = argv[++index];
    else if (argv[index] === '--plugin-dir') options.pluginDir = argv[++index];
    else if (argv[index] === '--marker') options.marker = argv[++index];
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await cleanupDshIntegration(parseArgs(process.argv.slice(2)));
  if (!result.success) {
    process.stderr.write(`${result.error ?? 'DSH cleanup failed'}\n`);
    process.exitCode = 1;
  }
}

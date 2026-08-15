#!/usr/bin/env node
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MARKER = 'PILOT-OBSERVABILITY-MANAGED';
const ENABLED_MARKER = '.collection-enabled';
const LOCK_SUFFIX = '.loongsuite-pilot.lock';
const BEGIN_PREFIX = '# BEGIN ';
const END_PREFIX = '# END ';
const LOCK_TIMEOUT_MS = 2_000;
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
  const text = bytes.toString('utf-8');
  const begin = `${BEGIN_PREFIX}${marker}`;
  const end = `${END_PREFIX}${marker}`;
  const beginIndex = text.indexOf(begin);
  if (beginIndex < 0) return { before: bytes, block: null, after: Buffer.alloc(0), conflict: false };
  const endIndex = text.indexOf(end, beginIndex);
  if (endIndex < 0) return { before: bytes, block: null, after: Buffer.alloc(0), conflict: true };
  let blockEnd = endIndex + end.length;
  if (text[blockEnd] === '\n') blockEnd++;
  const block = text.slice(beginIndex, blockEnd);
  const conflict = !block.includes('# entryId=')
    || !block.includes('# pluginSource=')
    || !block.includes('# pluginHash=')
    || !block.includes('# entryId=loongsuite-pilot-observability\n');
  return {
    before: Buffer.from(text.slice(0, beginIndex), 'utf-8'),
    block,
    after: Buffer.from(text.slice(blockEnd), 'utf-8'),
    conflict,
  };
}

async function syncDirectory(dir) {
  try {
    const handle = await fs.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch { /* Not supported by every platform/filesystem. */ }
}

async function acquireLock(target) {
  const lockPath = `${target}${LOCK_SUFFIX}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try { await handle.write(token); await handle.sync(); } finally { await handle.close(); }
      return token;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  return null;
}

async function releaseLock(target, token) {
  const lockPath = `${target}${LOCK_SUFFIX}`;
  try {
    if (await fs.readFile(lockPath, 'utf-8') === token) await fs.unlink(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
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

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { rootTriggerEnabled } from '../utils/producer-log-dir.js';

/** Existing native state owns the target; a missing path inherits its parent. */
export async function agentConfigOwner(target: string): Promise<{ uid: number; gid: number; cwd: string }> {
  let current = path.resolve(target);
  for (;;) {
    try {
      const stat = await fs.stat(current);
      return { uid: stat.uid, gid: stat.gid, cwd: stat.isDirectory() ? current : path.dirname(current) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || current === path.dirname(current)) throw err;
      current = path.dirname(current);
    }
  }
}

async function createAsOwner(target: string, file: boolean): Promise<boolean> {
  if (process.getuid?.() !== 0 || !rootTriggerEnabled()) return false;
  const owner = await agentConfigOwner(target);
  if (owner.uid === 0) return false;
  // Only a Pilot filesystem helper runs with this identity, never an Agent.
  // Creating as the owner avoids a root-private inode/chown window. Failure
  // propagates: do not retry as root against the user's configuration.
  await promisify(execFile)(process.execPath, ['-e', [
    "const fs = require('node:fs'), path = require('node:path');",
    'const target = process.argv[1], file = process.argv[2] === "file";',
    'fs.mkdirSync(file ? path.dirname(target) : target, { recursive: true, mode: 0o700 });',
    'if (file) {',
    "  const tmp = target + '.pilot-' + process.pid;",
    "  try { fs.writeFileSync(tmp, '{}\\n', { flag: 'wx', mode: 0o600 });",
    "    try { fs.linkSync(tmp, target); } catch (e) { if (e.code !== 'EEXIST') throw e; }",
    '  } finally { try { fs.unlinkSync(tmp); } catch {} }',
    '}',
  ].join('\n'), path.resolve(target), file ? 'file' : 'directory'], {
    uid: owner.uid, gid: owner.gid, cwd: owner.cwd, timeout: 5000, maxBuffer: 64 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', BUN_OPTIONS: '', NODE_PATH: '' },
  });
  return true;
}

export async function ensureAgentConfigDirectory(directory: string): Promise<void> {
  try {
    if (!(await fs.stat(directory)).isDirectory()) throw new Error(`Agent configuration directory is not a directory: ${directory}`);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (await createAsOwner(directory, false)) return;
  await fs.mkdir(directory, { recursive: true });
}

export async function createAgentConfigFileIfMissing(file: string): Promise<void> {
  if (await createAsOwner(file, true)) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{}\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  });
}

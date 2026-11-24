import { execFile } from 'node:child_process';
import type * as syncFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as util from 'node:util';
import type { AgentDefinition } from '../types/index.js';
import { resolveHome, writeTextFileAtomic } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('QoderTokenUsage');
const execFileAsync = util.promisify(execFile);
type ParseEnv = (text: string) => Record<string, string>;
// Pilot runs on Node 22+, but the project still uses Node 18 type definitions.
const { parseEnv } = util as typeof util & { parseEnv: ParseEnv };

function defaultsToAppend(content: string, parse: ParseEnv): string {
  const values = parse(content.replace(/^\uFEFF/, ''));
  const missing = ['QODER_EXPOSE_TOKEN_USAGE', 'QODERCN_EXPOSE_TOKEN_USAGE']
    .filter(key => !Object.hasOwn(values, key));
  if (missing.length === 0) return '';

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const separator = content && !content.endsWith('\n') ? newline : '';
  return separator + missing.map(key => `${key}=1${newline}`).join('');
}

interface ProfileIdentity {
  uid: number;
  gid: number;
  dev: string;
  ino: string;
}

async function profileIdentity(directory: string): Promise<ProfileIdentity | undefined> {
  const profile = await fs.lstat(directory, { bigint: true });
  // A parent's owner can redirect a child path. Only trust real directories
  // controlled by root or by the same profile owner. Sticky directories such
  // as /tmp protect entries owned by those identities.
  const root = path.parse(directory).root;
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current, { bigint: true });
    if (!stat.isDirectory() || (stat.uid !== 0n && stat.uid !== profile.uid)
      || ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n)) {
      return undefined;
    }
  }
  return { uid: Number(profile.uid), gid: Number(profile.gid), dev: String(profile.dev), ino: String(profile.ino) };
}

// Runs in a child only, with the profile directory pinned as its cwd and the
// profile's credentials. Keep dependencies explicit for the embedded worker.
function reconcileOwnedEnv(
  files: typeof syncFs,
  suffixFor: typeof defaultsToAppend,
  parse: ParseEnv,
  owner: ProfileIdentity,
  apply: boolean,
): boolean {
  const profile = files.statSync('.', { bigint: true });
  if (process.geteuid?.() !== owner.uid || process.getegid?.() !== owner.gid
    || process.getgroups?.().some(gid => gid !== owner.gid)
    || Number(profile.uid) !== owner.uid || Number(profile.gid) !== owner.gid
    || String(profile.dev) !== owner.dev || String(profile.ino) !== owner.ino) {
    return false;
  }

  let file = '.env';
  let stat;
  try {
    stat = files.lstatSync(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (apply) files.writeFileSync(file, suffixFor('', parse), { flag: 'wx', mode: 0o600 });
    return true;
  }
  if (stat.isSymbolicLink() && owner.uid !== 0) {
    file = files.realpathSync(file);
    stat = files.lstatSync(file, { bigint: true });
  }
  if (!stat.isFile() || Number(stat.uid) !== owner.uid) return false;

  const { O_RDONLY, O_RDWR, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = files.constants;
  const fd = files.openSync(file, O_NOFOLLOW | O_NONBLOCK | (apply ? O_RDWR | O_APPEND : O_RDONLY));
  try {
    const opened = files.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || Number(opened.uid) !== owner.uid || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      return false;
    }
    const suffix = suffixFor(files.readFileSync(fd, 'utf8'), parse);
    if (!suffix) return false;
    if (apply) {
      const current = files.lstatSync(file, { bigint: true });
      if (current.dev !== opened.dev || current.ino !== opened.ino || current.ctimeNs !== opened.ctimeNs) return false;
      // Append through the checked descriptor without replacing any pathname.
      files.appendFileSync(fd, suffix);
    }
    return true;
  } finally {
    files.closeSync(fd);
  }
}

const profileEnvProgram = `
  const result = (${reconcileOwnedEnv.toString()})(require('node:fs'),
    (${defaultsToAppend.toString()}), require('node:util').parseEnv,
    JSON.parse(process.argv[1]), process.argv[2] === 'apply');
  process.stdout.write(String(result));
`;

async function reconcileAsProfileOwner(directory: string, apply: boolean): Promise<boolean> {
  const owner = await profileIdentity(directory);
  if (!owner) return false;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['-e', profileEnvProgram, JSON.stringify(owner), apply ? 'apply' : 'check'],
    { uid: owner.uid, gid: owner.gid, cwd: directory, env: {}, timeout: 5000, maxBuffer: 1024 },
  ).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`Qoder profile helper failed (${error.code ?? 'unknown error'})`);
  });
  return stdout === 'true';
}

/** Qoder reads its user .env on startup. Keep explicit user values. */
export async function reconcileQoderTokenUsageDefaults(def: AgentDefinition, apply: boolean): Promise<boolean> {
  if (!def.hook || (def.id !== 'qoder' && def.id !== 'qoder-cn')) return false;

  const directory = path.dirname(path.resolve(resolveHome(def.hook.settingsPath)));
  const envFile = path.join(directory, '.env');
  try {
    if ((process.geteuid?.() ?? process.getuid?.()) === 0) {
      return await reconcileAsProfileOwner(directory, apply);
    }

    let stat = await fs.lstat(envFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    let target = envFile;
    if (stat?.isSymbolicLink()) {
      target = await fs.realpath(envFile);
      stat = await fs.stat(target);
    }
    if (stat && !stat.isFile()) return false;

    const content = stat ? await fs.readFile(target, 'utf8') : '';
    const suffix = defaultsToAppend(content, parseEnv);
    if (!suffix) return false;
    if (apply) {
      await writeTextFileAtomic(target, content + suffix, {
        mode: stat ? stat.mode & 0o777 : 0o600,
        preserveMode: stat !== undefined,
        expected: stat ? { exists: true, content } : { exists: false },
      });
    }
    return true;
  } catch (error) {
    logger.warn('unable to reconcile Qoder token usage defaults', { agentId: def.id, envFile, error: String(error) });
    return false;
  }
}

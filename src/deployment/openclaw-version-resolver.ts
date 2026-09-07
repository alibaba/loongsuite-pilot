import { promises as fs, constants } from 'node:fs';
import * as path from 'node:path';
import { openClawCapabilities, type OpenClawCapabilities } from '../../assets/plugins/openclaw/compatibility.mjs';

export interface OpenClawHost extends OpenClawCapabilities {
  source: string;
  executable?: string;
}

/** In-process metadata lookup: never executes a CLI, shell or package manager.
 * An explicit deployment entry wins; otherwise conflicting PATH/source-package
 * evidence fails closed. No cache: watchdog sees upgrades too.
 */
export async function resolveOpenClawHost(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<OpenClawHost | null> {
  const unreadable = Symbol('unidentified-package');
  async function readPackage(file: string): Promise<OpenClawHost | null | undefined | typeof unreadable> {
    try {
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      let pkg;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 256 * 1024) return unreadable;
        const buffer = Buffer.alloc(256 * 1024 + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > 256 * 1024) return unreadable;
        pkg = JSON.parse(buffer.toString('utf8', 0, size));
      } finally { await handle.close(); }
      if (!pkg || typeof pkg !== 'object') return unreadable;
      if (pkg.name !== 'openclaw') return undefined;
      const caps = openClawCapabilities(pkg.version);
      return caps ? { ...caps, source: file } : null;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : unreadable;
    }
  }

  async function fromEntry(entry: string): Promise<OpenClawHost | null> {
    let real: string;
    try { real = await fs.realpath(entry); } catch { return null; }
    let dir = path.dirname(real);
    for (let depth = 0; depth < 8; depth++) {
      // Stop before broad filesystem roots. Only fixed package candidates,
      // never recursive directory enumeration or inspecting wrapper code.
      if (dir === path.parse(dir).root) break;
      const candidates = [path.join(dir, 'package.json')];
      if (depth <= 1) {
        candidates.push(path.join(dir, 'node_modules/openclaw/package.json'));
        candidates.push(path.join(dir, 'lib/node_modules/openclaw/package.json'));
        candidates.push(path.join(dir, 'global/5/node_modules/openclaw/package.json'));
      }
      if (path.basename(dir) === '.openclaw-bundle' || path.basename(dir) === 'openclaw-bundle'
        || (env.OPENCLAW_BUNDLE_ROOT && dir === path.resolve(env.OPENCLAW_BUNDLE_ROOT))) {
        candidates.push(path.join(dir, 'openclaw/node_modules/openclaw/package.json'));
      }
      let unidentified = false;
      for (const candidate of candidates) {
        const host = await readPackage(candidate);
        if (host === unreadable) {
          // A confirmed package path is authoritative. A wrapper's unrelated
          // metadata may be broken: still inspect its fixed sibling package.
          if (path.basename(path.dirname(candidate)) === 'openclaw') return null;
          unidentified = true;
          continue;
        }
        if (host !== undefined) return host ? { ...host, executable: entry } : null;
      }
      if (unidentified) return null; // Never escape a broken wrapper to ancestors.
      dir = path.dirname(dir);
    }
    return null;
  }

  if (env.OPENCLAW_CLI_PATH) return fromEntry(path.resolve(env.OPENCLAW_CLI_PATH));
  if (env.OPENCLAW_BUNDLE_ROOT) {
    const host = await readPackage(path.join(env.OPENCLAW_BUNDLE_ROOT, 'openclaw/node_modules/openclaw/package.json'));
    if (host !== undefined) return host === unreadable ? null : host;
  }
  const sourceHost = await readPackage(path.join(cwd, 'package.json'));
  const extensions = process.platform === 'win32'
    ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.toLowerCase())]
    : [''];
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean).slice(0, 128)) {
    // Ignore implicit/current-directory PATH entries, just as a service should.
    if (!path.isAbsolute(directory)) continue;
    for (const ext of extensions) {
      const candidate = path.join(directory, `openclaw${ext}`);
      try {
        await fs.access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (!(await fs.stat(candidate)).isFile()) continue;
      } catch { continue; }
      const selected = await fromEntry(candidate);
      if (sourceHost === null) return null;
      // A source-container cwd and PATH can expose distinct installations.
      // Do not grant modern schema fields to a possibly legacy config. The
      // container launcher can bind its actual executable via CLI_PATH.
      if (selected && sourceHost && sourceHost !== unreadable
        && await fs.realpath(selected.source) !== await fs.realpath(sourceHost.source)) return null;
      return selected;
    }
  }
  // Source containers commonly run `node /app/openclaw.mjs` from the package
  // root without installing a PATH command. Shared mounts can expose CLI_PATH.
  if (sourceHost !== undefined) return sourceHost === unreadable ? null : sourceHost;
  // Version labels do not identify the executable that will load the config.
  // Never grant schema capabilities based solely on inherited environment.
  return null;
}

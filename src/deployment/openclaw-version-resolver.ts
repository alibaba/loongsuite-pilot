import { promises as fs, constants } from 'node:fs';
import * as path from 'node:path';
import { openClawCapabilities, type OpenClawCapabilities } from '../../assets/plugins/openclaw/compatibility.mjs';

export interface OpenClawHost extends OpenClawCapabilities {
  source: string;
  executable?: string;
}

/** In-process metadata lookup: never executes a CLI, shell or package manager.
 * The first executable on PATH owns discovery; a broken/unsupported install must
 * not silently select a second version. No cache: watchdog sees upgrades too.
 */
export async function resolveOpenClawHost(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<OpenClawHost | null> {
  async function readPackage(file: string): Promise<OpenClawHost | null | undefined> {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 256 * 1024) return null;
      const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
      if (pkg.name !== 'openclaw') return undefined;
      const caps = openClawCapabilities(pkg.version);
      return caps ? { ...caps, source: file } : null;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
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
      for (const candidate of candidates) {
        const host = await readPackage(candidate);
        if (host !== undefined) return host ? { ...host, executable: entry } : null;
      }
      dir = path.dirname(dir);
    }
    return null;
  }

  if (env.OPENCLAW_CLI_PATH) return fromEntry(path.resolve(env.OPENCLAW_CLI_PATH));
  if (env.OPENCLAW_BUNDLE_ROOT) {
    const host = await readPackage(path.join(env.OPENCLAW_BUNDLE_ROOT, 'openclaw/node_modules/openclaw/package.json'));
    if (host !== undefined) return host;
  }
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
      return fromEntry(candidate);
    }
  }
  // Source containers commonly run `node /app/openclaw.mjs` from the package
  // root without installing a PATH command. Shared mounts can expose CLI_PATH.
  const sourceHost = await readPackage(path.join(cwd, 'package.json'));
  if (sourceHost !== undefined) return sourceHost;
  for (const key of ['OPENCLAW_SERVICE_VERSION', 'OPENCLAW_BUNDLED_VERSION']) {
    if (!env[key]) continue;
    const caps = openClawCapabilities(env[key]);
    return caps ? { ...caps, source: `env:${key}` } : null;
  }
  return null;
}

import { promises as fs, constants } from 'node:fs';
import * as path from 'node:path';
import { openClawCapabilities, type OpenClawCapabilities } from '../../assets/plugins/openclaw/compatibility.mjs';

export interface OpenClawHost extends OpenClawCapabilities {
  source: string;
  executable?: string;
  /** The entry is explicit, persisted by the installer, or uniquely discovered. */
  binding?: 'explicit-entry' | 'persisted-entry' | 'auto-entry';
}

export function isOpenClawHostBound(host: OpenClawHost | null): host is OpenClawHost & { executable: string } {
  return !!host?.binding && typeof host.executable === 'string'
    && path.isAbsolute(host.executable);
}

export function openClawBindingProblem(host: OpenClawHost | null): string {
  return `${host ? `OpenClaw ${host.version} candidate found, but Gateway entry is unconfirmed` : 'OpenClaw >=2026.3.8 launch entry/version unavailable or unsupported'}; `
    + 'automatic entry discovery is unavailable or ambiguous; optionally set OPENCLAW_CLI_PATH to the absolute Gateway launch entry; config left unchanged';
}

/** In-process metadata lookup: never executes a CLI, shell or package manager.
 * An explicit entry wins, then the installer's persisted entry. Otherwise only
 * a unique package among fixed cwd/bundle/PATH candidates authorizes deployment.
 * No process inspection, recursive scan or cache: watchdog sees upgrades too.
 */
export async function resolveOpenClawHost(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<OpenClawHost | null> {
  const unreadable = Symbol('unidentified-package');
  async function readJson(file: string, limit = 256 * 1024): Promise<Record<string, unknown> | undefined | typeof unreadable> {
    try {
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      let pkg;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit) return unreadable;
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > limit) return unreadable;
        pkg = JSON.parse(buffer.toString('utf8', 0, size).replace(/^\uFEFF/, ''));
      } finally { await handle.close(); }
      return pkg && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg : unreadable;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : unreadable;
    }
  }
  async function readPackage(file: string): Promise<OpenClawHost | null | undefined | typeof unreadable> {
    const pkg = await readJson(file);
    if (pkg === undefined || pkg === unreadable) return pkg;
    if (pkg.name !== 'openclaw') return undefined;
    const caps = openClawCapabilities(pkg.version);
    return caps ? { ...caps, source: file } : null;
  }

  async function fromEntry(entry: string): Promise<OpenClawHost | null> {
    let real: string;
    try {
      real = await fs.realpath(entry);
      if (!(await fs.stat(real)).isFile()) return null;
    } catch { return null; }
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

  if (env.OPENCLAW_CLI_PATH !== undefined) {
    // A relative entry changes meaning after a daemon/service changes cwd.
    // Invalid explicit bindings must never fall back to another installation.
    if (!path.isAbsolute(env.OPENCLAW_CLI_PATH)) return null;
    const host = await fromEntry(env.OPENCLAW_CLI_PATH);
    return host ? { ...host, binding: 'explicit-entry' } : null;
  }

  // Persist the entry, never its version: daemon cwd/PATH need not match the
  // installer, and every check must still read the currently installed package.
  const home = env.HOME || env.USERPROFILE;
  const configuredPath = env.AGENT_DATA_COLLECTION_CONFIG?.trim();
  const configPath = configuredPath
    ? (configuredPath.startsWith('~/') && home ? path.join(home, configuredPath.slice(2)) : configuredPath)
    : home ? path.join(home, '.loongsuite-pilot/config.json') : undefined;
  if (configPath) {
    const config = await readJson(configPath, 1024 * 1024);
    if (config === unreadable) return null;
    const entry = (config as { agents?: { openclaw?: { cliPath?: unknown } } } | undefined)?.agents?.openclaw?.cliPath;
    if (entry !== undefined) {
      if (typeof entry !== 'string' || !path.isAbsolute(entry)) return null;
      const host = await fromEntry(entry);
      return host ? { ...host, binding: 'persisted-entry' } : null;
    }
  }

  const candidates: OpenClawHost[] = [];
  // Fixed source layouts only: WORKDIR may be the package or its parent.
  // Never enumerate arbitrary children or prefer one conflicting package.
  for (const packageDir of [cwd, path.join(cwd, 'openclaw')]) {
    if (packageDir !== cwd) {
      try {
        // An executable named ./openclaw is not a child package directory.
        if (!(await fs.stat(packageDir)).isDirectory()) continue;
      } catch (err) {
        if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code || '')) continue;
        return null;
      }
    }
    const sourceHost = await readPackage(path.join(packageDir, 'package.json'));
    if (sourceHost === null || sourceHost === unreadable) return null;
    if (sourceHost) {
      const host = await fromEntry(path.join(packageDir, 'openclaw.mjs'));
      if (!host) return null;
      candidates.push(host);
    }
  }
  const bundleRoot = env.OPENCLAW_BUNDLE_ROOT || (home ? path.join(home, '.openclaw-bundle') : undefined);
  if (bundleRoot) {
    if (!path.isAbsolute(bundleRoot)) return null;
    const packageDir = path.join(bundleRoot, 'openclaw/node_modules/openclaw');
    const bundle = await readPackage(path.join(packageDir, 'package.json'));
    if (bundle === null || bundle === unreadable) return null;
    if (bundle) {
      const host = await fromEntry(path.join(packageDir, 'openclaw.mjs'));
      if (!host) return null;
      candidates.push(host);
    }
  }
  const extensions = process.platform === 'win32'
    ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.toLowerCase())]
    : [''];
  pathSearch: for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean).slice(0, 128)) {
    // Ignore implicit/current-directory PATH entries, just as a service should.
    if (!path.isAbsolute(directory)) continue;
    for (const ext of extensions) {
      const candidate = path.join(directory, `openclaw${ext}`);
      try {
        await fs.access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (!(await fs.stat(candidate)).isFile()) continue;
      } catch { continue; }
      const selected = await fromEntry(candidate);
      if (!selected) return null; // Do not bypass an opaque/unsupported PATH command.
      candidates.push(selected);
      break pathSearch; // Match shell PATH precedence, not every installed CLI.
    }
  }
  if (!candidates.length) return null;
  try {
    const packages = new Set(await Promise.all(candidates.map(host => fs.realpath(host.source))));
    if (packages.size !== 1) return null; // Distinct installations are ambiguous, even at the same version.
  } catch { return null; }
  return { ...candidates[0], binding: 'auto-entry' };
}

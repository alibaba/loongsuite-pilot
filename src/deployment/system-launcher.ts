import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { AgentDefinition, SystemLauncherRecord } from '../types/deployment.js';
import { writeTextFileAtomic } from '../utils/fs-utils.js';
import { withDeployedStateLock } from './deployed-state-merge.js';

function shell(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Launcher paths cannot contain newlines or NUL');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
function locations(def: AgentDefinition, dataDir: string) {
  if (!def.systemLauncher || !/^[a-z0-9-]+$/.test(def.id)
    || !['--extension', '--patch'].includes(def.systemLauncher.argument)) throw new Error('No system CLI launcher for this agent');
  const root = path.join(dataDir, 'system-launchers', def.id);
  return { root, wrapper: path.join(root, 'entry.sh'), enabled: path.join(root, 'enabled'), manifest: path.join(root, 'assets.sha256') };
}
async function link(file: string): Promise<string | undefined> {
  try { return await fs.readlink(file); }
  catch (error) { if (['ENOENT', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
}
function pointsTo(entry: string, target: string | undefined, expected: string): boolean {
  return target !== undefined && path.resolve(path.dirname(entry), target) === expected;
}

async function commandPath(command: string): Promise<string> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const file = path.resolve(dir, command);
    try { await fs.access(file, fs.constants.X_OK); return file; } catch { /* try next PATH entry */ }
  }
  throw new Error(`Shared CLI '${command}' not found on PATH; install it before system onboarding`);
}

/** Verify an npm bin symlink against the owning official package's bin field. */
async function officialTarget(def: AgentDefinition, entry: string): Promise<{ originalLink: string; originalTarget: string }> {
  const info = await fs.lstat(entry);
  if (!info.isSymbolicLink()) throw new Error(`System scope requires an official npm bin symlink: ${entry}`);
  const originalLink = (await link(entry))!;
  const originalTarget = await fs.realpath(entry);
  let directory = path.dirname(originalTarget);
  for (let depth = 0; depth < 10; depth++) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (def.systemLauncher!.packageNames.includes(pkg.name)) {
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[def.systemLauncher!.command];
        if (typeof bin === 'string' && await fs.realpath(path.resolve(directory, bin)) === originalTarget) {
          return { originalLink, originalTarget };
        }
        throw new Error('The shared CLI does not match the official package bin entry');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Unrecognized CLI package for ${def.id}; no executable was changed`);
}

export async function planSystemLauncher(
  def: AgentDefinition, dataDir: string, previous?: SystemLauncherRecord,
): Promise<SystemLauncherRecord> {
  const paths = locations(def, dataDir);
  const entryPath = previous?.entryPath ?? await commandPath(def.systemLauncher!.command);
  if (previous && previous.wrapperPath !== paths.wrapper) throw new Error('Launcher belongs to a different Pilot directory');
  const current = await link(entryPath);
  if (previous && pointsTo(entryPath, current, paths.wrapper)) {
    await fs.access(previous.originalTarget, fs.constants.X_OK);
    return previous;
  }
  const original = await officialTarget(def, entryPath);
  return { schema: 1, entryPath, ...original, wrapperPath: paths.wrapper };
}

export function renderSystemLauncher(def: AgentDefinition, dataDir: string, record: SystemLauncherRecord): string {
  const paths = locations(def, dataDir);
  const cfg = def.systemLauncher!;
  return [
    '#!/bin/bash', `# loongsuite-pilot system launcher: ${def.id}`,
    `if [ -f ${shell(paths.enabled)} ] && command -v sha256sum >/dev/null 2>&1 && sha256sum -c ${shell(paths.manifest)} >/dev/null 2>&1; then`,
    `  export LOONGSUITE_PILOT_DATA_DIR=${shell(dataDir)}`,
    `  exec ${shell(record.originalTarget)} ${cfg.argument} ${shell(cfg.assetPath)} "$@"`,
    'fi',
    `exec ${shell(record.originalTarget)} "$@"`, '',
  ].join('\n');
}

async function assetBytes(def: AgentDefinition, pilotDir: string) {
  return Promise.all(def.systemLauncher!.assetFiles.map(async relative => {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Invalid launcher asset path');
    return { relative, bytes: await fs.readFile(path.join(pilotDir, 'assets/plugins', relative)) };
  }));
}
function checksum(bytes: Buffer): string { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function manifestLine(bytes: Buffer, file: string): string {
  shell(file);
  return (file.includes('\\') ? '\\' : '') + checksum(bytes) + '  ' + file.replace(/\\/g, '\\\\') + '\n';
}

async function runtimeAssets(def: AgentDefinition, dataDir: string, pilotDir: string) {
  const assets = (await assetBytes(def, pilotDir)).map(({ relative, bytes }) => ({
    file: path.join(dataDir, 'plugins', relative), bytes,
  }));
  if (def.systemLauncher!.argument === '--patch') {
    const cfg = def.dshYamlPatch;
    const file = def.systemLauncher!.assetPath;
    if (!cfg || file !== path.join(locations(def, dataDir).root, 'pilot.patch.yml')
      || path.resolve(cfg.pluginSource) !== path.join(dataDir, 'plugins/dsh/plugin.mjs')) {
      throw new Error('Invalid system DSH patch ownership');
    }
    assets.push({ file, bytes: Buffer.from('- insert:\n    - id: ' + JSON.stringify(cfg.entryId)
      + '\n      name: ' + JSON.stringify(pathToFileURL(cfg.pluginSource).href) + '\n') });
    assets.push({ file: path.join(path.dirname(cfg.pluginSource), '.collection-enabled'), bytes: Buffer.from('enabled\n') });
  }
  return assets;
}

/** Caller must durably save record/cleanupRequired before calling this. */
export async function activateSystemLauncher(
  def: AgentDefinition, dataDir: string, pilotDir: string, record: SystemLauncherRecord,
): Promise<void> {
  const paths = locations(def, dataDir);
  if (record.wrapperPath !== paths.wrapper) throw new Error('Unexpected launcher owner');
  const assets = await runtimeAssets(def, dataDir, pilotDir);
  await fs.mkdir(paths.root, { recursive: true });
  await fs.rm(paths.enabled, { force: true });
  let manifest = '';
  for (const { file: target, bytes } of assets) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeTextFileAtomic(target, bytes.toString('utf8'));
    manifest += manifestLine(bytes, target);
  }
  await writeTextFileAtomic(paths.manifest, manifest);
  await writeTextFileAtomic(paths.wrapper, renderSystemLauncher(def, dataDir, record), { mode: 0o755 });
  await fs.chmod(paths.wrapper, 0o755);
  await withDeployedStateLock(record.entryPath + '.pilot-lock', async () => {
    const current = await link(record.entryPath);
    if (!pointsTo(record.entryPath, current, record.wrapperPath) && current !== record.originalLink) {
      throw new Error('Shared CLI changed during installation; retry without overwriting it');
    }
    await writeTextFileAtomic(paths.enabled, 'enabled\n');
    if (!pointsTo(record.entryPath, current, record.wrapperPath)) {
      const temp = record.entryPath + '.pilot-' + crypto.randomUUID();
      try {
        await fs.symlink(record.wrapperPath, temp);
        if (await link(record.entryPath) !== current) throw new Error('Shared CLI changed before binding');
        await fs.rename(temp, record.entryPath);
      } finally { await fs.rm(temp, { force: true }); }
    }
  });
}

export async function systemLauncherHealthy(
  def: AgentDefinition, dataDir: string, pilotDir: string, record?: SystemLauncherRecord,
): Promise<boolean> {
  if (!record) return false;
  try {
    const paths = locations(def, dataDir);
    if (record.wrapperPath !== paths.wrapper || !pointsTo(record.entryPath, await link(record.entryPath), paths.wrapper)) return false;
    if (await fs.readFile(paths.wrapper, 'utf8') !== renderSystemLauncher(def, dataDir, record)) return false;
    if (await fs.readFile(paths.enabled, 'utf8') !== 'enabled\n') return false;
    await fs.access(record.originalTarget, fs.constants.X_OK);
    let manifest = '';
    for (const { file: target, bytes } of await runtimeAssets(def, dataDir, pilotDir)) {
      if (!(await fs.readFile(target)).equals(bytes)) return false;
      manifest += manifestLine(bytes, target);
    }
    return await fs.readFile(paths.manifest, 'utf8') === manifest;
  } catch { return false; }
}

/** Restore only our binding; leave an independently replaced command untouched. */
export async function removeSystemLauncher(
  def: AgentDefinition, dataDir: string, record: SystemLauncherRecord,
): Promise<void> {
  const paths = locations(def, dataDir);
  if (record.wrapperPath !== paths.wrapper) throw new Error('Unexpected launcher owner');
  await fs.rm(paths.enabled, { force: true });
  if (def.dshYamlPatch && def.systemLauncher?.argument === '--patch') {
    const marker = path.join(dataDir, 'plugins/dsh/.collection-enabled');
    await fs.rm(marker, { force: true });
  }
  await withDeployedStateLock(record.entryPath + '.pilot-lock', async () => {
    if (!pointsTo(record.entryPath, await link(record.entryPath), record.wrapperPath)) return;
    await fs.access(record.originalTarget, fs.constants.X_OK);
    const temp = record.entryPath + '.pilot-' + crypto.randomUUID();
    try {
      await fs.symlink(record.originalLink, temp);
      if (!pointsTo(record.entryPath, await link(record.entryPath), record.wrapperPath)) throw new Error('Shared CLI changed during cleanup');
      await fs.rename(temp, record.entryPath);
    } finally { await fs.rm(temp, { force: true }); }
  });
}

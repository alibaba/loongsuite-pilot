import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeTextFileAtomic } from '../utils/fs-utils.js';

/**
 * Runtime files imported by the Grok Build hook entry points.
 *
 * This manifest intentionally lives outside the generic AgentDefinition
 * contract: Grok Build is the only Hook integration that currently needs a
 * multi-file runtime integrity check, so other agents keep their existing
 * deployment and watchdog behaviour.
 */
export const GROK_BUILD_HOOK_ASSETS = [
  'grok-build-loongsuite-pilot-hook.sh',
  'grok-build-loongsuite-pilot-hook.ps1',
  'grok-build-hook-processor.mjs',
  'grok-build/fusion.mjs',
  'grok-build/state.mjs',
  'grok-build/transcript-parser.mjs',
  'grok-build/unified-parser.mjs',
  'grok-build/updates-parser.mjs',
  'agent-event-normalizer.mjs',
  'claude-code/message-converter.mjs',
  'shared/decode-payload.mjs',
  'shared/error-logger.mjs',
  'shared/event-emitter.mjs',
  'shared/qoder-db-utils.mjs',
  'shared/resource-context.mjs',
  'shared/stdin-reader.mjs',
] as const;

async function sameFile(source: string, target: string): Promise<boolean> {
  try {
    const [sourceBytes, targetBytes] = await Promise.all([
      fs.readFile(source),
      fs.readFile(target),
    ]);
    if (!sourceBytes.equals(targetBytes)) return false;
    if (process.platform !== 'win32' && source.endsWith('.sh')) {
      const stat = await fs.stat(target);
      return (stat.mode & 0o111) !== 0;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Host installs keep the gold copy at `$PILOT_DIR/assets/hooks` and postinstall
 * copies it to `$PILOT_DATA/hooks`. The K8s payload flattens `assets/hooks/`
 * into top-level `hooks/` and historically did not keep `assets/hooks`, so a
 * hard-coded gold path ENOENTs and the Grok watchdog repair-fails forever.
 * Prefer the packaged tree when it exists; otherwise use the flattened layout.
 */
export async function resolveGrokBuildHookSourceRoot(pilotDir: string): Promise<string> {
  const packaged = path.join(pilotDir, 'assets', 'hooks');
  try {
    await fs.access(packaged);
    return packaged;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return path.join(pilotDir, 'hooks');
  }
}

export async function areGrokBuildHookAssetsHealthy(
  pilotDir: string,
  dataDir: string,
): Promise<boolean> {
  const sourceRoot = await resolveGrokBuildHookSourceRoot(pilotDir);
  const targetRoot = path.join(dataDir, 'hooks');
  const results = await Promise.all(GROK_BUILD_HOOK_ASSETS.map(relativePath =>
    sameFile(path.join(sourceRoot, relativePath), path.join(targetRoot, relativePath))));
  return results.every(Boolean);
}

export async function restoreGrokBuildHookAssets(
  pilotDir: string,
  dataDir: string,
): Promise<void> {
  const sourceRoot = await resolveGrokBuildHookSourceRoot(pilotDir);
  const targetRoot = path.join(dataDir, 'hooks');

  for (const relativePath of GROK_BUILD_HOOK_ASSETS) {
    const source = path.join(sourceRoot, relativePath);
    const target = path.join(targetRoot, relativePath);
    await fs.access(source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const content = await fs.readFile(source, 'utf8');
    await writeTextFileAtomic(target, content);
    await fs.chmod(target, relativePath.endsWith('.sh') ? 0o755 : 0o644).catch(() => {});
  }
}

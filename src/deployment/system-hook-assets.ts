import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { GROK_BUILD_HOOK_ASSETS } from './grok-build-assets.js';
import { areHookRuntimeAssetsHealthy, restoreHookRuntimeAssets } from './hook-runtime-assets.js';
import { assertTrustedCursorSystemDirectory, assertTrustedCursorSystemFile,
  assertTrustedCursorSystemNodePin, cursorSystemRuntimeDir, withCursorPayloadFile, CURSOR_SYSTEM_HOOK_SCRIPT } from './cursor-system-paths.js';
import { writeTextFileAtomic } from '../utils/fs-utils.js';
import { configJsonPath } from '../utils/data-dir.js';

export const CODEX_SYSTEM_HOOK_ASSETS = [
  'codex-loongsuite-pilot-hook.sh', 'codex-loongsuite-pilot-hook.ps1',
  'codex-hook-processor.mjs', 'shared/decode-payload.mjs',
  'shared/error-logger.mjs', 'shared/hook-metrics.mjs',
  'shared/resource-context.mjs', 'shared/sync-file-lock.mjs', 'shared/upstream-context.mjs',
] as const;

const CURSOR_SYSTEM_HOOK_ASSETS = [
  CURSOR_SYSTEM_HOOK_SCRIPT, 'cursor-hook-processor.mjs', 'agent-event-normalizer.mjs',
  'cursor/assembly-lock.mjs', 'cursor/cli-transcript-recovery.mjs', 'cursor/event-journal.mjs',
  'cursor/react-assembler.mjs', 'cursor/skill-detector.mjs', 'cursor/source-event.mjs',
  'cursor/transcript-assembler.mjs', 'cursor/turn-events.mjs', 'cursor/workspace-context.mjs',
  'shared/decode-payload.mjs', 'shared/qoder-db-utils.mjs', 'shared/raw-jsonl-writer.mjs',
  'shared/raw-source-gate.mjs', 'shared/resource-context.mjs', 'shared/workspace-policy.mjs',
  'shared/workspace-privacy.mjs', 'shared/sync-file-lock.mjs',
] as const;
const CURSOR_SYSTEM_MANIFEST = 'cursor-system-assets.list';
const CURSOR_SYSTEM_CONFIG_PIN = 'cursor-system-config-path';
const CURSOR_SYSTEM_MANIFEST_TEXT = CURSOR_SYSTEM_HOOK_ASSETS.join('\n') + '\n';

function manifest(agentId: string): readonly string[] {
  if (agentId === 'grok-build') return GROK_BUILD_HOOK_ASSETS;
  if (agentId === 'codex') return CODEX_SYSTEM_HOOK_ASSETS;
  if (agentId === 'cursor') return CURSOR_SYSTEM_HOOK_ASSETS;
  throw new Error(`No system hook runtime for ${agentId}`);
}

async function assertPrivateCursorDirectory(directory: string): Promise<void> {
  await assertTrustedCursorSystemDirectory(directory);
  const stat = await lstat(directory);
  if (stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('Cursor system data directory must be private to the collector user');
  }
}

async function ensurePrivateCursorDirectory(directory: string): Promise<void> {
  await assertTrustedCursorSystemDirectory(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertTrustedCursorSystemDirectory(directory);
  if ((await lstat(directory)).uid !== process.geteuid?.()) {
    throw new Error('Cursor system data directory must belong to the collector user');
  }
  await chmod(directory, 0o700);
}

async function trustedCursorPolicyPath(): Promise<string> {
  const config = path.resolve(configJsonPath());
  if (/[\r\n\0]/.test(config)) throw new Error('Invalid Cursor system config path');
  try {
    await assertTrustedCursorSystemFile(config);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return config;
}

/** Select an already-trusted Node or copy the bundled runtime once per Pod. */
async function stageCursorContainerNode(payloadDir: string, runtimeDir: string): Promise<void> {
  try {
    await assertTrustedCursorSystemNodePin(runtimeDir);
    return;
  } catch { /* initial install or repair */ }
  const current = await realpath(process.execPath);
  const trustedCurrent = !('bun' in process.versions)
    && await assertTrustedCursorSystemFile(current).then(() => true, () => false);
  if (trustedCurrent) {
    await writeTextFileAtomic(path.join(runtimeDir, 'node-bin'), current + '\n', { mode: 0o644 });
    return;
  }
  const staging = await mkdtemp(path.join(runtimeDir, '.node-'));
  const node = path.join(runtimeDir, 'node');
  try {
    const staged = path.join(staging, 'node');
    await withCursorPayloadFile(payloadDir, 'bin/node', async file => {
      if (((await file.stat()).mode & 0o111) === 0) throw new Error('Cursor payload Node is not executable');
      await copyFile('/proc/self/fd/' + file.fd, staged);
    });
    await chmod(staged, 0o700);
    await rename(staged, node);
    await writeTextFileAtomic(path.join(runtimeDir, 'node-bin'), node + '\n', { mode: 0o600 });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function areSystemHookAssetsHealthy(agentId: string, pilotDir: string, dataDir: string): Promise<boolean> {
  if (agentId === 'cursor') {
    try {
      const runtimeDir = cursorSystemRuntimeDir(dataDir, pilotDir);
      await assertTrustedCursorSystemNodePin(runtimeDir);
      const config = await trustedCursorPolicyPath();
      await assertPrivateCursorDirectory(path.join(runtimeDir, 'logs/cursor'));
      await assertPrivateCursorDirectory(path.join(runtimeDir, 'state/cursor'));
      const root = path.join(runtimeDir, 'hooks');
      const pin = path.join(root, CURSOR_SYSTEM_CONFIG_PIN);
      await assertTrustedCursorSystemFile(pin);
      if (await readFile(pin, 'utf8') !== config + '\n') return false;
      const list = path.join(root, CURSOR_SYSTEM_MANIFEST);
      await assertTrustedCursorSystemFile(list);
      if (await readFile(list, 'utf8') !== CURSOR_SYSTEM_MANIFEST_TEXT) return false;
      for (const file of CURSOR_SYSTEM_HOOK_ASSETS) {
        const target = path.join(root, file);
        await assertTrustedCursorSystemFile(target);
        if (runtimeDir !== dataDir) {
          const packaged = await withCursorPayloadFile(pilotDir, 'hooks/' + file, handle => handle.readFile());
          if (!packaged.equals(await readFile(target))) return false;
        }
      }
      return runtimeDir !== dataDir || await areHookRuntimeAssetsHealthy(pilotDir, runtimeDir, CURSOR_SYSTEM_HOOK_ASSETS);
    } catch {
      return false;
    }
  }
  return areHookRuntimeAssetsHealthy(pilotDir, dataDir, manifest(agentId));
}

export async function restoreSystemHookAssets(agentId: string, pilotDir: string, dataDir: string): Promise<void> {
  if (agentId === 'cursor') {
    const runtimeDir = cursorSystemRuntimeDir(dataDir, pilotDir);
    const fromSharedPackage = runtimeDir !== dataDir;
    const config = await trustedCursorPolicyPath();
    if (fromSharedPackage) {
      if (path.resolve(pilotDir) !== path.resolve(dataDir)) throw new Error('Cursor container runtime requires the bundled Pilot payload');
      await ensurePrivateCursorDirectory(runtimeDir);
      await stageCursorContainerNode(dataDir, runtimeDir);
    }
    await assertTrustedCursorSystemNodePin(runtimeDir);
    const root = path.join(runtimeDir, 'hooks');
    await assertTrustedCursorSystemDirectory(root);
    const logs = path.join(runtimeDir, 'logs/cursor');
    await ensurePrivateCursorDirectory(logs);
    await ensurePrivateCursorDirectory(path.join(runtimeDir, 'state/cursor'));
    const history = path.join(logs, 'history');
    await assertTrustedCursorSystemDirectory(history);
    await mkdir(history, { recursive: true, mode: 0o700 });
    await writeTextFileAtomic(path.join(root, CURSOR_SYSTEM_CONFIG_PIN), config + '\n',
      { mode: 0o644, preserveMode: true });
    // Let the Cursor Input establish its first-run baseline before the first turn.
    if (fromSharedPackage) {
      // Read the entire allowed set before replacing any live asset.
      const payload = await Promise.all(CURSOR_SYSTEM_HOOK_ASSETS.map(asset =>
        withCursorPayloadFile(pilotDir, 'hooks/' + asset, async file => ({ asset, content: await file.readFile('utf8') }))));
      for (const { asset, content } of payload) {
        const target = path.join(root, asset);
        await assertTrustedCursorSystemDirectory(path.dirname(target));
        await writeTextFileAtomic(target, content, { mode: asset.endsWith('.sh') ? 0o755 : 0o644 });
      }
    } else {
      await restoreHookRuntimeAssets(pilotDir, dataDir, CURSOR_SYSTEM_HOOK_ASSETS, async (source, target) => {
        await assertTrustedCursorSystemFile(source);
        await assertTrustedCursorSystemDirectory(path.dirname(target));
      });
    }
    await writeTextFileAtomic(path.join(root, CURSOR_SYSTEM_MANIFEST), CURSOR_SYSTEM_MANIFEST_TEXT,
      { mode: 0o644, preserveMode: true });
    return;
  }
  await restoreHookRuntimeAssets(pilotDir, dataDir, manifest(agentId));
}

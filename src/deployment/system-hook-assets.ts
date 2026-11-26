import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { GROK_BUILD_HOOK_ASSETS } from './grok-build-assets.js';
import { areHookRuntimeAssetsHealthy, restoreHookRuntimeAssets } from './hook-runtime-assets.js';
import { assertTrustedCursorSystemDirectory, assertTrustedCursorSystemFile,
  assertTrustedCursorSystemNodePin, CURSOR_SYSTEM_HOOK_SCRIPT, usesCursorSystemContainerMount } from './cursor-system-paths.js';
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

async function assertPrivateCursorDirectory(directory: string, allowWritableMount: boolean): Promise<void> {
  await assertTrustedCursorSystemDirectory(directory, allowWritableMount);
  const stat = await lstat(directory);
  if (stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('Cursor system data directory must be private to the collector user');
  }
}

async function ensurePrivateCursorDirectory(directory: string, allowWritableMount: boolean): Promise<void> {
  await assertTrustedCursorSystemDirectory(directory, allowWritableMount);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertTrustedCursorSystemDirectory(directory, allowWritableMount);
  if ((await lstat(directory)).uid !== process.geteuid?.()) {
    throw new Error('Cursor system data directory must belong to the collector user');
  }
  await chmod(directory, 0o700);
}

async function trustedCursorPolicyPath(allowWritableMount: boolean): Promise<string> {
  const config = path.resolve(configJsonPath());
  if (/[\r\n\0]/.test(config)) throw new Error('Invalid Cursor system config path');
  try {
    await assertTrustedCursorSystemFile(config, allowWritableMount);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return config;
}

export async function areSystemHookAssetsHealthy(agentId: string, pilotDir: string, dataDir: string): Promise<boolean> {
  if (agentId === 'cursor') {
    try {
      const allowWritableMount = usesCursorSystemContainerMount(dataDir);
      await assertTrustedCursorSystemNodePin(dataDir, allowWritableMount);
      const config = await trustedCursorPolicyPath(allowWritableMount);
      await assertPrivateCursorDirectory(path.join(dataDir, 'logs/cursor'), allowWritableMount);
      await assertPrivateCursorDirectory(path.join(dataDir, 'state/cursor'), allowWritableMount);
      const root = path.join(dataDir, 'hooks');
      const pin = path.join(root, CURSOR_SYSTEM_CONFIG_PIN);
      await assertTrustedCursorSystemFile(pin, allowWritableMount);
      if (await readFile(pin, 'utf8') !== config + '\n') return false;
      const list = path.join(root, CURSOR_SYSTEM_MANIFEST);
      await assertTrustedCursorSystemFile(list, allowWritableMount);
      if (await readFile(list, 'utf8') !== CURSOR_SYSTEM_MANIFEST_TEXT) return false;
      for (const file of CURSOR_SYSTEM_HOOK_ASSETS) {
        await assertTrustedCursorSystemFile(path.join(root, file), allowWritableMount);
      }
    } catch {
      return false;
    }
  }
  return areHookRuntimeAssetsHealthy(pilotDir, dataDir, manifest(agentId));
}

export async function restoreSystemHookAssets(agentId: string, pilotDir: string, dataDir: string): Promise<void> {
  if (agentId === 'cursor') {
    const allowWritableMount = usesCursorSystemContainerMount(dataDir);
    await assertTrustedCursorSystemNodePin(dataDir, allowWritableMount);
    const config = await trustedCursorPolicyPath(allowWritableMount);
    const root = path.join(dataDir, 'hooks');
    await assertTrustedCursorSystemDirectory(root, allowWritableMount);
    const logs = path.join(dataDir, 'logs/cursor');
    await ensurePrivateCursorDirectory(logs, allowWritableMount);
    await ensurePrivateCursorDirectory(path.join(dataDir, 'state/cursor'), allowWritableMount);
    const history = path.join(logs, 'history');
    await assertTrustedCursorSystemDirectory(history, allowWritableMount);
    await mkdir(history, { recursive: true, mode: 0o700 });
    await writeTextFileAtomic(path.join(root, CURSOR_SYSTEM_CONFIG_PIN), config + '\n',
      { mode: 0o644, preserveMode: true });
    // Let the Cursor Input establish its first-run baseline before the first turn.
    await restoreHookRuntimeAssets(pilotDir, dataDir, CURSOR_SYSTEM_HOOK_ASSETS, async (source, target) => {
      await assertTrustedCursorSystemFile(source, allowWritableMount);
      await assertTrustedCursorSystemDirectory(path.dirname(target), allowWritableMount);
    });
    await writeTextFileAtomic(path.join(root, CURSOR_SYSTEM_MANIFEST), CURSOR_SYSTEM_MANIFEST_TEXT,
      { mode: 0o644, preserveMode: true });
    return;
  }
  await restoreHookRuntimeAssets(pilotDir, dataDir, manifest(agentId));
}

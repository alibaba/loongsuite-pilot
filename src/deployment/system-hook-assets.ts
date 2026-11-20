import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { GROK_BUILD_HOOK_ASSETS } from './grok-build-assets.js';
import { areHookRuntimeAssetsHealthy, restoreHookRuntimeAssets } from './hook-runtime-assets.js';
import { assertTrustedCursorSystemDirectory, assertTrustedCursorSystemFile,
  assertTrustedCursorSystemNodePin, CURSOR_SYSTEM_HOOK_SCRIPT } from './cursor-system-paths.js';
import { writeTextFileAtomic } from '../utils/fs-utils.js';

export const CODEX_SYSTEM_HOOK_ASSETS = [
  'codex-loongsuite-pilot-hook.sh', 'codex-loongsuite-pilot-hook.ps1',
  'codex-hook-processor.mjs', 'shared/decode-payload.mjs',
  'shared/error-logger.mjs', 'shared/hook-metrics.mjs',
  'shared/resource-context.mjs', 'shared/sync-file-lock.mjs', 'shared/upstream-context.mjs',
] as const;

const CURSOR_SYSTEM_HOOK_ASSETS = [
  CURSOR_SYSTEM_HOOK_SCRIPT, 'cursor-hook-processor.mjs', 'agent-event-normalizer.mjs',
  'cursor/event-journal.mjs', 'cursor/react-assembler.mjs', 'cursor/skill-detector.mjs',
  'cursor/source-event.mjs', 'cursor/transcript-assembler.mjs', 'cursor/workspace-context.mjs',
  'shared/decode-payload.mjs', 'shared/qoder-db-utils.mjs', 'shared/raw-jsonl-writer.mjs',
  'shared/raw-source-gate.mjs', 'shared/resource-context.mjs', 'shared/workspace-policy.mjs',
  'shared/workspace-privacy.mjs',
] as const;
const CURSOR_SYSTEM_MANIFEST = 'cursor-system-assets.list';
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

async function assertTrustedCursorPolicy(dataDir: string): Promise<void> {
  const config = path.join(dataDir, 'config.json');
  try {
    await assertTrustedCursorSystemFile(config);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export async function areSystemHookAssetsHealthy(agentId: string, pilotDir: string, dataDir: string): Promise<boolean> {
  if (agentId === 'cursor') {
    try {
      await assertTrustedCursorSystemNodePin(dataDir);
      await assertTrustedCursorPolicy(dataDir);
      await assertPrivateCursorDirectory(path.join(dataDir, 'logs/cursor'));
      await assertPrivateCursorDirectory(path.join(dataDir, 'state/cursor'));
      const root = path.join(dataDir, 'hooks');
      const list = path.join(root, CURSOR_SYSTEM_MANIFEST);
      await assertTrustedCursorSystemFile(list);
      if (await readFile(list, 'utf8') !== CURSOR_SYSTEM_MANIFEST_TEXT) return false;
      for (const file of CURSOR_SYSTEM_HOOK_ASSETS) await assertTrustedCursorSystemFile(path.join(root, file));
    } catch {
      return false;
    }
  }
  return areHookRuntimeAssetsHealthy(pilotDir, dataDir, manifest(agentId));
}

export async function restoreSystemHookAssets(agentId: string, pilotDir: string, dataDir: string): Promise<void> {
  if (agentId === 'cursor') {
    await assertTrustedCursorSystemNodePin(dataDir);
    await assertTrustedCursorPolicy(dataDir);
    const root = path.join(dataDir, 'hooks');
    await assertTrustedCursorSystemDirectory(root);
    const logs = path.join(dataDir, 'logs/cursor');
    await ensurePrivateCursorDirectory(logs);
    await ensurePrivateCursorDirectory(path.join(dataDir, 'state/cursor'));
    const history = path.join(logs, 'history');
    await assertTrustedCursorSystemDirectory(history);
    await mkdir(history, { recursive: true, mode: 0o700 });
    // Let the Cursor Input establish its first-run baseline before the first turn.
    await restoreHookRuntimeAssets(pilotDir, dataDir, CURSOR_SYSTEM_HOOK_ASSETS, async (source, target) => {
      await assertTrustedCursorSystemFile(source);
      await assertTrustedCursorSystemDirectory(path.dirname(target));
    });
    await writeTextFileAtomic(path.join(root, CURSOR_SYSTEM_MANIFEST), CURSOR_SYSTEM_MANIFEST_TEXT,
      { mode: 0o644, preserveMode: true });
    return;
  }
  await restoreHookRuntimeAssets(pilotDir, dataDir, manifest(agentId));
}

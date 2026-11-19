import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { GROK_BUILD_HOOK_ASSETS } from './grok-build-assets.js';
import { areHookRuntimeAssetsHealthy, restoreHookRuntimeAssets } from './hook-runtime-assets.js';

export const CODEX_SYSTEM_HOOK_ASSETS = [
  'codex-loongsuite-pilot-hook.sh', 'codex-loongsuite-pilot-hook.ps1',
  'codex-hook-processor.mjs', 'shared/decode-payload.mjs',
  'shared/error-logger.mjs', 'shared/hook-metrics.mjs',
  'shared/resource-context.mjs', 'shared/sync-file-lock.mjs', 'shared/upstream-context.mjs',
] as const;

const CURSOR_SYSTEM_HOOK_ASSETS = [
  'cursor-loongsuite-pilot-hook.sh', 'cursor-hook-processor.mjs', 'agent-event-normalizer.mjs',
  'cursor/event-journal.mjs', 'cursor/react-assembler.mjs', 'cursor/skill-detector.mjs',
  'cursor/source-event.mjs', 'cursor/transcript-assembler.mjs', 'cursor/workspace-context.mjs',
  'shared/decode-payload.mjs', 'shared/qoder-db-utils.mjs', 'shared/raw-jsonl-writer.mjs',
  'shared/raw-source-gate.mjs', 'shared/resource-context.mjs', 'shared/workspace-policy.mjs',
  'shared/workspace-privacy.mjs',
] as const;

function manifest(agentId: string): readonly string[] {
  if (agentId === 'grok-build') return GROK_BUILD_HOOK_ASSETS;
  if (agentId === 'codex') return CODEX_SYSTEM_HOOK_ASSETS;
  if (agentId === 'cursor') return CURSOR_SYSTEM_HOOK_ASSETS;
  throw new Error(`No system hook runtime for ${agentId}`);
}

export function areSystemHookAssetsHealthy(agentId: string, pilotDir: string, dataDir: string): Promise<boolean> {
  return areHookRuntimeAssetsHealthy(pilotDir, dataDir, manifest(agentId));
}

export async function restoreSystemHookAssets(agentId: string, pilotDir: string, dataDir: string): Promise<void> {
  await restoreHookRuntimeAssets(pilotDir, dataDir, manifest(agentId));
  if (agentId === 'cursor') {
    // Let the Cursor Input establish its first-run baseline before the first turn.
    await mkdir(path.join(dataDir, 'logs/cursor/history'), { recursive: true });
  }
}

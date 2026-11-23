import { GROK_BUILD_HOOK_ASSETS } from './grok-build-assets.js';
import { areHookRuntimeAssetsHealthy, restoreHookRuntimeAssets } from './hook-runtime-assets.js';

export const CODEX_SYSTEM_HOOK_ASSETS = [
  'codex-loongsuite-pilot-hook.sh', 'codex-loongsuite-pilot-hook.ps1',
  'codex-hook-processor.mjs', 'shared/decode-payload.mjs',
  'shared/error-logger.mjs', 'shared/hook-metrics.mjs',
  'shared/resource-context.mjs', 'shared/sync-file-lock.mjs', 'shared/upstream-context.mjs',
] as const;

function manifest(agentId: string): readonly string[] {
  if (agentId === 'grok-build') return GROK_BUILD_HOOK_ASSETS;
  if (agentId === 'codex') return CODEX_SYSTEM_HOOK_ASSETS;
  throw new Error(`No system hook runtime for ${agentId}`);
}

export function areSystemHookAssetsHealthy(agentId: string, pilotDir: string, dataDir: string): Promise<boolean> {
  return areHookRuntimeAssetsHealthy(pilotDir, dataDir, manifest(agentId));
}

export function restoreSystemHookAssets(agentId: string, pilotDir: string, dataDir: string): Promise<void> {
  return restoreHookRuntimeAssets(pilotDir, dataDir, manifest(agentId));
}

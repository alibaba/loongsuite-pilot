import { GROK_BUILD_HOOK_ASSETS } from './grok-build-assets.js';
import { areHookRuntimeAssetsHealthy, restoreHookRuntimeAssets } from './hook-runtime-assets.js';

function manifest(agentId: string): readonly string[] {
  if (agentId === 'grok-build') return GROK_BUILD_HOOK_ASSETS;
  throw new Error(`No system hook runtime for ${agentId}`);
}

export function areSystemHookAssetsHealthy(agentId: string, pilotDir: string, dataDir: string): Promise<boolean> {
  return areHookRuntimeAssetsHealthy(pilotDir, dataDir, manifest(agentId));
}

export function restoreSystemHookAssets(agentId: string, pilotDir: string, dataDir: string): Promise<void> {
  return restoreHookRuntimeAssets(pilotDir, dataDir, manifest(agentId));
}

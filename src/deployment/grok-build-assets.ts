import { areHookRuntimeAssetsHealthy, restoreHookRuntimeAssets } from './hook-runtime-assets.js';

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
  'shared/sync-file-lock.mjs',
  'shared/workspace-policy.mjs',
  'shared/workspace-privacy.mjs',
  'shared/qoder-db-utils.mjs',
  'shared/resource-context.mjs',
  'shared/stdin-reader.mjs',
] as const;


export function areGrokBuildHookAssetsHealthy(pilotDir: string, dataDir: string): Promise<boolean> {
  return areHookRuntimeAssetsHealthy(pilotDir, dataDir, GROK_BUILD_HOOK_ASSETS);
}
export function restoreGrokBuildHookAssets(pilotDir: string, dataDir: string): Promise<void> {
  return restoreHookRuntimeAssets(pilotDir, dataDir, GROK_BUILD_HOOK_ASSETS);
}

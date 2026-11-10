import { GROK_BUILD_HOOK_ASSETS } from './grok-build-assets.js';
import { areHookRuntimeAssetsHealthy, restoreHookRuntimeAssets } from './hook-runtime-assets.js';

export const CODEX_SYSTEM_HOOK_ASSETS = [
  'codex-loongsuite-pilot-hook.sh', 'codex-loongsuite-pilot-hook.ps1',
  'codex-hook-processor.mjs', 'shared/decode-payload.mjs',
  'shared/error-logger.mjs', 'shared/hook-metrics.mjs',
  'shared/resource-context.mjs', 'shared/sync-file-lock.mjs', 'shared/upstream-context.mjs',
] as const;

export const CLAUDE_SYSTEM_HOOK_ASSETS = [
  'claude-code-loongsuite-pilot-hook.sh', 'claude-code-loongsuite-pilot-hook.ps1',
  'claude-code-hook-processor.mjs', 'agent-event-normalizer.mjs',
  'claude-code/message-converter.mjs', 'claude-code/state.mjs',
  'claude-code/tool-context.mjs', 'claude-code/transcript-parser.mjs',
  'shared/decode-payload.mjs', 'shared/error-logger.mjs', 'shared/event-emitter.mjs',
  'shared/qoder-db-utils.mjs', 'shared/resource-context.mjs', 'shared/stdin-reader.mjs',
  'shared/sync-file-lock.mjs', 'shared/upstream-context.mjs',
  'shared/workspace-policy.mjs', 'shared/workspace-privacy.mjs',
] as const;

export const CURSOR_SYSTEM_HOOK_ASSETS = [
  'cursor-loongsuite-pilot-hook.sh', 'cursor-loongsuite-pilot-hook.ps1',
  'agent-event-normalizer.mjs', 'cursor-hook-processor.mjs',
  'cursor/event-journal.mjs', 'cursor/react-assembler.mjs',
  'cursor/skill-detector.mjs', 'cursor/source-event.mjs',
  'cursor/transcript-assembler.mjs', 'cursor/workspace-context.mjs',
  'shared/decode-payload.mjs', 'shared/qoder-db-utils.mjs',
  'shared/resource-context.mjs', 'shared/workspace-policy.mjs',
  'shared/workspace-privacy.mjs',
] as const;

function manifest(agentId: string): readonly string[] {
  if (agentId === 'grok-build') return GROK_BUILD_HOOK_ASSETS;
  if (agentId === 'codex') return CODEX_SYSTEM_HOOK_ASSETS;
  if (agentId === 'claude-code') return CLAUDE_SYSTEM_HOOK_ASSETS;
  if (agentId === 'cursor') return CURSOR_SYSTEM_HOOK_ASSETS;
  throw new Error(`No system hook runtime for ${agentId}`);
}

export function areSystemHookAssetsHealthy(agentId: string, pilotDir: string, dataDir: string): Promise<boolean> {
  return areHookRuntimeAssetsHealthy(pilotDir, dataDir, manifest(agentId));
}

export function restoreSystemHookAssets(agentId: string, pilotDir: string, dataDir: string): Promise<void> {
  return restoreHookRuntimeAssets(pilotDir, dataDir, manifest(agentId));
}

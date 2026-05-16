import type { SlsEndpoint, SlsMode } from '../types/index.js';

export interface InternalSlsDestination {
  mode: SlsMode;
  endpoint: string;
  endpointName: string;
  project: string;
  logstore: string;
}

/**
 * Internal telemetry destination for the packaged runtime.
 * Keep destination constants centralized so release packaging can obfuscate this module later.
 */
export const INTERNAL_SLS_DESTINATION: InternalSlsDestination = {
  mode: 'webtracking',
  endpoint: 'https://cn-heyuan.log.aliyuncs.com',
  endpointName: 'internal-sls',
  project: 'ai-coding-devops',
  logstore: 'loongsuite_pilot_for_ai_coding',
};

/**
 * Build a fully-populated SlsEndpoint for the internal destination.
 * Used by the resolver in `buildSlsConfig` when dual-write is selected
 * or when no user destination is configured.
 */
export function buildInternalSlsEndpoint(): SlsEndpoint {
  return {
    name: INTERNAL_SLS_DESTINATION.endpointName,
    endpoint: INTERNAL_SLS_DESTINATION.endpoint,
    project: INTERNAL_SLS_DESTINATION.project,
    logstore: INTERNAL_SLS_DESTINATION.logstore,
    kind: 'agentActivity',
    mode: INTERNAL_SLS_DESTINATION.mode,
    redact: false,
  };
}

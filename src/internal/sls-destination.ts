import type { SlsEndpoint, SlsMode } from '../types/index.js';

export interface InternalSlsDestination {
  mode: SlsMode;
  endpoint: string;
  endpointName: string;
  project: string;
  logstore: string;
}

export const INTERNAL_SLS_DESTINATION: InternalSlsDestination = {
  mode: 'webtracking',
  endpoint: 'https://cn-heyuan.log.aliyuncs.com',
  endpointName: 'internal-sls',
  project: 'ai-coding-devops',
  logstore: 'loongsuite_pilot_for_ai_coding',
};

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

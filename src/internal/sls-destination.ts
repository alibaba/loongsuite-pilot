import type { SlsMode } from '../types/index.js';

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
  endpointName: 'agent-activity',
  project: 'ai-coding-devops',
  logstore: 'loongsuite_pilot_for_ai_coding',
};

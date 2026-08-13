import { ClientType } from '../types/client-type.js';

const PI_SDK_AGENT_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

const RESERVED_PI_SDK_AGENT_IDS = new Set<string>([
  ...Object.values(ClientType),
  // Definition ids that intentionally differ from their emitted ClientType.
  'hermes-agent',
  'qoder-jetbrains',
]);

export function isValidPiSdkAgentId(id: unknown): id is string {
  return typeof id === 'string' && PI_SDK_AGENT_ID_RE.test(id);
}

export function isReservedPiSdkAgentId(id: string): boolean {
  return RESERVED_PI_SDK_AGENT_IDS.has(id);
}

export function validatePiSdkAgentId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!isValidPiSdkAgentId(id)) {
    throw new Error('agent id must be 1-64 lowercase letters, digits, dots, underscores, or hyphens');
  }
  if (isReservedPiSdkAgentId(id)) {
    throw new Error(`agent id is reserved by the built-in integration: ${id}`);
  }
  return id;
}

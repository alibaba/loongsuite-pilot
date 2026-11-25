import type { InvocationAttributes } from './invocation-attributes.mjs';
export type NativeInvocationSelector =
  | { kind: 'message'; messageId: string }
  | { kind: 'turn'; sessionId: string; turnId: string };
export interface InvocationIdentity { scope?: string; agent: string; invocationId: string; }
export interface InvocationRegistration extends InvocationIdentity { attributes: unknown; ttlMs?: number; }
export interface InvocationBinding extends InvocationIdentity { selector: NativeInvocationSelector; }
export interface InvocationResolution {
  state: 'pending'|'bound'|'noAttrs'|'timedOut'|'capacityDegraded';
  attributes: InvocationAttributes;
  invocationId?: string | null;
}
export class InvocationAttributeStoreError extends Error { code: string; constructor(code: string); }
export function invocationAttributeRoot(dataDir?: string): string;
export function isUsableInvocationId(value: unknown): value is string;
export class InvocationAttributeStore {
  constructor(options?: { root?: string; now?: () => number; maxBytes?: number; maxPending?: number });
  put(input: InvocationRegistration): 'stored' | 'unchanged';
  bind(input: InvocationBinding): 'bound' | 'unchanged' | 'sealed';
  register(input: InvocationRegistration & InvocationBinding): 'stored' | 'unchanged' | 'sealed';
  resolve(input: { agent: string; scope?: string; selector: NativeInvocationSelector; managed?: boolean; waitMs?: number; seal?: boolean }): InvocationResolution;
  prune(): void;
  close(): void;
}

export const INVOCATION_ATTRIBUTES_FIELD: 'pilot.invocation.attributes';
export type InvocationAttributes = Record<string, string | number | boolean>;
export function parseInvocationAttributes(input: unknown): InvocationAttributes;
export function projectInvocationAttributes(entry: Record<string, unknown>, input: unknown): void;

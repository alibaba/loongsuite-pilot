import type { HookRequest } from '../types.js';

export function collectHookText(request: HookRequest): string {
  return [request.prompt, request.toolName, stringifyUnknown(request.toolInput)]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n');
}

function stringifyUnknown(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

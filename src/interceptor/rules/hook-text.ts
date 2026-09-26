import type { HookRequest } from '../types.js';

const MAX_LEAF_DEPTH = 32;

export function collectHookText(request: HookRequest): string {
  return [
    request.prompt,
    request.toolName,
    ...collectTextLeaves(request.toolInput),
    ...collectTextLeaves(request.toolResponse),
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n');
}

function collectTextLeaves(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): string[] {
  if (value == null || depth > MAX_LEAF_DEPTH) return [];
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap(item => collectTextLeaves(item, seen, depth + 1));
  }
  return Object.values(value).flatMap(item => collectTextLeaves(item, seen, depth + 1));
}

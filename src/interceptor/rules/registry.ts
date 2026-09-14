import type { LocalRule } from '../types.js';

/** First-wave registry is empty; later waves register LocalRule implementations here. */
export function builtinRules(): LocalRule[] {
  return [];
}

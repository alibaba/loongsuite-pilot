import type { LocalRule } from '../types.js';
import { createSensitiveTypeRule, SENSITIVE_INTERCEPT_TYPES } from './sensitive-type.js';

/** Local rules run when interceptor mode/types enable the matching mask type. */
export function builtinRules(): LocalRule[] {
  return SENSITIVE_INTERCEPT_TYPES.map(createSensitiveTypeRule);
}

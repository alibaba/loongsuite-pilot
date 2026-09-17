import type { LocalRule } from '../types.js';
import { createSensitiveTypeRule, SENSITIVE_INTERCEPT_TYPES } from './sensitive-type.js';

/** Local rules run only when `interceptor[rule.id] === true`. */
export function builtinRules(): LocalRule[] {
  return SENSITIVE_INTERCEPT_TYPES.map(createSensitiveTypeRule);
}

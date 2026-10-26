import { findFirstSensitiveMatch } from '../../mask/detect.js';
import { loadSensitiveRules } from '../../mask/rule-loader.js';
import { SUPPORTED_INTERCEPTOR_TYPES, type InterceptorType } from '../../types/index.js';
import type { CompiledMaskRule } from '../../mask/types.js';
import type { HookRequest, LocalRule } from '../types.js';
import { collectHookText } from './hook-text.js';

export const SENSITIVE_INTERCEPT_TYPES = SUPPORTED_INTERCEPTOR_TYPES;
export type SensitiveInterceptType = InterceptorType;

const BLOCK_REASONS = {
  cloudAccessKey: '[ACCESSKEY_BLOCKED]',
  apiKey: '[APIKEY_BLOCKED]',
  privateKey: '[PRIVATEKEY_BLOCKED]',
  databaseUrl: '[DATABASEURL_BLOCKED]',
} satisfies Record<SensitiveInterceptType, string>;

function blockReasonFor(type: SensitiveInterceptType): string {
  return BLOCK_REASONS[type];
}

export function createSensitiveTypeRule(type: SensitiveInterceptType): LocalRule {
  let rules: CompiledMaskRule[] | undefined;
  return {
    id: type,
    supports(): boolean {
      return true;
    },
    async evaluate(request: HookRequest) {
      rules ??= loadSensitiveRules().filter(rule => rule.type === type);
      if (rules.length === 0) return { matched: false };
      const hit = findFirstSensitiveMatch(collectHookText(request), rules);
      return hit ? { matched: true, reason: blockReasonFor(type) } : { matched: false };
    },
  };
}

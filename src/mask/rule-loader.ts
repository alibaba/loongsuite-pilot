import { readFileSync } from 'node:fs';
import type { MaskConfig, MaskType } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import type {
  CompiledMaskRule,
  MaskRuleKind,
  SensitiveRuleDefinition,
  SensitiveRulesManifest,
} from './types.js';

const RULES_URL = new URL('./sensitive-rules.json', import.meta.url);
const logger = createLogger('MaskRuleLoader');
const SUPPORTED_RULE_KINDS = new Set<MaskRuleKind>(['regex', 'block', 'urlWithPassword']);
const SUPPORTED_MASK_TYPES = new Set<MaskType>([
  'cloudAccessKey',
  'apiKey',
  'privateKey',
  'databaseUrl',
]);

let cachedRules: CompiledMaskRule[] | undefined;

export function loadSensitiveRules(): CompiledMaskRule[] {
  if (!cachedRules) {
    try {
      const raw = readFileSync(RULES_URL, 'utf8');
      cachedRules = compileSensitiveRules(JSON.parse(raw) as SensitiveRulesManifest);
    } catch (err) {
      logger.error('failed to load sensitive rules, mask disabled', { error: String(err) });
      cachedRules = [];
    }
  }
  return cachedRules;
}

export function loadEnabledRules(config: MaskConfig): CompiledMaskRule[] {
  const enabledTypes = resolveEnabledMaskTypes(config);
  if (enabledTypes.size === 0) return [];
  return loadSensitiveRules().filter(rule => enabledTypes.has(rule.type));
}

export function filterRulesByConfig(
  rules: readonly CompiledMaskRule[],
  config: MaskConfig,
): CompiledMaskRule[] {
  const enabledTypes = resolveEnabledMaskTypes(config);
  if (enabledTypes.size === 0) return [];
  return rules.filter(rule => enabledTypes.has(rule.type));
}

export function resolveEnabledMaskTypes(config: MaskConfig): Set<MaskType> {
  if (config.mode === 'none') return new Set();
  if (config.mode === 'all') return new Set(SUPPORTED_MASK_TYPES);
  return new Set(config.types.filter(type => SUPPORTED_MASK_TYPES.has(type)));
}

export function compileSensitiveRules(manifest: SensitiveRulesManifest): CompiledMaskRule[] {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.rules)) {
    throw new Error('invalid sensitive rules manifest');
  }

  return manifest.rules.map(compileRule);
}

function compileRule(rule: SensitiveRuleDefinition): CompiledMaskRule {
  validateBaseRule(rule);

  if (rule.kind === 'regex') {
    if (!rule.pattern) throw new Error(`mask rule ${rule.id} missing pattern`);
    const flags = ensureGlobalFlag(rule.flags ?? 'g');
    try {
      return {
        ...rule,
        flags,
        regex: new RegExp(rule.pattern, flags),
        normalizedPrefilter: normalizePrefilter(rule.prefilter),
      };
    } catch (err) {
      throw new Error(`failed to compile mask rule ${rule.id}: ${String(err)}`);
    }
  }

  if (rule.kind === 'block') {
    if (!rule.beginPattern || !rule.endPattern) {
      throw new Error(`mask rule ${rule.id} missing block pattern`);
    }
    try {
      return {
        ...rule,
        blockRegex: new RegExp(`${rule.beginPattern}[\\s\\S]*?${rule.endPattern}`, 'g'),
        normalizedPrefilter: normalizePrefilter(rule.prefilter),
      };
    } catch (err) {
      throw new Error(`failed to compile mask rule ${rule.id}: ${String(err)}`);
    }
  }

  if (!Array.isArray(rule.schemes) || rule.schemes.length === 0) {
    throw new Error(`mask rule ${rule.id} missing schemes`);
  }

  return {
    ...rule,
    schemeSet: new Set(rule.schemes.map(scheme => scheme.toLowerCase())),
    normalizedPrefilter: normalizePrefilter(rule.prefilter),
  };
}

function validateBaseRule(rule: SensitiveRuleDefinition): void {
  if (!rule || typeof rule !== 'object') {
    throw new Error('invalid mask rule');
  }
  if (!rule.id || typeof rule.id !== 'string') {
    throw new Error('mask rule missing id');
  }
  if (!SUPPORTED_MASK_TYPES.has(rule.type)) {
    throw new Error(`mask rule ${rule.id} has unsupported type`);
  }
  if (!SUPPORTED_RULE_KINDS.has(rule.kind)) {
    throw new Error(`mask rule ${rule.id} has unsupported kind`);
  }
  if (!rule.replacement || typeof rule.replacement !== 'string') {
    throw new Error(`mask rule ${rule.id} missing replacement`);
  }
  if (!Array.isArray(rule.prefilter) || rule.prefilter.length === 0) {
    throw new Error(`mask rule ${rule.id} missing prefilter`);
  }
}

function ensureGlobalFlag(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`;
}

function normalizePrefilter(prefilter: string[]): string[] {
  return prefilter
    .filter(keyword => typeof keyword === 'string' && keyword.length > 0)
    .map(keyword => keyword.toLowerCase());
}

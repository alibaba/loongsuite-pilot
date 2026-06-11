import type { AgentActivityEntry, MaskConfig } from '../types/index.js';
import { shouldMaskField } from './field-whitelist.js';
import { loadEnabledRules } from './rule-loader.js';
import { maskString } from './string-masker.js';
import type { CompiledMaskRule, StringMaskOptions } from './types.js';

type JsonSafeValue =
  | string
  | number
  | boolean
  | null
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue };

const MAX_MASK_JSON_DEPTH = 32;

export function maskAgentActivityEntry(
  entry: AgentActivityEntry,
  config: MaskConfig,
  rules: readonly CompiledMaskRule[] = loadEnabledRules(config),
  options: StringMaskOptions = {},
): AgentActivityEntry {
  if (rules.length === 0) return entry;

  let maskedEntry: AgentActivityEntry | undefined;

  for (const [field, value] of Object.entries(entry)) {
    if (!shouldMaskField(field)) continue;
    const maskedValue = maskJsonSafeValue(value as JsonSafeValue, rules, options);
    if (maskedValue !== value) {
      maskedEntry ??= { ...entry };
      maskedEntry[field] = maskedValue;
    }
  }

  return maskedEntry ?? entry;
}

function maskJsonSafeValue(
  value: JsonSafeValue,
  rules: readonly CompiledMaskRule[],
  options: StringMaskOptions,
  depth = 0,
): JsonSafeValue {
  if (depth >= MAX_MASK_JSON_DEPTH) return value;

  if (typeof value === 'string') {
    return maskString(value, rules, options);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const maskedItems = value.map(item => {
      const maskedItem = maskJsonSafeValue(item, rules, options, depth + 1);
      if (maskedItem !== item) changed = true;
      return maskedItem;
    });
    return changed ? maskedItems : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const maskedObject: Record<string, JsonSafeValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const maskedChild = maskJsonSafeValue(child, rules, options, depth + 1);
      maskedObject[key] = maskedChild;
      if (maskedChild !== child) changed = true;
    }
    return changed ? maskedObject : value;
  }
  return value;
}

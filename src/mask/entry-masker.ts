import type { AgentActivityEntry, MaskConfig } from '../types/index.js';
import { shouldMaskField } from './field-whitelist.js';
import { loadMaskPlan } from './rule-loader.js';
import { maskString } from './string-masker.js';
import type {
  CompiledMaskRule,
  MaskPlan,
  StringMaskOptions,
} from './types.js';

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
  planOrRules: MaskPlan | readonly CompiledMaskRule[] = loadMaskPlan(config),
  options: StringMaskOptions = {},
): AgentActivityEntry {
  const plan = resolveMaskPlan(planOrRules);
  if (plan.rules.length === 0 && plan.piiTypes.size === 0) return entry;

  let maskedEntry: AgentActivityEntry | undefined;

  for (const [field, value] of Object.entries(entry)) {
    if (!shouldMaskField(field)) continue;
    const maskedValue = maskJsonSafeValue(value as JsonSafeValue, plan, options);
    if (maskedValue !== value) {
      maskedEntry ??= { ...entry };
      maskedEntry[field] = maskedValue;
    }
  }

  return maskedEntry ?? entry;
}

function maskJsonSafeValue(
  value: JsonSafeValue,
  plan: MaskPlan,
  options: StringMaskOptions,
  depth = 0,
): JsonSafeValue {
  if (depth >= MAX_MASK_JSON_DEPTH) return value;

  if (typeof value === 'string') {
    return maskString(value, plan, options);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const maskedItems = value.map(item => {
      const maskedItem = maskJsonSafeValue(item, plan, options, depth + 1);
      if (maskedItem !== item) changed = true;
      return maskedItem;
    });
    return changed ? maskedItems : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const maskedObject: Record<string, JsonSafeValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const maskedChild = maskJsonSafeValue(child, plan, options, depth + 1);
      maskedObject[key] = maskedChild;
      if (maskedChild !== child) changed = true;
    }
    return changed ? maskedObject : value;
  }
  return value;
}

function resolveMaskPlan(planOrRules: MaskPlan | readonly CompiledMaskRule[]): MaskPlan {
  if (Array.isArray(planOrRules)) {
    return {
      rules: planOrRules,
      piiTypes: new Set(),
    };
  }
  return planOrRules as MaskPlan;
}

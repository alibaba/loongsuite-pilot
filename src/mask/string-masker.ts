import { collectPiiRanges } from './pii-detectors.js';
import {
  collectSensitiveRanges,
  resolveStringMaskOptions,
} from './detect.js';
import type {
  CompiledMaskRule,
  MaskPlan,
  MaskRange,
  StringMaskOptions,
} from './types.js';
import { MASKED_TOKEN_PATTERN } from './types.js';

const EMPTY_PII_TYPES: MaskPlan['piiTypes'] = new Set();

export { isLargeString } from './detect.js';

export function maskString(
  value: string,
  planOrRules: MaskPlan | readonly CompiledMaskRule[],
  options: StringMaskOptions = {},
): string {
  const plan = resolveMaskPlan(planOrRules);
  if (
    value.length === 0 ||
    (plan.rules.length === 0 && plan.piiTypes.size === 0) ||
    MASKED_TOKEN_PATTERN.test(value)
  ) {
    return value;
  }

  const resolvedOptions = resolveStringMaskOptions(options);
  const ranges: MaskRange[] = [];

  if (plan.rules.length > 0) {
    ranges.push(...collectSensitiveRanges(value, plan.rules, resolvedOptions));
  }
  if (plan.piiTypes.size > 0) {
    ranges.push(...collectPiiRanges(value, plan.piiTypes));
  }

  return applyMaskRanges(value, ranges);
}

function resolveMaskPlan(planOrRules: MaskPlan | readonly CompiledMaskRule[]): MaskPlan {
  if (Array.isArray(planOrRules)) {
    return {
      rules: planOrRules,
      piiTypes: EMPTY_PII_TYPES,
    };
  }
  return planOrRules as MaskPlan;
}

export function applyMaskRanges(value: string, ranges: readonly MaskRange[]): string {
  const normalizedRanges = normalizeMaskRanges(value.length, ranges);
  if (normalizedRanges.length === 0) return value;

  // Build the output once so many matches do not repeatedly copy the whole string.
  const chunks: string[] = [];
  let cursor = 0;
  for (const range of normalizedRanges) {
    chunks.push(value.slice(cursor, range.start), range.replacement);
    cursor = range.end;
  }
  chunks.push(value.slice(cursor));
  return chunks.join('');
}

function normalizeMaskRanges(
  valueLength: number,
  ranges: readonly MaskRange[],
): MaskRange[] {
  const sorted = ranges
    .filter(range => range.start >= 0 && range.end > range.start && range.end <= valueLength)
    .sort(
      (a, b) =>
        a.start - b.start ||
        getMaskRangePriority(b) - getMaskRangePriority(a) ||
        b.end - b.start - (a.end - a.start) ||
        a.ruleId.localeCompare(b.ruleId),
    );

  const result: MaskRange[] = [];
  for (const candidate of sorted) {
    const previous = result[result.length - 1];
    if (!previous || candidate.start >= previous.end) {
      result.push({ ...candidate });
      continue;
    }

    const mergedEnd = Math.max(previous.end, candidate.end);
    if (getMaskRangePriority(candidate) > getMaskRangePriority(previous)) {
      result[result.length - 1] = {
        ...candidate,
        start: previous.start,
        end: mergedEnd,
      };
    } else if (mergedEnd !== previous.end) {
      result[result.length - 1] = {
        ...previous,
        end: mergedEnd,
      };
    }
  }
  return result;
}

function getMaskRangePriority(range: MaskRange): number {
  switch (range.type) {
    case 'idCard':
      return 30;
    case 'bankCard':
      return 20;
    case 'phone':
      return 10;
    case 'email':
    case 'ipAddress':
      return 5;
    default:
      return 100;
  }
}

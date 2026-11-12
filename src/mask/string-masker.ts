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
import {
  MASKED_PREVIEW_TOKEN_PATTERN,
  MASKED_TOKEN_PATTERN,
} from './types.js';

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
  const protectedPreviewRanges = collectMaskedPreviewRanges(value);
  const scanValue = blankProtectedPreviewRanges(value, protectedPreviewRanges);

  if (plan.rules.length > 0) {
    ranges.push(...collectSensitiveRanges(
      scanValue,
      plan.rules,
      resolvedOptions,
      plan.replacementMode,
    ));
  }
  if (plan.piiTypes.size > 0) {
    ranges.push(
      ...collectPiiRanges(scanValue, plan.piiTypes, plan.replacementMode),
    );
  }

  return applyMaskRanges(value, ranges);
}

interface ProtectedPreviewRange {
  start: number;
  end: number;
}

function collectMaskedPreviewRanges(value: string): ProtectedPreviewRange[] {
  if (!value.includes('_MASKED]{')) return [];

  const ranges: ProtectedPreviewRange[] = [];
  const pattern = new RegExp(MASKED_PREVIEW_TOKEN_PATTERN.source, 'g');
  for (const match of value.matchAll(pattern)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function blankProtectedPreviewRanges(
  value: string,
  protectedRanges: readonly ProtectedPreviewRange[],
): string {
  if (protectedRanges.length === 0) return value;

  const chunks: string[] = [];
  let cursor = 0;
  for (const range of protectedRanges) {
    chunks.push(
      value.slice(cursor, range.start),
      ' '.repeat(range.end - range.start),
    );
    cursor = range.end;
  }
  chunks.push(value.slice(cursor));
  return chunks.join('');
}

function resolveMaskPlan(planOrRules: MaskPlan | readonly CompiledMaskRule[]): MaskPlan {
  if (Array.isArray(planOrRules)) {
    return {
      rules: planOrRules,
      piiTypes: EMPTY_PII_TYPES,
      replacementMode: 'placeholder',
    };
  }
  return planOrRules as MaskPlan;
}

export function applyMaskRanges(value: string, ranges: readonly MaskRange[]): string {
  const normalizedRanges = normalizeMaskRanges(value, ranges);
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
  value: string,
  ranges: readonly MaskRange[],
): MaskRange[] {
  const sorted = ranges
    .filter(range => range.start >= 0 && range.end > range.start && range.end <= value.length)
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

    const selected = getMaskRangePriority(candidate) > getMaskRangePriority(previous)
      ? candidate
      : previous;
    const replacement = selected === candidate ||
      !isSafeMaskedIpv4Overlap(previous, candidate, value)
      ? stripMaskedPreview(selected.replacement)
      : selected.replacement;
    result[result.length - 1] = {
      ...selected,
      start: previous.start,
      end: Math.max(previous.end, candidate.end),
      // URL serialization can change raw bytes (for example @ to %40), so
      // only a known-safe masked IPv4 host may retain an overlapping preview.
      replacement,
    };
  }
  return result;
}

function isSafeMaskedIpv4Overlap(
  selected: MaskRange,
  candidate: MaskRange,
  value: string,
): boolean {
  if (selected.type !== 'databaseUrl' || candidate.type !== 'ipAddress') return false;
  const maskedIp = candidate.replacement.match(/^\[IP_ADDRESS_MASKED\]\{([^{}]+)\}$/)?.[1];
  return Boolean(
    maskedIp &&
    selected.replacement.includes(maskedIp) &&
    !selected.replacement.includes(value.slice(candidate.start, candidate.end)),
  );
}

function stripMaskedPreview(replacement: string): string {
  const previewStart = replacement.indexOf('{');
  if (previewStart < 0) return replacement;
  const marker = replacement.slice(0, previewStart);
  return MASKED_TOKEN_PATTERN.test(marker) ? marker : replacement;
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

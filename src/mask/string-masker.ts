import type {
  CompiledMaskRule,
  MaskPlan,
  MaskRange,
  ResolvedStringMaskOptions,
  StringMaskOptions,
} from './types.js';
import {
  DEFAULT_STRING_MASK_OPTIONS,
  MASKED_PREVIEW_TOKEN_PATTERN,
  MASKED_TOKEN_PATTERN,
} from './types.js';
import { collectPiiRanges } from './pii-detectors.js';
import { buildMaskReplacement } from './masked-preview.js';

const URL_CANDIDATE_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+/gi;
const EMPTY_PII_TYPES: MaskPlan['piiTypes'] = new Set();

export function isLargeString(value: string, thresholdBytes: number): boolean {
  return Buffer.byteLength(value, 'utf8') > thresholdBytes;
}

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

  if (plan.rules.length > 0) {
    const normalizedValue = value.toLowerCase();
    if (hasAnyPrefilter(normalizedValue, plan.rules)) {
      ranges.push(
        ...(isLargeString(value, resolvedOptions.largeStringThresholdBytes)
          ? collectLargeStringRanges(
              value,
              normalizedValue,
              plan.rules,
              plan.replacementMode,
              resolvedOptions,
            )
          : collectRangesForSegment(
              value,
              normalizedValue,
              0,
              plan.rules,
              plan.replacementMode,
              resolvedOptions,
            )),
      );
    }
  }
  if (plan.piiTypes.size > 0) {
    ranges.push(...collectPiiRanges(value, plan.piiTypes, plan.replacementMode));
  }

  return applyMaskRanges(
    value,
    ranges.filter(range => !overlapsProtectedPreview(range, protectedPreviewRanges)),
  );
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

function overlapsProtectedPreview(
  range: MaskRange,
  protectedRanges: readonly ProtectedPreviewRange[],
): boolean {
  let low = 0;
  let high = protectedRanges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (protectedRanges[middle].end <= range.start) low = middle + 1;
    else high = middle;
  }
  return low < protectedRanges.length && protectedRanges[low].start < range.end;
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

function resolveStringMaskOptions(options: StringMaskOptions): ResolvedStringMaskOptions {
  return {
    largeStringThresholdBytes:
      options.largeStringThresholdBytes ?? DEFAULT_STRING_MASK_OPTIONS.largeStringThresholdBytes,
    keywordContextWindow:
      options.keywordContextWindow ?? DEFAULT_STRING_MASK_OPTIONS.keywordContextWindow,
    privateKeyBlockLimit:
      options.privateKeyBlockLimit ?? DEFAULT_STRING_MASK_OPTIONS.privateKeyBlockLimit,
  };
}

function hasAnyPrefilter(
  normalizedValue: string,
  rules: readonly CompiledMaskRule[],
): boolean {
  for (const rule of rules) {
    if (ruleHasPrefilter(normalizedValue, rule)) return true;
  }
  return false;
}

function ruleHasPrefilter(normalizedValue: string, rule: CompiledMaskRule): boolean {
  return rule.normalizedPrefilter.some(keyword => normalizedValue.includes(keyword));
}

function collectLargeStringRanges(
  value: string,
  normalizedValue: string,
  rules: readonly CompiledMaskRule[],
  replacementMode: MaskPlan['replacementMode'],
  options: ResolvedStringMaskOptions,
): MaskRange[] {
  const windows = buildKeywordWindows(normalizedValue, rules, options.keywordContextWindow);
  if (windows.length === 0) return [];

  const ranges: MaskRange[] = [];
  for (const window of windows) {
    const segment = value.slice(window.start, window.end);
    const normalizedSegment = normalizedValue.slice(window.start, window.end);
    ranges.push(
      ...collectRangesForSegment(
        segment,
        normalizedSegment,
        window.start,
        rules,
        replacementMode,
        options,
      ),
    );
  }
  return ranges;
}

function buildKeywordWindows(
  normalizedValue: string,
  rules: readonly CompiledMaskRule[],
  contextWindow: number,
): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  const seenKeywords = new Set<string>();

  for (const rule of rules) {
    for (const keyword of rule.normalizedPrefilter) {
      if (seenKeywords.has(keyword)) continue;
      seenKeywords.add(keyword);

      let fromIndex = 0;
      while (fromIndex < normalizedValue.length) {
        const index = normalizedValue.indexOf(keyword, fromIndex);
        if (index === -1) break;
        windows.push({
          start: Math.max(0, index - contextWindow),
          end: Math.min(normalizedValue.length, index + keyword.length + contextWindow),
        });
        fromIndex = index + Math.max(keyword.length, 1);
      }
    }
  }

  if (windows.length <= 1) return windows;

  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.start <= previous.end) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function collectRangesForSegment(
  segment: string,
  normalizedSegment: string,
  offset: number,
  rules: readonly CompiledMaskRule[],
  replacementMode: MaskPlan['replacementMode'],
  options: ResolvedStringMaskOptions,
): MaskRange[] {
  const ranges: MaskRange[] = [];
  for (const rule of rules) {
    if (!ruleHasPrefilter(normalizedSegment, rule)) continue;

    if (rule.kind === 'regex' && rule.regex) {
      ranges.push(...collectRegexRanges(segment, offset, rule, replacementMode));
    } else if (rule.kind === 'block' && rule.blockRegex) {
      ranges.push(
        ...collectBlockRanges(
          segment,
          offset,
          rule,
          replacementMode,
          options.privateKeyBlockLimit,
        ),
      );
    } else if (rule.kind === 'urlWithPassword' && rule.schemeSet) {
      ranges.push(
        ...collectUrlWithPasswordRanges(segment, offset, rule, replacementMode),
      );
    }
  }
  return ranges;
}

function collectRegexRanges(
  segment: string,
  offset: number,
  rule: CompiledMaskRule,
  replacementMode: MaskPlan['replacementMode'],
): MaskRange[] {
  const ranges: MaskRange[] = [];
  const regex = rule.regex!;
  regex.lastIndex = 0;

  for (const match of segment.matchAll(regex)) {
    if (match.index === undefined || match[0].length === 0) continue;
    ranges.push({
      start: offset + match.index,
      end: offset + match.index + match[0].length,
      replacement: buildMaskReplacement(
        rule.replacement,
        rule.type,
        match[0],
        replacementMode,
      ),
      ruleId: rule.id,
      type: rule.type,
    });
  }
  regex.lastIndex = 0;
  return ranges;
}

function collectBlockRanges(
  segment: string,
  offset: number,
  rule: CompiledMaskRule,
  replacementMode: MaskPlan['replacementMode'],
  blockLimit: number,
): MaskRange[] {
  const ranges: MaskRange[] = [];
  const regex = rule.blockRegex!;
  regex.lastIndex = 0;

  for (const match of segment.matchAll(regex)) {
    if (match.index === undefined || match[0].length === 0) continue;
    if (Buffer.byteLength(match[0], 'utf8') > blockLimit) continue;
    ranges.push({
      start: offset + match.index,
      end: offset + match.index + match[0].length,
      replacement: buildMaskReplacement(
        rule.replacement,
        rule.type,
        match[0],
        replacementMode,
      ),
      ruleId: rule.id,
      type: rule.type,
    });
  }
  regex.lastIndex = 0;
  return ranges;
}

function collectUrlWithPasswordRanges(
  segment: string,
  offset: number,
  rule: CompiledMaskRule,
  replacementMode: MaskPlan['replacementMode'],
): MaskRange[] {
  const ranges: MaskRange[] = [];
  URL_CANDIDATE_PATTERN.lastIndex = 0;

  for (const match of segment.matchAll(URL_CANDIDATE_PATTERN)) {
    if (match.index === undefined || match[0].length === 0) continue;
    const candidate = trimUrlCandidate(match[0]);
    if (!candidate || !isDatabaseUrlWithPassword(candidate, rule)) continue;
    ranges.push({
      start: offset + match.index,
      end: offset + match.index + candidate.length,
      replacement: buildMaskReplacement(
        rule.replacement,
        rule.type,
        candidate,
        replacementMode,
      ),
      ruleId: rule.id,
      type: rule.type,
    });
  }
  URL_CANDIDATE_PATTERN.lastIndex = 0;
  return ranges;
}

function trimUrlCandidate(candidate: string): string {
  return candidate.replace(/[),.;\]}]+$/g, '');
}

function isDatabaseUrlWithPassword(candidate: string, rule: CompiledMaskRule): boolean {
  try {
    const parsed = new URL(candidate);
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    if (!rule.schemeSet?.has(scheme)) return false;
    return parsed.password.length > 0;
  } catch {
    return false;
  }
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

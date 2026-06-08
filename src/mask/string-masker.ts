import type {
  CompiledMaskRule,
  MaskRange,
  ResolvedStringMaskOptions,
  StringMaskOptions,
} from './types.js';
import {
  DEFAULT_STRING_MASK_OPTIONS,
  MASKED_TOKEN_PATTERN,
} from './types.js';

const URL_CANDIDATE_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+/gi;

export function isLargeString(value: string, thresholdBytes: number): boolean {
  return Buffer.byteLength(value, 'utf8') > thresholdBytes;
}

export function maskString(
  value: string,
  rules: readonly CompiledMaskRule[],
  options: StringMaskOptions = {},
): string {
  if (value.length === 0 || rules.length === 0 || MASKED_TOKEN_PATTERN.test(value)) {
    return value;
  }

  const resolvedOptions = resolveStringMaskOptions(options);
  const normalizedValue = value.toLowerCase();
  if (!hasAnyPrefilter(normalizedValue, rules)) return value;

  const ranges = isLargeString(value, resolvedOptions.largeStringThresholdBytes)
    ? collectLargeStringRanges(value, normalizedValue, rules, resolvedOptions)
    : collectRangesForSegment(value, normalizedValue, 0, rules, resolvedOptions);

  return applyMaskRanges(value, ranges);
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
  options: ResolvedStringMaskOptions,
): MaskRange[] {
  const windows = buildKeywordWindows(normalizedValue, rules, options.keywordContextWindow);
  if (windows.length === 0) return [];

  const ranges: MaskRange[] = [];
  for (const window of windows) {
    const segment = value.slice(window.start, window.end);
    const normalizedSegment = normalizedValue.slice(window.start, window.end);
    ranges.push(
      ...collectRangesForSegment(segment, normalizedSegment, window.start, rules, options),
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
  options: ResolvedStringMaskOptions,
): MaskRange[] {
  const ranges: MaskRange[] = [];
  for (const rule of rules) {
    if (!ruleHasPrefilter(normalizedSegment, rule)) continue;

    if (rule.kind === 'regex' && rule.regex) {
      ranges.push(...collectRegexRanges(segment, offset, rule));
    } else if (rule.kind === 'block' && rule.blockRegex) {
      ranges.push(...collectBlockRanges(segment, offset, rule, options.privateKeyBlockLimit));
    } else if (rule.kind === 'urlWithPassword' && rule.schemeSet) {
      ranges.push(...collectUrlWithPasswordRanges(segment, offset, rule));
    }
  }
  return ranges;
}

function collectRegexRanges(
  segment: string,
  offset: number,
  rule: CompiledMaskRule,
): MaskRange[] {
  const ranges: MaskRange[] = [];
  const regex = rule.regex!;
  regex.lastIndex = 0;

  for (const match of segment.matchAll(regex)) {
    if (match.index === undefined || match[0].length === 0) continue;
    ranges.push({
      start: offset + match.index,
      end: offset + match.index + match[0].length,
      replacement: rule.replacement,
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
      replacement: rule.replacement,
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
      replacement: rule.replacement,
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

  let result = value;
  for (let i = normalizedRanges.length - 1; i >= 0; i--) {
    const range = normalizedRanges[i];
    result = `${result.slice(0, range.start)}${range.replacement}${result.slice(range.end)}`;
  }
  return result;
}

function normalizeMaskRanges(
  valueLength: number,
  ranges: readonly MaskRange[],
): MaskRange[] {
  const sorted = ranges
    .filter(range => range.start >= 0 && range.end > range.start && range.end <= valueLength)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const result: MaskRange[] = [];
  let lastEnd = -1;
  for (const range of sorted) {
    if (range.start < lastEnd) continue;
    result.push(range);
    lastEnd = range.end;
  }
  return result;
}

import { buildMaskReplacement } from './masked-preview.js';
import type {
  CompiledMaskRule,
  MaskPlan,
  MaskRange,
  ResolvedStringMaskOptions,
  StringMaskOptions,
} from './types.js';
import {
  DEFAULT_STRING_MASK_OPTIONS,
  MASKED_TOKEN_PATTERN,
} from './types.js';

const URL_CANDIDATE_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+/gi;
const ACCESS_KEY_SECRET_LOOKAHEAD_CHARS = 1024;
const ACCESS_KEY_SECRET_MIN_LENGTH = 20;
const ACCESS_KEY_SECRET_MAX_LENGTH = 60;
const ACCESS_KEY_SECRET_REPLACEMENT = '[ACCESSKEY_SECRET_MASKED]';
const ACCESS_KEY_SECRET_RULE_ID = 'cloudAccessKey.secret.nearId';
const STICKY_REGEX_CACHE = new WeakMap<RegExp, RegExp>();

export function isLargeString(value: string, thresholdBytes: number): boolean {
  return Buffer.byteLength(value, 'utf8') > thresholdBytes;
}

export function resolveStringMaskOptions(options: StringMaskOptions = {}): ResolvedStringMaskOptions {
  return {
    largeStringThresholdBytes:
      options.largeStringThresholdBytes ?? DEFAULT_STRING_MASK_OPTIONS.largeStringThresholdBytes,
    keywordContextWindow:
      options.keywordContextWindow ?? DEFAULT_STRING_MASK_OPTIONS.keywordContextWindow,
    privateKeyBlockLimit:
      options.privateKeyBlockLimit ?? DEFAULT_STRING_MASK_OPTIONS.privateKeyBlockLimit,
  };
}

export function collectSensitiveRanges(
  value: string,
  rules: readonly CompiledMaskRule[],
  options: StringMaskOptions = {},
  replacementMode: MaskPlan['replacementMode'] = 'placeholder',
): MaskRange[] {
  if (value.length === 0 || rules.length === 0 || MASKED_TOKEN_PATTERN.test(value)) {
    return [];
  }

  const resolvedOptions = resolveStringMaskOptions(options);
  const normalizedValue = value.toLowerCase();
  if (!hasAnyPrefilter(normalizedValue, rules)) return [];

  const accessKeyRules = rules.filter(rule => rule.type === 'cloudAccessKey');
  const otherRules = rules.filter(rule => rule.type !== 'cloudAccessKey');
  const ranges = isLargeString(value, resolvedOptions.largeStringThresholdBytes)
    ? collectLargeStringRanges(value, normalizedValue, otherRules, replacementMode, resolvedOptions)
    : collectRangesForSegment(value, normalizedValue, 0, otherRules, replacementMode, resolvedOptions);

  if (accessKeyRules.length > 0 && hasAnyPrefilter(normalizedValue, accessKeyRules)) {
    ranges.push(...collectCloudAccessKeyRanges(value, normalizedValue, accessKeyRules, replacementMode));
  }
  return ranges;
}

interface AccessKeyAnchor {
  start: number;
  end: number;
  rule: CompiledMaskRule;
}

function collectCloudAccessKeyRanges(
  value: string,
  normalizedValue: string,
  rules: readonly CompiledMaskRule[],
  replacementMode: MaskPlan['replacementMode'],
): MaskRange[] {
  const anchors: AccessKeyAnchor[] = [];
  const ranges: MaskRange[] = [];
  const seenAnchors = new Set<string>();

  for (const rule of rules) {
    if (rule.kind !== 'regex' || !rule.regex || !ruleHasPrefilter(normalizedValue, rule)) {
      continue;
    }

    const stickyRegex = getStickyRegex(rule.regex);
    for (const keyword of rule.prefilter) {
      let fromIndex = 0;
      while (fromIndex < value.length) {
        const keywordIndex = value.indexOf(keyword, fromIndex);
        if (keywordIndex === -1) break;

        stickyRegex.lastIndex = keywordIndex;
        const match = stickyRegex.exec(value);
        if (!match || match.index !== keywordIndex || match[0].length === 0) {
          fromIndex = keywordIndex + Math.max(keyword.length, 1);
          continue;
        }

        const start = match.index;
        const end = start + match[0].length;
        const anchorKey = `${start}:${end}`;
        if (!seenAnchors.has(anchorKey)) {
          seenAnchors.add(anchorKey);
          anchors.push({ start, end, rule });
          ranges.push({
            start,
            end,
            replacement: buildMaskReplacement(rule.replacement, rule.type, match[0], replacementMode),
            ruleId: rule.id,
            type: rule.type,
          });
        }
        fromIndex = end;
      }
    }
  }

  anchors.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]!;
    const nextAnchorStart = anchors[index + 1]?.start ?? value.length;
    const searchStart = anchor.end;
    const searchEnd = Math.min(
      value.length,
      searchStart + ACCESS_KEY_SECRET_LOOKAHEAD_CHARS,
      nextAnchorStart,
    );
    if (searchStart < searchEnd) {
      ranges.push(...scanAccessKeySecretCandidates(
        value,
        searchStart,
        searchEnd,
        anchor.rule.type,
        replacementMode,
        searchEnd === nextAnchorStart && nextAnchorStart < value.length,
      ));
    }
  }

  return ranges;
}

function getStickyRegex(regex: RegExp): RegExp {
  let stickyRegex = STICKY_REGEX_CACHE.get(regex);
  if (!stickyRegex) {
    stickyRegex = new RegExp(regex.source, `${regex.flags.replace(/[gy]/g, '')}y`);
    STICKY_REGEX_CACHE.set(regex, stickyRegex);
  }
  return stickyRegex;
}

function scanAccessKeySecretCandidates(
  value: string,
  start: number,
  end: number,
  type: MaskRange['type'],
  replacementMode: MaskPlan['replacementMode'],
  stopAtKnownAnchor: boolean,
): MaskRange[] {
  const ranges: MaskRange[] = [];
  let tokenStart = -1;
  let tokenEnd = -1;
  let tokenLength = 0;
  let paddingLength = 0;
  let invalid = false;
  let hasUppercase = false;
  let hasLowercase = false;
  let hasDigit = false;
  // The scan starts at the boundary after a validated AccessKey ID. Allowed Secret
  // characters such as '/', '+', and '-' may begin the candidate at that boundary.
  let canStartToken = true;

  const resetToken = (): void => {
    tokenStart = -1;
    tokenEnd = -1;
    tokenLength = 0;
    paddingLength = 0;
    invalid = false;
    hasUppercase = false;
    hasLowercase = false;
    hasDigit = false;
  };

  const finishToken = (includePadding: boolean): void => {
    const actualPaddingLength = includePadding && paddingLength <= 2 ? paddingLength : 0;
    const candidateLength = tokenLength + actualPaddingLength;
    if (
      tokenStart >= 0 &&
      !invalid &&
      paddingLength <= 2 &&
      candidateLength >= ACCESS_KEY_SECRET_MIN_LENGTH &&
      candidateLength <= ACCESS_KEY_SECRET_MAX_LENGTH &&
      hasUppercase &&
      hasLowercase &&
      hasDigit
    ) {
      const candidateEnd = tokenEnd + actualPaddingLength;
      ranges.push({
        start: tokenStart,
        end: candidateEnd,
        replacement: replacementMode === 'preview'
          ? buildMaskReplacement(
            ACCESS_KEY_SECRET_REPLACEMENT,
            type,
            value.slice(tokenStart, candidateEnd),
            replacementMode,
          )
          : ACCESS_KEY_SECRET_REPLACEMENT,
        ruleId: ACCESS_KEY_SECRET_RULE_ID,
        type,
      });
    }
    resetToken();
  };

  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if (isAccessKeySecretBodyChar(code)) {
      if (tokenStart >= 0 && paddingLength > 0) {
        // An equals sign followed by more key characters was a separator, not padding.
        finishToken(false);
        canStartToken = true;
      }
      if (tokenStart < 0) {
        if (!canStartToken) continue;
        tokenStart = index;
      }
      tokenLength += 1;
      tokenEnd = index + 1;
      if (tokenLength > ACCESS_KEY_SECRET_MAX_LENGTH) invalid = true;
      if (code >= 65 && code <= 90) hasUppercase = true;
      else if (code >= 97 && code <= 122) hasLowercase = true;
      else if (code >= 48 && code <= 57) hasDigit = true;
      canStartToken = false;
      continue;
    }

    if (code === 61) {
      if (tokenStart >= 0) {
        paddingLength += 1;
        if (paddingLength > 2) invalid = true;
        canStartToken = false;
      } else {
        canStartToken = true;
      }
      continue;
    }

    if (tokenStart >= 0) finishToken(true);
    canStartToken = true;
  }

  const nextCode = end < value.length ? value.charCodeAt(end) : -1;
  const tokenContinuesPastWindow =
    isAccessKeySecretBodyChar(nextCode) || nextCode === 61;
  if ((stopAtKnownAnchor || !tokenContinuesPastWindow) && tokenStart >= 0) finishToken(true);
  return ranges;
}

function isAccessKeySecretBodyChar(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 45 ||
    code === 47 ||
    code === 95
  );
}

export function findFirstSensitiveMatch(
  value: string,
  rules: readonly CompiledMaskRule[],
  options: StringMaskOptions = {},
): MaskRange | undefined {
  const ranges = collectSensitiveRanges(value, rules, options);
  if (ranges.length === 0) return undefined;

  let first = ranges[0]!;
  for (const range of ranges) {
    if (range.start < first.start || (range.start === first.start && range.end > first.end)) {
      first = range;
    }
  }
  return first;
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
      ...collectRangesForSegment(segment, normalizedSegment, window.start, rules, replacementMode, options),
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
      ranges.push(...collectBlockRanges(segment, offset, rule, replacementMode, options.privateKeyBlockLimit));
    } else if (rule.kind === 'urlWithPassword' && rule.schemeSet) {
      ranges.push(...collectUrlWithPasswordRanges(segment, offset, rule, replacementMode));
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
      replacement: buildMaskReplacement(rule.replacement, rule.type, match[0], replacementMode),
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
      replacement: buildMaskReplacement(rule.replacement, rule.type, match[0], replacementMode),
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
      replacement: buildMaskReplacement(rule.replacement, rule.type, candidate, replacementMode),
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

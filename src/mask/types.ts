import type { MaskType } from '../types/index.js';

export type MaskRuleKind = 'regex' | 'block' | 'urlWithPassword';

export interface SensitiveRulesManifest {
  version: 1;
  rules: SensitiveRuleDefinition[];
}

export interface SensitiveRuleDefinition {
  id: string;
  type: MaskType;
  kind: MaskRuleKind;
  replacement: string;
  prefilter: string[];
  pattern?: string;
  flags?: string;
  beginPattern?: string;
  endPattern?: string;
  schemes?: string[];
}

export interface CompiledMaskRule extends SensitiveRuleDefinition {
  regex?: RegExp;
  blockRegex?: RegExp;
  schemeSet?: Set<string>;
  normalizedPrefilter: string[];
}

export interface MaskRange {
  start: number;
  end: number;
  replacement: string;
  ruleId: string;
  type: MaskType;
}

export interface StringMaskOptions {
  largeStringThresholdBytes?: number;
  keywordContextWindow?: number;
  privateKeyBlockLimit?: number;
}

export interface ResolvedStringMaskOptions {
  largeStringThresholdBytes: number;
  keywordContextWindow: number;
  privateKeyBlockLimit: number;
}

export const DEFAULT_STRING_MASK_OPTIONS: ResolvedStringMaskOptions = {
  largeStringThresholdBytes: 64 * 1024,
  keywordContextWindow: 8 * 1024,
  privateKeyBlockLimit: 64 * 1024,
};

export const MASKED_TOKEN_PATTERN =
  /^\[(?:ACCESSKEY|APIKEY|PRIVATEKEY|DATABASEURL)_MASKED\]$/;

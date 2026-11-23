/**
 * Model ID / display name normalization and provider inference for Antigravity.
 * Aligns with ccusage's Antigravity adapter naming table while handling newer
 * models (e.g. Gemini 4 Neon) generically.
 */

export const DEFAULT_ANTIGRAVITY_MODEL = 'gemini-internal-model';
const UNRESOLVED_PLACEHOLDER_PREFIX = 'model_placeholder_m';
const UNRESOLVED_ID_PREFIX = 'antigravity-model-';

const MODEL_ID_MAP: Readonly<Record<number, string>> = {
  246: 'gemini-2.5-pro',
  312: 'gemini-2.5-flash',
  313: 'gemini-2.5-flash-thinking',
  329: 'gemini-2.5-flash-thinking',
  330: 'gemini-2.5-flash-lite',
  281: 'claude-4-sonnet',
  282: 'claude-4-sonnet',
  290: 'claude-4-opus',
  291: 'claude-4-opus',
  333: 'claude-4.5-sonnet',
  334: 'claude-4.5-sonnet',
  340: 'claude-4.5-haiku',
  341: 'claude-4.5-haiku',
  342: 'model_openai_gpt_oss_120b_medium',
  1050: 'gemini-3.1-flash-lite',
  1071: 'gemini-3.6-flash-high',
  1072: 'gemini-3.6-flash-medium',
  1073: 'gemini-3.6-flash-low',
  1298: 'gemini-3.7-flash-high',
  1299: 'gemini-3.7-flash-medium',
  1300: 'gemini-3.7-flash-low',
  1318: 'gemini-3.8-flash-high',
  1319: 'gemini-3.8-flash-medium',
  1320: 'gemini-3.8-flash-low',
  1402: 'claude-opus-5-5',
  1417: 'gemini-4-argon',
  1418: 'gemini-4-argon',
  1419: 'gemini-4-argon',
};

const EXACT_ALIAS_MAP: Readonly<Record<string, string>> = {
  'gemini 3.8 flash (high)': 'gemini-3.8-flash-high',
  'gemini 3.8 flash (medium)': 'gemini-3.8-flash-medium',
  'gemini 3.8 flash (low)': 'gemini-3.8-flash-low',
  'gemini 3.7 flash (high)': 'gemini-3.7-flash-high',
  'gemini 3.7 flash (medium)': 'gemini-3.7-flash-medium',
  'gemini 3.7 flash (low)': 'gemini-3.7-flash-low',
  'gemini 3.6 flash (high)': 'gemini-3.6-flash-high',
  'gemini 3.6 flash (medium)': 'gemini-3.6-flash-medium',
  'gemini 3.6 flash (low)': 'gemini-3.6-flash-low',
};

const BASE_ALIAS_MAP: Readonly<Record<string, string>> = {
  'gemini 3.8 flash': 'gemini-3.8-flash',
  'gemini 3.8 flash thinking': 'gemini-3.8-flash',
  'gemini 3.7 flash': 'gemini-3.7-flash',
  'gemini 3.7 flash thinking': 'gemini-3.7-flash',
  'gemini 3.7 pro': 'gemini-3.7-pro',
  'gemini 3.7 pro thinking': 'gemini-3.7-pro',
  'gemini 3.6 flash': 'gemini-3.6-flash',
  'gemini 3 flash': 'gemini-3.6-flash',
  'gemini 3.6 pro': 'gemini-3.6-pro',
  'gemini 3 pro': 'gemini-3-pro',
  'gemini 3 pro thinking': 'gemini-3-pro',
  'gemini 2.5 flash': 'gemini-2.5-flash',
  'gemini 2.5 pro': 'gemini-2.5-pro',
  'gemini 2.0 flash': 'gemini-2.0-flash',
  'gemini 2 flash': 'gemini-2.0-flash',
  'gemini 2.0 pro': 'gemini-2.0-pro',
  'gemini 1.5 flash': 'gemini-1.5-flash',
  'gemini 1.5 pro': 'gemini-1.5-pro',
  'model_placeholder_m318': 'gemini-3.8-flash-high',
  'model_placeholder_m319': 'gemini-3.8-flash-medium',
  'model_placeholder_m320': 'gemini-3.8-flash-low',
  'model_placeholder_m298': 'gemini-3.7-flash-high',
  'model_placeholder_m299': 'gemini-3.7-flash-medium',
  'model_placeholder_m300': 'gemini-3.7-flash-low',
  'model_placeholder_m71': 'gemini-3.6-flash-high',
  'model_placeholder_m72': 'gemini-3.6-flash-medium',
  'model_placeholder_m73': 'gemini-3.6-flash-low',
  'model_placeholder_m417': 'gemini-4-argon',
  'model_placeholder_m418': 'gemini-4-argon',
  'model_placeholder_m419': 'gemini-4-argon',
  'model_placeholder_m402': 'claude-opus-5-5',
  'model_placeholder_m50': 'gemini-3.1-flash-lite',
  'model_placeholder_m26': 'claude-opus-4-6',
  'model_placeholder_m35': 'claude-sonnet-4-6',
  'model_placeholder_m36': 'gemini-3.1-pro',
  'model_placeholder_m37': 'gemini-3.1-pro',
  'model_placeholder_m16': 'gemini-3.1-pro',
  'model_placeholder_m18': 'gemini-3-flash-preview',
  'model_placeholder_m84': 'gemini-3-flash-preview',
  'model_placeholder_m47': 'gemini-3-flash-preview',
  'model_placeholder_m132': 'gemini-3.5-flash-high',
  'model_placeholder_m133': 'gemini-3.5-flash-high',
  'model_placeholder_m187': 'gemini-3.5-flash-extra-low',
  'model_placeholder_m20': 'gemini-3.5-flash-medium',
  'model_openai_gpt_oss_120b_medium': 'gpt-oss-120b-medium',
  'gemini-pro-default': 'gemini-3.1-pro',
  'gemini-pro-agent': 'gemini-3.1-pro',
  'gemini-3-flash-agent': 'gemini-3.5-flash-high',
  'gemini-3-flash-agent-a': 'gemini-3.5-flash-high',
  'gemini-3-flash-agent-b': 'gemini-3.5-flash-high',
  'gemini-3-flash-a': 'gemini-3.5-flash-high',
  'gemini-3-flash-b': 'gemini-3.5-flash-high',
  'gemini-3-flash-c': 'gemini-3-flash-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3.5-flash-low': 'gemini-3.5-flash-medium',
  'gemini-3.1-pro-high': 'gemini-3.1-pro',
  'gemini-3.1-pro-low': 'gemini-3.1-pro',
  'gemini-3-pro-high': 'gemini-3-pro',
  'gemini-3-pro-low': 'gemini-3-pro',
  'claude 3.7 sonnet': 'claude-3-7-sonnet',
  'claude 3.7 sonnet thinking': 'claude-3-7-sonnet',
  'claude 3.5 sonnet': 'claude-3-5-sonnet',
  'claude 3.5 haiku': 'claude-3-5-haiku',
  'claude 3 opus': 'claude-3-opus',
};

export function modelNameFromId(modelId: number): string {
  const mapped = MODEL_ID_MAP[modelId];
  if (mapped) return mapped;
  if (modelId >= 1000) {
    return `${UNRESOLVED_PLACEHOLDER_PREFIX}${modelId - 1000}`;
  }
  return `${UNRESOLVED_ID_PREFIX}${modelId}`;
}

/** 0 = default, 1 = unresolved placeholder/id, 2 = resolved model name. */
export function modelResolutionRank(model: string): number {
  if (!model || model === DEFAULT_ANTIGRAVITY_MODEL) return 0;
  if (model.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX) || model.startsWith(UNRESOLVED_ID_PREFIX)) {
    return 1;
  }
  return 2;
}

export function isResolvedModel(model: string): boolean {
  return modelResolutionRank(model) === 2;
}

export function normalizeAntigravityModel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 120) return undefined;
  // Reject non-printable corrupted strings
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return undefined;

  const lower = trimmed.toLowerCase();
  const exact = EXACT_ALIAS_MAP[lower];
  if (exact) return exact;

  // Generic effort parentheticals like "Gemini 4 Neon (Medium)" -> "gemini-4-neon-medium"
  const effortMatch = lower.match(/^(.+?)\s*\((high|medium|low|extra[- ]low|minimal)\)$/);
  if (effortMatch) {
    const basePart = effortMatch[1]!.trim();
    const effortPart = effortMatch[2]!.replace(/\s+/g, '-');
    const convertedBase = (BASE_ALIAS_MAP[basePart] ?? basePart).replace(/\s+/g, '-');
    if (
      convertedBase.startsWith('gemini-') ||
      convertedBase.startsWith('claude-') ||
      convertedBase.startsWith('gpt-')
    ) {
      return `${convertedBase}-${effortPart}`;
    }
  }

  const parenIdx = lower.indexOf('(');
  const base = parenIdx >= 0 ? lower.slice(0, parenIdx).trim() : lower;
  const mapped = BASE_ALIAS_MAP[base];
  if (mapped) return mapped;

  const converted = base.replace(/\s+/g, '-');
  if (
    converted.startsWith('gemini-') ||
    converted.startsWith('claude-') ||
    converted.startsWith('gpt-')
  ) {
    return converted;
  }
  return trimmed;
}

export function resolveAntigravityProvider(model?: string, providerId?: number): string {
  const lower = (model ?? '').toLowerCase();
  if (/claude|anthropic/.test(lower)) return 'anthropic';
  if (/gpt|openai/.test(lower)) return 'openai';
  if (/gemini/.test(lower)) return 'gcp.gemini';
  // API_PROVIDER_GOOGLE_VERTEX = 3, GOOGLE_GEMINI = 24, GOOGLE_EVERGREEN = 30
  if (providerId === 3 || providerId === 24 || providerId === 30) return 'gcp.gemini';
  return 'gcp.gemini';
}

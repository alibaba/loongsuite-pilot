import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { configJsonPath } from '../utils/data-dir.js';
import {
  SUPPORTED_INTERCEPTOR_TYPES,
  type InterceptorConfig,
  type InterceptorType,
  type MaskConfig,
  type MaskType,
} from '../types/index.js';

const SUPPORTED_INTERCEPTOR_TYPE_SET = new Set<string>(SUPPORTED_INTERCEPTOR_TYPES);

function env(key: string): string | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const normalized = v.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseInterceptorTypes(value: string | string[] | undefined): InterceptorType[] {
  const rawTypes = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return rawTypes
    .map(type => type.trim())
    .filter((type): type is InterceptorType => SUPPORTED_INTERCEPTOR_TYPE_SET.has(type));
}

function asTypesInput(value: unknown): string | string[] | undefined {
  if (Array.isArray(value)) return value.filter((type): type is string => typeof type === 'string');
  if (typeof value === 'string') return value;
  return undefined;
}

export function buildInterceptorConfig(value: unknown): InterceptorConfig {
  const file = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { mode?: unknown; types?: unknown }
    : null;
  const mode = env('LOONGSUITE_PILOT_INTERCEPTOR_MODE') ?? (typeof file?.mode === 'string' ? file.mode : undefined);
  if (mode !== 'all' && mode !== 'custom' && mode !== 'none') {
    return { mode: 'none', types: [] };
  }

  if (mode === 'all' || mode === 'none') {
    return { mode, types: [] };
  }

  const types = parseInterceptorTypes(
    env('LOONGSUITE_PILOT_INTERCEPTOR_TYPES') ?? asTypesInput(file?.types),
  );

  return { mode: 'custom', types };
}

/**
 * Credential types enabled for interception are also mask types. Installer
 * writes this union into config.json; runtime config (env overrides and
 * hand-edited files) has to apply the same rule or mask mode none would
 * leave interceptor matches in the clear.
 */
export function ensureMaskCoversInterceptor(mask: MaskConfig, interceptor: InterceptorConfig): MaskConfig {
  const extra: MaskType[] = interceptor.mode === 'all'
    ? [...SUPPORTED_INTERCEPTOR_TYPES]
    : interceptor.mode === 'custom'
      ? interceptor.types.filter((type): type is InterceptorType => SUPPORTED_INTERCEPTOR_TYPE_SET.has(type))
      : [];
  if (extra.length === 0 || mask.mode === 'all') return mask;
  const current = mask.mode === 'custom' ? mask.types : [];
  const types: MaskType[] = [];
  const seen = new Set<string>();
  for (const type of [...current, ...extra]) {
    if (seen.has(type)) continue;
    seen.add(type);
    types.push(type);
  }
  return { ...mask, mode: 'custom', types };
}

export function resolveEnabledInterceptorTypes(config: InterceptorConfig): Set<InterceptorType> {
  if (config.mode === 'none') return new Set();
  if (config.mode === 'all') return new Set(SUPPORTED_INTERCEPTOR_TYPES);
  return new Set(config.types.filter((type): type is InterceptorType => SUPPORTED_INTERCEPTOR_TYPE_SET.has(type)));
}

export function isRuleEnabled(config: InterceptorConfig, ruleId: string): boolean {
  return resolveEnabledInterceptorTypes(config).has(ruleId as InterceptorType);
}

export async function loadInterceptorConfig(configPath?: string): Promise<InterceptorConfig> {
  const file = await readJsonFile<{ interceptor?: unknown }>(
    configPath ?? resolveHome(configJsonPath()),
  );
  return buildInterceptorConfig(file?.interceptor);
}

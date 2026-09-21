import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { configJsonPath } from '../utils/data-dir.js';
import {
  SUPPORTED_INTERCEPTOR_TYPES,
  type InterceptorConfig,
  type InterceptorType,
} from '../types/index.js';

const SUPPORTED_INTERCEPTOR_TYPE_SET = new Set<string>(SUPPORTED_INTERCEPTOR_TYPES);

function env(key: string): string | undefined {
  const v = process.env[key];
  return v !== undefined ? (process.platform === 'win32' ? v.trim() : v) : undefined;
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

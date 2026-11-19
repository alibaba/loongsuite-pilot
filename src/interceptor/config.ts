import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import * as path from 'node:path';
import { configJsonPath, resolveDataDir } from '../utils/data-dir.js';
import {
  SUPPORTED_INTERCEPTOR_TYPES,
  type InterceptorConfig,
  type InterceptorType,
  type MaskConfig,
  type MaskType,
} from '../types/index.js';

function env(key: string): string | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const normalized = v.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function buildInterceptorConfig(value: unknown): InterceptorConfig {
  const file = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { mode?: unknown }
    : null;
  const mode = env('LOONGSUITE_PILOT_INTERCEPTOR_MODE') ?? (typeof file?.mode === 'string' ? file.mode : undefined);
  if (mode !== 'all' && mode !== 'none') {
    return { mode: 'none', types: [] };
  }
  return { mode, types: [] };
}

/**
 * Credential types enabled for interception are also mask types. Installer
 * writes this union into config.json; runtime config (env overrides and
 * hand-edited files) has to apply the same rule or mask mode none would
 * leave interceptor matches in the clear.
 */
export function ensureMaskCoversInterceptor(mask: MaskConfig, interceptor: InterceptorConfig): MaskConfig {
  const extra: MaskType[] = interceptor.mode === 'all' ? [...SUPPORTED_INTERCEPTOR_TYPES] : [];
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

/** Interceptor hooks follow the startup opt-in; cached rules never enable them. */
export function shouldDeployInterceptorHooks(config: InterceptorConfig): boolean {
  return config.mode === 'all';
}

export function resolveEnabledInterceptorTypes(config: InterceptorConfig): Set<InterceptorType> {
  if (config.mode !== 'all') return new Set();
  return new Set(SUPPORTED_INTERCEPTOR_TYPES);
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

/** Resolve an install's switch without borrowing another data directory's config. */
export async function resolveDeployInterceptorHooks(dataDir: string): Promise<boolean> {
  const installDataDir = path.resolve(resolveHome(dataDir));
  const daemonDataDir = path.resolve(resolveDataDir());
  const config = await loadInterceptorConfig(installDataDir === daemonDataDir
    ? undefined
    : path.join(installDataDir, 'config.json'));
  return shouldDeployInterceptorHooks(config);
}

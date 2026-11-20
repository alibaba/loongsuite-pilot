import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import * as path from 'node:path';
import { configJsonPath, resolveDataDir } from '../utils/data-dir.js';
import type { InterceptorConfig, MaskConfig, MaskType } from '../types/index.js';

/** Credential masking required whenever interception is enabled. */
export const INTERCEPTOR_MASK_TYPES = [
  'cloudAccessKey',
  'apiKey',
  'privateKey',
  'databaseUrl',
] as const satisfies readonly MaskType[];

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
    return { mode: 'none' };
  }
  return { mode };
}

/** Protect intercepted content using the same credential mask union as installers. */
export function ensureMaskCoversInterceptor(mask: MaskConfig, interceptor: InterceptorConfig): MaskConfig {
  if (interceptor.mode !== 'all' || mask.mode === 'all') return mask;
  const current = mask.mode === 'custom' ? mask.types : [];
  return {
    ...mask,
    mode: 'custom',
    types: [...new Set<MaskType>([...current, ...INTERCEPTOR_MASK_TYPES])],
  };
}

/** Interceptor hooks follow the startup opt-in; cached rules never enable them. */
export function shouldDeployInterceptorHooks(config: InterceptorConfig): boolean {
  return config.mode === 'all';
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

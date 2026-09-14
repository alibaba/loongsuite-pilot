import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { configJsonPath } from '../utils/data-dir.js';
import type { InterceptorConfig } from './types.js';

export function parseInterceptorSwitches(value: unknown): InterceptorConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const switches: InterceptorConfig = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'boolean') switches[key] = raw;
  }
  return switches;
}

export function isRuleEnabled(switches: InterceptorConfig, ruleId: string): boolean {
  return switches[ruleId] === true;
}

export async function loadInterceptorSwitches(configPath?: string): Promise<InterceptorConfig> {
  const file = await readJsonFile<{ interceptor?: unknown }>(
    configPath ?? resolveHome(configJsonPath()),
  );
  return parseInterceptorSwitches(file?.interceptor);
}

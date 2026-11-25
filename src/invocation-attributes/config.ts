import path from 'node:path';
import { isInvocationAttributeKey } from '../../assets/hooks/shared/invocation-attributes.mjs';

export interface InvocationAttributeSourceConfig {
  scope: string;
  selector: 'message' | 'turn';
  waitMs: number;
  // The caller owns only these custom namespaces; omit to fill unset fields.
  attributePrefixes: string[];
}

export interface InvocationAttributeConfig {
  root?: string;
  sources: Record<string, InvocationAttributeSourceConfig>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function readInvocationAttributeConfig(value: unknown): InvocationAttributeConfig | undefined {
  if (!object(value) || !object(value.sources)) return undefined;
  if (value.root !== undefined && (typeof value.root !== 'string' || !path.isAbsolute(value.root))) return undefined;
  if (Object.keys(value.sources).length > 128) return undefined;
  const sources: InvocationAttributeConfig['sources'] = Object.create(null);
  for (const [name, raw] of Object.entries(value.sources)) {
    if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name) || !object(raw)) continue;
    const scope = raw.scope ?? 'default';
    const selector = raw.selector ?? 'turn';
    const waitMs = raw.waitMs ?? 0;
    const prefixes = raw.attributePrefixes ?? [];
    if (typeof scope !== 'string' || !scope || scope.length > 512 || /[\u0000-\u001f\u007f]/.test(scope)
      || (selector !== 'message' && selector !== 'turn')
      || typeof waitMs !== 'number' || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5000
      || !Array.isArray(prefixes) || prefixes.length > 32
      || !prefixes.every(p => typeof p === 'string' && p.endsWith('.') && isInvocationAttributeKey(p + 'field'))) continue;
    sources[name] = { scope, selector, waitMs, attributePrefixes: [...new Set(prefixes)] };
  }
  return Object.keys(sources).length ? { root: value.root as string | undefined, sources } : undefined;
}

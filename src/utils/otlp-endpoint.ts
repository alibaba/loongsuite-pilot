import type { OtlpEndpoint } from '../types/index.js';

type OtlpEndpointRoute = Pick<OtlpEndpoint, 'endpoint' | 'traceEndpoint'>;

/**
 * Resolve the final OTLP/HTTP trace URL for one backend.
 *
 * A signal-specific traceEndpoint is used without changing its path. The
 * legacy endpoint remains a base URL and receives the /v1/traces suffix.
 */
export function resolveOtlpTraceUrl(route: OtlpEndpointRoute): string | undefined {
  const exact = nonEmpty(route.traceEndpoint);
  if (exact) return validateHttpUrl(exact, 'traceEndpoint');

  const legacy = nonEmpty(route.endpoint);
  if (!legacy) return undefined;

  const withoutTrailingSlash = legacy.replace(/\/+$/, '');
  const resolved = withoutTrailingSlash.endsWith('/v1/traces')
    ? withoutTrailingSlash
    : `${withoutTrailingSlash}/v1/traces`;
  return validateHttpUrl(resolved, 'endpoint');
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validateHttpUrl(value: string, field: 'endpoint' | 'traceEndpoint'): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`[otlp-trace] ${field} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[otlp-trace] ${field} must use the http or https scheme`);
  }
  return value;
}

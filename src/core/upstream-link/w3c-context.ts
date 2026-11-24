import { ROOT_CONTEXT, defaultTextMapGetter, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { normalizeUpstreamCarrier } from '../../../assets/hooks/shared/upstream-ingress.mjs';

const propagator = new W3CTraceContextPropagator();

export function extractUpstreamContext(carrier: unknown) {
  const normalized = normalizeUpstreamCarrier(carrier);
  if (!normalized) return undefined;
  const context = propagator.extract(ROOT_CONTEXT, normalized, defaultTextMapGetter);
  return trace.getSpanContext(context) ? context : undefined;
}

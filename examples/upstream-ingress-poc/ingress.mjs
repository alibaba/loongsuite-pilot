import { ROOT_CONTEXT, defaultTextMapGetter, defaultTextMapSetter } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { bindUpstreamTurn, normalizeUpstreamCarrier } from '../../assets/hooks/shared/upstream-ingress.mjs';

const propagator = new W3CTraceContextPropagator();

export function extractIngress(carrier) {
  return propagator.extract(ROOT_CONTEXT, carrier ?? {}, defaultTextMapGetter);
}

export function bindIngress({ agentId, sessionId, nativeTurnId, carrier, dataDir }) {
  return bindUpstreamTurn({ agentId, sessionId, nativeTurnId, carrier: normalizeUpstreamCarrier(carrier), dataDir });
}

export function captureIngress(context) {
  const injected = {};
  propagator.inject(context, injected, defaultTextMapSetter);
  const carrier = normalizeUpstreamCarrier(injected);
  return {
    carrier,
    childEnv(baseEnv, extra = {}) {
      const env = { ...baseEnv, ...extra };
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'traceparent' || key.toLowerCase() === 'tracestate') delete env[key];
      }
      if (carrier?.traceparent) env.TRACEPARENT = carrier.traceparent;
      if (carrier?.tracestate) env.TRACESTATE = carrier.tracestate;
      return env;
    },
    acpMeta(existing = {}) {
      const metadata = { ...existing };
      for (const key of Object.keys(metadata)) {
        if (key.toLowerCase() === 'traceparent' || key.toLowerCase() === 'tracestate') delete metadata[key];
      }
      return { ...metadata, ...(carrier ?? {}) };
    },
    bindNative({ agentId, sessionId, nativeTurnId, dataDir }) {
      return bindIngress({ agentId, sessionId, nativeTurnId, carrier, dataDir });
    },
  };
}

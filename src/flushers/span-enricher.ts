import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('span-enricher');
const LOAD_TIMEOUT_MS = 5_000;

export interface SpanEnricherView {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean | null | undefined)[] | undefined>>;
}

export interface SpanEnricherContext {
  readonly agentType: string;
  readonly serviceName: string;
}

/** Pilot pre-export transform; deliberately not an OpenTelemetry SpanProcessor. */
export interface SpanEnricher {
  enrich(span: SpanEnricherView, context: SpanEnricherContext): Attributes | void;
}

interface LoadedEnricher {
  path: string;
  plugin: SpanEnricher;
  warned?: boolean;
}

function validValue(value: unknown): value is AttributeValue {
  const scalar = (v: unknown): boolean => typeof v === 'string' || typeof v === 'boolean'
    || (typeof v === 'number' && Number.isFinite(v));
  if (scalar(value)) return true;
  if (!Array.isArray(value)) return false;
  const values = value.filter(v => v !== null && v !== undefined);
  return values.every(v => scalar(v) && typeof v === typeof values[0]);
}

function attributeSnapshot(attributes: Attributes): SpanEnricherView['attributes'] {
  return Object.freeze(Object.fromEntries(Object.entries(attributes).map(([key, value]) =>
    [key, Array.isArray(value) ? Object.freeze([...value]) : value])));
}

/** One lazy load per flusher, shared by all conversion providers. No SDK lifecycle hooks. */
export class SpanEnricherRunner {
  private loaded?: Promise<LoadedEnricher[]>;

  constructor(private readonly paths: readonly string[]) {}

  private async load(): Promise<LoadedEnricher[]> {
    const seen = new Set<string>();
    // Resolve in order so symlinks consistently keep the first configured occurrence.
    const canonical: string[] = [];
    for (const file of this.paths.slice(0, 16)) {
      try {
        if (!file.endsWith('.mjs')) throw new Error('Expected .mjs');
        const resolved = await realpath(file);
        if (!seen.has(resolved)) {
          seen.add(resolved);
          canonical.push(resolved);
        }
      } catch {
        logger.warn('Cannot resolve span enricher; skipping', { path: file });
      }
    }
    const loaded = await Promise.all(canonical.map(async file => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const module = await Promise.race([
          import(pathToFileURL(file).href),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Load timeout')), LOAD_TIMEOUT_MS);
          }),
        ]);
        if (!module.default || typeof module.default.enrich !== 'function') {
          throw new Error('Expected default export with enrich()');
        }
        return { path: file, plugin: module.default as SpanEnricher };
      } catch {
        // Avoid logging plugin errors, which may contain captured tool arguments.
        logger.warn('Cannot load span enricher; skipping', { path: file });
        return undefined;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
    return loaded.filter((item): item is LoadedEnricher => item !== undefined);
  }

  async enrich(spans: ReadableSpan[], context: SpanEnricherContext): Promise<ReadableSpan[]> {
    if (this.paths.length === 0) return spans;
    const plugins = await (this.loaded ??= this.load());
    const frozenContext = Object.freeze({ ...context });
    return spans.map(span => {
      let attributes = span.attributes;
      for (const entry of plugins) {
        try {
          const { traceId, spanId } = span.spanContext();
          const view = Object.freeze({ name: span.name, traceId, spanId, attributes: attributeSnapshot(attributes) });
          const patch = entry.plugin.enrich(view, frozenContext);
          if (patch === undefined) continue;
          if (patch && typeof (patch as unknown as PromiseLike<unknown>).then === 'function') {
            // Async callbacks are unsupported; consume rejection without awaiting them.
            void Promise.resolve(patch).catch(() => {});
            throw new Error('enrich() must be synchronous');
          }
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid patch');
          const updates: Attributes = Object.create(null);
          for (const [key, value] of Object.entries(patch)) {
            if (!key || ['__proto__', 'prototype', 'constructor'].includes(key) || !validValue(value)) {
              throw new Error('Invalid attribute');
            }
            updates[key] = Array.isArray(value) ? value.slice() as AttributeValue : value;
          }
          attributes = { ...attributes, ...updates };
        } catch {
          if (!entry.warned) {
            entry.warned = true;
            logger.warn('Span enricher failed; ignoring its patch (further errors suppressed)', { path: entry.path });
          }
        }
      }
      // Export a new view; do not mutate the ended SDK span.
      return attributes === span.attributes ? span : {
        name: span.name, kind: span.kind, spanContext: () => span.spanContext(),
        parentSpanId: span.parentSpanId, startTime: span.startTime, endTime: span.endTime,
        status: span.status, attributes, links: span.links, events: span.events,
        duration: span.duration, ended: span.ended, resource: span.resource,
        instrumentationLibrary: span.instrumentationLibrary,
        droppedAttributesCount: span.droppedAttributesCount,
        droppedEventsCount: span.droppedEventsCount, droppedLinksCount: span.droppedLinksCount,
      };
    });
  }
}

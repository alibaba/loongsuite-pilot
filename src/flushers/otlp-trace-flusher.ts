import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import {
  convertEventLogToTrace,
  ExtendedTelemetryHandler,
  type EventLogRecord,
} from '@loongsuite/otel-util-genai';
import { createReadableSpanToOtlpSpanJsonArray } from './otlp-json-serializer.js';

import type { AgentActivityEntry, OtlpTraceFlusherConfig } from '../types/index.js';
import { BaseFlusher } from './base-flusher.js';
import { normalizeAgentType } from '../utils/agent-type-normalize.js';
import { resolveAgentSystem } from '../normalization/agent-system-map.js';
import {
  DEFAULT_GIT_PASSTHROUGH_KEYS,
  isReservedKey,
  type GlobalAttributesProvider,
} from '../normalization/global-attributes.js';
import { createLogger } from '../utils/logger.js';
import { appendLine, ensureDir, getTodayDateString, readInstalledVersion } from '../utils/fs-utils.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const logger = createLogger('otlp-trace-flusher');

const VALID_TRACE_ID_RE = /^[0-9a-f]{32}$/;
const TERMINAL_FINISH_REASONS = new Set([
  'stop',
  'end_turn',
  'cancelled',
  'error',
  'length',
  'content_filter',
]);

const GROK_RECONSTRUCTION_PASSTHROUGH_KEYS = [
  'loongsuite.grok.match.strategy',
  'loongsuite.grok.timing.source',
] as const;
// Hard cap on simultaneously-open turn buffers. Above this, the oldest
// incomplete buffers are force-flushed to bound memory in pathological
// cases (e.g. an agent that never emits a terminal llm.response AND never
// sends a same-session successor AND turnIdleTimeoutMs=0). Normal load
// stays well under this; the cap is defense-in-depth, not a tuned limit.
const MAX_TURN_BUFFERS = 64;

interface TurnBuffer {
  key: string;
  keySource: 'turn_id' | 'trace_id' | 'session_id' | 'ephemeral';
  keyValue: string;
  agentType: string;
  sessionId?: string;
  records: AgentActivityEntry[];
  completed: boolean;
  lastActivityMs: number;
}

interface AgentConvertState {
  provider: BasicTracerProvider;
  handler: ExtendedTelemetryHandler;
  inMem: InMemorySpanExporter;
  active: number;
}

interface ToolOutcome {
  status: 'failure' | 'cancelled';
  errorType: string;
}

interface TraceOutcome {
  status: 'error' | 'cancelled';
  errorType: string;
  message: string;
}

interface LlmOutcome {
  errorType: string;
  message: string;
}

function parseSystemInstructions(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [{ type: 'text', content: value }];
}

function stripSystemRoleMessages(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((message) =>
      !message || typeof message !== 'object'
      || (message as Record<string, unknown>).role !== 'system');
  }
  if (typeof value !== 'string' || value.length === 0) return value;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return value;
    return JSON.stringify(parsed.filter((message) =>
      !message || typeof message !== 'object'
      || (message as Record<string, unknown>).role !== 'system'));
  } catch {
    return value;
  }
}

function prepareGrokConversionRecords(records: AgentActivityEntry[]): {
  records: AgentActivityEntry[];
  systemInstructions: unknown[];
} {
  let systemInstructions: unknown[] = [];
  const prepared = records.map((record) => {
    const copy = { ...record } as AgentActivityEntry;
    if (systemInstructions.length === 0 && copy['gen_ai.system_instructions'] != null) {
      systemInstructions = parseSystemInstructions(copy['gen_ai.system_instructions']);
    }
    delete copy['gen_ai.system_instructions'];

    for (const key of ['gen_ai.input.messages', 'gen_ai.input.messages_delta'] as const) {
      if (copy[key] != null) copy[key] = stripSystemRoleMessages(copy[key]) as never;
    }

    // The upstream converter discards `other` records without content. Retain
    // this structural marker in memory even when content capture is disabled so
    // session/turn/user metadata still reaches ENTRY and AGENT spans.
    if (
      copy['event.name'] === 'other'
      && copy['gen_ai.input.messages'] == null
      && copy['gen_ai.input.messages_delta'] == null
    ) {
      copy['gen_ai.input.messages_delta'] = [] as never;
    }
    return copy;
  });
  return { records: prepared, systemInstructions };
}

/** Minimal exporter surface used by the flusher; lets tests inject fakes. */
export interface TraceExporterLike {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
}

/** Factory for exporters, injectable for testing. */
export type OtlpExporterFactory = (opts: {
  url: string;
  headers: Record<string, string>;
  compression: CompressionAlgorithm;
  name: string;
}) => TraceExporterLike;

interface ResolvedOtlpEndpoint {
  name: string;
  url: string;
  headers: Record<string, string>;
  compression: CompressionAlgorithm;
  serviceName: string;
}

interface AgentExportState {
  exporters: Array<{ name: string; exporter: TraceExporterLike }>;
}

const RESERVED_RESOURCE_KEYS = new Set([
  'service.name',
  'service.version',
  'service.instance.id',
  'service.namespace',
  'host.name',
  'gen_ai.agent.type',
  'gen_ai.agent.system',
  'gen_ai.framework',
]);

type ResourceProjectionValue = string | number | boolean;

const SENSITIVE_RESOURCE_KEY_RE = /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$/i;

function resolveEndpointUrl(raw: string): string {
  let url = raw.replace(/\/+$/, '');
  if (!url.endsWith('/v1/traces')) {
    url += '/v1/traces';
  }
  return url;
}

const defaultExporterFactory: OtlpExporterFactory = ({ url, headers, compression }) =>
  new OTLPTraceExporter({ url, headers, compression });

const DEFAULT_MAX_EXPORT_BATCH_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_CONVERT_STATES = 64;
const GEN_AI_HIERARCHY_PASSTHROUGH_KEYS = [
  'gen_ai.turn.id',
  'gen_ai.agent.scope',
  'gen_ai.agent.depth',
  'gen_ai.agent.parent.id',
  'gen_ai.subagent.parent_tool_call.id',
];

// Wraps ExtendedTelemetryHandler to inject AGENT-span aggregation attributes
// the upstream library does not pull from event-log records (gen_ai.agent.description,
// gen_ai.data_source.id, and gen_ai.usage.cache_creation.input_tokens when the sum
// across llm.response records is 0 — the library returns null in that case, causing
// validate-trace SHOULD WARNs). The flusher scans the turn's records and seeds
// currentExtraAttrs before each convertEventLogToTrace call; the override runs
// before super.stopInvokeAgent so applyInvokeAgentFinishAttributes sees non-null
// values and emits them on the span.
class AgentSpanEnrichingHandler extends ExtendedTelemetryHandler {
  currentExtraAttrs: Record<string, string | number> = {};
  currentToolOutcomes = new Map<string, ToolOutcome>();
  currentToolDurations = new Map<string, number>();
  currentLlmOutcomes = new Map<string, LlmOutcome>();
  currentTurnOutcome: TraceOutcome | null = null;
  currentSystemInstructions: unknown[] = [];
  currentSystemInstructionInjected = false;

  constructor(opts: { tracerProvider: BasicTracerProvider }) {
    super(opts);
  }

  private enrichAgentInvocation(invocation: any): void {
    const a = this.currentExtraAttrs;
    if (a && invocation && typeof invocation === 'object') {
      const desc = a['gen_ai.agent.description'];
      if (typeof desc === 'string' && desc && invocation.agentDescription == null) {
        invocation.agentDescription = desc;
      }
      const dsId = a['gen_ai.data_source.id'];
      if (typeof dsId === 'string' && dsId && invocation.dataSourceId == null) {
        invocation.dataSourceId = dsId;
      }
      const cc = a['gen_ai.usage.cache_creation.input_tokens'];
      if (typeof cc === 'number' && Number.isFinite(cc) && invocation.usageCacheCreationInputTokens == null) {
        invocation.usageCacheCreationInputTokens = cc;
      }
    }
  }

  stopLlm(invocation: any, endTime?: number): any {
    if (!this.currentSystemInstructionInjected && this.currentSystemInstructions.length > 0) {
      invocation.systemInstruction = this.currentSystemInstructions;
      this.currentSystemInstructionInjected = true;
    }
    const responseId = typeof invocation?.responseId === 'string'
      ? invocation.responseId
      : '';
    const outcome = responseId ? this.currentLlmOutcomes.get(responseId) : undefined;
    if (outcome) {
      return super.failLlm(invocation, {
        type: outcome.errorType,
        message: outcome.message,
      }, endTime);
    }
    return super.stopLlm(invocation, endTime);
  }

  stopInvokeAgent(invocation: any, endTime?: number): any {
    this.enrichAgentInvocation(invocation);
    if (this.currentTurnOutcome) {
      return super.failInvokeAgent(invocation, {
        type: this.currentTurnOutcome.errorType,
        message: this.currentTurnOutcome.message,
      }, endTime);
    }
    return super.stopInvokeAgent(invocation, endTime);
  }

  stopEntry(invocation: any, endTime?: number): any {
    if (this.currentTurnOutcome) {
      return super.failEntry(invocation, {
        type: this.currentTurnOutcome.errorType,
        message: this.currentTurnOutcome.message,
      }, endTime);
    }
    return super.stopEntry(invocation, endTime);
  }

  stopExecuteTool(invocation: any, endTime?: number): any {
    const toolCallId = typeof invocation?.toolCallId === 'string'
      ? invocation.toolCallId
      : '';
    const duration = toolCallId ? this.currentToolDurations.get(toolCallId) : undefined;
    if (typeof duration === 'number' && Number.isFinite(duration)) {
      invocation.attributes = {
        ...(invocation.attributes ?? {}),
        'gen_ai.tool.call.duration': Math.max(0, duration),
      };
    }
    const outcome = toolCallId ? this.currentToolOutcomes.get(toolCallId) : undefined;
    if (outcome) {
      return super.failExecuteTool(invocation, {
        type: outcome.errorType,
        message: outcome.status === 'cancelled'
          ? 'tool execution cancelled'
          : 'tool execution failed',
      }, endTime);
    }
    return super.stopExecuteTool(invocation, endTime);
  }
}

export { AgentSpanEnrichingHandler };

function estimateSpanSize(span: ReadableSpan): number {
  let size = 512;
  for (const val of Object.values(span.attributes)) {
    if (typeof val === 'string') size += val.length;
    else size += 32;
  }
  for (const event of span.events ?? []) {
    size += 64;
    for (const val of Object.values(event.attributes ?? {})) {
      if (typeof val === 'string') size += val.length;
      else size += 32;
    }
  }
  return size;
}

export class OtlpTraceFlusher extends BaseFlusher {
  readonly name = 'otlp-trace';

  private readonly cfg: OtlpTraceFlusherConfig;
  private readonly turnBuffers = new Map<string, TurnBuffer>();
  private readonly agentConvertStates = new Map<string, AgentConvertState>();
  private readonly agentExportStates = new Map<string, AgentExportState>();
  private readonly instanceId = randomUUID();
  private readonly pilotVersion: string;
  private readonly endpoints: ResolvedOtlpEndpoint[];
  private readonly exporterFactory: OtlpExporterFactory;
  private readonly debugDir: string;
  private readonly failedDir: string;
  private readonly resourceAttributeKeys: string[];
  private readonly spanAttributePassthroughPrefixes: string[];
  private readonly globalAttributesProvider?: GlobalAttributesProvider;

  private idleTimer?: ReturnType<typeof setInterval>;
  private inFlightExports = new Set<Promise<void>>();
  private flushedTurnKeys = new Set<string>();
  private readonly convertLocks = new Map<string, Promise<void>>();

  // 批量模式标记：为 true 时 send() 中 Signal A（finish_reason=stop）只标记
  // completed 不立即 flush，由 sendBatch() 在所有 entries 处理完后统一 flush。
  // 解决的问题：Cursor subagent 的子 records 排在父 stop 之后，如果 Signal A
  // 即时 flush 会把 key 加入 flushedTurnKeys，导致后续同 key 的子 records 被丢弃。
  private _deferSignalA = false;

  constructor(
    cfg: OtlpTraceFlusherConfig,
    globalAttributesProvider?: GlobalAttributesProvider,
    exporterFactory?: OtlpExporterFactory,
  ) {
    super();
    if (!cfg.endpoints || cfg.endpoints.length === 0) {
      throw new Error('[otlp-trace-flusher] config.endpoints must be non-empty when enabled');
    }
    if (!cfg.serviceName) {
      throw new Error('[otlp-trace-flusher] config.serviceName is required when enabled');
    }
    this.cfg = cfg;
    this.globalAttributesProvider = globalAttributesProvider;
    this.exporterFactory = exporterFactory ?? defaultExporterFactory;
    this.endpoints = cfg.endpoints.map((ep, i) => ({
      name: ep.name || `otlp-${i}`,
      url: resolveEndpointUrl(ep.endpoint),
      headers: ep.headers ?? {},
      compression: ep.compression === 'none' ? CompressionAlgorithm.NONE : CompressionAlgorithm.GZIP,
      serviceName: ep.serviceName || cfg.serviceName,
    }));
    const dataDir = cfg.dataDir ?? os.homedir() + '/.loongsuite-pilot';
    this.pilotVersion = readInstalledVersion(dataDir);
    this.debugDir = path.join(dataDir, 'logs', 'otlp-debug');
    this.failedDir = path.join(dataDir, 'logs', 'otlp-failed');
    this.resourceAttributeKeys = (cfg.resourceAttributeKeys ?? [])
      .map(key => key.trim())
      .filter(key => key.length > 0);
    this.spanAttributePassthroughPrefixes = (cfg.spanAttributePassthroughPrefixes ?? [])
      .map(prefix => prefix.trim())
      .filter(prefix => prefix.length > 0);

    if (cfg.captureMessageContent !== false) {
      process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'gen_ai_latest_experimental';
      process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ??= 'SPAN_ONLY';
    }

    if (cfg.turnIdleTimeoutMs && cfg.turnIdleTimeoutMs > 0) {
      this.idleTimer = setInterval(() => this.tickIdleTimeout(), 1000);
      this.idleTimer.unref();
    }

    logger.info(
      `OTLP trace flusher initialized → ${this.endpoints.map(e => `${e.name}(${e.url})`).join(', ')}`,
    );
  }

  // --- Public API (BaseFlusher) ---

  async send(entry: AgentActivityEntry): Promise<void> {
    const { source, value, key } = this.resolveGroupKey(entry);
    const agentType = normalizeAgentType(
      (entry['gen_ai.agent.type'] as string) ?? '',
    );

    if (source === 'ephemeral') {
      await this.convertAndExport(agentType, [entry]);
      return;
    }

    // Drop late arrivals for already-flushed turns
    if (this.flushedTurnKeys.has(key)) {
      logger.debug(`Dropping late entry for already-flushed turn ${key}`);
      return;
    }

    // Signal B: a different turn from the same agent type is a boundary only
    // when both turns are confirmed to belong to the same session.
    // Different or unknown sessions may be concurrent; preempting one would
    // split its records and synthesize duplicate ENTRY/AGENT spans.
    const incomingSessionId = (entry['gen_ai.session.id'] as string | undefined) || undefined;
    for (const [bufKey, buf] of this.turnBuffers) {
      if (buf.agentType !== agentType || bufKey === key || buf.completed) continue;
      if (!incomingSessionId || !buf.sessionId || incomingSessionId !== buf.sessionId) continue;
      buf.completed = true;
      this.triggerFlush(buf, false);
    }

    // Bounded cleanup: if buffers have accumulated past the hard cap (pathological
    // case where neither Signal A, same-session successor, nor idle timeout ever
    // fires for many turns), flush oldest incomplete buffers to bound memory.
    if (this.turnBuffers.size > MAX_TURN_BUFFERS) {
      const overflow = this.turnBuffers.size - MAX_TURN_BUFFERS;
      const candidates = [...this.turnBuffers.values()]
        .filter((b) => !b.completed)
        .sort((a, b) => a.lastActivityMs - b.lastActivityMs)
        .slice(0, overflow);
      for (const b of candidates) {
        b.completed = true;
        this.triggerFlush(b, false);
      }
    }

    let buf = this.turnBuffers.get(key);
    if (!buf) {
      buf = {
        key,
        keySource: source,
        keyValue: value,
        agentType,
        sessionId: incomingSessionId,
        records: [],
        completed: false,
        lastActivityMs: Date.now(),
      };
      this.turnBuffers.set(key, buf);
    } else if (!buf.sessionId && incomingSessionId) {
      buf.sessionId = incomingSessionId;
    }
    buf.records.push(entry);
    buf.lastActivityMs = Date.now();

    // Signal A: 检测到终态 finish_reason，标记 turn 完成。
    // 逐条模式下立即 flush；批量模式下（_deferSignalA=true）仅标记 completed，
    // 由 sendBatch() 在所有 entries append 完后统一 flush。
    if (hasTerminalFinishReason(entry['gen_ai.response.finish_reasons'])) {
      buf.completed = true;
      if (!this._deferSignalA) {
        this.triggerFlush(buf);
      }
    }
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    // 批量模式：先 append 全部 entries，再统一 flush 已完成的 buffer。
    // 避免 Signal A 即时 flush 导致同 batch 内排在 stop 之后的子 records 被丢弃。
    this._deferSignalA = true;
    try {
      for (const entry of entries) {
        await this.send(entry);
      }
    } finally {
      this._deferSignalA = false;
    }
    // 统一 flush 所有在批量处理期间被 Signal A 标记为 completed 的 buffer
    await this.flushCompleted();
  }

  async flush(): Promise<void> {
    for (const buf of this.turnBuffers.values()) {
      buf.completed = true;
    }
    await this.flushCompleted();
    while (this.inFlightExports.size > 0) {
      const batch = [...this.inFlightExports];
      await Promise.allSettled(batch);
    }
    this.flushedTurnKeys.clear();
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    await this.flush();

    const exportShutdowns = [...this.agentExportStates.values()].flatMap(
      (s) => s.exporters.map((e) => e.exporter.shutdown()),
    );
    const providerShutdowns = [...this.agentConvertStates.values()].map(
      (s) => s.provider.shutdown(),
    );
    await Promise.allSettled([...exportShutdowns, ...providerShutdowns]);

    this.agentExportStates.clear();
    this.agentConvertStates.clear();
    logger.info('OTLP trace flusher shut down');
  }

  // --- Test seam ---

  async exportSpansForAgent(agentType: string, spans: ReadableSpan[]): Promise<void> {
    if (this.cfg.debug) {
      await this.writeDebugLog(agentType, spans);
    }
    // Fan out to every backend; each endpoint belongs to exactly one serviceName
    // group, so the spans reach each backend once.
    const serviceNames = [...new Set(this.endpoints.map((e) => e.serviceName))];
    await Promise.all(
      serviceNames.map((serviceName) =>
        this.exportInBatches(this.getOrCreateExportState(agentType, serviceName), agentType, spans),
      ),
    );
  }

  // --- Internal ---

  private resolveGroupKey(entry: AgentActivityEntry): {
    source: TurnBuffer['keySource'];
    value: string;
    key: string;
  } {
    const turnId = entry['gen_ai.turn.id'] as string | undefined;
    if (turnId && turnId.length > 0) {
      return { source: 'turn_id', value: turnId, key: `turn:${turnId}` };
    }

    const traceId = entry['trace_id'] as string | undefined;
    if (traceId && VALID_TRACE_ID_RE.test(traceId)) {
      return { source: 'trace_id', value: traceId, key: `trace:${traceId}` };
    }

    const sessionId = entry['gen_ai.session.id'] as string | undefined;
    if (sessionId && sessionId.length > 0) {
      return { source: 'session_id', value: sessionId, key: `session:${sessionId}` };
    }

    const ephemeralId = (entry['event.id'] as string) ?? randomUUID();
    return { source: 'ephemeral', value: ephemeralId, key: `ephemeral:${ephemeralId}` };
  }

  private triggerFlush(buf: TurnBuffer, markFlushed = true): void {
    if (markFlushed) {
      this.flushedTurnKeys.add(buf.key);
    }
    this.turnBuffers.delete(buf.key);
    const p = this.flushSingleTurn(buf).catch((err) => {
      logger.error(`Failed to flush turn ${buf.key}`, { err: String(err) });
    }).finally(() => {
      this.inFlightExports.delete(p);
    });
    this.inFlightExports.add(p);
  }

  private async flushCompleted(): Promise<void> {
    const completed: TurnBuffer[] = [];
    for (const [key, buf] of this.turnBuffers) {
      if (buf.completed) {
        completed.push(buf);
        this.flushedTurnKeys.add(key);
        this.turnBuffers.delete(key);
      }
    }
    await Promise.allSettled(
      completed.map((buf) => this.flushSingleTurn(buf)),
    );
  }

  private async flushSingleTurn(buf: TurnBuffer): Promise<void> {
    // Backfill gen_ai.turn.id if needed (D4)
    if (buf.keySource !== 'turn_id') {
      for (const record of buf.records) {
        if (!record['gen_ai.turn.id']) {
          (record as Record<string, unknown>)['gen_ai.turn.id'] = buf.keyValue;
        }
      }
    }
    await this.convertAndExport(buf.agentType, buf.records);
  }

  private async convertAndExport(
    agentType: string,
    records: AgentActivityEntry[],
  ): Promise<void> {
    if (records.length === 0) return;
    const projectedResourceAttributes = this.collectResourceAttributes(records);
    // Convert once per distinct service.name (backends may split into user/inner
    // service names). Each service name owns an independent convert state, so the
    // common single-name case still converts exactly once.
    const serviceNames = [...new Set(this.endpoints.map((e) => e.serviceName))];
    await Promise.all(
      serviceNames.map((serviceName) => {
        const convertKey = this.buildConvertStateKey(agentType, serviceName, projectedResourceAttributes);
        const prev = this.convertLocks.get(convertKey) ?? Promise.resolve();
        const current = prev.then(() => this.doConvertAndExport(
          agentType,
          serviceName,
          records,
          projectedResourceAttributes,
          convertKey,
        ));
        this.convertLocks.set(convertKey, current.catch(() => {}));
        return current;
      }),
    );
  }

  private async doConvertAndExport(
    agentType: string,
    serviceName: string,
    records: AgentActivityEntry[],
    projectedResourceAttributes: Record<string, ResourceProjectionValue>,
    convertKey: string,
  ): Promise<void> {
    const convertState = this.getOrCreateConvertState(agentType, serviceName, projectedResourceAttributes, convertKey);
    const { handler, provider, inMem } = convertState;
    convertState.active += 1;

    try {
      try {
        const agentSpanAttrs = this.collectAgentSpanAttributes(records);

        // Inject user-defined custom attributes (config/env/file) into trace
        // spans only — never the event log. Resolved per turn so the mutable
        // file is picked up on change. Values are fill-only stamped onto record
        // copies (originals untouched) so passthroughKeys can read them; git.*
        // are already on the records and only need to be listed as keys.
        const customAttrs = this.globalAttributesProvider?.resolve() ?? {};
        const customKeys = Object.keys(customAttrs);
        // Caller-supplied attributes (e.g. multica.*) are already stamped as
        // top-level fields on the records by the hook/plugin; discover any key
        // matching a configured prefix and list it so it reaches span attributes.
        const prefixKeys = this.spanAttributePassthroughPrefixes.length === 0
          ? []
          : [...new Set(
              records.flatMap(r =>
                Object.keys(r).filter(k =>
                  // Defense-in-depth: never surface reserved/pipeline keys even if a
                  // misconfigured prefix (e.g. "gen_ai.") happens to match them.
                  !isReservedKey(k) &&
                  this.spanAttributePassthroughPrefixes.some(p => k.startsWith(p)),
                ),
              ),
            )];
        const agentSpecificKeys = agentType === 'grok-build'
          ? GROK_RECONSTRUCTION_PASSTHROUGH_KEYS
          : [];
        const passthroughKeys = [
          ...new Set([
            ...DEFAULT_GIT_PASSTHROUGH_KEYS,
            ...GEN_AI_HIERARCHY_PASSTHROUGH_KEYS,
            ...agentSpecificKeys,
            ...customKeys,
            ...prefixKeys,
          ]),
        ];
        let recordsForConversion = customKeys.length === 0
          ? records
          : records.map((r) => {
              const copy: AgentActivityEntry = { ...r };
              for (const [k, v] of Object.entries(customAttrs)) {
                if (copy[k] === undefined) copy[k] = v;
              }
              return copy;
            });
        let systemInstructions: unknown[] = [];
        if (agentType === 'grok-build') {
          const prepared = prepareGrokConversionRecords(recordsForConversion);
          recordsForConversion = prepared.records;
          systemInstructions = prepared.systemInstructions;
        }

        if (handler instanceof AgentSpanEnrichingHandler) {
          handler.currentExtraAttrs = agentSpanAttrs;
          handler.currentToolOutcomes = this.collectToolOutcomes(records);
          handler.currentToolDurations = agentType === 'grok-build'
            ? this.collectToolDurations(records)
            : new Map();
          handler.currentLlmOutcomes = agentType === 'grok-build'
            ? this.collectLlmOutcomes(records)
            : new Map();
          handler.currentTurnOutcome = agentType === 'grok-build'
            ? this.collectTurnOutcome(records)
            : null;
          handler.currentSystemInstructions = systemInstructions;
          handler.currentSystemInstructionInjected = false;
        }

        const result = (() => {
          try {
            // Grok deliberately retains an orphan llm.request when a real
            // inference_start exists so StopFailure can emit the failed LLM
            // attempt. Other agents use the mainline orphan-pair cleanup.
            const conversionRecords = agentType === 'grok-build'
              ? recordsForConversion
              : dropOrphanPairs(recordsForConversion);
            return convertEventLogToTrace(
              conversionRecords as unknown as EventLogRecord[],
              { handler, strict: false, passthroughKeys },
            );
          } finally {
            if (handler instanceof AgentSpanEnrichingHandler) {
              handler.currentExtraAttrs = {};
              handler.currentToolOutcomes.clear();
              handler.currentToolDurations.clear();
              handler.currentLlmOutcomes.clear();
              handler.currentTurnOutcome = null;
              handler.currentSystemInstructions = [];
              handler.currentSystemInstructionInjected = false;
            }
          }
        })();
        if (result.warnings.length > 0) {
          logger.warn(`Conversion warnings for ${agentType}`, { warnings: result.warnings.join('; ') });
        }
      } catch (err) {
        logger.error(`convertEventLogToTrace failed for ${agentType}`, { err: String(err) });
        return;
      }

      await provider.forceFlush();
      const spans = inMem.getFinishedSpans();
      inMem.reset();

      if (spans.length === 0) return;

      const exportState = this.getOrCreateExportState(agentType, serviceName);

      if (this.cfg.debug) {
        await this.writeDebugLog(agentType, spans);
      }

      await this.exportInBatches(exportState, agentType, spans);
    } catch (err) {
      logger.error(`convert and export failed for ${agentType}`, { err: String(err) });
    } finally {
      convertState.active -= 1;
      this.evictConvertStates();
    }
  }

  private collectToolOutcomes(records: AgentActivityEntry[]): Map<string, ToolOutcome> {
    const outcomes = new Map<string, ToolOutcome>();
    for (const record of records) {
      if (record['event.name'] !== 'tool.result') continue;
      const toolCallId = record['gen_ai.tool.call.id'];
      const status = record['tool.result.status'];
      if (typeof toolCallId !== 'string' || !toolCallId) continue;
      if (status !== 'failure' && status !== 'cancelled') continue;
      const errorType = typeof record['error.type'] === 'string' && record['error.type']
        ? record['error.type']
        : (status === 'cancelled' ? 'ToolCancelled' : 'ToolError');
      outcomes.set(toolCallId, { status, errorType });
    }
    return outcomes;
  }

  private collectToolDurations(records: AgentActivityEntry[]): Map<string, number> {
    const durations = new Map<string, number>();
    for (const record of records) {
      if (record['event.name'] !== 'tool.result') continue;
      const toolCallId = record['gen_ai.tool.call.id'];
      const duration = record['gen_ai.tool.call.duration'];
      if (typeof toolCallId !== 'string' || !toolCallId) continue;
      if (typeof duration !== 'number' || !Number.isFinite(duration)) continue;
      durations.set(toolCallId, Math.max(0, duration));
    }
    return durations;
  }

  private collectLlmOutcomes(records: AgentActivityEntry[]): Map<string, LlmOutcome> {
    const outcomes = new Map<string, LlmOutcome>();
    for (const record of records) {
      if (record['event.name'] !== 'llm.response') continue;
      const responseId = record['gen_ai.response.id'];
      const errorType = record['error.type'];
      if (typeof responseId !== 'string' || !responseId) continue;
      if (typeof errorType !== 'string' || !errorType) continue;
      outcomes.set(responseId, {
        errorType,
        message: 'model request failed',
      });
    }
    return outcomes;
  }

  private collectTurnOutcome(records: AgentActivityEntry[]): TraceOutcome | null {
    for (const record of records) {
      if (record['event.name'] !== 'other') continue;
      const raw = record['gen_ai.response.finish_reasons'];
      const reasons = Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === 'string')
        : (typeof raw === 'string' ? [raw] : []);
      if (reasons.includes('error')) {
        const errorType = typeof record['error.type'] === 'string' && record['error.type']
          ? record['error.type']
          : 'model_error';
        return { status: 'error', errorType, message: 'model request failed' };
      }
      if (reasons.includes('cancelled')) {
        return { status: 'cancelled', errorType: 'cancelled', message: 'turn cancelled' };
      }
    }
    return null;
  }

  private async exportInBatches(
    exportState: AgentExportState,
    agentType: string,
    spans: ReadableSpan[],
  ): Promise<void> {
    const maxBytes = this.cfg.maxExportBatchBytes ?? DEFAULT_MAX_EXPORT_BATCH_BYTES;
    const batches: ReadableSpan[][] = [];
    let current: ReadableSpan[] = [];
    let currentSize = 0;

    for (const span of spans) {
      const size = estimateSpanSize(span);
      if (current.length > 0 && currentSize + size > maxBytes) {
        batches.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(span);
      currentSize += size;
    }
    if (current.length > 0) batches.push(current);

    if (batches.length > 1) {
      logger.info(`Exporting ${spans.length} spans in ${batches.length} batches`, { agentType, maxBytes });
    }

    // Fan out per-endpoint in parallel: each backend drains its own batches
    // sequentially, but backends run concurrently — so a slow/hung backend
    // only delays itself, not the healthy ones (no head-of-line blocking).
    await Promise.allSettled(
      exportState.exporters.map(({ name, exporter }) =>
        this.exportBatchesToEndpoint(exporter, name, agentType, batches),
      ),
    );
  }

  private async exportBatchesToEndpoint(
    exporter: TraceExporterLike,
    endpointName: string,
    agentType: string,
    batches: ReadableSpan[][],
  ): Promise<void> {
    for (const batch of batches) {
      await this.doExport(exporter, endpointName, agentType, batch);
    }
  }

  private doExport(
    exporter: TraceExporterLike,
    endpointName: string,
    agentType: string,
    spans: ReadableSpan[],
  ): Promise<void> {
    // Never rejects: a failing backend is isolated + persisted, not propagated.
    return new Promise<void>((resolve) => {
      exporter.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          const errMsg = result.error?.message ?? 'unknown export error';
          logger.warn(`Export failed for ${agentType} → ${endpointName}: ${errMsg}`);
          this.writeFailedLog(agentType, endpointName, spans, {
            code: result.code,
            message: errMsg,
          }).catch(() => undefined);
        }
        resolve();
      });
    });
  }

  private getOrCreateConvertState(
    agentType: string,
    serviceName: string,
    projectedResourceAttributes: Record<string, ResourceProjectionValue> = {},
    key = this.buildConvertStateKey(agentType, serviceName, projectedResourceAttributes),
  ): AgentConvertState {
    let state = this.agentConvertStates.get(key);
    if (state) {
      this.agentConvertStates.delete(key);
      this.agentConvertStates.set(key, state);
      return state;
    }

    const resource = this.buildResource(agentType, serviceName, projectedResourceAttributes);
    const inMem = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(inMem)],
    });
    const handler = new AgentSpanEnrichingHandler({ tracerProvider: provider });

    state = { provider, handler, inMem, active: 0 };
    this.agentConvertStates.set(key, state);
    this.evictConvertStates();
    return state;
  }

  private evictConvertStates(): void {
    while (this.agentConvertStates.size > MAX_CONVERT_STATES) {
      const entry = [...this.agentConvertStates.entries()].find(([, state]) => state.active === 0);
      if (!entry) {
        // Prefer correctness over a hard cap: active providers may still receive
        // spans, so allow a temporary overflow and retry when a conversion exits.
        return;
      }

      const [key, state] = entry;
      this.agentConvertStates.delete(key);
      this.convertLocks.delete(key);
      state.provider.shutdown().catch(err => {
        logger.warn('failed to shut down evicted convert state', { key, error: String(err) });
      });
    }
  }

  private buildConvertStateKey(
    agentType: string,
    serviceName: string,
    projectedResourceAttributes: Record<string, ResourceProjectionValue>,
  ): string {
    return `${agentType}|${serviceName}|${this.stableJson(projectedResourceAttributes)}`;
  }

  private stableJson(value: Record<string, ResourceProjectionValue>): string {
    const sorted: Record<string, ResourceProjectionValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = value[key];
    }
    return JSON.stringify(sorted);
  }

  private collectResourceAttributes(records: AgentActivityEntry[]): Record<string, ResourceProjectionValue> {
    const allowed = new Set(this.resourceAttributeKeys);
    const attributes: Record<string, ResourceProjectionValue> = {};

    for (const record of records) {
      this.collectResourceAttributeMap(attributes, record.resourceAttributes);
      if (allowed.size === 0) continue;

      for (const [key, rawValue] of Object.entries(record)) {
        if (!allowed.has(key)) continue;
        this.collectResourceAttribute(attributes, key, rawValue);
      }
    }

    return attributes;
  }

  private collectResourceAttributeMap(
    attributes: Record<string, ResourceProjectionValue>,
    rawMap: unknown,
  ): void {
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return;

    for (const [key, rawValue] of Object.entries(rawMap as Record<string, unknown>)) {
      this.collectResourceAttribute(attributes, key, rawValue);
    }
  }

  private collectResourceAttribute(
    attributes: Record<string, ResourceProjectionValue>,
    key: string,
    rawValue: unknown,
  ): void {
    if (SENSITIVE_RESOURCE_KEY_RE.test(key)) {
      logger.warn(`resource attribute key "${key}" looks sensitive and will be ignored`);
      return;
    }

    const value = this.normalizeResourceAttributeValue(rawValue);
    if (value === undefined) return;

    if (attributes[key] !== undefined && attributes[key] !== value) {
      logger.warn(`resource attribute key "${key}" has conflicting values in one turn; keeping first value`);
      return;
    }
    attributes[key] = value;
  }

  // Scan a turn's records for AGENT-span aggregation fields the upstream
  // @loongsuite/otel-util-genai library does NOT read from records itself:
  //   - gen_ai.agent.description (string, first non-empty wins)
  //   - gen_ai.data_source.id (string, first non-empty wins)
  //   - gen_ai.usage.cache_creation.input_tokens (sum across llm.response)
  // These are injected onto the AGENT invocation via AgentSpanEnrichingHandler
  // before the library's stopInvokeAgent applies attributes, so they propagate
  // to the AGENT span even though the library's buildInvokeAgentInvocation
  // ignores them. Without this, the AGENT span would WARN on these SHOULD
  // fields because the library only sets cache_creation when sum > 0 (null
  // otherwise) and never sets agent.description/data_source.id.
  private collectAgentSpanAttributes(records: AgentActivityEntry[]): Record<string, string | number> {
    const attrs: Record<string, string | number> = {};
    let cacheCreateSum = 0;
    let sawCacheCreation = false;
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      const desc = r['gen_ai.agent.description'];
      if (typeof desc === 'string' && desc && attrs['gen_ai.agent.description'] === undefined) {
        attrs['gen_ai.agent.description'] = desc;
      }
      const dsId = r['gen_ai.data_source.id'];
      if (typeof dsId === 'string' && dsId && attrs['gen_ai.data_source.id'] === undefined) {
        attrs['gen_ai.data_source.id'] = dsId;
      }
      if (r['event.name'] === 'llm.response') {
        const cc = r['gen_ai.usage.cache_creation.input_tokens'];
        if (typeof cc === 'number' && Number.isFinite(cc)) {
          cacheCreateSum += cc;
          sawCacheCreation = true;
        }
      }
    }
    if (sawCacheCreation) {
      attrs['gen_ai.usage.cache_creation.input_tokens'] = cacheCreateSum;
    }
    return attrs;
  }

  private normalizeResourceAttributeValue(value: unknown): ResourceProjectionValue | undefined {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return undefined;
  }

  private getOrCreateExportState(agentType: string, serviceName: string): AgentExportState {
    const key = `${agentType}|${serviceName}`;
    let state = this.agentExportStates.get(key);
    if (state) return state;

    const exporters = this.endpoints
      .filter((ep) => ep.serviceName === serviceName)
      .map((ep) => ({
        name: ep.name,
        exporter: this.exporterFactory({
          url: ep.url,
          headers: ep.headers,
          compression: ep.compression,
          name: ep.name,
        }),
      }));

    state = { exporters };
    this.agentExportStates.set(key, state);
    return state;
  }

  private buildResource(
    agentType: string,
    serviceName: string,
    projectedResourceAttributes: Record<string, ResourceProjectionValue> = {},
  ): Resource {
    const userAttrs: Record<string, string> = {};
    if (this.cfg.resourceAttributes) {
      for (const [k, v] of Object.entries(this.cfg.resourceAttributes)) {
        if (RESERVED_RESOURCE_KEYS.has(k)) {
          logger.warn(`resourceAttributes key "${k}" is reserved and will be ignored`);
          continue;
        }
        userAttrs[k] = v;
      }
    }

    const projectedAttrs: Record<string, ResourceProjectionValue> = {};
    for (const [k, v] of Object.entries(projectedResourceAttributes)) {
      if (RESERVED_RESOURCE_KEYS.has(k)) {
        logger.warn(`projected resource attribute key "${k}" is reserved and will be ignored`);
        continue;
      }
      if (SENSITIVE_RESOURCE_KEY_RE.test(k)) {
        logger.warn(`projected resource attribute key "${k}" looks sensitive and will be ignored`);
        continue;
      }
      if (userAttrs[k] !== undefined && userAttrs[k] !== String(v)) {
        logger.warn(`resourceAttributes key "${k}" is overridden by projected resource attribute`);
      }
      projectedAttrs[k] = v;
    }

    return new Resource({
      'service.name': `${serviceName}-${agentType}`,
      'service.version': this.pilotVersion,
      'service.instance.id': this.instanceId,
      'service.namespace': 'loongsuite-pilot',
      'host.name': os.hostname(),
      'gen_ai.agent.type': agentType,
      'gen_ai.agent.system': resolveAgentSystem(agentType),
      // ARMS GenAI semconv recommends gen_ai.framework on every span. The
      // converter library doesn't set it on span attributes, so we set it on
      // the Resource — OTel resources propagate to all spans of the trace,
      // which CMS reads the same way as span-level gen_ai.framework.
      'gen_ai.framework': agentType,
      ...userAttrs,
      ...projectedAttrs,
    });
  }

  private async writeDebugLog(agentType: string, spans: ReadableSpan[]): Promise<void> {
    try {
      const svcName = `${this.cfg.serviceName}-${agentType}`;
      const dir = this.debugDir;
      await ensureDir(dir);
      const filename = `${svcName}-${getTodayDateString()}.jsonl`;
      const filepath = path.join(dir, filename);
      const jsonLines = createReadableSpanToOtlpSpanJsonArray(spans);
      for (const line of jsonLines) {
        await appendLine(filepath, line);
      }
    } catch (err) {
      logger.warn('Debug log write failed (non-blocking)', { err: String(err) });
    }
  }

  private async writeFailedLog(
    agentType: string,
    endpointName: string,
    spans: ReadableSpan[],
    error: { code: number; message: string },
  ): Promise<void> {
    try {
      // Sanitize endpointName (comes from managed config `name`) so it cannot
      // escape failedDir via path traversal or create unintended subdirs.
      const safeEndpoint = endpointName.replace(/[^A-Za-z0-9._-]/g, '_');
      const svcName = `${this.cfg.serviceName}-${agentType}__${safeEndpoint}`;
      const dir = this.failedDir;
      await ensureDir(dir);
      const filepath = path.join(dir, `${svcName}.jsonl`);
      const jsonLines = createReadableSpanToOtlpSpanJsonArray(spans);
      for (const line of jsonLines) {
        const obj = JSON.parse(line);
        obj._error = error;
        await appendLine(filepath, JSON.stringify(obj));
      }
    } catch (err) {
      logger.warn('Failed-log write failed', { err: String(err) });
    }
  }

  private tickIdleTimeout(): void {
    const timeout = this.cfg.turnIdleTimeoutMs ?? 0;
    if (timeout <= 0) return;
    const now = Date.now();
    for (const [, buf] of this.turnBuffers) {
      if (!buf.completed && now - buf.lastActivityMs > timeout) {
        buf.completed = true;
        this.triggerFlush(buf);
      }
    }
  }
}

function hasTerminalFinishReason(finishReasons: unknown): boolean {
  return Array.isArray(finishReasons)
    && finishReasons.some(reason => typeof reason === 'string' && TERMINAL_FINISH_REASONS.has(reason));
}

/**
 * Drop orphan llm.request and tool.call events that have no matching
 * llm.response / tool.result in the same turn buffer. Without this, the
 * converter library still emits an LLM/TOOL span for the orphan event with
 * duration=0 (endMs=startMs) and missing output.messages / tool.call.result.
 *
 * Pairing scope:
 *   - llm.request ↔ llm.response: by gen_ai.step.id (a step is "complete"
 *     if it has at least one llm.response).
 *   - tool.call ↔ tool.result: by gen_ai.tool.call.id (a tool call is
 *     "complete" if a tool.result with the same call.id exists).
 *
 * Records whose pairing mate is missing are dropped. Records without
 * step.id (user-hook prompts / "other" events / llm.response-only) and
 * tool.result-only records are always kept — they don't produce orphan
 * spans downstream.
 */
function dropOrphanPairs(records: AgentActivityEntry[]): AgentActivityEntry[] {
  const stepsWithResponse = new Set<string>();
  const completedToolCallIds = new Set<string>();
  for (const r of records) {
    if (r['event.name'] === 'llm.response') {
      const stepId = (r['gen_ai.step.id'] as string | undefined) ?? '__no_step__';
      stepsWithResponse.add(stepId);
    }
    if (r['event.name'] === 'tool.result') {
      const callId = r['gen_ai.tool.call.id'] as string | undefined;
      if (callId) completedToolCallIds.add(callId);
    }
  }
  return records.filter((r) => {
    const name = r['event.name'];
    if (name === 'llm.request') {
      const stepId = (r['gen_ai.step.id'] as string | undefined) ?? '__no_step__';
      return stepsWithResponse.has(stepId);
    }
    if (name === 'tool.call') {
      const callId = r['gen_ai.tool.call.id'] as string | undefined;
      // Keep tool.call only if it has no call.id (rare) or a matching result.
      return !callId || completedToolCallIds.has(callId);
    }
    return true;
  });
}

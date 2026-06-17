import { ExportResultCode } from '@opentelemetry/core';
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
import { createLogger } from '../utils/logger.js';
import { appendLine, ensureDir, getTodayDateString } from '../utils/fs-utils.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const logger = createLogger('otlp-trace-flusher');

const VALID_TRACE_ID_RE = /^[0-9a-f]{32}$/;

interface TurnBuffer {
  key: string;
  keySource: 'turn_id' | 'trace_id' | 'session_id' | 'ephemeral';
  keyValue: string;
  agentType: string;
  records: AgentActivityEntry[];
  completed: boolean;
  lastActivityMs: number;
}

interface AgentConvertState {
  provider: BasicTracerProvider;
  handler: ExtendedTelemetryHandler;
  inMem: InMemorySpanExporter;
}

interface AgentExportState {
  exporter: OTLPTraceExporter;
}

const RESERVED_RESOURCE_KEYS = new Set([
  'service.name',
  'service.version',
  'service.instance.id',
  'service.namespace',
  'host.name',
  'gen_ai.agent.type',
  'gen_ai.agent.system',
]);

function resolveEndpointUrl(raw: string): string {
  let url = raw.replace(/\/+$/, '');
  if (!url.endsWith('/v1/traces')) {
    url += '/v1/traces';
  }
  return url;
}

function getPilotVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    );
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const DEFAULT_MAX_EXPORT_BATCH_BYTES = 10 * 1024 * 1024; // 10 MB

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
  private readonly pilotVersion = getPilotVersion();
  private readonly resolvedEndpointUrl: string;
  private readonly debugDir: string;
  private readonly failedDir: string;

  private idleTimer?: ReturnType<typeof setInterval>;
  private inFlightExports = new Set<Promise<void>>();
  private flushedTurnKeys = new Set<string>();
  private readonly convertLocks = new Map<string, Promise<void>>();

  // 批量模式标记：为 true 时 send() 中 Signal A（finish_reason=stop）只标记
  // completed 不立即 flush，由 sendBatch() 在所有 entries 处理完后统一 flush。
  // 解决的问题：Cursor subagent 的子 records 排在父 stop 之后，如果 Signal A
  // 即时 flush 会把 key 加入 flushedTurnKeys，导致后续同 key 的子 records 被丢弃。
  private _deferSignalA = false;

  constructor(cfg: OtlpTraceFlusherConfig) {
    super();
    if (!cfg.endpoint) {
      throw new Error('[otlp-trace-flusher] config.endpoint is required when enabled');
    }
    if (!cfg.serviceName) {
      throw new Error('[otlp-trace-flusher] config.serviceName is required when enabled');
    }
    this.cfg = cfg;
    this.resolvedEndpointUrl = resolveEndpointUrl(cfg.endpoint);
    this.debugDir = path.join(os.homedir(), '.loongsuite-pilot', 'logs', 'otlp-debug');
    this.failedDir = path.join(os.homedir(), '.loongsuite-pilot', 'logs', 'otlp-failed');

    if (cfg.captureMessageContent !== false) {
      process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'gen_ai_latest_experimental';
      process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ??= 'SPAN_ONLY';
    }

    if (cfg.turnIdleTimeoutMs && cfg.turnIdleTimeoutMs > 0) {
      this.idleTimer = setInterval(() => this.tickIdleTimeout(), 1000);
      this.idleTimer.unref();
    }

    logger.info(`OTLP trace flusher initialized → ${this.resolvedEndpointUrl}`);
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

    // Signal B: check if there's an active buffer for same agentType with different key
    for (const [bufKey, buf] of this.turnBuffers) {
      if (buf.agentType === agentType && bufKey !== key && !buf.completed) {
        buf.completed = true;
        this.triggerFlush(buf, false);
      }
    }

    let buf = this.turnBuffers.get(key);
    if (!buf) {
      buf = {
        key,
        keySource: source,
        keyValue: value,
        agentType,
        records: [],
        completed: false,
        lastActivityMs: Date.now(),
      };
      this.turnBuffers.set(key, buf);
    }
    buf.records.push(entry);
    buf.lastActivityMs = Date.now();

    // Signal A: 检测到 finish_reason=stop/end_turn，标记 turn 完成。
    // 逐条模式下立即 flush；批量模式下（_deferSignalA=true）仅标记 completed，
    // 由 sendBatch() 在所有 entries append 完后统一 flush。
    const finishReasons = entry['gen_ai.response.finish_reasons'];
    if (Array.isArray(finishReasons) && (finishReasons.includes('stop') || finishReasons.includes('end_turn'))) {
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

    const exportShutdowns = [...this.agentExportStates.values()].map(
      (s) => s.exporter.shutdown(),
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
    const exportState = this.getOrCreateExportState(agentType);
    if (this.cfg.debug) {
      await this.writeDebugLog(agentType, spans);
    }
    await this.exportInBatches(exportState, agentType, spans);
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
    const prev = this.convertLocks.get(agentType) ?? Promise.resolve();
    const current = prev.then(() => this.doConvertAndExport(agentType, records));
    this.convertLocks.set(agentType, current.catch(() => {}));
    await current;
  }

  private async doConvertAndExport(
    agentType: string,
    records: AgentActivityEntry[],
  ): Promise<void> {
    const convertState = this.getOrCreateConvertState(agentType);
    const { handler, provider, inMem } = convertState;

    try {
      const result = convertEventLogToTrace(
        records as unknown as EventLogRecord[],
        { handler, strict: false },
      );
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

    const exportState = this.getOrCreateExportState(agentType);

    if (this.cfg.debug) {
      await this.writeDebugLog(agentType, spans);
    }

    await this.exportInBatches(exportState, agentType, spans);
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
    for (const batch of batches) {
      await this.doExport(exportState, agentType, batch);
    }
  }

  private doExport(
    exportState: AgentExportState,
    agentType: string,
    spans: ReadableSpan[],
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      exportState.exporter.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          const errMsg = result.error?.message ?? 'unknown export error';
          logger.warn(`Export failed for ${agentType}: ${errMsg}`);
          this.writeFailedLog(agentType, spans, {
            code: result.code,
            message: errMsg,
          }).catch(() => undefined);
        }
        resolve();
      });
    });
  }

  private getOrCreateConvertState(agentType: string): AgentConvertState {
    let state = this.agentConvertStates.get(agentType);
    if (state) return state;

    const resource = this.buildResource(agentType);
    const inMem = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(inMem)],
    });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });

    state = { provider, handler, inMem };
    this.agentConvertStates.set(agentType, state);
    return state;
  }

  private getOrCreateExportState(agentType: string): AgentExportState {
    let state = this.agentExportStates.get(agentType);
    if (state) return state;

    const exporter = new OTLPTraceExporter({
      url: this.resolvedEndpointUrl,
      headers: this.cfg.headers ?? {},
      compression: this.cfg.compression === 'none'
        ? CompressionAlgorithm.NONE
        : CompressionAlgorithm.GZIP,
    });

    state = { exporter };
    this.agentExportStates.set(agentType, state);
    return state;
  }

  private buildResource(agentType: string): Resource {
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

    return new Resource({
      'service.name': `${this.cfg.serviceName}-${agentType}`,
      'service.version': this.pilotVersion,
      'service.instance.id': this.instanceId,
      'service.namespace': 'loongsuite-pilot',
      'host.name': os.hostname(),
      'gen_ai.agent.type': agentType,
      'gen_ai.agent.system': resolveAgentSystem(agentType),
      ...userAttrs,
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
    spans: ReadableSpan[],
    error: { code: number; message: string },
  ): Promise<void> {
    try {
      const svcName = `${this.cfg.serviceName}-${agentType}`;
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

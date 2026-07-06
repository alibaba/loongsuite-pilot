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

import type { AgentActivityEntry, JsonValue, OtlpTraceFlusherConfig, PerAgentFlusherConfig } from '../types/index.js';
import { BaseFlusher } from './base-flusher.js';
import { normalizeAgentType } from '../utils/agent-type-normalize.js';
import { resolveAgentSystem } from '../normalization/agent-system-map.js';
import { buildAgentActivityEntry } from '../normalization/entry-builder.js';
import { createLogger } from '../utils/logger.js';
import { appendLine, ensureDir, getTodayDateString, readInstalledVersion } from '../utils/fs-utils.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const logger = createLogger('otlp-trace-flusher');

const VALID_TRACE_ID_RE = /^[0-9a-f]{32}$/;
const TERMINAL_FINISH_REASONS = new Set(['stop', 'end_turn', 'cancelled', 'interrupted']);
// Lazy-loaded from assets/hooks/agent-event-normalizer.mjs (ESM). The resolver
// backfills gen_ai.step.id on hook tool events after the matching rollout
// llm.response arrives — see plan 1.2.
//
// To keep the flusher testable in vitest (where dynamic import of relative
// .mjs paths from compiled TS is unreliable) AND to avoid a second
// implementation, the canonical ZcodeStepResolver lives in
// assets/hooks/agent-event-normalizer.mjs and is exercised by the .mjs test
// suite. The flusher uses a thin inline wrapper below that mirrors the same
// logic — kept in sync via agent-event-normalizer.test.mjs (covers the
// canonical impl) and this flusher's debounce.test.ts (covers integration).

const ZCODE_AGENT_TYPE = 'zcode';

/**
 * Extract tool_call.id values from a record's gen_ai.output.messages parts.
 * Rollout llm.response carries one assistant message whose parts include
 * {type:'tool_call', id, name, input} blocks.
 */
function extractToolCallIds(record: Record<string, any>): string[] {
  const out: string[] = [];
  const messages = record['gen_ai.output.messages'];
  if (!Array.isArray(messages)) return out;
  for (const msg of messages) {
    const parts = (msg as Record<string, any>)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      const id = (p as Record<string, any>)?.id
        ?? (p as Record<string, any>)?.tool_call_id
        ?? (p as Record<string, any>)?.toolCallId;
      if (typeof id === 'string' && id.length > 0) out.push(id);
    }
  }
  return out;
}

/**
 * ZcodeStepResolver — lazy step.id resolver for ZCode hook tool events.
 * Mirrors assets/hooks/agent-event-normalizer.mjs ZcodeStepResolver; kept
 * in sync. See plan 1.2 for the lazy-resolution flow diagram.
 */
class ZcodeStepResolver {
  private stepIdByCallId = new Map<string, string>();
  private pendingToolByCallId = new Map<string, { record: Record<string, any>; turnId: string }[]>();
  private pendingByTurn = new Map<string, Set<string>>();

  resolve(record: Record<string, any>): Record<string, any> {
    if (!record || typeof record !== 'object') return record;
    const agentType = record['gen_ai.agent.type'];
    if (agentType !== ZCODE_AGENT_TYPE) return record;

    const eventName = record['event.name'];
    const turnId = record['gen_ai.turn.id'] || '';
    const callId = record['gen_ai.tool.call.id'] || record['gen_ai.tool.call.exec.id'];
    const stepId = record['gen_ai.step.id'];

    if (eventName === 'llm.response' && stepId) {
      const callIds = extractToolCallIds(record);
      for (const id of callIds) {
        this.stepIdByCallId.set(id, stepId);
        const pending = this.pendingToolByCallId.get(id);
        if (pending) {
          for (const { record: pendingRec } of pending) {
            if (!pendingRec['gen_ai.step.id']) pendingRec['gen_ai.step.id'] = stepId;
          }
          this.pendingToolByCallId.delete(id);
        }
      }
      return record;
    }

    if ((eventName === 'tool.call' || eventName === 'tool.result') && !stepId && callId) {
      const resolved = this.stepIdByCallId.get(callId);
      if (resolved) {
        record['gen_ai.step.id'] = resolved;
      } else {
        const pendingList = this.pendingToolByCallId.get(callId) ?? [];
        pendingList.push({ record, turnId });
        this.pendingToolByCallId.set(callId, pendingList);
        if (turnId) {
          const set = this.pendingByTurn.get(turnId) ?? new Set();
          set.add(callId);
          this.pendingByTurn.set(turnId, set);
        }
      }
    }
    return record;
  }

  flushTurn(turnId: string): string[] {
    if (!turnId) return [];
    const callIds = this.pendingByTurn.get(turnId);
    if (!callIds) return [];
    const unresolved: string[] = [];
    for (const id of callIds) {
      const pendingList = this.pendingToolByCallId.get(id);
      if (!pendingList) continue;
      const resolved = this.stepIdByCallId.get(id);
      if (resolved) {
        for (const { record } of pendingList) {
          if (!record['gen_ai.step.id']) record['gen_ai.step.id'] = resolved;
        }
        this.pendingToolByCallId.delete(id);
      } else {
        unresolved.push(id);
        this.pendingToolByCallId.delete(id);
      }
    }
    this.pendingByTurn.delete(turnId);
    return unresolved;
  }
}

interface TurnBuffer {
  key: string;
  keySource: 'turn_id' | 'trace_id' | 'session_id' | 'ephemeral';
  keyValue: string;
  agentType: string;
  records: AgentActivityEntry[];
  completed: boolean;
  lastActivityMs: number;
}

/**
 * Synthesize records for orphan ZCode tool.call events.
 *
 * Two flavors of orphan are handled:
 *
 * A) Missing tool.result, step.id resolved: the tool.call was declared by a
 *    real llm.response (so it carries a real gen_ai.step.id), but ZCode never
 *    emitted the matching tool.result event. Without intervention the OTLP
 *    converter's `pairTool()` falls back to "first unconsumed result" and
 *    routes a sibling tool's result payload to this call's TOOL span (this
 *    is the S2 failure path: Read TOOL span ends up carrying Bash's cat
 *    stderr, while Bash's own TOOL span goes empty + 0ms). We synthesize an
 *    error tool.result keyed by the same gen_ai.tool.call.id so `pairTool`
 *    pairs it correctly, and the sibling result stays bound to its own call.
 *
 * B) Missing tool.result AND missing parent llm.response: the callId never
 *    got resolved to a step.id (Signal A flushed before rollout poll caught
 *    up). For this batch we additionally synthesize ONE llm.request +
 *    llm.response pair whose gen_ai.output.messages parts list every orphan
 *    tool_call (fixes `structure.step_has_one_llm` — the STEP now has 1 LLM).
 *    The synthesized llm.response carries finish_reasons=['tool_calls']
 *    (NOT terminal) so it cannot re-trigger Signal A. A synthetic step.id
 *    is backfilled onto these tool.call records so they escape the
 *    converter's `__no_step__` bucket.
 *
 * `unresolvedCallIds` (from the ZcodeStepResolver.flushTurn) distinguishes
 * the two: callIds in this set are flavor B; all other tool.call records in
 * buf that lack a matching tool.result are flavor A.
 *
 * Returns the synthesized records (NOT including the backfilled tool.call
 * mutations — those are applied in place on buf.records). Caller appends the
 * synthesized records to buf.records before conversion.
 */
function synthesizeOrphanZcodeToolRecords(
  buf: TurnBuffer,
  unresolvedCallIds: string[],
): AgentActivityEntry[] {
  if (buf.keySource !== 'turn_id') return [];

  const unresolvedSet = new Set(unresolvedCallIds);

  // Build set of callIds that already have a tool.result in buf — we don't
  // synthesize results for those.
  const existingResultCallIds = new Set<string>();
  for (const rec of buf.records) {
    if (rec['event.name'] === 'tool.result') {
      const id = rec['gen_ai.tool.call.id'] as string | undefined;
      if (id) existingResultCallIds.add(id);
    }
  }

  // Collect orphan tool.call records — those lacking a matching tool.result
  // (flavor A: resolved step.id but missing result event) OR whose callId is
  // in `unresolved` (flavor B: no parent llm.response ever arrived, even if
  // a tool.result does exist — the LLM pair still needs synthesis).
  const orphanToolCalls: AgentActivityEntry[] = [];
  for (const rec of buf.records) {
    if (rec['event.name'] !== 'tool.call') continue;
    const id = rec['gen_ai.tool.call.id'] as string | undefined;
    if (!id) continue;
    const hasResult = existingResultCallIds.has(id);
    const isUnresolved = unresolvedSet.has(id);
    if (!hasResult || isUnresolved) {
      orphanToolCalls.push(rec);
    }
  }

  if (orphanToolCalls.length === 0) return [];

  // Pick a synthetic step.id that doesn't collide with existing step.ids in buf.
  // Used only for flavor B orphans (no real step.id).
  const existingStepIds = new Set<string>();
  for (const rec of buf.records) {
    const sid = rec['gen_ai.step.id'] as string | undefined;
    if (sid) existingStepIds.add(sid);
  }
  let synthIdx = 0;
  let stepId = `${buf.keyValue}:synthetic-${synthIdx}`;
  while (existingStepIds.has(stepId)) {
    synthIdx++;
    stepId = `${buf.keyValue}:synthetic-${synthIdx}`;
  }

  // Find an LLM record to copy model/session/trace context from; fall back to
  // values on the orphan tool.call itself.
  const refLlm = buf.records.find(
    (r) => r['event.name'] === 'llm.response' || r['event.name'] === 'llm.request',
  );
  const refRec = refLlm ?? orphanToolCalls[0];
  const traceId = (refRec['trace_id'] as string) ?? '';
  const sessionId = (refRec['gen_ai.session.id'] as string) ?? '';
  const agentType = (refRec['gen_ai.agent.type'] as string) ?? ZCODE_AGENT_TYPE;
  const model = (refLlm?.['gen_ai.request.model'] as string) ?? 'unknown';

  const out: AgentActivityEntry[] = [];

  // Synthesize tool.result for every orphan tool.call that lacks one
  // (flavor A missing-result path; flavor B with existing result is skipped
  // to avoid duplicate tool.result events). Keyed by the SAME
  // gen_ai.tool.call.id so the OTLP converter's pairTool() matches it to
  // this call instead of falling back to a sibling's result.
  for (const tc of orphanToolCalls) {
    const callId = tc['gen_ai.tool.call.id'] as string;
    if (existingResultCallIds.has(callId)) continue;
    const callTimeNs = String(tc['time_unix_nano'] ?? '0');
    const callTimeMs = callTimeNs.length >= 16
      ? Number(BigInt(callTimeNs) / 1_000_000n)
      : Date.now();
    const resultTimeMs = callTimeMs + 1;
    const resultTimeNs = String(resultTimeMs) + '000000';
    const tcStepId = (tc['gen_ai.step.id'] as string | undefined) ?? stepId;
    out.push(buildAgentActivityEntry({
      timestamp: resultTimeMs,
      time_unix_nano: resultTimeNs,
      'event.name': 'tool.result',
      trace_id: traceId,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': buf.keyValue,
      'gen_ai.step.id': tcStepId,
      'gen_ai.agent.type': agentType,
      'gen_ai.tool.name': tc['gen_ai.tool.name'] ?? '',
      'gen_ai.tool.call.id': callId,
      'gen_ai.tool.call.arguments': tc['gen_ai.tool.call.arguments'],
      'gen_ai.tool.call.result': { status: 'error', error: 'orphaned' } as unknown as JsonValue,
      'gen_ai.tool.call.status': 'error',
      'tool.result.status': 'error',
      'error.type': 'orphaned',
      'error.message': 'ZCode did not emit tool.result for this call',
    }));
  }

  // Flavor B only: tool.call records whose callId is in `unresolved` (no
  // parent llm.response ever arrived). Backfill a synthetic step.id on them
  // (so they escape __no_step__ bucket) and synthesize ONE llm.request +
  // llm.response pair parenting all of them. Flavor A orphans already have a
  // real step.id from a real llm.response — synthesizing an LLM pair for
  // them would create a duplicate STEP and break `step_has_one_llm`.
  const trueOrphans = orphanToolCalls.filter(
    (tc) => unresolvedSet.has(tc['gen_ai.tool.call.id'] as string),
  );
  if (trueOrphans.length === 0) return out;

  for (const rec of trueOrphans) {
    if (!rec['gen_ai.step.id']) {
      (rec as Record<string, unknown>)['gen_ai.step.id'] = stepId;
    }
  }

  const firstCallMs = trueOrphans.reduce(
    (min, tc) => {
      const ns = String(tc['time_unix_nano'] ?? '0');
      const ms = ns.length >= 16 ? Number(BigInt(ns) / 1_000_000n) : Date.now();
      return Math.min(min, ms);
    },
    Date.now(),
  );
  const reqTimeMs = Math.max(0, firstCallMs - 1);
  const lastCallMs = trueOrphans.reduce(
    (max, tc) => {
      const ns = String(tc['time_unix_nano'] ?? '0');
      const ms = ns.length >= 16 ? Number(BigInt(ns) / 1_000_000n) : Date.now();
      return Math.max(max, ms);
    },
    0,
  );
  const respTimeMs = lastCallMs + 1;

  const pairingId = `synthetic-resp-${stepId}`;
  const toolCallParts = trueOrphans.map((tc) => ({
    type: 'tool_call',
    id: (tc['gen_ai.tool.call.id'] as string) ?? '',
    name: (tc['gen_ai.tool.name'] as string) ?? '',
    input: tc['gen_ai.tool.call.arguments'],
  }));

  out.push(buildAgentActivityEntry({
    timestamp: reqTimeMs,
    time_unix_nano: String(reqTimeMs) + '000000',
    'event.name': 'llm.request',
    trace_id: traceId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': buf.keyValue,
    'gen_ai.step.id': stepId,
    'gen_ai.request.id': `synthetic-req-${stepId}`,
    'gen_ai.response.id': pairingId,
    'gen_ai.agent.type': agentType,
    'gen_ai.request.model': model,
    'gen_ai.response.model': model,
  }));

  out.push(buildAgentActivityEntry({
    timestamp: respTimeMs,
    time_unix_nano: String(respTimeMs) + '000000',
    'event.name': 'llm.response',
    trace_id: traceId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': buf.keyValue,
    'gen_ai.step.id': stepId,
    'gen_ai.request.id': `synthetic-req-${stepId}`,
    'gen_ai.response.id': pairingId,
    'gen_ai.agent.type': agentType,
    'gen_ai.request.model': model,
    'gen_ai.response.model': model,
    'gen_ai.response.finish_reasons': ['tool_calls'],
    'gen_ai.output.messages': [{
      role: 'assistant',
      parts: toolCallParts,
      finish_reason: 'tool_calls',
    }] as unknown as JsonValue,
  }));

  return out;
}

interface AgentConvertState {
  provider: BasicTracerProvider;
  handler: ExtendedTelemetryHandler;
  inMem: InMemorySpanExporter;
  active: number;
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

type ResourceProjectionValue = string | number | boolean;

const SENSITIVE_RESOURCE_KEY_RE = /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$/i;

function resolveEndpointUrl(raw: string): string {
  let url = raw.replace(/\/+$/, '');
  if (!url.endsWith('/v1/traces')) {
    url += '/v1/traces';
  }
  return url;
}

const DEFAULT_MAX_EXPORT_BATCH_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_CONVERT_STATES = 64;

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
  private readonly resolvedEndpointUrl: string;
  private readonly debugDir: string;
  private readonly failedDir: string;
  private readonly resourceAttributeKeys: string[];

  private idleTimer?: ReturnType<typeof setInterval>;
  private inFlightExports = new Set<Promise<void>>();
  private flushedTurnKeys = new Set<string>();
  private readonly convertLocks = new Map<string, Promise<void>>();

  /**
   * Per-agentType flusher config overrides (plan 2.1 + 2.2). Keyed by
   * normalized agentType. Falls back to global cfg for missing fields.
   * Built once at construction from cfg.perAgentFlusherConfig.
   */
  private readonly perAgentConfig: Map<string, PerAgentFlusherConfig>;

  /**
   * Debounce timers for turn flush (plan 2.2). When `turnFlushDebounceMs > 0`
   * for an agentType, triggerFlush() schedules a setTimeout instead of
   * flushing immediately; late-arriving entries for the same turn key
   * appended during the debounce window are included in the single flush.
   *
   * Keyed by turn buffer key (same as turnBuffers/flushedTurnKeys).
   */
  private flushDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * ZCode step.id lazy resolver instance. Lazily instantiated on first zcode
   * entry. Single instance per flusher — state is process-scoped (in-memory),
   * which is fine since both rollout llm.response and hook tool.call events
   * for the same turn flow through this flusher.
   */
  private zcodeResolver: ZcodeStepResolver | undefined;

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
    const dataDir = cfg.dataDir ?? os.homedir() + '/.loongsuite-pilot';
    this.pilotVersion = readInstalledVersion(dataDir);
    this.resolvedEndpointUrl = resolveEndpointUrl(cfg.endpoint);
    this.debugDir = path.join(dataDir, 'logs', 'otlp-debug');
    this.failedDir = path.join(dataDir, 'logs', 'otlp-failed');
    this.resourceAttributeKeys = (cfg.resourceAttributeKeys ?? [])
      .map(key => key.trim())
      .filter(key => key.length > 0);

    if (cfg.captureMessageContent !== false) {
      process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'gen_ai_latest_experimental';
      process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ??= 'SPAN_ONLY';
    }

    if (cfg.turnIdleTimeoutMs && cfg.turnIdleTimeoutMs > 0) {
      this.idleTimer = setInterval(() => this.tickIdleTimeout(), 1000);
      this.idleTimer.unref();
    }

    // Build per-agentType override map. Lookup key is normalized agentType
    // (e.g. 'zcode'); missing fields fall back to global cfg inside the
    // accessors (getTurnIdleTimeoutMs / getTurnFlushDebounceMs).
    this.perAgentConfig = new Map();
    const perAgentRaw = cfg.perAgentFlusherConfig ?? {};
    for (const [agentType, override] of Object.entries(perAgentRaw)) {
      if (override && typeof override === 'object') {
        this.perAgentConfig.set(normalizeAgentType(agentType), override);
      }
    }
    // Per-agent idle timeout may be set even when global is 0; spin up the
    // ticker in that case too.
    const hasPerAgentIdle = [...this.perAgentConfig.values()].some(
      (o) => typeof o.turnIdleTimeoutMs === 'number' && (o.turnIdleTimeoutMs ?? 0) > 0,
    );
    if (hasPerAgentIdle && !this.idleTimer) {
      this.idleTimer = setInterval(() => this.tickIdleTimeout(), 1000);
      this.idleTimer.unref();
    }

    logger.info(`OTLP trace flusher initialized → ${this.resolvedEndpointUrl}`);
  }

  /** Per-agent idle timeout, falling back to global cfg. */
  private getTurnIdleTimeoutMs(agentType: string): number {
    const override = this.perAgentConfig.get(agentType);
    if (override && typeof override.turnIdleTimeoutMs === 'number') {
      return override.turnIdleTimeoutMs;
    }
    return this.cfg.turnIdleTimeoutMs ?? 0;
  }

  /** Per-agent debounce, falling back to global cfg (default 0 = no debounce). */
  private getTurnFlushDebounceMs(agentType: string): number {
    const override = this.perAgentConfig.get(agentType);
    if (override && typeof override.turnFlushDebounceMs === 'number') {
      return override.turnFlushDebounceMs;
    }
    return this.cfg.turnFlushDebounceMs ?? 0;
  }

  /**
   * Instantiate the ZCode step.id resolver on first zcode entry. The
   * resolver is process-scoped (in-memory state). Non-zcode agents skip.
   */
  private ensureZcodeResolver(): ZcodeStepResolver {
    if (!this.zcodeResolver) {
      this.zcodeResolver = new ZcodeStepResolver();
    }
    return this.zcodeResolver;
  }

  // --- Public API (BaseFlusher) ---

  async send(entry: AgentActivityEntry): Promise<void> {
    const { source, value, key } = this.resolveGroupKey(entry);
    const agentType = normalizeAgentType(
      (entry['gen_ai.agent.type'] as string) ?? '',
    );

    // ZCode step.id lazy backfill (plan 1.2): for zcode agent records only,
    // run the entry through the resolver. Rollout llm.response populates
    // call_id→step.id; hook tool.call/tool.result get backfilled. Late-
    // arriving tool events that miss the rollout window stay pending until
    // flushTurn() is called for the turn.
    if (agentType === ZCODE_AGENT_TYPE) {
      const resolver = this.ensureZcodeResolver();
      resolver.resolve(entry);
    }

    if (source === 'ephemeral') {
      await this.convertAndExport(agentType, [entry]);
      return;
    }

    // Late-arrival handling (plan 2.2): when debounce is active, a key that
    // is in flushedTurnKeys BUT still has a live debounce timer means the
    // turn hasn't actually flushed yet — we still accept the entry. The
    // existing timer will fire and pick up the re-created buffer (the
    // original buf was removed from turnBuffers in triggerFlush; send()'s
    // append path below creates a fresh one to hold the late entry). Once
    // the timer fires and runs the flush, the debounce timer is cleared and
    // subsequent arrivals are dropped.
    if (this.flushedTurnKeys.has(key) && !this.flushDebounceTimers.has(key)) {
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
    // sendBatch 路径走 triggerFlush 以尊重 per-agent turnFlushDebounceMs（AGE-675）。
    // flush()/shutdown 仍走原 flushCompleted 的立即 flush 语义（clearTimers + 三连），
    // 不受此处改动影响——避免 debounce>0 agent 在 flush()/shutdown 路径重新 schedule
    // timer 导致 exporter 已 shutdown 后才 fire、turn 数据丢失。
    const completed: TurnBuffer[] = [];
    for (const [, buf] of this.turnBuffers) {
      if (buf.completed) completed.push(buf);
    }
    for (const buf of completed) {
      this.triggerFlush(buf);
    }
    // debounce>0: triggerFlush 只 schedule timer，不入 inFlightExports；此循环对
    // zcode 是 no-op，timer 在 shutdown() 路径由 clearTimers + flushCompleted 兜底。
    // debounce=0: triggerFlush 立即 invokeFlushSingleTurn 入 inFlightExports，此循环等待。
    while (this.inFlightExports.size > 0) {
      const batch = [...this.inFlightExports];
      await Promise.allSettled(batch);
    }
  }

  async flush(): Promise<void> {
    // Clear any pending debounce timers so their callbacks don't fire after
    // the in-flight set has been awaited; their buffers are flushed below.
    for (const timer of this.flushDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.flushDebounceTimers.clear();

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
    for (const timer of this.flushDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.flushDebounceTimers.clear();

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
    const debounceMs = this.getTurnFlushDebounceMs(buf.agentType);
    if (debounceMs > 0) {
      // Debounce path (plan 2.2): keep buf in turnBuffers so late-arriving
      // entries (passing the late-arrival guard in send()) append to its
      // records array — they get included in the single flush when the
      // timer fires. The buf is removed only when the timer actually runs.
      const existing = this.flushDebounceTimers.get(buf.key);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.flushDebounceTimers.delete(buf.key);
        const liveBuf = this.turnBuffers.get(buf.key);
        if (!liveBuf) return;
        this.turnBuffers.delete(buf.key);
        this.invokeFlushSingleTurn(liveBuf);
      }, debounceMs);
      timer.unref?.();
      this.flushDebounceTimers.set(buf.key, timer);
      return;
    }
    this.turnBuffers.delete(buf.key);
    this.invokeFlushSingleTurn(buf);
  }

  /**
   * Wraps flushSingleTurn with the resolver's flushTurn() pre-pass for zcode
   * agent buffers. Non-zcode buffers skip the resolver. The in-flight
   * promise is tracked for shutdown.
   */
  private invokeFlushSingleTurn(buf: TurnBuffer): void {
    const p = (async () => {
      await this.flushSingleTurn(buf);
    })().catch((err) => {
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
    // ZCode step.id lazy resolver flush pass + orphan synthesis. Runs in
    // flushSingleTurn so ALL flush paths (Signal A immediate, sendBatch
    // deferred, idle timeout, shutdown) benefit.
    if (buf.agentType === ZCODE_AGENT_TYPE && buf.keySource === 'turn_id') {
      const resolver = this.ensureZcodeResolver();
      const unresolved = resolver.flushTurn(buf.keyValue);
      if (unresolved.length > 0) {
        logger.warn(`zcode step.id unresolved for ${unresolved.length} tool calls in turn ${buf.keyValue}`, {
          callIds: unresolved.slice(0, 10).join(','),
        });
      }
      // Always run synthesis — it covers both unresolved-step orphans AND
      // tool.call records that have a real step.id but no matching
      // tool.result event (S2 failure path: missing tool.result would
      // otherwise let pairTool() route a sibling's result payload here).
      const synthesized = synthesizeOrphanZcodeToolRecords(buf, unresolved);
      if (synthesized.length > 0) {
        buf.records.push(...synthesized);
        logger.info(`zcode orphan synthesis for turn ${buf.keyValue}: +${synthesized.length} records`);
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
    const convertKey = this.buildConvertStateKey(agentType, projectedResourceAttributes);
    const prev = this.convertLocks.get(convertKey) ?? Promise.resolve();
    const current = prev.then(() => this.doConvertAndExport(
      agentType,
      records,
      projectedResourceAttributes,
      convertKey,
    ));
    this.convertLocks.set(convertKey, current.catch(() => {}));
    await current;
  }

  private async doConvertAndExport(
    agentType: string,
    records: AgentActivityEntry[],
    projectedResourceAttributes: Record<string, ResourceProjectionValue>,
    convertKey: string,
  ): Promise<void> {
    const convertState = this.getOrCreateConvertState(agentType, projectedResourceAttributes, convertKey);
    const { handler, provider, inMem } = convertState;
    convertState.active += 1;

    try {
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
    } catch (err) {
      logger.error(`convert and export failed for ${agentType}`, { err: String(err) });
    } finally {
      convertState.active -= 1;
      this.evictConvertStates();
    }
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

  private getOrCreateConvertState(
    agentType: string,
    projectedResourceAttributes: Record<string, ResourceProjectionValue> = {},
    key = this.buildConvertStateKey(agentType, projectedResourceAttributes),
  ): AgentConvertState {
    let state = this.agentConvertStates.get(key);
    if (state) {
      this.agentConvertStates.delete(key);
      this.agentConvertStates.set(key, state);
      return state;
    }

    const resource = this.buildResource(agentType, projectedResourceAttributes);
    const inMem = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(inMem)],
    });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });

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
    projectedResourceAttributes: Record<string, ResourceProjectionValue>,
  ): string {
    return `${agentType}|${this.stableJson(projectedResourceAttributes)}`;
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

  private normalizeResourceAttributeValue(value: unknown): ResourceProjectionValue | undefined {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return undefined;
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

  private buildResource(
    agentType: string,
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
      'service.name': `${this.cfg.serviceName}-${agentType}`,
      'service.version': this.pilotVersion,
      'service.instance.id': this.instanceId,
      'service.namespace': 'loongsuite-pilot',
      'host.name': os.hostname(),
      'gen_ai.agent.type': agentType,
      'gen_ai.agent.system': resolveAgentSystem(agentType),
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
    const now = Date.now();
    for (const [, buf] of this.turnBuffers) {
      if (buf.completed) continue;
      const timeout = this.getTurnIdleTimeoutMs(buf.agentType);
      // `>=` so the first tick at exactly TTL boundary flushes (rather than
      // requiring one extra polling tick — easier to reason about in tests
      // and aligns with "no activity for N ms" semantics).
      if (timeout > 0 && now - buf.lastActivityMs >= timeout) {
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

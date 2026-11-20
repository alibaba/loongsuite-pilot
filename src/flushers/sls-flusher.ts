import ALY from '@alicloud/log';
import * as os from 'node:os';
import { Agent as UndiciAgent } from 'undici';
import { BaseFlusher, CodexOutputDurabilityError } from './base-flusher.js';
import {
  serialiseLogEntry,
  redactCodeGenerationFields,
} from '../normalization/entry-builder.js';
import type { AgentActivityEntry, SlsFlusherConfig, SlsEndpoint, SlsTimeoutConfig, SlsRetryConfig } from '../types/index.js';
import type { AlarmManager } from '../metrics/alarm-manager.js';
import { createLogger } from '../utils/logger.js';
import { formatTime } from '../utils/time-utils.js';
import { normalizeAgentType } from '../utils/agent-type-normalize.js';
import { LOCAL_IP, LOCAL_MAC, buildUserAgent } from '../utils/network-utils.js';
import { readInstalledVersion } from '../utils/fs-utils.js';
import * as path from 'node:path';
import { SlsFailureLogWriter } from './sls-failure-log-writer.js';
import {
  HttpError,
  postWebtracking,
  postApiKeyLogStoreLogs,
  isRetryable,
  RETRY_MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  WEBTRACKING_TIMEOUT_MS,
  WEBTRACKING_MAX_BODY_BYTES,
  WEBTRACKING_MAX_LOGS,
  RETRYABLE_STATUS_CODES,
} from './sls-transport.js';
import {
  classifySlsFailureAction,
  classifySlsSendError,
  formatSlsSendFailureMessage,
  type SlsFailureClass,
} from './sls-error-classifier.js';

const HOSTNAME = os.hostname();

const BATCH_MAX_SIZE = 20;
const FLUSH_INTERVAL_MS = 2000;
const DEFAULT_FLUSH_CONCURRENCY = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_TIMEOUT_MS = 15_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 30_000;
const FAILURES_TO_ESCALATE = 3;
const ALARM_COOLDOWN_MS = 60 * 60_000;
const INITIAL_CIRCUIT_BACKOFF_MS = 2_000;
const MAX_CIRCUIT_BACKOFF_MS = 10 * 60_000;
const MAX_DEFERRED_ENTRIES = 500;
const MAX_DEFERRED_BYTES = 16 * 1024 * 1024;
// Preserve single-record requests above our batching budget unless they exceed
// even the larger (binary) interpretation of SLS's documented 3 MB wire limit.
const MAX_SINGLE_WEBTRACKING_BYTES = 3 * 1024 * 1024;

interface QueuedLog {
  content: Record<string, string>;
  endpoint: SlsEndpoint;
  agentType?: string;
  byteSize: number;
}

interface QueuedBatch {
  key: string;
  logs: QueuedLog[];
  probe?: boolean;
}

const logger = createLogger('SlsFlusher');

export interface EndpointCounter {
  inEntries: number;
  inBytes: number;
  outEntries: number;
  /**
   * Bytes actually written out to this endpoint, i.e. what a billing view
   * charges for. Counted per endpoint, so a log fanned out to two endpoints is
   * counted twice — that is the point, the write happened twice.
   */
  outBytes: number;
  /** Entries whose send failed after retries, i.e. persisted instead of written. */
  outFailed: number;
  totalDelayMs: number;
  lastFlushTime: string;
  startTime: string;
  mode: string;
  project: string;
  logstore: string;
}

/**
 * What one endpoint's flush actually achieved. The send paths swallow their
 * failures on purpose (persist + alarm, never propagate), so promise settlement
 * says nothing about whether the bytes landed — the counters have to be driven
 * by this instead, or a dead backend still reports a full out_bytes.
 *
 * Webtracking splits a batch into several requests, so a flush can be partly
 * successful: the counts are per-entry, not per-batch.
 */
interface FlushOutcome {
  sentEntries: number;
  sentBytes: number;
  failedEntries: number;
  failures: SendFailure[];
}

interface SendFailure {
  failureClass: SlsFailureClass;
  message: string;
  attempted: boolean;
}

interface EndpointFailureState {
  transientCycles: number;
  configCycles: number;
  openUntil: number;
  backoffMs: number;
  lastConfigAlarmAt?: number;
  lastTransientAlarmAt?: number;
}

function sumByteSize(logs: QueuedLog[]): number {
  return logs.reduce((sum, log) => sum + log.byteSize, 0);
}

function flushSucceeded(logs: QueuedLog[]): FlushOutcome {
  return { sentEntries: logs.length, sentBytes: sumByteSize(logs), failedEntries: 0, failures: [] };
}

function emptyOutcome(): FlushOutcome {
  return { sentEntries: 0, sentBytes: 0, failedEntries: 0, failures: [] };
}

function addOutcome(total: FlushOutcome, outcome: FlushOutcome): void {
  total.sentEntries += outcome.sentEntries;
  total.sentBytes += outcome.sentBytes;
  total.failedEntries += outcome.failedEntries;
  for (const failure of outcome.failures) total.failures.push(failure);
}

const MAX_BACKOFF_MS = 60_000;

/** Compute backoff delay with optional full-jitter, capped at MAX_BACKOFF_MS. */
export function computeBackoff(baseMs: number, attempt: number, jitter: boolean): number {
  const exponential = Math.min(baseMs * 2 ** attempt, MAX_BACKOFF_MS);
  if (!jitter) return exponential;
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

export class SlsFlusher extends BaseFlusher {
  readonly name = 'sls';
  private readonly config: SlsFlusherConfig;
  private readonly queue: Map<string, QueuedLog[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly failedLogWriter: SlsFailureLogWriter;
  private readonly akClients: Map<string, any> = new Map();
  private readonly endpointCounters: Map<string, EndpointCounter> = new Map();
  private readonly endpointFailures = new Map<string, EndpointFailureState>();
  private alarmManager: AlarmManager | null = null;

  private readonly serviceName: string;
  private readonly serviceNamePrefix: string;
  private readonly userAgent: string;
  private readonly pilotVersion: string;

  private readonly resolvedTimeoutMs: number;
  private readonly resolvedRetryMaxAttempts: number;
  private readonly resolvedRetryBaseDelayMs: number;
  private readonly resolvedRetryJitter: boolean;
  private readonly resolvedFlushConcurrency: number;
  private readonly hostSn: string;
  private readonly hostIdentityTags: boolean;
  private readonly dispatcher: UndiciAgent | undefined;
  private flushPromise: Promise<void> | undefined;

  constructor(
    config: SlsFlusherConfig,
    dataDir: string,
    pilotVersion = readInstalledVersion(dataDir),
    hostSn?: string,
    hostIdentityTags = true,
  ) {
    super();
    this.config = config;
    this.hostSn = hostSn?.trim() ?? '';
    this.hostIdentityTags = hostIdentityTags;
    this.failedLogWriter = new SlsFailureLogWriter(
      path.join(dataDir, 'logs', 'sls-failed-logs'),
    );
    this.serviceName = config.serviceName || '';
    this.serviceNamePrefix = config.serviceNamePrefix || '';
    this.userAgent = buildUserAgent(dataDir);
    this.pilotVersion = pilotVersion;

    const tc = config.timeout ?? {};
    const rc = config.retry ?? {};
    this.resolvedTimeoutMs = tc.timeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
    this.resolvedRetryMaxAttempts = Math.max(1, rc.retryMaxAttempts ?? RETRY_MAX_ATTEMPTS);
    this.resolvedRetryBaseDelayMs = rc.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    this.resolvedRetryJitter = rc.retryJitter !== false;
    this.resolvedFlushConcurrency = Math.max(1, config.flushConcurrency ?? DEFAULT_FLUSH_CONCURRENCY);

    const hasPhaseTimeouts = tc.connectTimeoutMs != null || tc.headersTimeoutMs != null || tc.bodyTimeoutMs != null;
    if (hasPhaseTimeouts) {
      this.dispatcher = new UndiciAgent({
        connect: { timeout: tc.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS },
        headersTimeout: tc.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
        bodyTimeout: tc.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS,
      });
    }

    for (const ep of config.endpoints) {
      this.endpointCounters.set(ep.name, {
        inEntries: 0, inBytes: 0, outEntries: 0, outBytes: 0, outFailed: 0,
        totalDelayMs: 0, lastFlushTime: '', startTime: '',
        mode: ep.mode, project: ep.project, logstore: ep.logstore,
      });
      this.endpointFailures.set(ep.name, { transientCycles: 0, configCycles: 0, openUntil: 0, backoffMs: 0 });
    }
  }

  getEndpointCounters(): Map<string, EndpointCounter> {
    return this.endpointCounters;
  }

  setAlarmManager(alarmManager: AlarmManager): void {
    this.alarmManager = alarmManager;
  }

  private getAkClient(endpoint: SlsEndpoint): any {
    let client = this.akClients.get(endpoint.name);
    if (!client) {
      client = new ALY({
        accessKeyId: endpoint.accessKeyId ?? '',
        accessKeySecret: endpoint.accessKeySecret ?? '',
        endpoint: endpoint.endpoint,
        userAgent: this.userAgent,
      } as any);
      this.akClients.set(endpoint.name, client);
    }
    return client;
  }

  async start(): Promise<void> {
    await this.failedLogWriter.start();
    this.flushTimer = setInterval(
      () => void this.flush(),
      this.config.flushIntervalMs || FLUSH_INTERVAL_MS,
    );
  }

  async send(entry: AgentActivityEntry): Promise<void> {
    if (entry['gen_ai.agent.type'] === 'codex') return this.sendCodexBatch([entry]);
    const serialized = serialiseLogEntry(entry, { dropAgentScopedFields: true });
    serialized.version = this.pilotVersion;
    const agentType = normalizeAgentType(String(entry['gen_ai.agent.type'] ?? 'unknown'));

    for (const endpoint of this.config.endpoints) {
      const content = endpoint.redact
        ? redactCodeGenerationFields(serialized)
        : serialized;
      this.enqueue(endpoint, content, agentType);
    }
  }

  async sendBatch(entries: AgentActivityEntry[], _logicalBytes?: readonly number[], signal?: AbortSignal): Promise<void> {
    const codex: AgentActivityEntry[] = [];
    for (const entry of entries) {
      if (entry['gen_ai.agent.type'] === 'codex') codex.push(entry);
      else await this.send(entry);
    }
    if (codex.length) await this.sendCodexBatch(codex, signal);
  }

  private async sendCodexBatch(entries: AgentActivityEntry[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new CodexOutputDurabilityError('SLS');
    const serialized = entries.map(entry => ({
      ...serialiseLogEntry(entry, { dropAgentScopedFields: true }), version: this.pilotVersion,
    }));
    let failed = false;
    await this.runWithConcurrency(this.config.endpoints.map(endpoint => async () => {
      if (signal?.aborted) { failed = true; return; }
      const logs = serialized.map(content => this.createQueuedLog(endpoint,
        endpoint.redact ? redactCodeGenerationFields(content) : content, 'codex'));
      const counter = this.endpointCounters.get(endpoint.name);
      const startMs = Date.now();
      try {
        const outcome = await this.flushEndpoint(endpoint, logs, signal);
        if (counter) {
          counter.outEntries += outcome.sentEntries;
          counter.outBytes += outcome.sentBytes;
          counter.outFailed += outcome.failedEntries;
          counter.totalDelayMs += Date.now() - startMs;
          if (outcome.sentEntries > 0) counter.lastFlushTime = formatTime(new Date());
        }
        if (outcome.failedEntries > 0) failed = true;
        this.observeEndpointOutcome(endpoint, outcome, false);
      } catch (error) {
        failed = true;
        if (counter) {
          counter.outFailed += logs.length;
          counter.totalDelayMs += Date.now() - startMs;
        }
        if (!signal?.aborted) logger.error('SLS endpoint flush failed', { endpoint: endpoint.name, error: String(error) });
      }
    }), this.resolvedFlushConcurrency);
    if (failed || signal?.aborted) throw new CodexOutputDurabilityError('SLS');
  }

  flush(): Promise<void> {
    return this.flushPromise ??= this.flushQueued(false).finally(() => { this.flushPromise = undefined; });
  }

  private async flushQueued(force: boolean): Promise<void> {
    const batches = this.takeFlushBatches(force);
    if (batches.length > 0) {
      logger.debug('flush dispatching', {
        buckets: batches.length,
        totalLogs: batches.reduce((sum, batch) => sum + batch.logs.length, 0),
      });
    }

    const outcomes = new Map<SlsEndpoint, FlushOutcome>();
    await this.runWithConcurrency(batches.map(({ key, logs, probe }) => async () => {
      const endpoint = logs[0].endpoint;
      const startMs = Date.now();
      let outcome: FlushOutcome;
      try {
        outcome = await this.flushEndpoint(endpoint, logs);
      } catch (err) {
        outcome = await this.recordFailedBatch(endpoint, logs, err, 1);
      }
      if (probe && outcome.failures.some(failure => failure.attempted && failure.failureClass !== 'payload')) {
        // A failed reachability probe must not consume the queued record. It
        // will be retried after the next backoff or by the normal send path.
        this.queue.set(key, [...logs, ...(this.queue.get(key) ?? [])]);
        outcome.failedEntries = 0;
      }
      const counter = this.endpointCounters.get(endpoint.name);
      if (counter) {
        counter.outEntries += outcome.sentEntries;
        counter.outBytes += outcome.sentBytes;
        counter.outFailed += outcome.failedEntries;
        counter.totalDelayMs += Date.now() - startMs;
        if (outcome.sentEntries > 0) counter.lastFlushTime = formatTime(new Date());
      }
      const total = outcomes.get(endpoint) ?? emptyOutcome();
      addOutcome(total, outcome);
      outcomes.set(endpoint, total);
    }), this.resolvedFlushConcurrency);

    for (const [endpoint, outcome] of outcomes) this.observeEndpointOutcome(endpoint, outcome, true);
  }

  private takeFlushBatches(force: boolean): QueuedBatch[] {
    const now = Date.now();
    const deferred = new Map<string, { entries: number; bytes: number }>();
    if (!force) {
      for (const logs of this.queue.values()) {
        const name = logs[0].endpoint.name;
        if ((this.endpointFailures.get(name)?.openUntil ?? 0) <= now) continue;
        const size = deferred.get(name) ?? { entries: 0, bytes: 0 };
        size.entries += logs.length;
        size.bytes += sumByteSize(logs);
        deferred.set(name, size);
      }
    }

    const selected: QueuedBatch[] = [];
    const probes = new Set<string>();
    for (const [key, logs] of this.queue) {
      const name = logs[0].endpoint.name;
      const openUntil = this.endpointFailures.get(name)?.openUntil ?? 0;
      if (!force && openUntil > now) {
        const queued = deferred.get(name)!;
        if (queued.entries < MAX_DEFERRED_ENTRIES && queued.bytes < MAX_DEFERRED_BYTES) {
          logger.debug('SLS circuit open, retaining pending entries', { endpoint: name, entries: logs.length });
          continue;
        }
        // Under queue pressure, fall back to the normal send policy rather
        // than shedding records or growing an unbounded circuit backlog.
        queued.entries -= logs.length;
        queued.bytes -= sumByteSize(logs);
        logger.debug('SLS circuit open, sending under queue pressure', { endpoint: name, entries: logs.length });
      } else if (!force && openUntil > 0) {
        if (probes.has(name)) continue;
        probes.add(name);
        if (logs.length > 1) this.queue.set(key, logs.slice(1));
        else this.queue.delete(key);
        selected.push({ key, logs: [logs[0]], probe: true });
        continue;
      }
      this.queue.delete(key);
      selected.push({ key, logs });
    }
    return selected;
  }

  private async runWithConcurrency(
    tasks: Array<() => Promise<void>>,
    concurrency: number,
  ): Promise<void> {
    let idx = 0;
    const execute = async (): Promise<void> => {
      while (idx < tasks.length) {
        const task = tasks[idx++];
        await task();
      }
    };
    const workers = Array.from(
      { length: Math.min(concurrency, tasks.length) },
      () => execute(),
    );
    await Promise.all(workers);
  }

  private observeEndpointOutcome(endpoint: SlsEndpoint, outcome: FlushOutcome, trackCircuit: boolean): void {
    const state = this.endpointFailures.get(endpoint.name)!;
    const now = Date.now();
    const transient = outcome.failures.find(failure => failure.failureClass === 'transient');
    const config = outcome.failures.find(failure => failure.failureClass === 'config');
    const allFailedAs = (failureClass: SlsFailureClass) => outcome.sentEntries === 0
      && outcome.failures.length > 0 && outcome.failures.every(failure => failure.failureClass === failureClass);
    state.transientCycles = allFailedAs('transient') ? state.transientCycles + 1 : 0;

    if (transient && state.transientCycles >= FAILURES_TO_ESCALATE
      && (state.lastTransientAlarmAt === undefined || now - state.lastTransientAlarmAt >= ALARM_COOLDOWN_MS)) {
      state.lastTransientAlarmAt = now;
      this.alarmManager?.record('FLUSH_SEND_ALARM', '3', `${transient.message}; consecutive_failed_cycles=${state.transientCycles}`,
        { endpoint_name: endpoint.name, failure_class: 'transient' });
    }
    if (config && (state.lastConfigAlarmAt === undefined || now - state.lastConfigAlarmAt >= ALARM_COOLDOWN_MS)) {
      state.lastConfigAlarmAt = now;
      this.alarmManager?.record('FLUSH_SEND_ALARM', '1', config.message,
        { endpoint_name: endpoint.name, failure_class: 'config' });
    }
    for (const { failureClass, message } of outcome.failures) {
      if (failureClass === 'payload' || failureClass === 'quota') {
        this.alarmManager?.record('FLUSH_SEND_ALARM', failureClass === 'payload' ? '1' : '2', message,
          { endpoint_name: endpoint.name, failure_class: failureClass });
      }
      if (failureClass === 'quota') {
        this.alarmManager?.record('FLUSH_QUOTA_ALARM', '2', message, { endpoint_name: endpoint.name });
      }
    }

    // Codex waits for the transport ACK and already owns its durable retry.
    // Preflight-only failures also say nothing about destination readiness.
    if (!trackCircuit || (outcome.sentEntries === 0 && !outcome.failures.some(failure => failure.attempted))) return;
    if (!allFailedAs('config')) {
      if (state.openUntil && outcome.sentEntries > 0) logger.info('SLS circuit breaker recovered', { endpoint: endpoint.name });
      state.configCycles = 0;
      state.openUntil = 0;
      state.backoffMs = 0;
      return;
    }
    state.configCycles++;
    if (state.configCycles >= FAILURES_TO_ESCALATE) {
      state.backoffMs = state.backoffMs === 0 ? INITIAL_CIRCUIT_BACKOFF_MS
        : Math.min(state.backoffMs * 2, MAX_CIRCUIT_BACKOFF_MS);
      state.openUntil = now + state.backoffMs;
      logger.warn('SLS circuit breaker tripped', { endpoint: endpoint.name, backoffMs: state.backoffMs });
    }
  }

  private async recordFailedBatch(endpoint: SlsEndpoint, logs: QueuedLog[], error: unknown, attempts: number,
    bytes = sumByteSize(logs)): Promise<FlushOutcome> {
    const diagnosis = classifySlsSendError(error);
    const failureClass = classifySlsFailureAction(diagnosis);
    const message = formatSlsSendFailureMessage(endpoint.mode, diagnosis, attempts);
    logger.error('SLS batch not delivered', { endpoint: endpoint.name, failureClass, diagnostic: message });
    await this.persistFailedLogs(endpoint, logs.length, bytes, error);
    return { sentEntries: 0, sentBytes: 0, failedEntries: logs.length,
      failures: [{ failureClass, message, attempted: attempts > 0 }] };
  }

  /** Exact global name wins; otherwise managed endpoints may override the shared prefix. */
  private effectiveServiceName(endpoint?: SlsEndpoint): string {
    return this.serviceName || endpoint?.serviceName || this.serviceNamePrefix;
  }

  private resolveServiceName(endpoint?: SlsEndpoint, agentType?: string): string {
    const base = this.effectiveServiceName(endpoint);
    if (!base) return '';
    if (this.serviceName) return this.serviceName;
    return agentType ? `${base}-${agentType}` : base;
  }

  private buildAkTags(endpoint: SlsEndpoint, agentType?: string): Record<string, string>[] {
    const tags: Record<string, string>[] = [
      { __hostname__: HOSTNAME },
      ...(this.hostIdentityTags && LOCAL_MAC ? [{ __mac__: LOCAL_MAC }] : []),
      ...(this.hostIdentityTags && this.hostSn ? [{ __sn__: this.hostSn }] : []),
    ];
    const sn = this.resolveServiceName(endpoint, agentType);
    if (sn) tags.push({ __service_name__: sn });
    return tags;
  }

  private flushEndpoint(endpoint: SlsEndpoint, logs: QueuedLog[], signal?: AbortSignal): Promise<FlushOutcome> {
    signal?.throwIfAborted();
    if (endpoint.mode === 'ak') return this.flushViaAk(endpoint, logs, signal);
    if (endpoint.mode === 'apiKey') return this.flushViaApiKey(endpoint, logs, signal);
    return this.flushViaWebtracking(endpoint, logs, signal);
  }

  private buildWebtrackingTags(endpoint: SlsEndpoint, agentType?: string): Record<string, string> {
    const tags: Record<string, string> = {
      __hostname__: HOSTNAME,
      ...(this.hostIdentityTags && LOCAL_MAC ? { __mac__: LOCAL_MAC } : {}),
      ...(this.hostIdentityTags && this.hostSn ? { __sn__: this.hostSn } : {}),
    };
    const sn = this.resolveServiceName(endpoint, agentType);
    if (sn) tags['__service_name__'] = sn;
    return tags;
  }

  private warnIfMixedAgentTypes(logs: QueuedLog[]): void {
    if (this.effectiveServiceName(logs[0]?.endpoint)) {
      const types = new Set(logs.map(l => l.agentType));
      if (types.size > 1) logger.warn('mixed agentTypes in batch', { types: [...types] });
    }
  }

  private async flushViaAk(endpoint: SlsEndpoint, logs: QueuedLog[], signal?: AbortSignal): Promise<FlushOutcome> {
    this.warnIfMixedAgentTypes(logs);
    const now = Math.floor(Date.now() / 1000);
    const agentType = logs[0]?.agentType;
    const logGroup = {
      logs: logs.map(l => ({
        timestamp: now,
        content: l.content,
      })),
      source: LOCAL_IP,
      topic: endpoint.kind,
      tags: this.buildAkTags(endpoint, agentType),
    };

    const client = this.getAkClient(endpoint);
    let lastErr: unknown;
    let attempts = 0;
    for (let attempt = 0; attempt < this.resolvedRetryMaxAttempts; attempt++) {
      attempts = attempt + 1;
      signal?.throwIfAborted();
      try {
        await client.postLogStoreLogs(
          endpoint.project,
          endpoint.logstore,
          logGroup,
          // httpx exposes request options through this SDK hook, not a top-level signal.
          signal ? { beforeRequest: (options: Record<string, unknown>) => ({ ...options, signal }) } : undefined,
        );
        logger.debug('batch sent via ak', {
          endpoint: endpoint.name,
          project: endpoint.project,
          logstore: endpoint.logstore,
          count: logs.length,
        });
        return flushSucceeded(logs);
      } catch (err) {
        signal?.throwIfAborted();
        lastErr = err;
        if (!isRetryable(err) || attempt === this.resolvedRetryMaxAttempts - 1) break;
        const delay = computeBackoff(this.resolvedRetryBaseDelayMs, attempt, this.resolvedRetryJitter);
        logger.warn('SLS ak send retrying', {
          endpoint: endpoint.name,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(err),
        });
        await this.sleep(delay, signal);
      }
    }

    return this.recordFailedBatch(endpoint, logs, lastErr, attempts);
  }

  /** One batch, several requests: sum the per-chunk outcomes so a partial send counts as partial. */
  private async flushViaWebtracking(endpoint: SlsEndpoint, logs: QueuedLog[], signal?: AbortSignal): Promise<FlushOutcome> {
    const total = emptyOutcome();
    this.warnIfMixedAgentTypes(logs);
    const envelope = {
      __topic__: endpoint.kind ?? '',
      __source__: LOCAL_IP,
      __logs__: [] as Record<string, string>[],
      __tags__: this.buildWebtrackingTags(endpoint, logs[0]?.agentType),
    };
    const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope));
    const { chunks, oversize } = this.splitForWebtracking(logs, envelopeBytes);
    if (oversize.length) {
      signal?.throwIfAborted();
      const error = new HttpError(413, '{"errorCode":"PostBodyTooLarge"}');
      addOutcome(total, await this.recordFailedBatch(endpoint, oversize, error, 0,
        sumByteSize(oversize) + envelopeBytes * oversize.length));
    }
    for (const chunk of chunks) {
      signal?.throwIfAborted();
      const raw = JSON.stringify({ ...envelope, __logs__: chunk.map(log => log.content) });
      addOutcome(total, await this.postWebtracking(endpoint, chunk, raw, signal));
    }
    return total;
  }

  private async flushViaApiKey(endpoint: SlsEndpoint, logs: QueuedLog[], signal?: AbortSignal): Promise<FlushOutcome> {
    this.warnIfMixedAgentTypes(logs);
    const now = Math.floor(Date.now() / 1000);
    const agentType = logs[0]?.agentType;
    const logGroup = {
      logs: logs.map(l => ({
        timestamp: now,
        content: l.content,
      })),
      source: LOCAL_IP,
      topic: endpoint.kind,
      tags: this.buildAkTags(endpoint, agentType),
    };

    let lastErr: unknown;
    let attempts = 0;
    for (let attempt = 0; attempt < this.resolvedRetryMaxAttempts; attempt++) {
      attempts = attempt + 1;
      signal?.throwIfAborted();
      try {
        await postApiKeyLogStoreLogs(
          {
            endpoint: endpoint.endpoint,
            project: endpoint.project,
            logstore: endpoint.logstore,
            apiKey: endpoint.apiKey ?? '',
            timeoutMs: this.resolvedTimeoutMs,
            maxRetries: 1,
          },
          logGroup,
          { userAgent: this.userAgent, ...(signal ? { signal } : {}) },
        );
        logger.debug('batch sent via apiKey', {
          endpoint: endpoint.name,
          project: endpoint.project,
          logstore: endpoint.logstore,
          count: logs.length,
        });
        return flushSucceeded(logs);
      } catch (err) {
        signal?.throwIfAborted();
        lastErr = err;
        if (!isRetryable(err) || attempt === this.resolvedRetryMaxAttempts - 1) break;
        const delay = computeBackoff(this.resolvedRetryBaseDelayMs, attempt, this.resolvedRetryJitter);
        logger.warn('SLS apiKey send retrying', {
          endpoint: endpoint.name,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(err),
        });
        await this.sleep(delay, signal);
      }
    }

    return this.recordFailedBatch(endpoint, logs, lastErr, attempts);
  }

  private splitForWebtracking(logs: QueuedLog[], envelopeBytes: number): { chunks: QueuedLog[][]; oversize: QueuedLog[] } {
    const chunks: QueuedLog[][] = [];
    const oversize: QueuedLog[] = [];
    let current: QueuedLog[] = [];
    let currentSize = envelopeBytes;

    for (const log of logs) {
      if (envelopeBytes + log.byteSize > MAX_SINGLE_WEBTRACKING_BYTES) {
        // Altering a stringified canonical field could destroy its structure.
        // Report the failed record exactly as a terminal 413, without sending it.
        oversize.push(log);
        continue;
      }

      if (current.length > 0 &&
          (current.length >= WEBTRACKING_MAX_LOGS ||
           currentSize + 1 + log.byteSize > WEBTRACKING_MAX_BODY_BYTES)) {
        chunks.push(current);
        current = [];
        currentSize = envelopeBytes;
      }

      if (current.length > 0) currentSize++;
      current.push(log);
      currentSize += log.byteSize;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    return { chunks, oversize };
  }

  private async postWebtracking(endpoint: SlsEndpoint, logs: QueuedLog[], raw: string, signal?: AbortSignal): Promise<FlushOutcome> {
    const base = endpoint.project
      ? endpoint.endpoint.replace(/^(https?:\/\/)/, `$1${endpoint.project}.`)
      : endpoint.endpoint;
    const url = `${base}/logstores/${endpoint.logstore}/track`;

    let lastErr: unknown;
    let attempts = 0;
    for (let attempt = 0; attempt < this.resolvedRetryMaxAttempts; attempt++) {
      attempts = attempt + 1;
      signal?.throwIfAborted();
      const timeout = new AbortController();
      const timer = signal ? setTimeout(() => timeout.abort(new Error('TimeoutError')), this.resolvedTimeoutMs) : undefined;
      try {
        const fetchOptions: Record<string, unknown> = {
          method: 'POST',
          headers: {
            'x-log-apiversion': '0.6.0',
            'x-log-bodyrawsize': String(Buffer.byteLength(raw)),
            'Content-Type': 'application/json',
            'user-agent': this.userAgent,
          },
          body: raw,
          signal: signal ? AbortSignal.any([signal, timeout.signal]) : AbortSignal.timeout(this.resolvedTimeoutMs),
        };
        if (this.dispatcher) {
          fetchOptions.dispatcher = this.dispatcher;
        }
        const resp = await fetch(url, fetchOptions as RequestInit);

        if (!resp.ok) {
          const text = await resp.text();
          const err = new HttpError(resp.status, text);
          if (!RETRYABLE_STATUS_CODES.has(resp.status) || attempt === this.resolvedRetryMaxAttempts - 1) {
            throw err;
          }
          lastErr = err;
        } else {
          // The status is the ACK; dispose its unused body before removing the timeout.
          if (signal) await resp.body?.cancel();
          logger.debug('batch sent via webtracking', {
            project: endpoint.project,
            logstore: endpoint.logstore,
            count: logs.length,
          });
          return flushSucceeded(logs);
        }
      } catch (err) {
        signal?.throwIfAborted();
        lastErr = err;
        if (err instanceof HttpError && !RETRYABLE_STATUS_CODES.has(err.status)) break;
        if (attempt === this.resolvedRetryMaxAttempts - 1) break;
      } finally {
        clearTimeout(timer);
      }

      const delay = computeBackoff(this.resolvedRetryBaseDelayMs, attempt, this.resolvedRetryJitter);
      logger.warn('SLS webtracking retrying', {
        endpoint: endpoint.name,
        attempt: attempt + 1,
        delayMs: delay,
        error: String(lastErr),
      });
      await this.sleep(delay, signal);
    }

    return this.recordFailedBatch(endpoint, logs, lastErr, attempts, Buffer.byteLength(raw));
  }

  private async persistFailedLogs(
    endpoint: SlsEndpoint,
    batchCount: number,
    batchBytes: number,
    err: unknown,
  ): Promise<void> {
    await this.failedLogWriter.write({
      endpoint: endpoint.name,
      mode: endpoint.mode,
      project: endpoint.project,
      logstore: endpoint.logstore,
      kind: endpoint.kind,
      batchCount,
      batchBytes,
      error: err,
    });
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.flushPromise;
      await this.flushQueued(true);
    } finally {
      if (this.dispatcher) {
        await this.dispatcher.close();
      }
    }
  }

  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    const content: Record<string, string> = { topic };
    for (const [k, v] of Object.entries(payload)) {
      content[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }

    for (const endpoint of this.config.endpoints) {
      if (endpoint.kind !== 'mcp' && endpoint.kind !== 'trace') continue;
      try {
        if (endpoint.mode === 'ak') {
          const client = this.getAkClient(endpoint);
          await client.postLogStoreLogs(endpoint.project, endpoint.logstore, {
            logs: [{ timestamp: Math.floor(Date.now() / 1000), content }],
            source: LOCAL_IP,
            topic,
            tags: this.buildAkTags(endpoint),
          });
        } else if (endpoint.mode === 'apiKey') {
          await postApiKeyLogStoreLogs(
            {
              endpoint: endpoint.endpoint,
              project: endpoint.project,
              logstore: endpoint.logstore,
              apiKey: endpoint.apiKey ?? '',
              timeoutMs: this.resolvedTimeoutMs,
              maxRetries: 1,
            },
            {
              logs: [{ timestamp: Math.floor(Date.now() / 1000), content }],
              source: LOCAL_IP,
              topic,
              tags: this.buildAkTags(endpoint),
            },
            { userAgent: this.userAgent },
          );
        } else {
          await postWebtracking(
            {
              endpoint: endpoint.endpoint,
              project: endpoint.project,
              logstore: endpoint.logstore,
            },
            [content],
            {
              topic,
              source: LOCAL_IP,
              tags: {
                __hostname__: HOSTNAME,
                ...(this.hostIdentityTags && LOCAL_MAC ? { __mac__: LOCAL_MAC } : {}),
                ...(this.hostIdentityTags && this.hostSn ? { __sn__: this.hostSn } : {}),
              },
              userAgent: this.userAgent,
            },
          );
        }
      } catch {
        logger.warn('sendRaw failed', { topic, endpoint: endpoint.name });
      }
    }
  }

  private enqueue(endpoint: SlsEndpoint, content: Record<string, string>, agentType?: string): void {
    const base = `${endpoint.name}/${endpoint.project}/${endpoint.logstore}`;
    const key = (this.effectiveServiceName(endpoint) && agentType)
      ? `${base}/${agentType}`
      : base;
    let bucket = this.queue.get(key);
    if (!bucket) {
      bucket = [];
      this.queue.set(key, bucket);
    }
    bucket.push(this.createQueuedLog(endpoint, content, agentType));

    const maxSize = this.config.batchMaxSize || BATCH_MAX_SIZE;
    if (bucket.length >= maxSize) {
      void this.flush();
    }
  }

  private createQueuedLog(endpoint: SlsEndpoint, content: Record<string, string>, agentType?: string): QueuedLog {
    const byteSize = Buffer.byteLength(JSON.stringify(content));
    const counter = this.endpointCounters.get(endpoint.name);
    if (counter) {
      counter.inEntries++;
      counter.inBytes += byteSize;
      if (!counter.startTime) counter.startTime = formatTime(new Date());
    }

    return { content, endpoint, agentType, byteSize };
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, ms);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
}

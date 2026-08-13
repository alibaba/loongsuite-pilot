import ALY from '@alicloud/log';
import * as os from 'node:os';
import { Agent as UndiciAgent } from 'undici';
import { BaseFlusher } from './base-flusher.js';
import {
  serialiseLogEntry,
  redactCodeGenerationFields,
} from '../normalization/entry-builder.js';
import type { AgentActivityEntry, SlsFlusherConfig, SlsEndpoint, SlsTimeoutConfig, SlsRetryConfig } from '../types/index.js';
import type { AlarmManager } from '../metrics/alarm-manager.js';
import { createLogger } from '../utils/logger.js';
import { formatTime } from '../utils/time-utils.js';
import { normalizeAgentType } from '../utils/agent-type-normalize.js';
import { LOCAL_IP, buildUserAgent } from '../utils/network-utils.js';
import * as path from 'node:path';
import { SlsFailureLogWriter } from './sls-failure-log-writer.js';
import {
  HttpError,
  postWebtracking,
  postApiKeyLogStoreLogs,
  isRetryable,
  classifyFailure,
  FAILURE_CLASS_ALARM_LEVEL,
  type FailureClass,
  RETRY_MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  WEBTRACKING_TIMEOUT_MS,
  WEBTRACKING_MAX_BODY_BYTES,
  WEBTRACKING_MAX_LOGS,
  RETRYABLE_STATUS_CODES,
} from './sls-transport.js';

const HOSTNAME = os.hostname();

const BATCH_MAX_SIZE = 20;
const FLUSH_INTERVAL_MS = 2000;
const DEFAULT_FLUSH_CONCURRENCY = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_TIMEOUT_MS = 15_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 30_000;

// transient (network) failures don't alarm per-occurrence — the out_failed metric
// already carries the volume. Only a sustained outage (this many consecutive
// all-batch-failed flush cycles on one endpoint) escalates to a single alarm.
const TRANSIENT_ESCALATE_THRESHOLD = 3;

// A terminal (config) failure trips the breaker after this many consecutive
// occurrences, then backs off exponentially to stop pointless retries.
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_BASE_BACKOFF_MS = 2_000;
const CIRCUIT_MAX_BACKOFF_MS = 600_000; // 10 min upper bound

// config + escalated-transient alarms are cooldown-gated so a persistent fault
// reports once per window instead of every cycle. Re-arms after the window (not a once-guard).
const FLUSH_ALARM_COOLDOWN_MS = 3_600_000;

// Marker appended to a field truncated to fit the single-request body cap.
const TRUNCATION_MARKER = '...[TRUNCATED]';

interface QueuedLog {
  content: Record<string, string>;
  endpoint: SlsEndpoint;
  agentType?: string;
  byteSize: number;
}

interface CircuitState {
  configFails: number;
  openUntil: number;
  backoffMs: number;
}

/**
 * Raised by a send path when a batch (or part of it) finally fails. Carries the
 * split so flush() can credit succeeded entries and debit failed ones accurately,
 * instead of charging the whole batch to one side.
 */
export class FlushFailure extends Error {
  constructor(
    readonly succeededEntries: number,
    readonly failedEntries: number,
    readonly failureClass: FailureClass,
    readonly cause?: unknown,
  ) {
    super(`flush failed: ${failedEntries} entries (${failureClass})`);
    this.name = 'FlushFailure';
  }
}

const logger = createLogger('SlsFlusher');

export interface EndpointCounter {
  inEntries: number;
  inBytes: number;
  outEntries: number;
  outFailed: number;
  totalDelayMs: number;
  lastFlushTime: string;
  startTime: string;
  mode: string;
  endpoint: string;
  project: string;
  logstore: string;
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
  private alarmManager: AlarmManager | null = null;

  // Per-endpoint failure state (keyed by endpoint.name).
  private readonly transientFailStreak: Map<string, number> = new Map();
  private readonly circuits: Map<string, CircuitState> = new Map();
  // Cooldown gate for config + escalated-transient alarms, keyed `${endpoint}_${class}`.
  private readonly lastAlarmAt: Map<string, number> = new Map();

  private readonly serviceName: string;
  private readonly serviceNamePrefix: string;
  private readonly userAgent: string;

  private readonly resolvedTimeoutMs: number;
  private readonly resolvedRetryMaxAttempts: number;
  private readonly resolvedRetryBaseDelayMs: number;
  private readonly resolvedRetryJitter: boolean;
  private readonly resolvedFlushConcurrency: number;
  private readonly dispatcher: UndiciAgent | undefined;
  private flushing = false;

  constructor(config: SlsFlusherConfig, dataDir: string) {
    super();
    this.config = config;
    this.failedLogWriter = new SlsFailureLogWriter(
      path.join(dataDir, 'logs', 'sls-failed-logs'),
    );
    this.serviceName = config.serviceName || '';
    this.serviceNamePrefix = config.serviceNamePrefix || '';
    this.userAgent = buildUserAgent(dataDir);

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
        inEntries: 0, inBytes: 0, outEntries: 0, outFailed: 0,
        totalDelayMs: 0, lastFlushTime: '', startTime: '',
        mode: ep.mode, endpoint: ep.endpoint, project: ep.project, logstore: ep.logstore,
      });
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
    const serialized = serialiseLogEntry(entry, { dropAgentScopedFields: true });
    const agentType = normalizeAgentType(String(entry['gen_ai.agent.type'] ?? 'unknown'));

    for (const endpoint of this.config.endpoints) {
      const content = endpoint.redact
        ? redactCodeGenerationFields(serialized)
        : serialized;
      this.enqueue(endpoint, content, agentType);
    }
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.send(entry);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const batches = Array.from(this.queue.entries());
      this.queue.clear();

      if (batches.length > 0) {
        logger.debug('flush dispatching', {
          buckets: batches.length,
          totalLogs: batches.reduce((sum, [, logs]) => sum + logs.length, 0),
        });
      }

      const pending = batches
        .filter(([, logs]) => logs.length > 0)
        .map(([, logs]) => () => {
          const endpoint = logs[0].endpoint;
          const counter = this.endpointCounters.get(endpoint.name);

          // Circuit open (terminal endpoint, still within backoff): skip the send
          // entirely. Count the drop but do NOT re-send, re-persist, or re-alarm —
          // that is exactly the pointless-request/write loop we are stopping.
          if (this.isCircuitOpen(endpoint.name, Date.now())) {
            if (counter) counter.outFailed += logs.length;
            logger.debug('SLS circuit open, skipping send', {
              endpoint: endpoint.name,
              dropped: logs.length,
            });
            return Promise.resolve();
          }

          const startMs = Date.now();
          const send = this.flushEndpoint(endpoint, logs);
          return send.then(() => {
            if (counter) {
              counter.outEntries += logs.length;
              counter.totalDelayMs += Date.now() - startMs;
              counter.lastFlushTime = formatTime(new Date());
            }
            this.onEndpointSuccess(endpoint.name);
          }).catch(err => {
            const succeeded = err instanceof FlushFailure ? err.succeededEntries : 0;
            const failed = err instanceof FlushFailure ? err.failedEntries : logs.length;
            const failureClass: FailureClass =
              err instanceof FlushFailure ? err.failureClass : classifyFailure(err);
            if (counter) {
              counter.outEntries += succeeded;
              counter.outFailed += failed;
              counter.totalDelayMs += Date.now() - startMs;
            }
            logger.error('SLS endpoint flush failed', {
              endpoint: endpoint.name,
              failureClass,
              failed,
              succeeded,
            });
            this.onEndpointFailure(endpoint, succeeded, failureClass, err instanceof FlushFailure ? err.cause : err);
          });
        });

      await this.runWithConcurrency(pending, this.resolvedFlushConcurrency);
    } finally {
      this.flushing = false;
    }
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

  // --- per-endpoint failure handling -------------------------------------

  private isCircuitOpen(name: string, now: number): boolean {
    const c = this.circuits.get(name);
    return !!c && now < c.openUntil;
  }

  private onEndpointSuccess(name: string): void {
    // Any success (including a half-open probe) clears streak + breaker.
    this.transientFailStreak.delete(name);
    if (this.circuits.delete(name)) {
      logger.info('SLS circuit breaker recovered', { endpoint: name });
    }
  }

  private onEndpointFailure(
    endpoint: SlsEndpoint,
    succeeded: number,
    failureClass: FailureClass,
    cause: unknown,
  ): void {
    if (failureClass === 'transient') {
      // Only a whole-batch failure counts toward "sustained outage". Any partial
      // success means the endpoint is reachable → reset and stay silent.
      if (succeeded > 0) {
        this.transientFailStreak.delete(endpoint.name);
        return;
      }
      const streak = (this.transientFailStreak.get(endpoint.name) ?? 0) + 1;
      this.transientFailStreak.set(endpoint.name, streak);
      if (streak >= TRANSIENT_ESCALATE_THRESHOLD) {
        this.recordFailureAlarm(
          endpoint, 'transient',
          `SLS send failing continuously (${streak} cycles): ${String(cause)}`,
          true,
        );
      }
      return;
    }

    // Non-transient failure this cycle: not a clean transient outage → reset streak.
    this.transientFailStreak.delete(endpoint.name);

    if (failureClass === 'config') {
      this.recordFailureAlarm(endpoint, 'config', `SLS terminal config error: ${String(cause)}`, true);
      this.tripCircuit(endpoint.name);
      return;
    }
    // quota / payload: report per-occurrence (aggregated by AlarmManager, no cooldown).
    this.recordFailureAlarm(endpoint, failureClass, `SLS ${failureClass} failure: ${String(cause)}`, false);
  }

  private recordFailureAlarm(
    endpoint: SlsEndpoint,
    failureClass: FailureClass,
    message: string,
    cooldown: boolean,
  ): void {
    if (!this.alarmManager) return;
    if (cooldown) {
      const key = `${endpoint.name}_${failureClass}`;
      const now = Date.now();
      const last = this.lastAlarmAt.get(key) ?? 0;
      if (now - last < FLUSH_ALARM_COOLDOWN_MS) return;
      this.lastAlarmAt.set(key, now);
    }
    this.alarmManager.record(
      'FLUSH_SEND_ALARM',
      FAILURE_CLASS_ALARM_LEVEL[failureClass],
      message,
      { endpoint_name: endpoint.name, failure_class: failureClass },
    );
  }

  private tripCircuit(name: string): void {
    const c = this.circuits.get(name) ?? { configFails: 0, openUntil: 0, backoffMs: CIRCUIT_BASE_BACKOFF_MS };
    c.configFails++;
    if (c.configFails >= CIRCUIT_FAILURE_THRESHOLD) {
      // First trip uses base backoff; each subsequent probe failure doubles it (capped).
      c.backoffMs = c.openUntil === 0
        ? CIRCUIT_BASE_BACKOFF_MS
        : Math.min(c.backoffMs * 2, CIRCUIT_MAX_BACKOFF_MS);
      c.openUntil = Date.now() + c.backoffMs;
      logger.warn('SLS circuit breaker tripped', {
        endpoint: name,
        configFails: c.configFails,
        backoffMs: c.backoffMs,
      });
    }
    this.circuits.set(name, c);
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
    const tags: Record<string, string>[] = [{ __hostname__: HOSTNAME }];
    const sn = this.resolveServiceName(endpoint, agentType);
    if (sn) tags.push({ __service_name__: sn });
    return tags;
  }

  private flushEndpoint(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
    if (endpoint.mode === 'ak') return this.flushViaAk(endpoint, logs);
    if (endpoint.mode === 'apiKey') return this.flushViaApiKey(endpoint, logs);
    return this.flushViaWebtracking(endpoint, logs);
  }

  private buildWebtrackingTags(endpoint: SlsEndpoint, agentType?: string): Record<string, string> {
    const tags: Record<string, string> = { __hostname__: HOSTNAME };
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

  private async flushViaAk(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
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
    for (let attempt = 0; attempt < this.resolvedRetryMaxAttempts; attempt++) {
      try {
        await client.postLogStoreLogs(
          endpoint.project,
          endpoint.logstore,
          logGroup,
        );
        logger.debug('batch sent via ak', {
          endpoint: endpoint.name,
          project: endpoint.project,
          logstore: endpoint.logstore,
          count: logs.length,
        });
        return;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === this.resolvedRetryMaxAttempts - 1) break;
        const delay = computeBackoff(this.resolvedRetryBaseDelayMs, attempt, this.resolvedRetryJitter);
        logger.warn('SLS ak send retrying', {
          endpoint: endpoint.name,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(err),
        });
        await this.sleep(delay);
      }
    }

    logger.error('SLS send failed after retries', {
      endpoint: endpoint.name,
      error: String(lastErr),
    });
    await this.persistFailedLogs(
      endpoint,
      logs.length,
      logs.reduce((sum, log) => sum + log.byteSize, 0),
      lastErr,
    );
    throw lastErr;
  }

  private async flushViaWebtracking(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
    const { chunks, dropped } = this.splitForWebtracking(logs);
    let succeeded = 0;
    let failed = 0;
    let sendErr: unknown;

    // Oversize entries the splitter could not fit even after truncation: count as
    // failed and persist a payload record. They never reach the wire.
    if (dropped > 0) {
      failed += dropped;
      await this.persistFailedLogs(
        endpoint, dropped, 0,
        new Error(`payload dropped: ${dropped} entr${dropped === 1 ? 'y' : 'ies'} exceed WEBTRACKING_MAX_BODY_BYTES`),
      );
    }

    for (const chunk of chunks) {
      try {
        await this.postWebtracking(endpoint, chunk);
        succeeded += chunk.length;
      } catch (err) {
        failed += chunk.length;
        sendErr = err;
      }
    }

    if (failed > 0) {
      const failureClass: FailureClass = sendErr ? classifyFailure(sendErr) : 'payload';
      throw new FlushFailure(succeeded, failed, failureClass, sendErr ?? new Error('payload oversize'));
    }
  }

  private async flushViaApiKey(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
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
    for (let attempt = 0; attempt < this.resolvedRetryMaxAttempts; attempt++) {
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
          { userAgent: this.userAgent },
        );
        logger.debug('batch sent via apiKey', {
          endpoint: endpoint.name,
          project: endpoint.project,
          logstore: endpoint.logstore,
          count: logs.length,
        });
        return;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === this.resolvedRetryMaxAttempts - 1) break;
        const delay = computeBackoff(this.resolvedRetryBaseDelayMs, attempt, this.resolvedRetryJitter);
        logger.warn('SLS apiKey send retrying', {
          endpoint: endpoint.name,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(err),
        });
        await this.sleep(delay);
      }
    }

    logger.error('SLS apiKey send failed after retries', {
      endpoint: endpoint.name,
      error: String(lastErr),
    });
    await this.persistFailedLogs(
      endpoint,
      logs.length,
      logs.reduce((sum, log) => sum + log.byteSize, 0),
      lastErr,
    );
    throw lastErr;
  }

  private splitForWebtracking(logs: QueuedLog[]): { chunks: QueuedLog[][]; dropped: number } {
    const maxBytes = WEBTRACKING_MAX_BODY_BYTES;
    const chunks: QueuedLog[][] = [];
    let current: QueuedLog[] = [];
    let currentSize = 0;
    let dropped = 0;

    for (const raw of logs) {
      let log = raw;
      // byteSize was already computed in enqueue() from the same JSON.stringify —
      // reuse it here and only re-serialize after a truncation mutates content.
      let logSize = raw.byteSize;

      // A single entry over the cap can never fit any chunk. Try trimming its
      // largest field; if it still won't fit, drop it rather than emit a request
      // that is guaranteed to be rejected.
      if (logSize > maxBytes) {
        const trimmed = this.truncateOversizeEntry(log, maxBytes);
        if (!trimmed) {
          dropped++;
          continue;
        }
        log = trimmed;
        logSize = trimmed.byteSize;
        if (logSize > maxBytes) {
          dropped++;
          continue;
        }
      }

      if (current.length > 0 &&
          (current.length >= WEBTRACKING_MAX_LOGS ||
           currentSize + logSize > maxBytes)) {
        chunks.push(current);
        current = [];
        currentSize = 0;
      }

      current.push(log);
      currentSize += logSize;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    return { chunks, dropped };
  }

  /**
   * Shrink an oversize entry by truncating its largest string field so the whole
   * content serializes under maxBytes, preserving JSON validity, UTF-8 boundaries,
   * and leaving a marker. Returns null when trimming that one field can't get it
   * under the cap (caller then drops the entry).
   */
  private truncateOversizeEntry(log: QueuedLog, maxBytes: number): QueuedLog | null {
    const content: Record<string, string> = { ...log.content };
    let largestKey = '';
    let largestBytes = 0;
    for (const [k, v] of Object.entries(content)) {
      const len = Buffer.byteLength(v);
      if (len > largestBytes) {
        largestBytes = len;
        largestKey = k;
      }
    }
    if (!largestKey) return null;

    const overshoot = Buffer.byteLength(JSON.stringify(content)) - maxBytes;
    if (overshoot <= 0) return log;

    const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
    // Headroom absorbs JSON escaping of the retained slice.
    const targetBytes = largestBytes - overshoot - markerBytes - 256;
    if (targetBytes <= 0) return null;

    content[largestKey] = truncateUtf8Bytes(content[largestKey], targetBytes) + TRUNCATION_MARKER;
    const byteSize = Buffer.byteLength(JSON.stringify(content));
    return { ...log, content, byteSize };
  }

  private async postWebtracking(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
    this.warnIfMixedAgentTypes(logs);
    const agentType = logs[0]?.agentType;
    const body = {
      __topic__: endpoint.kind ?? '',
      __source__: LOCAL_IP,
      __logs__: logs.map(l => l.content),
      __tags__: this.buildWebtrackingTags(endpoint, agentType),
    };

    const raw = JSON.stringify(body);
    const base = endpoint.project
      ? endpoint.endpoint.replace(/^(https?:\/\/)/, `$1${endpoint.project}.`)
      : endpoint.endpoint;
    const url = `${base}/logstores/${endpoint.logstore}/track`;

    let lastErr: unknown;
    for (let attempt = 0; attempt < this.resolvedRetryMaxAttempts; attempt++) {
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
          signal: AbortSignal.timeout(this.resolvedTimeoutMs),
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
          logger.debug('batch sent via webtracking', {
            project: endpoint.project,
            logstore: endpoint.logstore,
            count: logs.length,
          });
          return;
        }
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError && !RETRYABLE_STATUS_CODES.has(err.status)) break;
        if (attempt === this.resolvedRetryMaxAttempts - 1) break;
      }

      const delay = computeBackoff(this.resolvedRetryBaseDelayMs, attempt, this.resolvedRetryJitter);
      logger.warn('SLS webtracking retrying', {
        endpoint: endpoint.name,
        attempt: attempt + 1,
        delayMs: delay,
        error: String(lastErr),
      });
      await this.sleep(delay);
    }

    logger.error('SLS webtracking send failed after retries', {
      endpoint: endpoint.name,
      error: String(lastErr),
    });
    await this.persistFailedLogs(endpoint, logs.length, Buffer.byteLength(raw), lastErr);
    throw lastErr;
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
      await this.flush();
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
              tags: { __hostname__: HOSTNAME },
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
    const byteSize = Buffer.byteLength(JSON.stringify(content));
    bucket.push({ content, endpoint, agentType, byteSize });

    const counter = this.endpointCounters.get(endpoint.name);
    if (counter) {
      counter.inEntries++;
      counter.inBytes += byteSize;
      if (!counter.startTime) counter.startTime = formatTime(new Date());
    }

    const maxSize = this.config.batchMaxSize || BATCH_MAX_SIZE;
    if (bucket.length >= maxSize) {
      void this.flush();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/** UTF-8-safe truncation to at most maxBytes, without splitting a multibyte char. */
function truncateUtf8Bytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

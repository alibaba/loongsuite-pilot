import ALY from '@alicloud/log';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { BaseFlusher, type FlusherBackpressureState } from './base-flusher.js';
import {
  serialiseLogEntry,
  redactCodeGenerationFields,
} from '../normalization/entry-builder.js';
import type { AgentActivityEntry, SlsFlusherConfig, SlsEndpoint } from '../types/index.js';
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
  isRetryable,
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
const RETRY_INITIAL_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;
const RETRY_MAX_AGE_MS = 60 * 60 * 1000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 3_000;
const BACKPRESSURE_HIGH_WATERMARK_ENTRIES = 5_000;
const BACKPRESSURE_LOW_WATERMARK_ENTRIES = 1_000;
const MAX_QUEUED_ENTRIES = 20_000;
const BACKPRESSURE_HIGH_WATERMARK_BYTES = 64 * 1024 * 1024;
const BACKPRESSURE_LOW_WATERMARK_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_BYTES = 256 * 1024 * 1024;
const BACKPRESSURE_ALARM_THRESHOLD_MS = 20 * 60 * 1000;
const BACKPRESSURE_STATE_CACHE_MS = 500;

interface QueuedLog {
  content: Record<string, string>;
  endpoint: SlsEndpoint;
  agentType?: string;
  sizeBytes: number;
  enqueuedAt: number;
  firstFailureAt?: number;
}

interface EndpointRetryState {
  consecutiveFailures: number;
  nextRetryAt: number;
  lastAttemptAt: number;
  lastSuccessAt: number;
  lastErrorAt: number;
  lastErrorType: string;
  lastStatusCode?: number;
}

interface ErrorClassification {
  retryable: boolean;
  type: string;
  statusCode?: number;
}

interface QueueStats {
  entries: number;
  bytes: number;
  oldestQueuedAt: number;
}

interface FlushOptions {
  ignoreCooldown?: boolean;
  deadlineMs?: number;
}

interface SlsQueuePolicy {
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  retryMaxAgeMs: number;
  shutdownDrainTimeoutMs: number;
  backpressureHighWatermarkEntries: number;
  backpressureLowWatermarkEntries: number;
  maxQueuedEntries: number;
  backpressureHighWatermarkBytes: number;
  backpressureLowWatermarkBytes: number;
  maxQueuedBytes: number;
}

type SlsQueuePolicyOverrides = Partial<SlsQueuePolicy>;

interface ShutdownPendingRecord {
  version: 1;
  createdAt: number;
  endpointName: string;
  project: string;
  logstore: string;
  kind: SlsEndpoint['kind'];
  mode: SlsEndpoint['mode'];
  logs: Array<{
    content: Record<string, string>;
    agentType?: string;
    sizeBytes?: number;
    enqueuedAt?: number;
    firstFailureAt?: number;
  }>;
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
  queuedEntries?: number;
  queuedBytes?: number;
  oldestQueuedAgeMs?: number;
  backpressureActive?: boolean;
  backpressureReason?: string;
  backpressureSince?: string;
  consecutiveFailures?: number;
  lastAttemptTime?: string;
  lastSuccessTime?: string;
  lastErrorTime?: string;
  lastErrorType?: string;
  lastStatusCode?: number;
  nextRetryTime?: string;
  retryExpiredEntriesTotal?: number;
  queueOverflowEntriesTotal?: number;
  nonRetryableFailedEntriesTotal?: number;
  shutdownPendingWrittenEntriesTotal?: number;
  shutdownPendingRestoredEntriesTotal?: number;
}

export class SlsFlusher extends BaseFlusher {
  readonly name = 'sls';
  private readonly config: SlsFlusherConfig;
  private readonly policy: SlsQueuePolicy;
  private readonly queue: Map<string, QueuedLog[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly shutdownPendingDir: string;
  private readonly failedLogWriter: SlsFailureLogWriter;
  private readonly akClients: Map<string, any> = new Map();
  private readonly endpointCounters: Map<string, EndpointCounter> = new Map();
  private readonly retryStates: Map<string, EndpointRetryState> = new Map();
  private alarmManager: AlarmManager | null = null;
  private flushPromise: Promise<void> | null = null;
  private backpressureActive = false;
  private backpressureSince = 0;
  private backpressureReason = '';
  private backpressureAlarmRecorded = false;
  private cachedBackpressureState: FlusherBackpressureState | null = null;
  private cachedBackpressureStateAt = 0;
  private readonly totalQueueStats: QueueStats = {
    entries: 0,
    bytes: 0,
    oldestQueuedAt: 0,
  };
  private readonly endpointQueueStats: Map<string, QueueStats> = new Map();

  private readonly serviceName: string;
  private readonly userAgent: string;

  constructor(config: SlsFlusherConfig, dataDir: string) {
    super();
    this.config = config;
    const policyOverrides = config as SlsFlusherConfig & SlsQueuePolicyOverrides;
    this.policy = {
      retryInitialDelayMs: policyOverrides.retryInitialDelayMs ?? RETRY_INITIAL_DELAY_MS,
      retryMaxDelayMs: policyOverrides.retryMaxDelayMs ?? RETRY_MAX_DELAY_MS,
      retryMaxAgeMs: policyOverrides.retryMaxAgeMs ?? RETRY_MAX_AGE_MS,
      shutdownDrainTimeoutMs: policyOverrides.shutdownDrainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS,
      backpressureHighWatermarkEntries:
        policyOverrides.backpressureHighWatermarkEntries ?? BACKPRESSURE_HIGH_WATERMARK_ENTRIES,
      backpressureLowWatermarkEntries:
        policyOverrides.backpressureLowWatermarkEntries ?? BACKPRESSURE_LOW_WATERMARK_ENTRIES,
      maxQueuedEntries: policyOverrides.maxQueuedEntries ?? MAX_QUEUED_ENTRIES,
      backpressureHighWatermarkBytes:
        policyOverrides.backpressureHighWatermarkBytes ?? BACKPRESSURE_HIGH_WATERMARK_BYTES,
      backpressureLowWatermarkBytes:
        policyOverrides.backpressureLowWatermarkBytes ?? BACKPRESSURE_LOW_WATERMARK_BYTES,
      maxQueuedBytes: policyOverrides.maxQueuedBytes ?? MAX_QUEUED_BYTES,
    };
    this.shutdownPendingDir = path.join(dataDir, 'sls-shutdown-pending');
    this.failedLogWriter = new SlsFailureLogWriter(
      path.join(dataDir, 'logs', 'sls-failed-logs'),
    );
    this.serviceName = config.serviceNamePrefix || '';
    this.userAgent = buildUserAgent(dataDir);
    for (const ep of config.endpoints) {
      this.endpointQueueStats.set(ep.name, {
        entries: 0,
        bytes: 0,
        oldestQueuedAt: 0,
      });
      this.endpointCounters.set(ep.name, {
        inEntries: 0, inBytes: 0, outEntries: 0, outFailed: 0,
        totalDelayMs: 0, lastFlushTime: '', startTime: '',
        mode: ep.mode, endpoint: ep.endpoint, project: ep.project, logstore: ep.logstore,
        queuedEntries: 0, queuedBytes: 0, oldestQueuedAgeMs: 0,
        backpressureActive: false, backpressureReason: '', backpressureSince: '',
        consecutiveFailures: 0, lastAttemptTime: '', lastSuccessTime: '',
        lastErrorTime: '', lastErrorType: '', nextRetryTime: '',
        retryExpiredEntriesTotal: 0, queueOverflowEntriesTotal: 0,
        nonRetryableFailedEntriesTotal: 0, shutdownPendingWrittenEntriesTotal: 0,
        shutdownPendingRestoredEntriesTotal: 0,
      });
      this.retryStates.set(ep.name, {
        consecutiveFailures: 0,
        nextRetryAt: 0,
        lastAttemptAt: 0,
        lastSuccessAt: 0,
        lastErrorAt: 0,
        lastErrorType: '',
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
    await fs.mkdir(this.shutdownPendingDir, { recursive: true });
    await this.restoreShutdownPending();
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
      await this.enqueue(endpoint, content, agentType);
    }
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.send(entry);
    }
  }

  async flush(options: FlushOptions = {}): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushInternal(options).finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  override getBackpressureState(): FlusherBackpressureState {
    const now = Date.now();
    if (
      this.cachedBackpressureState &&
      now - this.cachedBackpressureStateAt < BACKPRESSURE_STATE_CACHE_MS
    ) {
      return { ...this.cachedBackpressureState };
    }

    this.syncDeliveryHealth(now);
    return { ...(this.cachedBackpressureState ?? { active: false }) };
  }

  private async flushInternal(options: FlushOptions): Promise<void> {
    const deadlineAt = options.deadlineMs ? Date.now() + options.deadlineMs : 0;
    let madeProgress = false;

    do {
      madeProgress = false;
      const buckets = Array.from(this.queue.entries());
      if (buckets.length > 0) {
        logger.debug('flush dispatching', {
          buckets: buckets.length,
          totalLogs: buckets.reduce((sum, [, logs]) => sum + logs.length, 0),
        });
      }

      for (const [key, bucket] of buckets) {
        if (deadlineAt > 0 && Date.now() >= deadlineAt) {
          this.syncDeliveryHealth();
          return;
        }
        if (bucket.length === 0) {
          this.queue.delete(key);
          continue;
        }

        const endpoint = bucket[0].endpoint;
        const retryState = this.getRetryState(endpoint.name);
        const now = Date.now();
        const expired = this.takeExpiredRetryableLogs(bucket, now);
        if (expired.length > 0) {
          await this.expireRetryableLogs(endpoint, expired, now);
          madeProgress = true;
          if (bucket.length === 0) this.queue.delete(key);
          continue;
        }
        if (!options.ignoreCooldown && retryState.nextRetryAt > now) {
          continue;
        }

        const logs = this.buildSendSlice(endpoint, bucket);
        if (logs.length === 0) continue;

        const counter = this.endpointCounters.get(endpoint.name);
        const startMs = Date.now();
        this.markAttempt(endpoint.name, startMs);
        try {
          const send = endpoint.mode === 'ak'
            ? this.flushViaAk(endpoint, logs)
            : this.flushViaWebtracking(endpoint, logs);
          await this.withDeadline(send, deadlineAt);

          bucket.splice(0, logs.length);
          this.trackDequeuedLogs(logs);
          if (bucket.length === 0) this.queue.delete(key);
          if (counter) {
            counter.outEntries += logs.length;
            counter.totalDelayMs += Date.now() - startMs;
            counter.lastFlushTime = formatTime(new Date());
          }
          this.markSuccess(endpoint.name);
          madeProgress = true;
        } catch (err) {
          const classification = this.classifyError(err);
          if (counter) {
            counter.totalDelayMs += Date.now() - startMs;
          }
          this.markError(endpoint.name, classification);
          if (classification.statusCode === 429) {
            this.alarmManager?.record(
              'FLUSH_QUOTA_ALARM', '2',
              `SLS endpoint throttled (429)`,
              { endpoint_name: endpoint.name },
            );
          }

          if (classification.retryable) {
            for (const log of logs) {
              log.firstFailureAt ??= Date.now();
            }
            this.scheduleRetry(endpoint, classification, err);
            continue;
          }

          await this.persistFailedLogs(endpoint, logs, err);
          bucket.splice(0, logs.length);
          this.trackDequeuedLogs(logs);
          if (bucket.length === 0) this.queue.delete(key);
          if (counter) {
            counter.outFailed += logs.length;
            counter.nonRetryableFailedEntriesTotal =
              (counter.nonRetryableFailedEntriesTotal ?? 0) + logs.length;
          }
          this.alarmManager?.record(
            'FLUSH_SEND_ALARM', '2',
            `SLS non-retryable send failed: ${String(err)}`,
            { endpoint_name: endpoint.name },
          );
          logger.error('SLS endpoint non-retryable flush failed', {
            endpoint: endpoint.name,
            errorType: classification.type,
            statusCode: classification.statusCode,
            count: logs.length,
            error: String(err),
          });
          madeProgress = true;
        } finally {
          this.syncDeliveryHealth();
        }
      }
    } while (madeProgress);

    this.syncDeliveryHealth();
  }

  /** Per-endpoint service name: managed endpoints may override the shared prefix. */
  private effectiveServiceName(endpoint?: SlsEndpoint): string {
    return endpoint?.serviceName || this.serviceName;
  }

  private resolveServiceName(endpoint?: SlsEndpoint, agentType?: string): string {
    const base = this.effectiveServiceName(endpoint);
    if (!base) return '';
    return agentType ? `${base}-${agentType}` : base;
  }

  private buildAkTags(endpoint: SlsEndpoint, agentType?: string): Record<string, string>[] {
    const tags: Record<string, string>[] = [{ __hostname__: HOSTNAME }];
    const sn = this.resolveServiceName(endpoint, agentType);
    if (sn) tags.push({ __service_name__: sn });
    return tags;
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
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
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
        if (!isRetryable(err) || attempt === RETRY_MAX_ATTEMPTS - 1) break;
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
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
    throw lastErr;
  }

  private async flushViaWebtracking(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
    const chunks = this.splitForWebtracking(logs);
    for (const chunk of chunks) {
      await this.postWebtracking(endpoint, chunk);
    }
  }

  private splitForWebtracking(logs: QueuedLog[]): QueuedLog[][] {
    const chunks: QueuedLog[][] = [];
    let current: QueuedLog[] = [];
    let currentSize = 0;

    for (const log of logs) {
      const logSize = Buffer.byteLength(JSON.stringify(log.content));

      if (current.length > 0 &&
          (current.length >= WEBTRACKING_MAX_LOGS ||
           currentSize + logSize > WEBTRACKING_MAX_BODY_BYTES)) {
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
    return chunks;
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
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'x-log-apiversion': '0.6.0',
            'x-log-bodyrawsize': String(Buffer.byteLength(raw)),
            'Content-Type': 'application/json',
            'user-agent': this.userAgent,
          },
          body: raw,
          signal: AbortSignal.timeout(WEBTRACKING_TIMEOUT_MS),
        });

        if (!resp.ok) {
          const text = await resp.text();
          const err = new HttpError(resp.status, text);
          if (!RETRYABLE_STATUS_CODES.has(resp.status) || attempt === RETRY_MAX_ATTEMPTS - 1) {
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
        if (attempt === RETRY_MAX_ATTEMPTS - 1) break;
      }

      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
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
    throw lastErr;
  }

  private buildSendSlice(endpoint: SlsEndpoint, bucket: QueuedLog[]): QueuedLog[] {
    const maxSize = this.config.batchMaxSize || BATCH_MAX_SIZE;
    const candidate = bucket.slice(0, maxSize);
    if (endpoint.mode !== 'webtracking') return candidate;
    return this.splitForWebtracking(candidate)[0] ?? [];
  }

  private classifyError(err: unknown): ErrorClassification {
    const statusCode = this.extractStatusCode(err);
    if (statusCode !== undefined) {
      if (statusCode === 429) return { retryable: true, type: 'quota', statusCode };
      if (RETRYABLE_STATUS_CODES.has(statusCode)) {
        return { retryable: true, type: 'retryable_status', statusCode };
      }
      return { retryable: false, type: 'non_retryable_status', statusCode };
    }
    if (isRetryable(err)) return { retryable: true, type: 'retryable_network' };
    return { retryable: false, type: 'non_retryable_error' };
  }

  private extractStatusCode(err: unknown): number | undefined {
    if (err instanceof HttpError) return err.status;
    if (!err || typeof err !== 'object') return undefined;
    const record = err as Record<string, unknown>;
    const raw = record.statusCode ?? record.status ?? record.httpStatusCode;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  private getRetryState(endpointName: string): EndpointRetryState {
    let state = this.retryStates.get(endpointName);
    if (!state) {
      state = {
        consecutiveFailures: 0,
        nextRetryAt: 0,
        lastAttemptAt: 0,
        lastSuccessAt: 0,
        lastErrorAt: 0,
        lastErrorType: '',
      };
      this.retryStates.set(endpointName, state);
    }
    return state;
  }

  private markAttempt(endpointName: string, now: number): void {
    const state = this.getRetryState(endpointName);
    state.lastAttemptAt = now;
  }

  private markError(endpointName: string, classification: ErrorClassification): void {
    const state = this.getRetryState(endpointName);
    state.lastErrorAt = Date.now();
    state.lastErrorType = classification.type;
    state.lastStatusCode = classification.statusCode;
  }

  private markSuccess(endpointName: string): void {
    const state = this.getRetryState(endpointName);
    if (state.consecutiveFailures > 0) {
      logger.info('SLS endpoint recovered after retry failures', {
        endpoint: endpointName,
        consecutiveFailures: state.consecutiveFailures,
        outageMs: state.lastErrorAt > 0 ? Date.now() - state.lastErrorAt : 0,
      });
    }
    state.consecutiveFailures = 0;
    state.nextRetryAt = 0;
    state.lastSuccessAt = Date.now();
  }

  private scheduleRetry(
    endpoint: SlsEndpoint,
    classification: ErrorClassification,
    err: unknown,
  ): void {
    const state = this.getRetryState(endpoint.name);
    state.consecutiveFailures += 1;
    const delayMs = this.computeRetryDelayMs(state.consecutiveFailures);
    state.nextRetryAt = Date.now() + delayMs;

    this.alarmManager?.record(
      'FLUSH_SEND_ALARM', '2',
      `SLS retryable send failed: ${String(err)}`,
      { endpoint_name: endpoint.name },
    );
    logger.warn('SLS retry cooldown scheduled', {
      endpoint: endpoint.name,
      errorType: classification.type,
      statusCode: classification.statusCode,
      consecutiveFailures: state.consecutiveFailures,
      retryDelayMs: delayMs,
      nextRetryTime: formatTime(new Date(state.nextRetryAt)),
      error: String(err),
    });
  }

  private computeRetryDelayMs(consecutiveFailures: number): number {
    const initial = this.policy.retryInitialDelayMs;
    const max = this.policy.retryMaxDelayMs;
    return Math.min(max, initial * 2 ** Math.max(0, consecutiveFailures - 1));
  }

  private takeExpiredRetryableLogs(bucket: QueuedLog[], now: number): QueuedLog[] {
    const retryMaxAgeMs = this.policy.retryMaxAgeMs;
    const maxSize = this.config.batchMaxSize || BATCH_MAX_SIZE;
    const expired: QueuedLog[] = [];
    while (
      expired.length < maxSize &&
      bucket.length > 0 &&
      bucket[0].firstFailureAt !== undefined &&
      now - bucket[0].firstFailureAt >= retryMaxAgeMs
    ) {
      expired.push(bucket.shift()!);
    }
    this.trackDequeuedLogs(expired);
    return expired;
  }

  private async expireRetryableLogs(
    endpoint: SlsEndpoint,
    logs: QueuedLog[],
    now: number,
  ): Promise<void> {
    const oldestFailureAt = logs.reduce(
      (oldest, log) => Math.min(oldest, log.firstFailureAt ?? now),
      now,
    );
    await this.persistFailedLogs(
      endpoint,
      logs,
      new Error(`SLS retry TTL expired after ${now - oldestFailureAt}ms`),
    );
    const counter = this.endpointCounters.get(endpoint.name);
    if (counter) {
      counter.outFailed += logs.length;
      counter.retryExpiredEntriesTotal =
        (counter.retryExpiredEntriesTotal ?? 0) + logs.length;
    }
    this.markError(endpoint.name, { retryable: false, type: 'retry_expired' });
    this.alarmManager?.record(
      'FLUSH_RETRY_EXPIRED_ALARM', '2',
      `SLS retry TTL expired for ${logs.length} entries`,
      { endpoint_name: endpoint.name },
    );
    logger.warn('SLS retry TTL expired', {
      endpoint: endpoint.name,
      count: logs.length,
      ageMs: now - oldestFailureAt,
    });
  }

  private calculateQueueStats(endpointName?: string): QueueStats {
    const stats = endpointName
      ? this.endpointQueueStats.get(endpointName)
      : this.totalQueueStats;
    return stats
      ? { ...stats }
      : { entries: 0, bytes: 0, oldestQueuedAt: 0 };
  }

  private trackEnqueuedLog(log: QueuedLog): void {
    this.totalQueueStats.entries++;
    this.totalQueueStats.bytes += log.sizeBytes;
    if (
      !this.totalQueueStats.oldestQueuedAt ||
      log.enqueuedAt < this.totalQueueStats.oldestQueuedAt
    ) {
      this.totalQueueStats.oldestQueuedAt = log.enqueuedAt;
    }

    let endpointStats = this.endpointQueueStats.get(log.endpoint.name);
    if (!endpointStats) {
      endpointStats = { entries: 0, bytes: 0, oldestQueuedAt: 0 };
      this.endpointQueueStats.set(log.endpoint.name, endpointStats);
    }
    endpointStats.entries++;
    endpointStats.bytes += log.sizeBytes;
    if (!endpointStats.oldestQueuedAt || log.enqueuedAt < endpointStats.oldestQueuedAt) {
      endpointStats.oldestQueuedAt = log.enqueuedAt;
    }
  }

  private trackDequeuedLogs(logs: QueuedLog[]): void {
    if (logs.length === 0) return;

    let globalOldestRemoved = false;
    const endpointOldestRemoved = new Set<string>();
    for (const log of logs) {
      if (log.enqueuedAt === this.totalQueueStats.oldestQueuedAt) {
        globalOldestRemoved = true;
      }
      this.totalQueueStats.entries = Math.max(0, this.totalQueueStats.entries - 1);
      this.totalQueueStats.bytes = Math.max(0, this.totalQueueStats.bytes - log.sizeBytes);

      const endpointStats = this.endpointQueueStats.get(log.endpoint.name);
      if (!endpointStats) continue;
      if (log.enqueuedAt === endpointStats.oldestQueuedAt) {
        endpointOldestRemoved.add(log.endpoint.name);
      }
      endpointStats.entries = Math.max(0, endpointStats.entries - 1);
      endpointStats.bytes = Math.max(0, endpointStats.bytes - log.sizeBytes);
    }

    if (this.totalQueueStats.entries === 0) {
      this.totalQueueStats.oldestQueuedAt = 0;
    } else if (globalOldestRemoved) {
      this.totalQueueStats.oldestQueuedAt = this.findOldestQueuedAt();
    }

    for (const endpointName of endpointOldestRemoved) {
      const endpointStats = this.endpointQueueStats.get(endpointName);
      if (!endpointStats) continue;
      endpointStats.oldestQueuedAt = endpointStats.entries === 0
        ? 0
        : this.findOldestQueuedAt(endpointName);
    }
  }

  private findOldestQueuedAt(endpointName?: string): number {
    let oldestQueuedAt = 0;
    // Buckets are FIFO, so only each bucket head can be the oldest remaining log.
    for (const bucket of this.queue.values()) {
      const first = bucket[0];
      if (!first || (endpointName && first.endpoint.name !== endpointName)) continue;
      if (!oldestQueuedAt || first.enqueuedAt < oldestQueuedAt) {
        oldestQueuedAt = first.enqueuedAt;
      }
    }
    return oldestQueuedAt;
  }

  private clearQueue(): void {
    this.queue.clear();
    this.totalQueueStats.entries = 0;
    this.totalQueueStats.bytes = 0;
    this.totalQueueStats.oldestQueuedAt = 0;
    for (const stats of this.endpointQueueStats.values()) {
      stats.entries = 0;
      stats.bytes = 0;
      stats.oldestQueuedAt = 0;
    }
  }

  private syncDeliveryHealth(now = Date.now()): void {
    const total = this.calculateQueueStats();
    this.updateBackpressure(total, now);

    for (const [endpointName, counter] of this.endpointCounters) {
      const stats = this.calculateQueueStats(endpointName);
      const retryState = this.getRetryState(endpointName);
      const endpointBackpressure = this.backpressureActive && stats.entries > 0;

      counter.queuedEntries = stats.entries;
      counter.queuedBytes = stats.bytes;
      counter.oldestQueuedAgeMs = stats.oldestQueuedAt
        ? Math.max(0, now - stats.oldestQueuedAt)
        : 0;
      counter.backpressureActive = endpointBackpressure;
      counter.backpressureReason = endpointBackpressure ? this.backpressureReason : '';
      counter.backpressureSince = endpointBackpressure && this.backpressureSince
        ? formatTime(new Date(this.backpressureSince))
        : '';
      counter.consecutiveFailures = retryState.consecutiveFailures;
      counter.lastAttemptTime = retryState.lastAttemptAt
        ? formatTime(new Date(retryState.lastAttemptAt))
        : '';
      counter.lastSuccessTime = retryState.lastSuccessAt
        ? formatTime(new Date(retryState.lastSuccessAt))
        : '';
      counter.lastErrorTime = retryState.lastErrorAt
        ? formatTime(new Date(retryState.lastErrorAt))
        : '';
      counter.lastErrorType = retryState.lastErrorType;
      counter.lastStatusCode = retryState.lastStatusCode;
      counter.nextRetryTime = retryState.nextRetryAt > now
        ? formatTime(new Date(retryState.nextRetryAt))
        : '';
    }

    this.cachedBackpressureState = this.buildBackpressureState(total, now);
    this.cachedBackpressureStateAt = now;
  }

  private buildBackpressureState(total: QueueStats, now: number): FlusherBackpressureState {
    return {
      active: this.backpressureActive,
      queuedEntries: total.entries,
      queuedBytes: total.bytes,
      retryAfterMs: this.getRetryAfterMs(now),
      reason: this.backpressureReason || undefined,
    };
  }

  private updateBackpressure(total: QueueStats, now: number): void {
    const reason = this.resolveBackpressureReason(total);
    const shouldActivate = reason !== '';
    const shouldClear =
      total.entries < this.policy.backpressureLowWatermarkEntries &&
      total.bytes < this.policy.backpressureLowWatermarkBytes;

    if (!this.backpressureActive && shouldActivate) {
      this.backpressureActive = true;
      this.backpressureSince = now;
      this.backpressureReason = reason;
      this.backpressureAlarmRecorded = false;
      logger.warn('SLS backpressure entered', {
        queuedEntries: total.entries,
        queuedBytes: total.bytes,
        reason,
      });
    } else if (this.backpressureActive && shouldClear) {
      logger.info('SLS backpressure exited', {
        queuedEntries: total.entries,
        queuedBytes: total.bytes,
        reason: this.backpressureReason,
        durationMs: now - this.backpressureSince,
      });
      this.backpressureActive = false;
      this.backpressureSince = 0;
      this.backpressureReason = '';
      this.backpressureAlarmRecorded = false;
    } else if (this.backpressureActive && shouldActivate) {
      this.backpressureReason = reason;
    }

    if (
      this.backpressureActive &&
      !this.backpressureAlarmRecorded &&
      now - this.backpressureSince >= BACKPRESSURE_ALARM_THRESHOLD_MS
    ) {
      this.alarmManager?.record(
        'FLUSH_BACKPRESSURE_ALARM', '2',
        `SLS backpressure sustained for at least 20 minutes`,
        { endpoint_name: 'sls' },
      );
      this.backpressureAlarmRecorded = true;
    }
  }

  private resolveBackpressureReason(total: QueueStats): string {
    const maxEntries = this.policy.maxQueuedEntries;
    const maxBytes = this.policy.maxQueuedBytes;
    const highEntries = this.policy.backpressureHighWatermarkEntries;
    const highBytes = this.policy.backpressureHighWatermarkBytes;

    if (total.entries >= maxEntries || total.bytes >= maxBytes) return 'max_queue';
    if (total.entries >= highEntries && total.bytes >= highBytes) {
      return 'entries_and_bytes_high_watermark';
    }
    if (total.entries >= highEntries) return 'entries_high_watermark';
    if (total.bytes >= highBytes) return 'bytes_high_watermark';
    return '';
  }

  private getRetryAfterMs(now: number): number | undefined {
    let retryAfterMs = 0;
    for (const state of this.retryStates.values()) {
      if (state.nextRetryAt > now) {
        retryAfterMs = Math.max(retryAfterMs, state.nextRetryAt - now);
      }
    }
    return retryAfterMs > 0 ? retryAfterMs : undefined;
  }

  private async withDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
    if (!deadlineAt) return promise;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error('ETIMEDOUT SLS shutdown drain timeout');

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('ETIMEDOUT SLS shutdown drain timeout')),
            remainingMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async persistFailedLogs(
    endpoint: SlsEndpoint,
    logs: QueuedLog[],
    err: unknown,
  ): Promise<void> {
    await this.failedLogWriter.write({
      endpoint: endpoint.name,
      mode: endpoint.mode,
      project: endpoint.project,
      logstore: endpoint.logstore,
      kind: endpoint.kind,
      batchCount: logs.length,
      batchBytes: logs.reduce((sum, log) => sum + log.sizeBytes, 0),
      error: err,
    });
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    const before = this.calculateQueueStats();
    logger.info('SLS shutdown drain started', {
      queuedEntries: before.entries,
      queuedBytes: before.bytes,
      timeoutMs: this.policy.shutdownDrainTimeoutMs,
    });
    await this.flush({
      ignoreCooldown: true,
      deadlineMs: this.policy.shutdownDrainTimeoutMs,
    });
    const after = this.calculateQueueStats();
    if (after.entries > 0) {
      await this.persistShutdownPending();
      this.clearQueue();
    }
    this.syncDeliveryHealth();
    logger.info('SLS shutdown drain finished', {
      queuedBeforeEntries: before.entries,
      queuedBeforeBytes: before.bytes,
      pendingEntries: after.entries,
      pendingBytes: after.bytes,
    });
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

  private async enqueue(
    endpoint: SlsEndpoint,
    content: Record<string, string>,
    agentType?: string,
    restored?: {
      firstFailureAt?: number;
      enqueuedAt?: number;
      sizeBytes?: number;
    },
  ): Promise<void> {
    const base = `${endpoint.name}/${endpoint.project}/${endpoint.logstore}`;
    const key = (this.effectiveServiceName(endpoint) && agentType)
      ? `${base}/${agentType}`
      : base;
    let bucket = this.queue.get(key);
    if (!bucket) {
      bucket = [];
      this.queue.set(key, bucket);
    }
    const sizeBytes = restored?.sizeBytes ?? Buffer.byteLength(JSON.stringify(content));
    const queuedLog: QueuedLog = {
      content,
      endpoint,
      agentType,
      sizeBytes,
      enqueuedAt: restored?.enqueuedAt ?? Date.now(),
      firstFailureAt: restored?.firstFailureAt,
    };
    bucket.push(queuedLog);
    this.trackEnqueuedLog(queuedLog);

    const counter = this.endpointCounters.get(endpoint.name);
    if (counter) {
      counter.inEntries++;
      counter.inBytes += sizeBytes;
      if (!counter.startTime) counter.startTime = formatTime(new Date());
    }

    await this.enforceQueueLimits(endpoint);
    this.syncDeliveryHealth();

    const maxSize = this.config.batchMaxSize || BATCH_MAX_SIZE;
    if (bucket.length >= maxSize) {
      void this.flush();
    }
  }

  private async enforceQueueLimits(endpoint: SlsEndpoint): Promise<void> {
    const maxEntries = this.policy.maxQueuedEntries;
    const maxBytes = this.policy.maxQueuedBytes;

    while (
      this.totalQueueStats.entries > maxEntries ||
      this.totalQueueStats.bytes > maxBytes
    ) {
      const stats = this.calculateQueueStats();
      const victim = this.takeOldestQueuedLog();
      if (!victim) break;
      const overflow = victim.log;
      const causedByEndpoint = endpoint.name;
      const droppedEndpoint = overflow.endpoint;
      await this.persistFailedLogs(
        droppedEndpoint,
        [overflow],
        new Error(`SLS queue overflow entries=${stats.entries} bytes=${stats.bytes}`),
      );
      const counter = this.endpointCounters.get(droppedEndpoint.name);
      if (counter) {
        counter.outFailed += 1;
        counter.queueOverflowEntriesTotal = (counter.queueOverflowEntriesTotal ?? 0) + 1;
      }
      this.markError(droppedEndpoint.name, { retryable: false, type: 'queue_overflow' });
      this.alarmManager?.record(
        'FLUSH_SEND_ALARM', '2',
        `SLS queue overflow persisted 1 entry`,
        { endpoint_name: droppedEndpoint.name },
      );
      logger.warn('SLS queue max exceeded', {
        causedByEndpoint,
        droppedEndpoint: droppedEndpoint.name,
        droppedProject: droppedEndpoint.project,
        droppedLogstore: droppedEndpoint.logstore,
        droppedAgentType: overflow.agentType,
        droppedSizeBytes: overflow.sizeBytes,
        remainingDroppedBucketEntries: victim.remainingBucketEntries,
        queuedEntries: stats.entries,
        queuedBytes: stats.bytes,
        remainingQueuedEntries: this.totalQueueStats.entries,
        remainingQueuedBytes: this.totalQueueStats.bytes,
        maxEntries,
        maxBytes,
      });
    }
  }

  private takeOldestQueuedLog(): {
    log: QueuedLog;
    remainingBucketEntries: number;
  } | null {
    let victimKey: string | undefined;
    let victimBucket: QueuedLog[] | undefined;
    let oldestQueuedAt = Number.POSITIVE_INFINITY;

    for (const [key, bucket] of this.queue) {
      const first = bucket[0];
      if (!first || first.enqueuedAt >= oldestQueuedAt) continue;
      victimKey = key;
      victimBucket = bucket;
      oldestQueuedAt = first.enqueuedAt;
    }

    if (!victimKey || !victimBucket) return null;
    const log = victimBucket.shift();
    if (!log) return null;
    this.trackDequeuedLogs([log]);
    if (victimBucket.length === 0) this.queue.delete(victimKey);
    return { log, remainingBucketEntries: victimBucket.length };
  }

  private async persistShutdownPending(): Promise<void> {
    await fs.mkdir(this.shutdownPendingDir, { recursive: true });
    const createdAt = Date.now();
    const records: ShutdownPendingRecord[] = [];
    for (const logs of this.queue.values()) {
      if (logs.length === 0) continue;
      const endpoint = logs[0].endpoint;
      records.push({
        version: 1,
        createdAt,
        endpointName: endpoint.name,
        project: endpoint.project,
        logstore: endpoint.logstore,
        kind: endpoint.kind,
        mode: endpoint.mode,
        logs: logs.map(log => ({
          content: log.content,
          agentType: log.agentType,
          sizeBytes: log.sizeBytes,
          enqueuedAt: log.enqueuedAt,
          firstFailureAt: log.firstFailureAt,
        })),
      });
    }
    if (records.length === 0) return;

    const fileName = `${createdAt}-${process.pid}.jsonl`;
    const finalPath = path.join(this.shutdownPendingDir, fileName);
    const tmpPath = `${finalPath}.tmp`;
    const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
    await fs.writeFile(tmpPath, body, 'utf8');
    await fs.rename(tmpPath, finalPath);

    for (const record of records) {
      const counter = this.endpointCounters.get(record.endpointName);
      if (counter) {
        counter.shutdownPendingWrittenEntriesTotal =
          (counter.shutdownPendingWrittenEntriesTotal ?? 0) + record.logs.length;
      }
    }
    logger.warn('SLS shutdown pending written', {
      file: finalPath,
      buckets: records.length,
      entries: records.reduce((sum, record) => sum + record.logs.length, 0),
    });
  }

  private async restoreShutdownPending(): Promise<void> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.shutdownPendingDir);
    } catch (err) {
      logger.warn('SLS shutdown pending restore skipped', { error: String(err) });
      return;
    }

    const endpointByName = new Map(this.config.endpoints.map(endpoint => [endpoint.name, endpoint]));
    for (const fileName of fileNames.sort()) {
      if (!fileName.endsWith('.jsonl')) continue;
      const filePath = path.join(this.shutdownPendingDir, fileName);
      let records: ShutdownPendingRecord[];
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        records = this.parseShutdownPendingRecords(raw);
      } catch (err) {
        const quarantinedPath = await this.moveShutdownPendingAside(filePath, 'corrupt');
        logger.warn('SLS shutdown pending file quarantined', {
          file: filePath,
          quarantinedFile: quarantinedPath,
          error: String(err),
        });
        continue;
      }

      const claimedPath = `${filePath}.${process.pid}.restoring`;
      try {
        await fs.rename(filePath, claimedPath);
      } catch (err) {
        logger.warn('SLS shutdown pending claim failed', {
          file: filePath,
          error: String(err),
        });
        continue;
      }

      try {
        let restoredEntries = 0;
        for (const record of records) {
          const endpoint = endpointByName.get(record.endpointName);
          if (!endpoint) {
            logger.warn('SLS shutdown pending endpoint no longer configured', {
              endpoint: record.endpointName,
              file: claimedPath,
            });
            continue;
          }
          for (const log of record.logs) {
            await this.enqueue(endpoint, log.content, log.agentType, {
              sizeBytes: log.sizeBytes,
              enqueuedAt: log.enqueuedAt,
              firstFailureAt: log.firstFailureAt,
            });
            restoredEntries++;
          }
          const counter = this.endpointCounters.get(endpoint.name);
          if (counter) {
            counter.shutdownPendingRestoredEntriesTotal =
              (counter.shutdownPendingRestoredEntriesTotal ?? 0) + record.logs.length;
          }
        }
        await fs.unlink(claimedPath);
        logger.warn('SLS shutdown pending restored', {
          file: filePath,
          entries: restoredEntries,
        });
      } catch (err) {
        const failedPath = await this.moveShutdownPendingAside(claimedPath, 'failed');
        logger.warn('SLS shutdown pending restore failed', {
          file: claimedPath,
          failedFile: failedPath,
          error: String(err),
        });
      }
    }
    this.syncDeliveryHealth();
  }

  private parseShutdownPendingRecords(raw: string): ShutdownPendingRecord[] {
    const lines = raw.split('\n').filter(line => line.trim().length > 0);
    if (lines.length === 0) {
      throw new Error('SLS shutdown pending file is empty');
    }

    return lines.map((line, index) => {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`invalid shutdown pending record at line ${index + 1}`);
      }
      const record = parsed as Partial<ShutdownPendingRecord>;
      if (
        record.version !== 1 ||
        typeof record.createdAt !== 'number' ||
        typeof record.endpointName !== 'string' ||
        typeof record.project !== 'string' ||
        typeof record.logstore !== 'string' ||
        typeof record.kind !== 'string' ||
        (record.mode !== 'ak' && record.mode !== 'webtracking') ||
        !Array.isArray(record.logs)
      ) {
        throw new Error(`invalid shutdown pending record shape at line ${index + 1}`);
      }

      for (const [logIndex, log] of record.logs.entries()) {
        if (
          !log ||
          typeof log !== 'object' ||
          Array.isArray(log) ||
          !log.content ||
          typeof log.content !== 'object' ||
          Array.isArray(log.content) ||
          Object.values(log.content).some(value => typeof value !== 'string') ||
          (log.agentType !== undefined && typeof log.agentType !== 'string') ||
          (log.sizeBytes !== undefined &&
            (typeof log.sizeBytes !== 'number' || !Number.isFinite(log.sizeBytes) || log.sizeBytes < 0)) ||
          (log.enqueuedAt !== undefined &&
            (typeof log.enqueuedAt !== 'number' || !Number.isFinite(log.enqueuedAt))) ||
          (log.firstFailureAt !== undefined &&
            (typeof log.firstFailureAt !== 'number' || !Number.isFinite(log.firstFailureAt)))
        ) {
          throw new Error(
            `invalid shutdown pending log at line ${index + 1}, index ${logIndex}`,
          );
        }
      }

      return record as ShutdownPendingRecord;
    });
  }

  private async moveShutdownPendingAside(
    filePath: string,
    suffix: 'corrupt' | 'failed',
  ): Promise<string> {
    const targetPath = `${filePath}.${Date.now()}-${process.pid}.${suffix}`;
    try {
      await fs.rename(filePath, targetPath);
      return targetPath;
    } catch (err) {
      logger.warn('SLS shutdown pending quarantine failed', {
        file: filePath,
        targetFile: targetPath,
        error: String(err),
      });
      return filePath;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

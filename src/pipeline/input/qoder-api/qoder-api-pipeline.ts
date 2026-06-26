import type { WakeEvent } from '../../sleep-detector.js';
import type {
  Pipeline,
  PipelineConfig,
  QoderApiInputConfig,
  QoderApiPipelineOptions,
} from '../../types.js';
import { QoderApiClient } from './qoder-api-client.js';
import { QoderApiInput } from './qoder-api-input.js';
import { QoderApiSlsSender } from '../../flusher/qoder-api/qoder-api-sls-sender.js';
import { createLogger, type BoundLogger } from '../../../utils/logger.js';
import { persistFailedLogs } from '../../../flushers/sls-transport.js';

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_BACKFILL_DAYS = 7;
const DEFAULT_API_BASE = 'https://api.qoder.com';

/**
 * Qoder API pipeline that assembles the HTTP client, collection input, and
 * SLS sender into a single polling loop.
 *
 * Lifecycle:
 *   start()  -> create client/input/sender, start flush timer, run first cycle
 *   stop()   -> clear poll timer, drain sender
 *   handleWake() -> run an immediate poll cycle after system sleep
 */
export class QoderApiPipeline implements Pipeline {
  private readonly config: PipelineConfig;
  private readonly stateDir: string;
  private readonly failedLogDir: string;
  private readonly dataDir: string;
  private readonly logger: BoundLogger;

  private client: QoderApiClient | null = null;
  private input: QoderApiInput | null = null;
  private sender: QoderApiSlsSender | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;

  constructor(opts: QoderApiPipelineOptions) {
    this.config = opts.config;
    this.stateDir = opts.stateDir;
    this.failedLogDir = opts.failedLogDir;
    this.dataDir = opts.dataDir;
    this.logger = createLogger(`QoderApiPipeline:${opts.config.configName}`);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const inputConfig = this.config.inputs[0] as QoderApiInputConfig;
    const flusherConfig = this.config.flushers[0];
    const configName = this.config.configName;

    const apiBase = inputConfig.ApiBase ?? DEFAULT_API_BASE;
    const interval = inputConfig.Interval ?? DEFAULT_INTERVAL_SECONDS;
    const backfillDays = inputConfig.BackfillDays ?? DEFAULT_BACKFILL_DAYS;

    // 1. Create QoderApiClient
    this.client = new QoderApiClient({
      apiBase,
      apiKey: inputConfig.ApiKey,
      orgId: inputConfig.OrgId,
    });

    // 2. Create QoderApiInput
    this.input = new QoderApiInput({
      client: this.client,
      orgId: inputConfig.OrgId,
      configName,
      stateDir: this.stateDir,
      interval,
      backfillDays,
    });

    // 3. Create QoderApiSlsSender
    this.sender = new QoderApiSlsSender({
      flusherConfig,
      configName,
      failedLogDir: this.failedLogDir,
      dataDir: this.dataDir,
    });

    // 4. Start sender flush interval
    this.sender.start();

    // 5. Start poll interval
    const intervalMs = interval * 1000;
    this.pollTimer = setInterval(
      () => void this.pollCycle(),
      intervalMs,
    );
    this.pollTimer.unref();

    // 6. Run immediate first cycle
    void this.pollCycle();

    this.logger.info('started', {
      configName,
      orgId: inputConfig.OrgId,
      apiBase,
      intervalSeconds: interval,
      backfillDays,
      logstore: flusherConfig.Logstore,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.sender) {
      await this.sender.shutdown();
    }

    this.logger.info('stopped', { configName: this.config.configName });
  }

  async handleWake(_event: WakeEvent): Promise<void> {
    if (!this.running) return;
    this.logger.info('wake recovery: running immediate poll cycle');
    void this.pollCycle();
  }

  private async pollCycle(): Promise<void> {
    if (!this.running || !this.input || !this.sender) return;
    if (this.polling) {
      this.logger.debug('previous poll cycle still running; skipping');
      return;
    }

    // 1. Check fatalAuthError
    if (this.input.hasFatalAuthError()) {
      this.logger.warn('skipping cycle: fatal auth error previously detected');
      return;
    }

    this.polling = true;
    try {
      // 2. Collect rows from input (window NOT yet advanced)
      const rows = await this.input.collect();

      if (rows.length === 0) return;

      // 3. Enqueue into sender
      const accepted = this.sender.enqueue(rows);

      if (accepted) {
        // 4a. Delivery accepted — advance the collection window.
        //     The sender may still flush asynchronously, but the buffer accepted
        //     the rows so they won't be lost. event_id provides SLS-side dedup
        //     if the same window is re-collected after a crash before flush.
        await this.input.confirmCycle();
      } else {
        // 4b. Buffer full — do NOT advance the window so data is re-collected
        //     next cycle. Persist the dropped rows to failed-log for manual recovery.
        this.logger.warn('sender buffer full, persisting rows to failed-log', {
          configName: this.config.configName,
          droppedRows: rows.length,
          bufferSize: this.sender.bufferSize(),
        });
        await persistFailedLogs(
          this.failedLogDir,
          this.config.configName,
          { __logs__: rows },
          new Error('sender buffer full, window not advanced'),
        );
      }
    } catch (err) {
      this.logger.error('poll cycle failed', {
        configName: this.config.configName,
        error: String(err),
      });
    } finally {
      this.polling = false;
    }
  }
}

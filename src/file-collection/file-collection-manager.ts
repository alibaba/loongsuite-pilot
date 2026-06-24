import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { FileCollectionConfig, FileCollectionManagerOptions } from './types.js';
import { FilePipeline } from './file-pipeline.js';
import { SleepDetector, type WakeEvent } from './sleep-detector.js';
import { createLogger } from '../utils/logger.js';
import { ensureDir } from '../utils/fs-utils.js';

const logger = createLogger('FileCollectionManager');

const RESCAN_INTERVAL_MS = 60_000;
const VALID_CONFIG_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export class FileCollectionManager {
  private readonly configDir: string;
  private readonly stateDir: string;
  private readonly failedLogDir: string;
  private readonly dataDir: string;
  private readonly pipelines: Map<string, FilePipeline> = new Map();
  private readonly configHashes: Map<string, string> = new Map();
  private watcher: fs.FSWatcher | null = null;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sleepDetector = new SleepDetector();
  private running = false;
  private rescanInProgress = false;
  private rescanQueued = false;

  constructor(opts: FileCollectionManagerOptions) {
    this.configDir = opts.configDir;
    this.stateDir = opts.stateDir;
    this.failedLogDir = opts.failedLogDir;
    this.dataDir = opts.dataDir;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await ensureDir(this.configDir);
    await ensureDir(this.stateDir);
    await ensureDir(this.failedLogDir);

    await this.fullRescan();

    try {
      this.watcher = fs.watch(this.configDir, (_event, filename) => {
        if (filename && filename.endsWith('.json')) {
          void this.fullRescan();
        }
      });
      this.watcher.on('error', (err) => {
        logger.warn('config dir watcher error, relying on rescan', {
          error: String(err),
        });
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (err) {
      logger.warn('failed to watch config dir, relying on rescan', {
        error: String(err),
      });
    }

    this.rescanTimer = setInterval(
      () => void this.fullRescan(),
      RESCAN_INTERVAL_MS,
    );

    if (process.platform === 'darwin') {
      this.sleepDetector.on('wake', (event: WakeEvent) => void this.handleWake(event));
      this.sleepDetector.start();
    }

    logger.info('started', {
      configDir: this.configDir,
      pipelines: this.pipelines.size,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.sleepDetector.stop();

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }

    const stopTasks = Array.from(this.pipelines.entries()).map(
      async ([name, pipeline]) => {
        try {
          await pipeline.stop();
        } catch (err) {
          logger.error('error stopping pipeline', {
            configName: name,
            error: String(err),
          });
        }
      },
    );
    await Promise.all(stopTasks);
    this.pipelines.clear();
    this.configHashes.clear();

    logger.info('stopped');
  }

  private async handleWake(event: WakeEvent): Promise<void> {
    if (!this.running) return;
    logger.info('handling system wake, recovering pipelines', {
      sleepDurationMs: event.sleepDurationMs,
      pipelines: this.pipelines.size,
    });

    const wakeTasks = Array.from(this.pipelines.entries()).map(
      async ([name, pipeline]) => {
        try {
          await pipeline.handleWake();
        } catch (err) {
          logger.error('wake recovery failed for pipeline', {
            configName: name,
            error: String(err),
          });
        }
      },
    );
    await Promise.all(wakeTasks);

    void this.fullRescan();
  }

  private async fullRescan(): Promise<void> {
    if (this.rescanInProgress) {
      this.rescanQueued = true;
      return;
    }
    this.rescanInProgress = true;
    this.rescanQueued = false;

    try {
      await this.doRescan();
    } finally {
      this.rescanInProgress = false;
      if (this.rescanQueued && this.running) {
        this.rescanQueued = false;
        void this.fullRescan();
      }
    }
  }

  private async doRescan(): Promise<void> {
    if (!this.running) return;

    const diskConfigs = await this.scanConfigDir();
    const diskNames = new Set(diskConfigs.map((c) => c.configName));

    for (const [name] of this.pipelines) {
      if (!diskNames.has(name)) {
        await this.destroyPipeline(name);
      }
    }

    for (const config of diskConfigs) {
      const configJson = stableStringify(config);
      const existingHash = this.configHashes.get(config.configName);

      if (!this.running) return;

      if (!this.pipelines.has(config.configName)) {
        await this.createPipeline(config);
        this.configHashes.set(config.configName, configJson);
      } else if (existingHash !== configJson) {
        logger.info('config changed, recreating pipeline', {
          configName: config.configName,
        });
        await this.destroyPipeline(config.configName);
        await this.createPipeline(config);
        this.configHashes.set(config.configName, configJson);
      }
    }
  }

  private async scanConfigDir(): Promise<FileCollectionConfig[]> {
    let entries: string[];
    try {
      entries = await fsPromises.readdir(this.configDir);
    } catch {
      return [];
    }

    const configs: FileCollectionConfig[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = path.join(this.configDir, entry);
      try {
        const raw = await fsPromises.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as FileCollectionConfig;
        if (!this.validateConfig(parsed, entry)) continue;
        configs.push(parsed);
      } catch (err) {
        logger.warn('failed to parse config file', {
          file: entry,
          error: String(err),
        });
      }
    }
    return configs;
  }

  private validateConfig(config: FileCollectionConfig, fileName: string): boolean {
    if (!config.configName) {
      logger.warn('config missing configName', { file: fileName });
      return false;
    }
    if (!VALID_CONFIG_NAME.test(config.configName)) {
      logger.warn('config has invalid configName (must match [a-zA-Z0-9._-])', {
        file: fileName,
        configName: config.configName,
      });
      return false;
    }
    if (!config.inputs || config.inputs.length === 0) {
      logger.warn('config missing inputs', { file: fileName });
      return false;
    }
    if (!config.flushers || config.flushers.length === 0) {
      logger.warn('config missing flushers', { file: fileName });
      return false;
    }
    const input = config.inputs[0];
    if (!input.FilePaths || input.FilePaths.length === 0) {
      logger.warn('config input missing FilePaths', { file: fileName });
      return false;
    }
    const flusher = config.flushers[0];
    if (!flusher.Endpoint || !flusher.Project || !flusher.Logstore) {
      logger.warn('config flusher missing required fields', { file: fileName });
      return false;
    }
    return true;
  }

  private async createPipeline(config: FileCollectionConfig): Promise<void> {
    try {
      const pipeline = new FilePipeline({
        config,
        stateDir: this.stateDir,
        failedLogDir: this.failedLogDir,
        dataDir: this.dataDir,
      });
      await pipeline.start();
      this.pipelines.set(config.configName, pipeline);
      logger.info('pipeline created', { configName: config.configName });
    } catch (err) {
      logger.error('failed to create pipeline', {
        configName: config.configName,
        error: String(err),
      });
    }
  }

  private async destroyPipeline(configName: string): Promise<void> {
    const pipeline = this.pipelines.get(configName);
    if (!pipeline) return;
    try {
      await pipeline.stop();
    } catch (err) {
      logger.error('error stopping pipeline', {
        configName,
        error: String(err),
      });
    }
    this.pipelines.delete(configName);
    this.configHashes.delete(configName);
    logger.info('pipeline destroyed', { configName });
  }
}

function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce<Record<string, unknown>>((sorted, k) => {
        sorted[k] = (value as Record<string, unknown>)[k];
        return sorted;
      }, {});
    }
    return value;
  });
}

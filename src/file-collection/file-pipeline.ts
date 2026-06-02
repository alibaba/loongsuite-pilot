import * as path from 'node:path';
import type { FileCollectionConfig, FileCheckpoint, FilePipelineOptions } from './types.js';
import { FileTailer } from './file-tailer.js';
import { FileSlsSender } from './file-sls-sender.js';
import { StateStore } from '../checkpoints/state-store.js';
import { createLogger } from '../utils/logger.js';
import { ensureDir } from '../utils/fs-utils.js';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const HIGH_WATERMARK = 8000;

export class FilePipeline {
  private readonly config: FileCollectionConfig;
  private readonly tailer: FileTailer;
  private readonly sender: FileSlsSender;
  private readonly stateStore: StateStore;
  private readonly stateFilePath: string;
  private readonly logger;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly checkpoints: Map<string, FileCheckpoint> = new Map();

  constructor(opts: FilePipelineOptions) {
    this.config = opts.config;
    this.logger = createLogger(`FilePipeline:${opts.config.configName}`);

    const input = opts.config.inputs[0];
    this.tailer = new FileTailer({
      filePaths: input.FilePaths,
      encoding: input.FileEncoding,
      maxDirSearchDepth: input.MaxDirSearchDepth,
    });

    const flusher = opts.config.flushers[0];
    this.sender = new FileSlsSender(
      flusher,
      opts.config.configName,
      opts.failedLogDir,
    );

    this.stateFilePath = path.join(opts.stateDir, `${opts.config.configName}.json`);
    this.stateStore = new StateStore(this.stateFilePath);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await ensureDir(path.dirname(this.stateFilePath));
    await this.stateStore.load();
    this.loadCheckpoints();

    this.sender.start();
    await this.pollCycle();
    this.pollTimer = setInterval(
      () => void this.pollCycle(),
      DEFAULT_POLL_INTERVAL_MS,
    );

    this.logger.info('started', { configName: this.config.configName });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    await this.sender.shutdown();
    this.saveCheckpoints();
    await this.stateStore.save();

    this.logger.info('stopped', { configName: this.config.configName });
  }

  private async pollCycle(): Promise<void> {
    if (!this.running) return;

    try {
      const files = this.tailer.discoverFiles();

      for (const filePath of files) {
        if (!this.running) return;

        try {
          const checkpoint = this.checkpoints.get(filePath) ?? null;
          const result = await this.tailer.readNewLines(filePath, checkpoint);

          if (result.drainedLines && result.drainedLines.length > 0) {
            this.sender.enqueue(result.drainedLines);
            this.checkpoints.set(filePath, {
              offset: 0,
              inode: result.checkpoint.inode,
            });
          }

          if (this.sender.bufferSize() >= HIGH_WATERMARK) {
            this.logger.debug('backpressure active, skipping remaining files', {
              bufferSize: this.sender.bufferSize(),
            });
            break;
          }

          if (result.lines.length > 0) {
            this.sender.enqueue(result.lines);
          }

          this.checkpoints.set(filePath, result.checkpoint);
        } catch (err) {
          this.logger.warn('error reading file', {
            file: filePath,
            error: String(err),
          });
        }
      }

      this.saveCheckpoints();
      await this.stateStore.save();
    } catch (err) {
      this.logger.error('poll cycle failed', { error: String(err) });
    }
  }

  private loadCheckpoints(): void {
    this.checkpoints.clear();
    const allKeys = this.stateStore.keys();
    for (const key of allKeys) {
      const state = this.stateStore.get(key);
      if (state.lastOffset !== undefined && state.extra?.inode !== undefined) {
        this.checkpoints.set(key, {
          offset: state.lastOffset,
          inode: state.extra.inode as number,
          signature: state.extra.signature as string | undefined,
        });
      }
    }
  }

  private saveCheckpoints(): void {
    for (const [filePath, cp] of this.checkpoints) {
      this.stateStore.update(filePath, {
        lastOffset: cp.offset,
        extra: { inode: cp.inode, signature: cp.signature },
      });
    }
  }
}

import * as path from 'node:path';
import type { FileCollectionConfig, FileCheckpoint, FilePipelineOptions } from './types.js';
import { FileTailer } from './file-tailer.js';
import { FileSlsSender } from './file-sls-sender.js';
import { FileWatcher, extractParentDirs } from './file-watcher.js';
import { StateStore } from '../checkpoints/state-store.js';
import { createLogger } from '../utils/logger.js';
import { ensureDir } from '../utils/fs-utils.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const RESCAN_INTERVAL_MS = 30_000;
const READ_TIME_SLICE_MS = 50;
const SIGNATURE_BYTES = 1024;

export class FilePipeline {
  private readonly config: FileCollectionConfig;
  private readonly tailer: FileTailer;
  private readonly sender: FileSlsSender;
  private readonly fileWatcher: FileWatcher;
  private readonly stateStore: StateStore;
  private readonly stateFilePath: string;
  private readonly logger;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly checkpoints: Map<string, FileCheckpoint> = new Map();
  private lastRescanTime = 0;

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

    this.fileWatcher = new FileWatcher();

    this.stateFilePath = path.join(opts.stateDir, `${opts.config.configName}.json`);
    this.stateStore = new StateStore(this.stateFilePath);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await ensureDir(path.dirname(this.stateFilePath));
    await this.stateStore.load();
    this.loadCheckpoints();

    const input = this.config.inputs[0];
    const parentDirs = extractParentDirs(input.FilePaths);
    this.fileWatcher.watch(parentDirs);

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

    this.fileWatcher.close();
    await this.sender.shutdown();
    this.saveCheckpoints();
    await this.stateStore.save();

    this.logger.info('stopped', { configName: this.config.configName });
  }

  private async pollCycle(): Promise<void> {
    if (!this.running) return;

    try {
      const filesToProcess = new Set<string>();

      const dirtyFiles = this.fileWatcher.getDirtyFiles();
      for (const f of dirtyFiles) {
        filesToProcess.add(f);
      }

      for (const f of this.tailer.getActiveFiles()) {
        filesToProcess.add(f);
      }

      const now = Date.now();
      if (now - this.lastRescanTime >= RESCAN_INTERVAL_MS) {
        this.lastRescanTime = now;
        const discovered = this.tailer.discoverFiles();
        for (const f of discovered) {
          filesToProcess.add(f);
        }
      }

      for (const filePath of filesToProcess) {
        if (!this.running) return;

        if (this.sender.isBackpressured()) {
          this.fileWatcher.addDirty(filePath);
          this.logger.debug('backpressure active, deferring file', {
            file: filePath,
            bufferSize: this.sender.bufferSize(),
          });
          continue;
        }

        try {
          const sliceStart = Date.now();
          let hasMore = true;

          while (hasMore && Date.now() - sliceStart < READ_TIME_SLICE_MS) {
            const checkpoint = this.checkpoints.get(filePath) ?? null;
            const result = await this.tailer.readNewLines(filePath, checkpoint);

            if (result.lines.length > 0) {
              const accepted = this.sender.enqueue(result.lines, filePath);
              if (!accepted) {
                this.fileWatcher.addDirty(filePath);
                break;
              }
            }

            this.checkpoints.set(filePath, result.checkpoint);
            hasMore = result.hasMore;
          }

          if (hasMore) {
            this.fileWatcher.addDirty(filePath);
          }
        } catch (err) {
          this.logger.warn('error reading file', {
            file: filePath,
            error: String(err),
          });
        }
      }

      this.tailer.cleanupStaleReaders();
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
        const cp: FileCheckpoint = {
          offset: state.lastOffset,
          inode: state.extra.inode as number,
          dev: (state.extra.dev as number) || 0,
          signatureHash: (state.extra.signatureHash as string) || (state.extra.signature as string) || '',
          signatureSize: (state.extra.signatureSize as number) || SIGNATURE_BYTES,
          lastUpdateTime: (state.extra.lastUpdateTime as number) || Date.now(),
          cache: (state.extra.cache as string) || '',
        };
        this.checkpoints.set(key, cp);
        this.tailer.initReaderFromCheckpoint(key, cp);
      }
    }
  }

  private saveCheckpoints(): void {
    const tailerCheckpoints = this.tailer.getCheckpoints();
    for (const [filePath, cp] of tailerCheckpoints) {
      this.checkpoints.set(filePath, cp);
    }

    for (const [filePath, cp] of this.checkpoints) {
      this.stateStore.update(filePath, {
        lastOffset: cp.offset,
        extra: {
          inode: cp.inode,
          dev: cp.dev,
          signatureHash: cp.signatureHash,
          signatureSize: cp.signatureSize,
          lastUpdateTime: cp.lastUpdateTime,
          cache: cp.cache,
        },
      });
    }
  }
}

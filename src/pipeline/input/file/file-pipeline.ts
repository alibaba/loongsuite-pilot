import * as path from 'node:path';
import type { PipelineConfig, FileCheckpoint, FilePipelineOptions, Pipeline, WakeEvent } from '../../types.js';
import { FileTailer, globToRegex } from './file-tailer.js';
import { FileSlsSender } from '../../flusher/file/file-sls-sender.js';
import { FileWatcher, extractParentDirs } from './file-watcher.js';
import { StateStore } from '../../../checkpoints/state-store.js';
import { createLogger } from '../../../utils/logger.js';
import { ensureDir } from '../../../utils/fs-utils.js';

export function parseCheckpointKey(key: string): string | null {
  const lastStar = key.lastIndexOf('*');
  if (lastStar === -1) return key;
  const secondLastStar = key.lastIndexOf('*', lastStar - 1);
  if (secondLastStar === -1) return null;
  return key.substring(0, secondLastStar);
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const RESCAN_INTERVAL_MS = 30_000;
const READ_TIME_SLICE_MS = 50;
const SIGNATURE_BYTES = 1024;

export class FilePipeline implements Pipeline {
  private readonly config: PipelineConfig;
  private readonly tailer: FileTailer;
  private readonly sender: FileSlsSender;
  private readonly fileWatcher: FileWatcher;
  private readonly stateStore: StateStore;
  private readonly stateFilePath: string;
  private readonly logger;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  private readonly pendingLines: Map<string, string[]> = new Map();
  private lastRescanTime = 0;
  private readonly patternMatchers: { dir: string; regex: RegExp }[];

  constructor(opts: FilePipelineOptions) {
    this.config = opts.config;
    this.logger = createLogger(`FilePipeline:${opts.config.configName}`);

    const input = opts.config.inputs[0];
    if (input.Type !== 'input_file') {
      throw new Error(`FilePipeline expects input_file, got ${input.Type}`);
    }

    this.tailer = new FileTailer({
      filePaths: input.FilePaths,
      encoding: input.FileEncoding,
      maxDirSearchDepth: input.MaxDirSearchDepth,
    });

    this.patternMatchers = input.FilePaths.map((p) => ({
      dir: path.dirname(p),
      regex: globToRegex(path.basename(p)),
    }));

    const flusher = opts.config.flushers[0];
    this.sender = new FileSlsSender(
      flusher,
      opts.config.configName,
      opts.failedLogDir,
      opts.dataDir,
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
    await this.loadCheckpoints();

    const input = this.config.inputs[0];
    if (input.Type !== 'input_file') {
      throw new Error(`FilePipeline expects input_file, got ${input.Type}`);
    }
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

  async handleWake(event?: WakeEvent): Promise<void> {
    if (!this.running) return;

    try {
      this.tailer.refreshReaderTimestamps();

      this.fileWatcher.rewatch();

      this.lastRescanTime = 0;

      this.saveCheckpoints();
      await this.stateStore.save();
    } catch (err) {
      this.logger.error('wake recovery failed', {
        configName: this.config.configName,
        error: String(err),
      });
    }

    this.logger.info('wake recovery complete', { configName: this.config.configName });

    void this.pollCycle();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.fileWatcher.close();

    for (const [filePath, lines] of this.pendingLines) {
      this.sender.enqueue(lines, filePath);
    }
    this.pendingLines.clear();

    await this.sender.shutdown();
    this.saveCheckpoints();
    await this.stateStore.save();

    this.logger.info('stopped', { configName: this.config.configName });
  }

  private async pollCycle(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;

    try {
      const filesToProcess = new Set<string>();

      const dirtyFiles = this.fileWatcher.getDirtyFiles();
      for (const f of dirtyFiles) {
        if (this.matchesPattern(f)) {
          filesToProcess.add(f);
        }
      }

      for (const f of this.tailer.getActiveFiles()) {
        if (this.matchesPattern(f)) {
          filesToProcess.add(f);
        }
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

        try {
          const pending = this.pendingLines.get(filePath);
          if (pending) {
            const accepted = this.sender.enqueue(pending, filePath);
            if (!accepted) {
              this.fileWatcher.addDirty(filePath);
              await this.tailer.checkRotation(filePath);
              continue;
            }
            this.pendingLines.delete(filePath);
          }

          if (this.sender.isBackpressured()) {
            await this.tailer.checkRotation(filePath);
            this.fileWatcher.addDirty(filePath);
            this.logger.debug('backpressure active, deferring file', {
              file: filePath,
              bufferSize: this.sender.bufferSize(),
            });
            continue;
          }

          const sliceStart = Date.now();
          let hasMore = true;

          while (hasMore && Date.now() - sliceStart < READ_TIME_SLICE_MS) {
            const result = await this.tailer.readNewLines(filePath);

            hasMore = result.hasMore;

            if (result.lines.length > 0) {
              const accepted = this.sender.enqueue(result.lines, filePath);
              if (!accepted) {
                this.pendingLines.set(filePath, result.lines);
                this.fileWatcher.addDirty(filePath);
                break;
              }
            }
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
    } finally {
      this.polling = false;
    }
  }

  private matchesPattern(filePath: string): boolean {
    const dir = path.dirname(filePath);
    const name = path.basename(filePath);
    return this.patternMatchers.some((m) => dir === m.dir && m.regex.test(name));
  }

  private async loadCheckpoints(): Promise<void> {
    const allKeys = this.stateStore.keys();
    for (const key of allKeys) {
      const filePath = parseCheckpointKey(key);
      if (!filePath || !this.matchesPattern(filePath)) continue;

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
        const restored = await this.tailer.initReaderFromCheckpoint(filePath, cp);
        if (!restored) {
          this.logger.info('checkpoint discarded', { key, reason: 'validation failed' });
        }
      }
    }
  }

  private saveCheckpoints(): void {
    const allCheckpoints = this.tailer.getAllReaderCheckpoints();
    const currentKeys = new Set<string>();

    for (const [key, cp] of allCheckpoints) {
      currentKeys.add(key);
      this.stateStore.update(key, {
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

    for (const existingKey of this.stateStore.keys()) {
      if (!currentKeys.has(existingKey)) {
        this.stateStore.delete(existingKey);
      }
    }
  }
}

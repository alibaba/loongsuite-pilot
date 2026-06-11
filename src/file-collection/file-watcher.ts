import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FileWatcher');

export class FileWatcher {
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private dirtyFiles: Set<string> = new Set();

  watch(dirs: string[]): void {
    const uniqueDirs = [...new Set(dirs)];
    for (const dir of uniqueDirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, (_event, filename) => {
          if (filename) {
            this.dirtyFiles.add(path.join(dir, filename));
          }
        });
        watcher.on('error', (err) => {
          logger.warn('fs.watch error, degrading to polling', { dir, error: String(err) });
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch (err) {
        logger.warn('failed to create fs.watch, degrading to polling', { dir, error: String(err) });
      }
    }
  }

  getDirtyFiles(): string[] {
    const files = [...this.dirtyFiles];
    this.dirtyFiles.clear();
    return files;
  }

  addDirty(filePath: string): void {
    this.dirtyFiles.add(filePath);
  }

  rewatch(): void {
    const dirs = [...this.watchers.keys()];
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.watch(dirs);
  }

  close(): void {
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.dirtyFiles.clear();
  }
}

export function extractParentDirs(patterns: string[]): string[] {
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    dirs.add(path.dirname(pattern));
  }
  return [...dirs];
}

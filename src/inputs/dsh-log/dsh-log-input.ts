import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';
import {
  transformDshRecord,
  newState,
  type DshEventAggregatorState,
} from '../dsh/dsh-event-transform.js';

const DEFAULT_SESSION_DIR = '~/.loongsuite-pilot/logs/dsh';
const DEFAULT_FILE_PATTERN = 'dsh-*.jsonl';
const logger = createLogger('DshLogInput');

export interface DshLogInputOptions
  extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
}

/** Collect raw dsh session events emitted by the Pilot plugin. */
export class DshLogInput extends BaseSessionInput {
  readonly id = 'dsh-log';
  readonly agentType = ClientType.Dsh;
  private readonly aggregator: DshEventAggregatorState = newState();

  constructor(opts: DshLogInputOptions) {
    super({
      stateStore: opts.stateStore,
      sessionDir: opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR),
      filePattern: opts.filePattern ?? DEFAULT_FILE_PATTERN,
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.sessionDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('failed to discover dsh event logs', {
          sessionDir: this.sessionDir,
          error: String(err),
        });
      }
      return [];
    }

    return entries
      .filter(entry => entry.isFile() && matchesFilePattern(entry.name, this.filePattern))
      .map(entry => path.join(this.sessionDir, entry.name))
      .sort();
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    _filePath: string,
  ): Promise<AgentActivityEntry | null> {
    return transformDshRecord(record, ClientType.Dsh, this.aggregator);
  }
}

export async function ensureDshLogDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function matchesFilePattern(fileName: string, pattern: string): boolean {
  const regexSource = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexSource}$`).test(fileName);
}

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
import { transformHookRecord } from '../base/hook-record-transform.js';

const DEFAULT_SESSION_DIR = '~/.loongsuite-pilot/logs/hermes-agent';
const DEFAULT_FILE_PATTERN = 'hermes-agent-*.jsonl';
const logger = createLogger('HermesLogInput');

export interface HermesLogInputOptions
  extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
}

/** Collect canonical JSONL records emitted by the Hermes Pilot plugin. */
export class HermesLogInput extends BaseSessionInput {
  readonly id = 'hermes-agent-log';
  readonly agentType = ClientType.Hermes;

  constructor(opts: HermesLogInputOptions) {
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
        logger.warn('failed to discover Hermes event logs', {
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
  ): Promise<AgentActivityEntry[]> {
    // Round 3 (PR #233): BaseSessionInput.processSessionLine now returns an
    // array of entries. Hermes source records are 1:1 with normalized
    // entries, so the hook transform result is wrapped in a single-element
    // array. Return `[]` (after filtering null) to skip.
    const entry = await transformHookRecord(record, ClientType.Hermes, 'hermes-agent');
    return entry ? [entry] : [];
  }
}

function matchesFilePattern(fileName: string, pattern: string): boolean {
  const regexSource = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexSource}$`).test(fileName);
}

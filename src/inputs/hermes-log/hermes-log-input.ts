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
import { DEFAULT_POLL_INTERVAL_MS } from '../../utils/poll-interval.js';
import { matchesFileIdentity } from '../../utils/file-identity.js';

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
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  /** Prove the dead producer's extant source files were drained into output. */
  async confirmSourceDrained(token: string): Promise<boolean> {
    if (!/^\d{1,10}-\d{1,24}-[a-f0-9]{8}$/.test(token)) return false;
    try {
      const prefix = `hermes-agent-${token}`;
      const findCandidates = async () => (await fs.readdir(this.sessionDir, { withFileTypes: true }))
        .filter(entry => entry.name === `${prefix}.jsonl`
          || (entry.name.startsWith(`${prefix}.segment-`) && entry.name.endsWith('.jsonl')));
      const candidates = await findCandidates();
      if (!candidates.length || candidates.some(entry => !entry.isFile())) return false;
      let drained = true;
      for (const candidate of candidates) {
        const file = path.join(this.sessionDir, candidate.name);
        const stat = await fs.stat(file);
        const key = `${this.id}:${file}`;
        // In-memory offsets can run ahead of a blocked output. A previously
        // persisted cursor for this particular file remains valid even while
        // a different producer is waiting for journal capacity.
        const state = this.stateStore.getPersistedState(key);
        if (!state || (state.lastOffset ?? 0) !== stat.size
          || !matchesFileIdentity(state.extra?.sourceIdentity, stat)) drained = false;
      }
      const after = await findCandidates();
      const names = new Set(candidates.map(entry => entry.name));
      if (after.length !== names.size || after.some(entry => !entry.isFile() || !names.has(entry.name))) drained = false;
      if (!drained) this.requestCollection();
      return drained && this.running && !this.checkpointFailed;
    } catch {
      // An incomplete scan, an unreadable file or a disappearing file is not
      // evidence that the remaining output has already been consumed.
      return false;
    }
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.sessionDir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        // The plugin creates its session directory 0700 inside the process that
        // loaded it; an unreadable directory means a differently-privileged
        // process (commonly root) is the one writing events. Diagnose once.
        await this.diagnoseUnreadablePath(this.sessionDir, 'session directory');
        return [];
      }
      if (code !== 'ENOENT') {
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
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.Hermes, 'hermes-agent');
  }
}

function matchesFilePattern(fileName: string, pattern: string): boolean {
  const regexSource = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexSource}$`).test(fileName);
}

// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * CopilotLogInput — polls Copilot CLI session-state event files.
 *
 * Copilot writes one `events.jsonl` per session under
 *   `~/.copilot/session-state/<sessionId>/events.jsonl`
 * (nested layout — Codex is flat `rollout-*.jsonl` — so discoverSessionFiles
 * must be overridden to walk one directory level).
 *
 * The Copilot parser reconstructs STEP/TOOL spans by `data.turnId` +
 * `data.toolCallId`, which requires the whole session file. We therefore
 * override `collect()` to do per-file parsing: on each poll, if a session
 * file has grown, re-parse it whole and emit any newly-observed spans,
 * tracking the last emitted byte offset per file.
 *
 * Best-effort wakeup: hook processor writes a marker to
 *   `~/.loongsuite-pilot/state/copilot/session-wakeups/<sessionId>.json`
 * on each hook event. We discover those markers and ensure the corresponding
 * session-state file is included in the poll cycle even before the file
 * watcher fires.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';
import { parseTranscript, hasSessionShutdown } from '../../../assets/hooks/copilot/transcript-parser.mjs';

const DEFAULT_SESSION_DIR = '~/.copilot/session-state';
const DEFAULT_FILE_PATTERN = '*/events.jsonl';
const WAKEUP_DIR = '~/.loongsuite-pilot/state/copilot/session-wakeups';
const SHUTDOWN_TIMEOUT_MS = 5 * 60 * 1000;

export interface CopilotLogInputOptions
  extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
  /** Reserved for parity with CodexTranscriptInput; Copilot spans carry no
   *  multimodal payload today. Accepted but currently unused. */
  multimodal?: unknown;
}

export class CopilotLogInput extends BaseSessionInput {
  readonly id = 'copilot-log';
  readonly agentType = ClientType.CopilotCli;
  override readonly collectionMethod = CollectionMethod.SessionFilePolling;

  constructor(opts: CopilotLogInputOptions) {
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
    const root = this.sessionDir;
    const found: string[] = [];
    let top: string[];
    try {
      top = await fs.readdir(root);
    } catch {
      return found;
    }
    for (const name of top) {
      const sessionDir = path.join(root, name);
      let stat;
      try {
        stat = await fs.stat(sessionDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const eventsFile = path.join(sessionDir, 'events.jsonl');
      try {
        await fs.access(eventsFile);
        found.push(eventsFile);
      } catch {
        // session directory without events.jsonl — skip
      }
    }
    // Best-effort: also probe wakeup markers to include sessions that the
    // file watcher has not yet picked up.
    const wakeupDir = resolveHome(WAKEUP_DIR);
    try {
      const markers = await fs.readdir(wakeupDir);
      for (const marker of markers) {
        if (!marker.endsWith('.json')) continue;
        const markerPath = path.join(wakeupDir, marker);
        let raw;
        try {
          raw = await fs.readFile(markerPath, 'utf8');
        } catch {
          continue;
        }
        let parsed: any = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const sessionId = parsed?.session_id || parsed?.sessionId;
        if (!sessionId) continue;
        const eventsFile = path.join(root, String(sessionId), 'events.jsonl');
        if (!found.includes(eventsFile)) {
          try {
            await fs.access(eventsFile);
            found.push(eventsFile);
          } catch {
            // marker exists but session file no longer present
          }
        }
      }
    } catch {
      // wakeup directory absent — normal on first run
    }
    return found;
  }

  protected async processSessionLine(
    _record: Record<string, unknown>,
    _filePath: string,
  ): Promise<AgentActivityEntry | null> {
    // Copilot spans are reconstructed at the session-file level by
    // parseTranscript (the parser needs the whole file to join
    // permission.requested/completed across events by toolCallId). Per-line
    // emission is intentionally a no-op.
    return null;
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const entries: AgentActivityEntry[] = [];
    for (const filePath of files) {
      try {
        entries.push(...(await this.processSessionFile(filePath)));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') continue;
        this.logger.warn('copilot session file parse failed', {
          file: filePath,
          error: String(err),
        });
      }
    }
    return entries;
  }

  private async processSessionFile(filePath: string): Promise<AgentActivityEntry[]> {
    const stateKey = `${this.id}:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }
    const prevOffset = this.stateStore.getOffset(stateKey);
    if (prevOffset >= stat.size) {
      return this.maybeFlushTimeoutBuffer(stateKey);
    }

    let parsed: AgentActivityEntry[] = [];
    try {
      parsed = parseTranscript(filePath);
    } catch (err) {
      this.logger.warn('copilot parseTranscript failed', {
        file: filePath,
        error: String(err),
      });
      return [];
    }
    this.stateStore.setOffset(stateKey, stat.size);
    this.stateStore.update(stateKey, { extra: { inode: Number(stat.ino) } });

    let hasShutdown = false;
    try {
      hasShutdown = hasSessionShutdown(filePath);
    } catch {
      hasShutdown = false;
    }

    const now = Date.now();
    const existing = this.sessionBuffers.get(stateKey);
    const firstSeenMs = existing ? existing.firstSeenMs : now;
    this.sessionBuffers.set(stateKey, { records: parsed, firstSeenMs });

    if (hasShutdown) {
      this.sessionBuffers.delete(stateKey);
      return parsed;
    }
    if (now - firstSeenMs >= SHUTDOWN_TIMEOUT_MS) {
      this.sessionBuffers.delete(stateKey);
      return parsed;
    }
    return [];
  }

  private maybeFlushTimeoutBuffer(stateKey: string): AgentActivityEntry[] {
    const buf = this.sessionBuffers.get(stateKey);
    if (!buf) return [];
    const now = Date.now();
    if (now - buf.firstSeenMs < SHUTDOWN_TIMEOUT_MS) return [];
    this.sessionBuffers.delete(stateKey);
    return buf.records;
  }

  private readonly sessionBuffers = new Map<
    string,
    { records: AgentActivityEntry[]; firstSeenMs: number }
  >();
}

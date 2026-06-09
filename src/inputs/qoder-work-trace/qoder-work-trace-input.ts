import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { resolveHome, directoryExists, ensureDir } from '../../utils/fs-utils.js';
import { getTodayDateString } from '../../utils/fs-utils.js';
import { parseSdkLogLine, type SdkEvent } from '../qoder-work-log/qoder-work-log-input.js';

export interface QoderWorkTraceInputOptions extends InputOptions {
  logDir?: string;
  sdkLogDir?: string;
}

interface SessionTokenData {
  inputTokens: number;
  outputTokens: number;
}

/**
 * QoderWork CN TraceInput — multi-source merge.
 *
 * Reads hook JSONL (messages + structure, produced by the rewritten
 * qoderwork-hook-processor.mjs) and SDK log (tokens from message_delta).
 * Merges tokens into the hook's llm.response events, injects trace_id.
 *
 * When enabled, supersedes qoder-work-hook / qoder-work-log / qoder-work-sqlite.
 */
export class QoderWorkTraceInput extends BaseInput {
  readonly id = 'qoder-work-trace';
  readonly agentType = ClientType.QoderWork;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  private readonly logDir: string;
  private readonly sdkLogDir: string;
  private readonly logPrefix = 'qoder-work';

  constructor(opts: QoderWorkTraceInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.logDir = opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder-work/history');
    this.sdkLogDir = opts.sdkLogDir ?? resolveQoderWorkSdkLogDir();
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoderwork'));
  }

  static getWatchPaths(): string[] {
    return [
      resolveHome('~/.loongsuite-pilot/logs/qoder-work/history'),
      resolveQoderWorkSdkLogDir(),
    ];
  }

  protected override async onStart(): Promise<void> {
    await ensureDir(this.logDir);
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    // 1. Read SDK log tokens first (so they're available for enrichment)
    const sessionTokens = await this.readSdkLogTokens();

    // 2. Read hook JSONL entries
    const rawEntries = await this.readHookJsonl();
    if (rawEntries.length === 0) return [];

    // 3. Group by turn.id
    const turnGroups = this.groupByTurn(rawEntries);

    // 4. Enrich each turn with tokens + trace_id + git context
    const allEntries: AgentActivityEntry[] = [];
    for (const [, turnEntries] of turnGroups) {
      this.enrichTurnWithTokens(turnEntries, sessionTokens);
      this.injectTraceId(turnEntries);
      for (const entry of turnEntries) {
        await enrichCanonicalEntryWithGit(
          entry as Record<string, unknown>,
          entry as Record<string, unknown>,
          'qoder-work',
        );
      }
      allEntries.push(...turnEntries);
    }

    return allEntries;
  }

  // ─── Hook JSONL reading ────────────────────────────────────────────────────

  private async readHookJsonl(): Promise<AgentActivityEntry[]> {
    const today = getTodayDateString();
    const logFileName = `${this.logPrefix}-${today}.jsonl`;
    const logFile = path.join(this.logDir, logFileName);

    let stat;
    try {
      stat = await fs.stat(logFile);
    } catch {
      return [];
    }

    const state = this.getState();
    let offset = state.lastFile === logFileName ? (state.lastOffset ?? 0) : 0;

    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated, resetting offset', { file: logFile });
      offset = 0;
    }
    if (stat.size <= offset) return [];

    const handle = await fs.open(logFile, 'r');
    const entries: AgentActivityEntry[] = [];
    try {
      const maxReadSize = 16 * 1024 * 1024;
      const readSize = Math.min(stat.size - offset, maxReadSize);
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, offset);
      let text = buf.toString('utf-8');
      let consumedBytes = readSize;
      if (readSize < stat.size - offset) {
        const lastNL = text.lastIndexOf('\n');
        if (lastNL >= 0) { text = text.substring(0, lastNL); consumedBytes = Buffer.byteLength(text, 'utf-8') + 1; }
      }
      this.setState({ lastFile: logFileName, lastOffset: offset + consumedBytes });

      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as AgentActivityEntry;
          if (record['event.name']) entries.push(record);
        } catch {
          this.logger.warn('invalid JSONL line');
        }
      }
    } finally {
      await handle.close();
    }

    return entries;
  }

  // ─── SDK Log token reading ─────────────────────────────────────────────────

  private async readSdkLogTokens(): Promise<Map<string, SessionTokenData[]>> {
    const tokens = new Map<string, SessionTokenData[]>();
    const stateKey = `${this.id}:sdk-log`;

    let logFiles: string[];
    try {
      logFiles = await this.discoverSdkLogFiles();
    } catch {
      return tokens;
    }

    for (const filePath of logFiles) {
      const fileStateKey = `${stateKey}:${filePath}`;
      let stat;
      try { stat = await fs.stat(filePath); } catch { continue; }

      const prevState = this.stateStore.get(fileStateKey);
      const prevInode = prevState.extra?.inode as number | undefined;
      const currentInode = (stat as unknown as { ino: number }).ino;

      if (prevInode !== undefined && prevInode !== currentInode) {
        this.stateStore.setOffset(fileStateKey, 0);
        this.stateStore.update(fileStateKey, { extra: { inode: currentInode } });
      } else if (prevInode === undefined) {
        this.stateStore.update(fileStateKey, { extra: { inode: currentInode } });
      }

      const offset = this.stateStore.getOffset(fileStateKey);
      if (stat.size <= offset) continue;

      const handle = await fs.open(filePath, 'r');
      try {
        const readSize = Math.min(stat.size - offset, 16 * 1024 * 1024);
        const buf = Buffer.alloc(readSize);
        await handle.read(buf, 0, readSize, offset);
        let text = buf.toString('utf-8');

        let consumedBytes = readSize;
        if (readSize < stat.size - offset) {
          const lastNL = text.lastIndexOf('\n');
          if (lastNL >= 0) { text = text.substring(0, lastNL); consumedBytes = Buffer.byteLength(text, 'utf-8') + 1; }
        }
        this.stateStore.setOffset(fileStateKey, offset + consumedBytes);
        this.stateStore.update(fileStateKey, { extra: { inode: currentInode } });

        // Parse SDK log lines for message_delta events with tokens
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const event = parseSdkLogLine(line);
          if (!event) continue;
          if (event.kind === 'message_delta' && event.sessionId) {
            if (event.inputTokens > 0 || event.outputTokens > 0) {
              const list = tokens.get(event.sessionId) ?? [];
              list.push({ inputTokens: event.inputTokens, outputTokens: event.outputTokens });
              tokens.set(event.sessionId, list);
            }
          }
        }
      } finally {
        await handle.close();
      }
    }

    return tokens;
  }

  private async discoverSdkLogFiles(): Promise<string[]> {
    const files: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(this.sdkLogDir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const dir of entries) {
      if (!dir.isDirectory()) continue;
      const sessionPath = path.join(this.sdkLogDir, dir.name);
      const mainLogPath = path.join(sessionPath, 'main.log');
      try {
        const st = await fs.stat(mainLogPath);
        if (st.isFile()) { files.push(mainLogPath); continue; }
      } catch { /* fall through */ }
      const mainDir = path.join(sessionPath, 'main');
      let subEntries;
      try { subEntries = await fs.readdir(mainDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of subEntries) {
        if (entry.isFile() && entry.name.startsWith('sdk-') && entry.name.endsWith('.log')) {
          files.push(path.join(mainDir, entry.name));
        }
      }
    }
    return files.sort();
  }

  // ─── Token enrichment ──────────────────────────────────────────────────────

  // Token-to-response matching relies on FIFO order within the same sessionId.
  // This is safe because QoderWork sessions are serial (one turn at a time) and
  // SDK log message_delta events arrive in the same order as hook transcript lines.
  private enrichTurnWithTokens(entries: AgentActivityEntry[], sessionTokens: Map<string, SessionTokenData[]>): void {
    const responses = entries.filter(e => e['event.name'] === 'llm.response');
    if (responses.length === 0) return;

    const sessionId = (responses[0]['gen_ai.session.id'] as string) || '';
    if (!sessionId) return;

    const tokenList = sessionTokens.get(sessionId);
    if (!tokenList || tokenList.length === 0) return;

    // Consume ALL token entries for this turn's responses and aggregate into first response.
    // Multi-step turns (tool_use) produce one message_delta per step — we must drain them
    // all to prevent leftover tokens from leaking into subsequent turns.
    let totalInput = 0;
    let totalOutput = 0;
    for (let i = 0; i < responses.length; i++) {
      const tokenData = tokenList.shift();
      if (tokenData) {
        totalInput += tokenData.inputTokens;
        totalOutput += tokenData.outputTokens;
      }
    }
    responses[0]['gen_ai.usage.input_tokens'] = totalInput;
    responses[0]['gen_ai.usage.output_tokens'] = totalOutput;
    responses[0]['gen_ai.usage.total_tokens'] = totalInput + totalOutput;

    for (let i = 1; i < responses.length; i++) {
      responses[i]['gen_ai.usage.input_tokens'] = 0;
      responses[i]['gen_ai.usage.output_tokens'] = 0;
      responses[i]['gen_ai.usage.total_tokens'] = 0;
    }
  }

  // ─── Trace ID injection ────────────────────────────────────────────────────

  private injectTraceId(entries: AgentActivityEntry[]): void {
    if (entries.length === 0) return;
    const traceId = crypto.randomBytes(16).toString('hex');
    for (const entry of entries) {
      (entry as Record<string, unknown>).trace_id = traceId;
    }
  }

  // ─── Grouping ──────────────────────────────────────────────────────────────

  private groupByTurn(entries: AgentActivityEntry[]): Map<string, AgentActivityEntry[]> {
    const groups = new Map<string, AgentActivityEntry[]>();
    for (const entry of entries) {
      const turnId = (entry['gen_ai.turn.id'] as string) || 'unknown';
      const group = groups.get(turnId) ?? [];
      group.push(entry);
      groups.set(turnId, group);
    }
    return groups;
  }
}

function resolveQoderWorkSdkLogDir(): string {
  if (process.platform === 'darwin') {
    return resolveHome('~/Library/Application Support/QoderWork/logs');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'QoderWork', 'logs');
  return resolveHome('~/.config/QoderWork/logs');
}

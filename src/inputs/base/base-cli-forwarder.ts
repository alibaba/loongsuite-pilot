import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';
import { ensureDir, appendLine, getTodayDateString } from '../../utils/fs-utils.js';

export interface CliForwarderOptions extends InputOptions {
  /** Path to the raw telemetry log file written by the CLI tool. */
  rawTelemetryPath: string;
  /** Directory where forwarded history JSONL files are written. */
  historyDir: string;
  /** File prefix for forwarded JSONL (e.g. "gemini"). */
  historyPrefix: string;
  /** Polling interval for the raw telemetry file (default 5 seconds). */
  forwarderPollMs?: number;
}

/**
 * Base input for CLI telemetry log forwarding.
 *
 * Flow: CLI tool writes raw telemetry → forwarder polls the raw file →
 * filters relevant events → writes to daily JSONL → transforms to AgentActivityEntry.
 *
 * Subclass must implement:
 *   - isRelevantEvent(): filter for tool_call events
 *   - transformPayload(): convert a telemetry event into AgentActivityEntry
 */
export abstract class BaseCliForwarder extends BaseInput {
  readonly collectionMethod = CollectionMethod.CliTelemetryForwarding;

  protected readonly rawTelemetryPath: string;
  protected readonly historyDir: string;
  protected readonly historyPrefix: string;

  constructor(opts: CliForwarderOptions) {
    super(opts);
    this.rawTelemetryPath = opts.rawTelemetryPath;
    this.historyDir = opts.historyDir;
    this.historyPrefix = opts.historyPrefix;
    this.pollIntervalMs = opts.forwarderPollMs ?? 5_000;
  }

  protected override async onStart(): Promise<void> {
    await ensureDir(this.historyDir);
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const newRecords = await this.forwardNewTelemetry();
    const entries: AgentActivityEntry[] = [];

    for (const record of newRecords) {
      try {
        const entry = await this.transformPayload(record);
        if (entry) entries.push(entry);
      } catch (err) {
        this.logger.warn('transformPayload failed', { error: String(err) });
      }
    }
    return entries;
  }

  private async forwardNewTelemetry(): Promise<Record<string, unknown>[]> {
    let stat;
    try {
      stat = await fs.stat(this.rawTelemetryPath);
    } catch {
      return [];
    }

    const offsetKey = `${this.id}:raw`;
    const offset = this.stateStore.getOffset(offsetKey);
    if (stat.size <= offset) return [];

    const handle = await fs.open(this.rawTelemetryPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');
      this.stateStore.setOffset(offsetKey, stat.size);

      const records: Record<string, unknown>[] = [];
      const jsonObjects = this.extractJsonObjects(text);

      for (const obj of jsonObjects) {
        if (!this.isRelevantEvent(obj)) continue;

        const historyFile = path.join(
          this.historyDir,
          `${this.historyPrefix}-${getTodayDateString()}.jsonl`,
        );
        await appendLine(historyFile, JSON.stringify(obj));
        records.push(obj);
      }
      return records;
    } finally {
      await handle.close();
    }
  }

  private extractJsonObjects(text: string): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;
      try {
        results.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // skip malformed lines
      }
    }
    return results;
  }

  /** Return true if this telemetry event should be forwarded. */
  protected abstract isRelevantEvent(event: Record<string, unknown>): boolean;

  /** Convert a forwarded telemetry event into an AgentActivityEntry. */
  protected abstract transformPayload(
    event: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null>;
}

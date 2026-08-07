import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { directoryExists, ensureDir, getTodayDateString, resolveHome } from '../../utils/fs-utils.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { filterBootstrapHistoryTurns } from '../base/bootstrap-turn-filter.js';
import { createHookHistoryStartupCheckpoint } from '../base/hook-history-checkpoint.js';
import { getInterceptFile, readInterceptFile, type InterceptData, type InterceptTokenData } from '../qoder-trace/intercept-token-reader.js';

const NANO_PER_MILLI = 1_000_000n;
const SEGMENT_TIMING_TOLERANCE_MS = 5 * 60 * 1000;
const SEGMENT_STATE_TTL_MS = 60 * 60 * 1000;

/**
 * Independent QwenWorkCN trace collector.
 *
 * Hook history owns the event graph and step boundaries. QwenWorkCN session
 * segments enrich timing/model/usage, and the host-specific runtime intercept
 * supplies usage when the segment writer reports zero tokens.
 */
export class QwenWorkCNTraceInput extends BaseInput {
  readonly id = 'qwen-work-cn-trace';
  readonly agentType = ClientType.QwenWorkCN;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  private readonly logDir: string;
  private readonly segmentsRoot: string;
  private readonly interceptFile: string;
  private readonly segmentPairs = new Map<string, SegmentLlmPair[]>();
  private readonly segmentToolTimings = new Map<string, Map<string, SegmentToolTiming>>();
  private readonly subagentTurns = new Map<string, Map<string, number>>();
  private readonly inFlightPairs = new Map<string, Map<string, InFlightPair>>();
  private readonly segmentDirBySession = new Map<string, CachedSegmentDir>();

  constructor(opts: QwenWorkCNTraceInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.logDir = opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qwen-work-cn/history');
    this.segmentsRoot = opts.segmentsRoot ?? resolveHome('~/.qwenworkcn/logs/sessions');
    this.interceptFile = opts.interceptFile ?? getInterceptFile('qwenworkcn-intercept.jsonl');
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qwenworkcn'));
  }

  static getWatchPaths(opts: QwenWorkCNTraceWatchPaths = {}): string[] {
    return [
      opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qwen-work-cn/history'),
      opts.segmentsRoot ?? resolveHome('~/.qwenworkcn/logs/sessions'),
      opts.interceptFile ?? getInterceptFile('qwenworkcn-intercept.jsonl'),
    ];
  }

  protected override async onStart(): Promise<void> {
    await ensureDir(this.logDir);
    const checkpoint = await createHookHistoryStartupCheckpoint(
      this.getState(),
      this.logDir,
      'qwen-work-cn',
    );
    if (!checkpoint) return;
    this.setState(checkpoint.state);
    if (checkpoint.skippedExistingBytes > 0) {
      this.logger.warn('history checkpoint missing, baselining existing file without replay', {
        skippedBytes: checkpoint.skippedExistingBytes,
      });
    }
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    try {
      const rawEntries = await this.readHookJsonl();
      if (rawEntries.length === 0) return [];
      const entries = filterBootstrapHistoryTurns(rawEntries);

      for (const [sessionId, cwd] of this.collectSessionCwd(entries)) {
        await this.readSegmentsForSession(sessionId, cwd);
      }

      const interceptData = await this.readInterceptData();
      const output: AgentActivityEntry[] = [];
      for (const turnEntries of this.groupByTurn(entries).values()) {
        this.enrichTurn(turnEntries, interceptData);
        this.injectTraceId(turnEntries);
        for (const entry of turnEntries) {
          (entry as Record<string, unknown>)['gen_ai.agent.type'] = ClientType.QwenWorkCN;
          await enrichCanonicalEntryWithGit(
            entry as Record<string, unknown>,
            entry as Record<string, unknown>,
            'qwen-work-cn',
          );
        }
        output.push(...turnEntries);
      }
      return output;
    } finally {
      this.evictStaleState();
    }
  }

  private async readHookJsonl(): Promise<AgentActivityEntry[]> {
    const logFileName = `qwen-work-cn-${getTodayDateString()}.jsonl`;
    const logFile = path.join(this.logDir, logFileName);
    let stat;
    try {
      stat = await fs.stat(logFile);
    } catch {
      return [];
    }

    const state = this.getState();
    let offset = state.lastFile === logFileName ? (state.lastOffset ?? 0) : 0;
    if (offset > 0 && stat.size < offset) offset = 0;
    if (stat.size <= offset) return [];

    const handle = await fs.open(logFile, 'r');
    const entries: AgentActivityEntry[] = [];
    try {
      const readSize = Math.min(stat.size - offset, 16 * 1024 * 1024);
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, offset);
      let text = buffer.toString('utf-8');
      let consumedBytes = readSize;
      if (readSize < stat.size - offset) {
        const lastNewLine = text.lastIndexOf('\n');
        if (lastNewLine >= 0) {
          text = text.substring(0, lastNewLine);
          consumedBytes = Buffer.byteLength(text, 'utf-8') + 1;
        }
      }
      this.setState({ lastFile: logFileName, lastOffset: offset + consumedBytes });
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as AgentActivityEntry;
          if (record['event.name']) entries.push(record);
        } catch {
          this.logger.warn('invalid QwenWorkCN history JSONL line');
        }
      }
    } finally {
      await handle.close();
    }
    return entries;
  }

  private collectSessionCwd(entries: AgentActivityEntry[]): Map<string, string> {
    const sessions = new Map<string, string>();
    for (const entry of entries) {
      const sessionId = entry['gen_ai.session.id'] as string | undefined;
      const cwd = entry['agent.qwenworkcn.cwd'] as string | undefined;
      if (sessionId && cwd && !sessions.has(sessionId)) sessions.set(sessionId, cwd);
    }
    return sessions;
  }

  private encodeWorkspace(cwd: string): string {
    return cwd.replace(/\//g, '-').replace(/\./g, '-');
  }

  private async readSegmentsForSession(sessionId: string, cwd: string): Promise<void> {
    const segmentDir = await this.resolveSegmentsDir(sessionId, cwd);
    if (!segmentDir) return;
    let files: string[];
    try {
      files = (await fs.readdir(segmentDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(entry => path.join(segmentDir, entry.name))
        .sort();
    } catch {
      return;
    }
    for (const file of files) await this.readSegmentFile(sessionId, file);
  }

  private async resolveSegmentsDir(sessionId: string, cwd: string): Promise<string | undefined> {
    const cached = this.segmentDirBySession.get(sessionId);
    if (cached) {
      cached.seenAtMs = Date.now();
      return cached.path;
    }

    const preferred = path.join(this.segmentsRoot, this.encodeWorkspace(cwd), sessionId, 'segments');
    if (await isDirectory(preferred)) {
      this.segmentDirBySession.set(sessionId, { path: preferred, seenAtMs: Date.now() });
      return preferred;
    }

    let workspaceDirs: import('node:fs').Dirent[];
    try {
      workspaceDirs = await fs.readdir(this.segmentsRoot, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const workspaceDir of workspaceDirs) {
      if (!workspaceDir.isDirectory()) continue;
      const candidate = path.join(this.segmentsRoot, workspaceDir.name, sessionId, 'segments');
      if (await isDirectory(candidate)) {
        this.segmentDirBySession.set(sessionId, { path: candidate, seenAtMs: Date.now() });
        return candidate;
      }
    }
    return undefined;
  }

  private async readSegmentFile(sessionId: string, filePath: string): Promise<void> {
    const stateKey = `${this.id}:segment:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    const inode = (stat as unknown as { ino: number }).ino;
    const previousInode = (this.stateStore.get(stateKey).extra as { inode?: number } | undefined)?.inode;
    if (previousInode !== undefined && previousInode !== inode) this.stateStore.setOffset(stateKey, 0);
    let offset = this.stateStore.getOffset(stateKey);
    if (offset > 0 && stat.size < offset) offset = 0;
    if (stat.size <= offset) {
      this.stateStore.update(stateKey, { extra: { inode } });
      return;
    }

    const handle = await fs.open(filePath, 'r');
    let text = '';
    try {
      const readSize = Math.min(stat.size - offset, 16 * 1024 * 1024);
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, offset);
      text = buffer.toString('utf-8');
      let consumedBytes = readSize;
      if (readSize < stat.size - offset) {
        const lastNewLine = text.lastIndexOf('\n');
        if (lastNewLine >= 0) {
          text = text.substring(0, lastNewLine);
          consumedBytes = Buffer.byteLength(text, 'utf-8') + 1;
        }
      }
      this.stateStore.setOffset(stateKey, offset + consumedBytes);
      this.stateStore.update(stateKey, { extra: { inode } });
    } finally {
      await handle.close();
    }

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.handleSegmentEvent(sessionId, JSON.parse(line) as SegmentEvent);
      } catch {
        this.logger.warn('invalid QwenWorkCN segment JSONL line');
      }
    }
  }

  private handleSegmentEvent(sessionId: string, event: SegmentEvent): void {
    const seenAtMs = Date.now();
    if (event.type === 'turn.started') {
      if (event.turn_id && (event.data?.is_subagent === true || isIgnoredTurn(event.turn_id))) {
        const turns = this.subagentTurns.get(sessionId) ?? new Map<string, number>();
        turns.set(event.turn_id, seenAtMs);
        this.subagentTurns.set(sessionId, turns);
      }
      return;
    }

    if (event.type === 'model.request.started') {
      if (!event.turn_id || !event.request_id || !event.ts || this.shouldSkipTurn(sessionId, event.turn_id)) return;
      const startNano = isoToNano(event.ts);
      if (!startNano) return;
      const pairs = this.inFlightPairs.get(sessionId) ?? new Map<string, InFlightPair>();
      pairs.set(event.request_id, {
        turnId: event.turn_id,
        startNano,
        model: event.data?.model || '',
        seenAtMs,
      });
      this.inFlightPairs.set(sessionId, pairs);
      return;
    }

    if (event.type === 'model.response.completed') {
      if (!event.turn_id || !event.request_id || !event.ts || this.shouldSkipTurn(sessionId, event.turn_id)) return;
      const inFlight = this.inFlightPairs.get(sessionId)?.get(event.request_id);
      const endNano = isoToNano(event.ts);
      if (!inFlight || !endNano) return;
      this.inFlightPairs.get(sessionId)?.delete(event.request_id);
      const pairs = this.segmentPairs.get(sessionId) ?? [];
      pairs.push({
        turnId: inFlight.turnId,
        startNano: inFlight.startNano,
        endNano,
        model: event.data?.model || inFlight.model,
        usage: extractUsage(event.data),
        seenAtMs,
      });
      this.segmentPairs.set(sessionId, pairs);
      return;
    }

    if (event.type === 'tool.requested' || event.type === 'tool.execution.finished') {
      if (!event.turn_id || !event.tool_call_id || !event.ts || this.shouldSkipTurn(sessionId, event.turn_id)) return;
      const timestampNano = isoToNano(event.ts);
      if (!timestampNano) return;
      const timings = this.segmentToolTimings.get(sessionId) ?? new Map<string, SegmentToolTiming>();
      const timing = timings.get(event.tool_call_id) ?? { turnId: event.turn_id, seenAtMs };
      timing.seenAtMs = seenAtMs;
      if (event.type === 'tool.requested') timing.requestedNano = timestampNano;
      else timing.finishedNano = timestampNano;
      timings.set(event.tool_call_id, timing);
      this.segmentToolTimings.set(sessionId, timings);
    }
  }

  private shouldSkipTurn(sessionId: string, turnId: string): boolean {
    return isIgnoredTurn(turnId) || this.subagentTurns.get(sessionId)?.has(turnId) === true;
  }

  private enrichTurn(entries: AgentActivityEntry[], interceptData: InterceptData): void {
    const sessionId = entries.find(entry => entry['gen_ai.session.id'])?.['gen_ai.session.id'] as string | undefined;
    const turnId = entries.find(entry => entry['gen_ai.turn.id'])?.['gen_ai.turn.id'] as string | undefined;
    const steps = this.groupByStep(entries);
    const stepOrder = [...steps.keys()].filter((key): key is string => key !== undefined);
    const interceptTokens = new Map<string, InterceptTokenData>(interceptData.tokens.map(token => [token.id, token]));

    if (sessionId) {
      for (const stepId of stepOrder) {
        const stepEntries = steps.get(stepId);
        if (!stepEntries) continue;
        const request = stepEntries.find(entry => entry['event.name'] === 'llm.request');
        const response = stepEntries.find(entry => entry['event.name'] === 'llm.response');
        if (request && response) {
          const pair = this.takeSegmentPair(sessionId, turnId, request, response);
          let hasSegmentUsage = false;
          if (pair) {
            (request as Record<string, unknown>).time_unix_nano = pair.startNano;
            (response as Record<string, unknown>).time_unix_nano = pair.endNano;
            if (pair.model) {
              for (const entry of stepEntries) {
                if (!entry['gen_ai.request.model']
                  || entry['gen_ai.request.model'] === 'auto'
                  || entry['gen_ai.request.model'] === 'unknown') {
                  (entry as Record<string, unknown>)['gen_ai.request.model'] = pair.model;
                }
                if (entry['event.name'] === 'llm.response') {
                  (entry as Record<string, unknown>)['gen_ai.response.model'] = pair.model;
                }
              }
            }
            hasSegmentUsage = this.applyUsage(response, pair.usage);
          }
          if (!hasSegmentUsage) this.applyInterceptUsage(response, interceptTokens);
          else this.applyInterceptCacheRead(response, interceptTokens);
        }
        this.applyToolTiming(sessionId, stepEntries);
      }
    }

    if (interceptData.systemPrompt) {
      const firstRequest = entries.find(entry => entry['event.name'] === 'llm.request' && entry['gen_ai.step.id']);
      if (firstRequest) {
        (firstRequest as Record<string, unknown>)['gen_ai.system_instructions'] = [
          { type: 'text', content: interceptData.systemPrompt.content },
        ];
      }
    }

    for (let index = 0; index < stepOrder.length - 1; index++) {
      const current = steps.get(stepOrder[index]);
      const next = steps.get(stepOrder[index + 1]);
      const nextRequest = next?.find(entry => entry['event.name'] === 'llm.request');
      const nextStart = nextRequest?.time_unix_nano as string | undefined;
      if (!current || !nextStart) continue;
      const nextStartNano = BigInt(nextStart);
      for (const entry of current) {
        const timestamp = entry.time_unix_nano as string | undefined;
        if (entry['event.name'] === 'tool.result' && timestamp && BigInt(timestamp) > nextStartNano) {
          (entry as Record<string, unknown>).time_unix_nano = String(nextStartNano - NANO_PER_MILLI);
        }
      }
    }
  }

  private applyUsage(response: AgentActivityEntry, usage: TokenUsage): boolean {
    const inputTokens = positiveNumber(usage.inputTokens);
    const outputTokens = positiveNumber(usage.outputTokens);
    const cacheReadTokens = positiveNumber(usage.cacheReadInputTokens);
    const cacheCreationTokens = positiveNumber(usage.cacheCreationInputTokens);
    if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheCreationTokens) return false;
    const target = response as Record<string, unknown>;
    if (inputTokens) target['gen_ai.usage.input_tokens'] = inputTokens;
    if (outputTokens) target['gen_ai.usage.output_tokens'] = outputTokens;
    if (inputTokens || outputTokens) target['gen_ai.usage.total_tokens'] = (inputTokens ?? 0) + (outputTokens ?? 0);
    if (cacheReadTokens) target['gen_ai.usage.cache_read.input_tokens'] = cacheReadTokens;
    if (cacheCreationTokens) target['gen_ai.usage.cache_creation.input_tokens'] = cacheCreationTokens;
    return true;
  }

  private applyInterceptUsage(response: AgentActivityEntry, tokens: Map<string, InterceptTokenData>): boolean {
    const responseId = response['gen_ai.response.id'] as string | undefined;
    const match = responseId ? tokens.get(responseId) : undefined;
    if (!match) return false;
    const applied = this.applyUsage(response, {
      inputTokens: match.promptTokens,
      outputTokens: match.completionTokens,
      cacheReadInputTokens: match.cachedTokens,
    });
    if (applied && match.totalTokens) {
      (response as Record<string, unknown>)['gen_ai.usage.total_tokens'] = match.totalTokens;
    }
    return applied;
  }

  private applyInterceptCacheRead(response: AgentActivityEntry, tokens: Map<string, InterceptTokenData>): void {
    const responseId = response['gen_ai.response.id'] as string | undefined;
    const match = responseId ? tokens.get(responseId) : undefined;
    if (match?.cachedTokens && !response['gen_ai.usage.cache_read.input_tokens']) {
      (response as Record<string, unknown>)['gen_ai.usage.cache_read.input_tokens'] = match.cachedTokens;
    }
  }

  private async readInterceptData(): Promise<InterceptData> {
    try {
      return await readInterceptFile(this.interceptFile);
    } catch {
      return { tokens: [], systemPrompt: null };
    }
  }

  private takeSegmentPair(
    sessionId: string,
    turnId: string | undefined,
    request: AgentActivityEntry,
    response: AgentActivityEntry,
  ): SegmentLlmPair | undefined {
    const pairs = this.segmentPairs.get(sessionId);
    if (!pairs?.length) return undefined;
    let index = turnId ? pairs.findIndex(pair => pair.turnId === turnId) : -1;
    if (index < 0) {
      index = pairs.findIndex(pair => isCompatiblePair(pair, request, response));
    }
    if (index < 0) return undefined;
    const [pair] = pairs.splice(index, 1);
    if (pairs.length === 0) this.segmentPairs.delete(sessionId);
    return pair;
  }

  private applyToolTiming(sessionId: string, entries: AgentActivityEntry[]): void {
    const timings = this.segmentToolTimings.get(sessionId);
    if (!timings) return;
    for (const entry of entries) {
      const callId = entry['gen_ai.tool.call.id'] as string | undefined;
      const timing = callId ? timings.get(callId) : undefined;
      if (!timing) continue;
      if (entry['event.name'] === 'tool.call' && timing.requestedNano) {
        (entry as Record<string, unknown>).time_unix_nano = timing.requestedNano;
      } else if (entry['event.name'] === 'tool.result' && timing.finishedNano) {
        (entry as Record<string, unknown>).time_unix_nano = timing.finishedNano;
      }
    }
  }

  private groupByStep(entries: AgentActivityEntry[]): Map<string | undefined, AgentActivityEntry[]> {
    const groups = new Map<string | undefined, AgentActivityEntry[]>();
    for (const entry of entries) {
      const stepId = (entry['gen_ai.step.id'] as string) || undefined;
      const group = groups.get(stepId) ?? [];
      group.push(entry);
      groups.set(stepId, group);
    }
    return groups;
  }

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

  private injectTraceId(entries: AgentActivityEntry[]): void {
    const traceId = crypto.randomBytes(16).toString('hex');
    for (const entry of entries) (entry as Record<string, unknown>).trace_id = traceId;
  }

  private evictStaleState(): void {
    const cutoff = Date.now() - SEGMENT_STATE_TTL_MS;
    evictArrayMap(this.segmentPairs, pair => pair.seenAtMs >= cutoff);
    evictNestedMap(this.segmentToolTimings, timing => timing.seenAtMs >= cutoff);
    evictNestedMap(this.subagentTurns, seenAtMs => seenAtMs >= cutoff);
    evictNestedMap(this.inFlightPairs, pair => pair.seenAtMs >= cutoff);
    for (const [sessionId, cached] of this.segmentDirBySession) {
      if (cached.seenAtMs < cutoff) this.segmentDirBySession.delete(sessionId);
    }
  }
}

export interface QwenWorkCNTraceInputOptions extends InputOptions {
  logDir?: string;
  segmentsRoot?: string;
  interceptFile?: string;
}

export type QwenWorkCNTraceWatchPaths = Pick<
  QwenWorkCNTraceInputOptions,
  'logDir' | 'segmentsRoot' | 'interceptFile'
>;

interface SegmentEvent {
  ts?: string;
  type?: string;
  turn_id?: string;
  request_id?: string;
  tool_call_id?: string;
  data?: {
    model?: string;
    is_subagent?: boolean;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface InFlightPair {
  turnId: string;
  startNano: string;
  model: string;
  seenAtMs: number;
}

interface SegmentLlmPair extends InFlightPair {
  endNano: string;
  usage: TokenUsage;
}

interface SegmentToolTiming {
  turnId: string;
  requestedNano?: string;
  finishedNano?: string;
  seenAtMs: number;
}

interface CachedSegmentDir {
  path: string;
  seenAtMs: number;
}

function extractUsage(data: SegmentEvent['data']): TokenUsage {
  return {
    inputTokens: positiveNumber(data?.input_tokens),
    outputTokens: positiveNumber(data?.output_tokens),
    cacheReadInputTokens: positiveNumber(data?.cache_read_input_tokens),
    cacheCreationInputTokens: positiveNumber(data?.cache_creation_input_tokens),
  };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isoToNano(value: string): string | undefined {
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? undefined : String(BigInt(millis) * NANO_PER_MILLI);
}

function isCompatiblePair(
  pair: SegmentLlmPair,
  request: AgentActivityEntry,
  response: AgentActivityEntry,
): boolean {
  const requestNano = request.time_unix_nano as string | undefined;
  const responseNano = response.time_unix_nano as string | undefined;
  return !!requestNano && !!responseNano
    && isWithinTolerance(pair.startNano, requestNano)
    && isWithinTolerance(pair.endNano, responseNano);
}

function isWithinTolerance(left: string, right: string): boolean {
  try {
    const delta = BigInt(left) - BigInt(right);
    const absolute = delta < 0n ? -delta : delta;
    return absolute <= BigInt(SEGMENT_TIMING_TOLERANCE_MS) * NANO_PER_MILLI;
  } catch {
    return false;
  }
}

function isIgnoredTurn(turnId: string): boolean {
  return turnId.startsWith('qoderwork-memory-sink');
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function evictArrayMap<T>(map: Map<string, T[]>, keep: (value: T) => boolean): void {
  for (const [key, values] of map) {
    const retained = values.filter(keep);
    if (retained.length) map.set(key, retained);
    else map.delete(key);
  }
}

function evictNestedMap<T>(map: Map<string, Map<string, T>>, keep: (value: T) => boolean): void {
  for (const [key, values] of map) {
    for (const [nestedKey, value] of values) {
      if (!keep(value)) values.delete(nestedKey);
    }
    if (values.size === 0) map.delete(key);
  }
}

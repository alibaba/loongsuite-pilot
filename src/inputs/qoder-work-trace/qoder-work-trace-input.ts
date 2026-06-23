import * as crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { resolveHome, directoryExists, ensureDir } from '../../utils/fs-utils.js';
import { getTodayDateString } from '../../utils/fs-utils.js';
import {
  parseSdkLogLine,
  resolveQoderWorkRoot,
  type SdkEvent,
} from '../qoder-work-log/qoder-work-log-input.js';

const NANO_PER_MILLI = 1_000_000n;
const SEGMENT_TIMING_TOLERANCE_MS = 5 * 60 * 1000;
const SDK_TOKEN_MATCH_TOLERANCE_MS = 5 * 1000;
const SEGMENT_STATE_TTL_MS = 60 * 60 * 1000;

/**
 * QoderWork TraceInput — hook JSONL + segments enrichment.
 *
 * Pipeline:
 *   1. Read hook processor's JSONL output (`logs/qoder-work/history/...`) —
 *      this owns event structure (turn/step ids, message deltas, ordering).
 *   2. Read QoderWork session segments (`~/.qoderwork/logs/sessions/<ws>/<sid>/segments/*.jsonl`) —
 *      these own precise LLM timing and resolved model names.
 *   3. Match each hook step's (llm.request, llm.response) with one segment
 *      `model.request.started`/`model.response.completed` pair via per-session FIFO.
 *      Subagent turns are skipped — hook transcript only contains main agent
 *      conversation, so segment subagent LLM calls would mis-align the FIFO.
 *
 * Outputs `AgentActivityEntry[]` with shared trace_id per turn.
 */
export class QoderWorkTraceInput extends BaseInput {
  readonly id = 'qoder-work-trace';
  readonly agentType = ClientType.QoderWork;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  private readonly logDir: string;
  private readonly segmentsRoot: string;
  private readonly sdkLogDir: string;
  private readonly logPrefix = 'qoder-work';

  // Per-session in-memory state for segment enrichment
  // Key: sessionId. Value: FIFO of LLM pairs from main-turn segments.
  private readonly segmentPairs: Map<string, SegmentLlmPair[]> = new Map();
  // Per-session tool timing from segments, keyed by tool_call_id.
  private readonly segmentToolTimings: Map<string, Map<string, SegmentToolTiming>> = new Map();
  // Per-session set of turn_ids known to be subagent. We only filter LLM calls
  // whose turn_id is in this set. A turn_id absent from the set is treated as
  // main (covers the rare case where turn.started is split across files).
  private readonly subagentTurns: Map<string, Map<string, number>> = new Map();
  // Per-session in-flight LLM pairs (request seen, response not yet seen).
  private readonly inFlightPairs: Map<string, Map<string, InFlightPair>> = new Map();
  // Legacy SDK fallback is token-only. It must never change timing or model.
  private readonly sdkTokenPairs: Map<string, SdkTokenPair[]> = new Map();
  private readonly sdkInFlightMessages: Map<string, SdkInFlightMessage> = new Map();
  // The encoded workspace directory is a fast path; session-id lookup handles
  // writer encoding changes and non-POSIX workspace paths.
  private readonly segmentDirBySession: Map<string, CachedSegmentDir> = new Map();

  constructor(opts: QoderWorkTraceInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.logDir = opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder-work/history');
    this.segmentsRoot = opts.segmentsRoot ?? resolveHome('~/.qoderwork/logs/sessions');
    this.sdkLogDir = opts.sdkLogDir ?? resolveQoderWorkSdkLogDir();
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoderwork'));
  }

  static getWatchPaths(): string[] {
    return [
      resolveHome('~/.loongsuite-pilot/logs/qoder-work/history'),
      resolveHome('~/.qoderwork/logs/sessions'),
    ];
  }

  protected override async onStart(): Promise<void> {
    await ensureDir(this.logDir);
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    try {
      // Read legacy SDK logs only for token compatibility. Segment data remains
      // authoritative for LLM/tool timing and model attribution.
      await this.readSdkTokenState();

      // 1. Hook JSONL — primary source of structure.
      const { entries: rawEntries, isFirstRun, turnCount } = await this.readHookJsonl();
      if (rawEntries.length === 0) return [];

      // A fresh collector must not replay a whole pre-existing daily hook log.
      const allTurnGroups = this.groupByTurn(rawEntries);
      const entries = isFirstRun
        ? [...allTurnGroups.values()].at(-1) ?? []
        : rawEntries;
      if (isFirstRun) {
        const state = this.getState();
        const extra = state.extra && typeof state.extra === 'object'
          ? state.extra as Record<string, unknown>
          : {};
        this.setState({
          extra: { ...extra, qoderWorkTurnCount: turnCount ?? allTurnGroups.size },
        });
      }

      // 2. Discover the (sessionId, cwd) pairs we have entries for, then read
      //    fresh segments for each. Lazily — sessions absent from hook batch
      //    don't trigger segment IO.
      const sessionCwd = this.collectSessionCwd(entries);
      for (const [sessionId, cwd] of sessionCwd) {
        await this.readSegmentsForSession(sessionId, cwd);
      }

      // 3. Group → enrich → emit.
      const turnGroups = this.groupByTurn(entries);
      const allEntries: AgentActivityEntry[] = [];
      for (const [, turnEntries] of turnGroups) {
        this.enrichTurn(turnEntries);
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
    } finally {
      this.evictStaleState();
    }
  }

  // ─── Hook JSONL reading ────────────────────────────────────────────────────

  private async readHookJsonl(): Promise<HookJsonlBatch> {
    const today = getTodayDateString();
    const logFileName = `${this.logPrefix}-${today}.jsonl`;
    const logFile = path.join(this.logDir, logFileName);

    let stat;
    try {
      stat = await fs.stat(logFile);
    } catch {
      return { entries: [], isFirstRun: false };
    }

    const state = this.getState();
    let offset = state.lastFile === logFileName ? (state.lastOffset ?? 0) : 0;

    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated, resetting offset', { file: logFile });
      offset = 0;
    }
    if (stat.size <= offset) return { entries: [], isFirstRun: false };

    const hasFirstRunMarker = state.extra
      && typeof state.extra === 'object'
      && Object.hasOwn(state.extra, 'qoderWorkTurnCount');
    const isFirstRun = offset === 0 && !hasFirstRunMarker;

    if (isFirstRun) {
      return this.readFirstRunHookBaseline(logFile, logFileName, stat.size);
    }

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

    return { entries, isFirstRun };
  }

  private async readFirstRunHookBaseline(
    logFile: string,
    logFileName: string,
    fileSize: number,
  ): Promise<HookJsonlBatch> {
    let latestTurnId: string | undefined;
    let latestTurnEntries: AgentActivityEntry[] = [];
    let turnCount = 0;
    const reader = createInterface({
      input: createReadStream(logFile, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of reader) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as AgentActivityEntry;
        if (!record['event.name']) continue;
        const turnId = String(record['gen_ai.turn.id'] ?? 'unknown');
        if (turnId !== latestTurnId) {
          latestTurnId = turnId;
          latestTurnEntries = [];
          turnCount++;
        }
        latestTurnEntries.push(record);
      } catch {
        this.logger.warn('invalid JSONL line');
      }
    }

    this.setState({ lastFile: logFileName, lastOffset: fileSize });
    return { entries: latestTurnEntries, isFirstRun: true, turnCount };
  }

  // ─── Segments reading ──────────────────────────────────────────────────────

  private collectSessionCwd(entries: AgentActivityEntry[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const e of entries) {
      const sid = e['gen_ai.session.id'] as string | undefined;
      const cwd = e['agent.qoderwork.cwd'] as string | undefined;
      if (sid && cwd && !map.has(sid)) map.set(sid, cwd);
    }
    return map;
  }

  /**
   * QoderWork 1.0.21 on macOS writes this form. Keep it as a fast path, then
   * resolve by session id below so a writer/platform encoding change does not
   * silently disable timing enrichment.
   */
  private encodeWorkspace(cwd: string): string {
    return cwd.replace(/\//g, '-').replace(/\./g, '-');
  }

  private async readSegmentsForSession(sessionId: string, cwd: string): Promise<void> {
    const segDir = await this.resolveSegmentsDir(sessionId, cwd);
    if (!segDir) return;

    let files: string[];
    try {
      const dirEntries = await fs.readdir(segDir, { withFileTypes: true });
      files = dirEntries
        .filter(d => d.isFile() && d.name.endsWith('.jsonl'))
        .map(d => path.join(segDir, d.name))
        .sort(); // filename starts with ISO timestamp → sort = chronological
    } catch {
      return; // no segments dir for this session yet
    }

    for (const filePath of files) {
      await this.readSegmentsFile(sessionId, filePath);
    }
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

  private async readSegmentsFile(sessionId: string, filePath: string): Promise<void> {
    const fileStateKey = `${this.id}:seg:${filePath}`;

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }

    const prevState = this.stateStore.get(fileStateKey);
    const prevInode = (prevState.extra as { inode?: number } | undefined)?.inode;
    const currentInode = (stat as unknown as { ino: number }).ino;

    if (prevInode !== undefined && prevInode !== currentInode) {
      this.stateStore.setOffset(fileStateKey, 0);
      this.stateStore.update(fileStateKey, { extra: { inode: currentInode } });
    } else if (prevInode === undefined) {
      this.stateStore.update(fileStateKey, { extra: { inode: currentInode } });
    }

    let offset = this.stateStore.getOffset(fileStateKey);
    if (offset > 0 && stat.size < offset) offset = 0; // truncated
    if (stat.size <= offset) return;

    const handle = await fs.open(filePath, 'r');
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
      this.stateStore.setOffset(fileStateKey, offset + consumedBytes);
      this.stateStore.update(fileStateKey, { extra: { inode: currentInode } });

      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as SegmentEvent;
          this.handleSegmentEvent(sessionId, event);
        } catch {
          this.logger.warn('invalid segments JSONL line');
        }
      }
    } finally {
      await handle.close();
    }
  }

  private handleSegmentEvent(sessionId: string, event: SegmentEvent): void {
    const seenAtMs = Date.now();
    switch (event.type) {
      case 'turn.started': {
        if (event.turn_id && (event.data?.is_subagent === true || isIgnoredSegmentTurn(event.turn_id))) {
          const turns = this.subagentTurns.get(sessionId) ?? new Map<string, number>();
          turns.set(event.turn_id, seenAtMs);
          this.subagentTurns.set(sessionId, turns);
        }
        return;
      }
      case 'model.request.started': {
        if (!event.turn_id || !event.request_id || !event.ts) return;
        // Skip subagent LLM calls — hook transcript only carries main agent.
        if (this.shouldSkipSegmentTurn(sessionId, event.turn_id)) return;
        const startNano = isoToNano(event.ts);
        if (!startNano) return;
        let m = this.inFlightPairs.get(sessionId);
        if (!m) { m = new Map(); this.inFlightPairs.set(sessionId, m); }
        m.set(event.request_id, {
          turnId: event.turn_id,
          startNano,
          model: event.data?.model || '',
          seenAtMs,
        });
        return;
      }
      case 'model.response.completed': {
        if (!event.turn_id || !event.request_id || !event.ts) return;
        if (this.shouldSkipSegmentTurn(sessionId, event.turn_id)) return;
        const inFlightForSession = this.inFlightPairs.get(sessionId);
        const inFlight = inFlightForSession?.get(event.request_id);
        if (!inFlight) return; // orphan response (e.g. resumed mid-stream)
        inFlightForSession!.delete(event.request_id);
        const endNano = isoToNano(event.ts);
        if (!endNano) return;
        const list = this.segmentPairs.get(sessionId) ?? [];
        list.push({
          turnId: inFlight.turnId,
          startNano: inFlight.startNano,
          endNano,
          model: event.data?.model || inFlight.model || '',
          usage: extractSegmentUsage(event.data),
          seenAtMs,
        });
        this.segmentPairs.set(sessionId, list);
        return;
      }
      case 'tool.requested':
      case 'tool.execution.finished': {
        if (!event.turn_id || !event.tool_call_id || !event.ts) return;
        if (this.shouldSkipSegmentTurn(sessionId, event.turn_id)) return;
        const nano = isoToNano(event.ts);
        if (!nano) return;
        const timings = this.segmentToolTimings.get(sessionId) ?? new Map<string, SegmentToolTiming>();
        const existing = timings.get(event.tool_call_id) ?? { turnId: event.turn_id, seenAtMs };
        existing.turnId = event.turn_id;
        existing.seenAtMs = seenAtMs;
        if (event.data?.tool_name) existing.toolName = String(event.data.tool_name);
        if (event.type === 'tool.requested') {
          existing.requestedNano = nano;
        } else {
          existing.finishedNano = nano;
        }
        timings.set(event.tool_call_id, existing);
        this.segmentToolTimings.set(sessionId, timings);
        return;
      }
      default:
        return;
    }
  }

  private shouldSkipSegmentTurn(sessionId: string, turnId: string): boolean {
    return isIgnoredSegmentTurn(turnId) || this.subagentTurns.get(sessionId)?.has(turnId) === true;
  }

  // ─── Enrichment ─────────────────────────────────────────────────────────────

  private enrichTurn(entries: AgentActivityEntry[]): void {
    const sessionId = entries.find(e => e['gen_ai.session.id'])?.['gen_ai.session.id'] as string | undefined;
    const turnId = entries.find(e => e['gen_ai.turn.id'])?.['gen_ai.turn.id'] as string | undefined;

    const steps = this.groupByStep(entries);
    const stepOrder = [...steps.keys()].filter((k): k is string => k !== undefined);

    // Apply segment-derived timing + model to each step in transcript order.
    if (sessionId) {
      for (const stepId of stepOrder) {
        const stepEntries = steps.get(stepId);
        if (!stepEntries) continue;
        const request = stepEntries.find(e => e['event.name'] === 'llm.request');
        const response = stepEntries.find(e => e['event.name'] === 'llm.response');
        let hasSegmentUsage = false;
        if (request && response) {
          const pair = this.takeSegmentPair(sessionId, turnId, request, response);
          if (pair) {
            (request as Record<string, unknown>)['time_unix_nano'] = pair.startNano;
            (response as Record<string, unknown>)['time_unix_nano'] = pair.endNano;

            if (pair.model) {
              for (const e of stepEntries) {
                if (!e['gen_ai.request.model'] || e['gen_ai.request.model'] === 'auto') {
                  (e as Record<string, unknown>)['gen_ai.request.model'] = pair.model;
                }
                if (e['event.name'] === 'llm.response') {
                  (e as Record<string, unknown>)['gen_ai.response.model'] = pair.model;
                }
              }
            }
            hasSegmentUsage = this.applyUsage(response, pair.usage);
          }
          if (!hasSegmentUsage) this.applySdkTokenUsage(sessionId, request, response);
        }

        this.applySegmentToolTiming(sessionId, stepEntries);
      }
    }

    // Defensive STEP overlap clamp: ensure tool.result of step N doesn't exceed
    // llm.request of step N+1. Hook is already monotonic; segments enrichment
    // shouldn't break that, but we keep this guard for edge cases.
    for (let i = 0; i < stepOrder.length - 1; i++) {
      const currentStepEntries = steps.get(stepOrder[i]);
      const nextStepEntries = steps.get(stepOrder[i + 1]);
      if (!currentStepEntries || !nextStepEntries) continue;

      const nextRequest = nextStepEntries.find(e => e['event.name'] === 'llm.request');
      if (!nextRequest) continue;
      const nextStartNano = nextRequest['time_unix_nano'] as string | undefined;
      if (!nextStartNano) continue;
      const nextStartBig = BigInt(nextStartNano);
      const capNano = String(nextStartBig - 1_000_000n); // 减 1ms

      for (const e of currentStepEntries) {
        if (e['event.name'] !== 'tool.result') continue;
        const ts = e['time_unix_nano'] as string | undefined;
        if (ts && BigInt(ts) > nextStartBig) {
          (e as Record<string, unknown>)['time_unix_nano'] = capNano;
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

  private applySdkTokenUsage(
    sessionId: string,
    request: AgentActivityEntry,
    response: AgentActivityEntry,
  ): void {
    const requestNano = request['time_unix_nano'] as string | undefined;
    const requestMs = nanoToMillis(requestNano);
    if (requestMs === undefined) return;

    const pairs = this.sdkTokenPairs.get(sessionId);
    if (!pairs?.length) return;
    let index = -1;
    let smallestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pairs.length; i++) {
      const delta = Math.abs(pairs[i].startMs - requestMs);
      if (delta <= SDK_TOKEN_MATCH_TOLERANCE_MS && delta < smallestDelta) {
        index = i;
        smallestDelta = delta;
      }
    }
    if (index < 0) return;

    const [pair] = pairs.splice(index, 1);
    if (pairs.length === 0) this.sdkTokenPairs.delete(sessionId);
    this.applyUsage(response, pair);
  }

  // ─── SDK token compatibility ─────────────────────────────────────────────

  private async readSdkTokenState(): Promise<void> {
    for (const filePath of await this.discoverSdkLogFiles()) {
      await this.readSdkTokenFile(filePath);
    }
  }

  private async discoverSdkLogFiles(): Promise<string[]> {
    let sessionDirs: import('node:fs').Dirent[];
    try {
      sessionDirs = await fs.readdir(this.sdkLogDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: string[] = [];
    for (const dir of sessionDirs) {
      if (!dir.isDirectory()) continue;
      const sessionDir = path.join(this.sdkLogDir, dir.name);
      const mainLog = path.join(sessionDir, 'main.log');
      if (await isFile(mainLog)) {
        files.push(mainLog);
        continue;
      }
      const legacyDir = path.join(sessionDir, 'main');
      try {
        const legacyFiles = await fs.readdir(legacyDir, { withFileTypes: true });
        for (const file of legacyFiles) {
          if (file.isFile() && file.name.startsWith('sdk-') && file.name.endsWith('.log')) {
            files.push(path.join(legacyDir, file.name));
          }
        }
      } catch {
        // The directory can be created after the session directory appears.
      }
    }
    return files.sort();
  }

  private async readSdkTokenFile(filePath: string): Promise<void> {
    const stateKey = `${this.id}:sdk-token:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    const currentInode = (stat as unknown as { ino: number }).ino;
    const previous = this.stateStore.get(stateKey);
    const previousInode = (previous.extra as { inode?: number } | undefined)?.inode;
    if (previousInode !== undefined && previousInode !== currentInode) {
      this.stateStore.setOffset(stateKey, 0);
    }

    let offset = previousInode !== undefined && previousInode !== currentInode
      ? 0
      : this.stateStore.getOffset(stateKey);
    if (offset > 0 && stat.size < offset) offset = 0;
    if (stat.size <= offset) {
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
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
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
    } finally {
      await handle.close();
    }

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = parseSdkLogLine(line);
      if (event) this.handleSdkTokenEvent(event);
    }
  }

  private handleSdkTokenEvent(event: SdkEvent): void {
    const seenAtMs = Date.now();
    if (event.kind === 'message_start') {
      if (!event.sessionId) return;
      this.sdkInFlightMessages.set(event.sessionId, { startMs: event.ts, seenAtMs });
      return;
    }
    if (event.kind !== 'message_delta') return;
    if (!event.sessionId) return;
    const inFlight = this.sdkInFlightMessages.get(event.sessionId);
    if (!inFlight) return;
    this.sdkInFlightMessages.delete(event.sessionId);
    const pairs = this.sdkTokenPairs.get(event.sessionId) ?? [];
    pairs.push({
      startMs: inFlight.startMs,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      seenAtMs,
    });
    this.sdkTokenPairs.set(event.sessionId, pairs);
  }

  private evictStaleState(): void {
    const cutoff = Date.now() - SEGMENT_STATE_TTL_MS;
    evictMapValues(this.segmentPairs, pair => pair.seenAtMs >= cutoff);
    evictNestedMapValues(this.segmentToolTimings, timing => timing.seenAtMs >= cutoff);
    evictNestedMapValues(this.subagentTurns, seenAtMs => seenAtMs >= cutoff);
    evictNestedMapValues(this.inFlightPairs, pair => pair.seenAtMs >= cutoff);
    evictMapValues(this.sdkTokenPairs, pair => pair.seenAtMs >= cutoff);
    for (const [sessionId, message] of this.sdkInFlightMessages) {
      if (message.seenAtMs < cutoff) this.sdkInFlightMessages.delete(sessionId);
    }
    for (const [sessionId, cachedDir] of this.segmentDirBySession) {
      if (cachedDir.seenAtMs < cutoff) this.segmentDirBySession.delete(sessionId);
    }
  }

  private takeSegmentPair(
    sessionId: string,
    turnId: string | undefined,
    request: AgentActivityEntry,
    response: AgentActivityEntry,
  ): SegmentLlmPair | undefined {
    const buffer = this.segmentPairs.get(sessionId);
    if (!buffer?.length) return undefined;

    let idx = turnId ? buffer.findIndex(pair => pair.turnId === turnId) : -1;
    if (idx < 0) {
      idx = buffer.findIndex(pair => this.isSegmentPairCompatible(pair, request, response));
    }
    if (idx < 0) return undefined;

    const [pair] = buffer.splice(idx, 1);
    if (buffer.length === 0) this.segmentPairs.delete(sessionId);
    return pair;
  }

  private isSegmentPairCompatible(
    pair: SegmentLlmPair,
    request: AgentActivityEntry,
    response: AgentActivityEntry,
  ): boolean {
    const requestNano = request['time_unix_nano'] as string | undefined;
    const responseNano = response['time_unix_nano'] as string | undefined;
    if (!requestNano || !responseNano) return false;
    return isWithinTolerance(pair.startNano, requestNano, SEGMENT_TIMING_TOLERANCE_MS)
      && isWithinTolerance(pair.endNano, responseNano, SEGMENT_TIMING_TOLERANCE_MS);
  }

  private applySegmentToolTiming(sessionId: string, stepEntries: AgentActivityEntry[]): void {
    const timings = this.segmentToolTimings.get(sessionId);
    if (!timings?.size) return;

    const usedCallIds = new Set<string>();
    for (const entry of stepEntries) {
      const eventName = entry['event.name'];
      if (eventName !== 'tool.call' && eventName !== 'tool.result') continue;
      const callId = entry['gen_ai.tool.call.id'] as string | undefined;
      if (!callId) continue;
      const timing = timings.get(callId);
      if (!timing) continue;

      if (eventName === 'tool.call' && timing.requestedNano) {
        (entry as Record<string, unknown>)['time_unix_nano'] = timing.requestedNano;
        usedCallIds.add(callId);
      } else if (eventName === 'tool.result' && timing.finishedNano) {
        (entry as Record<string, unknown>)['time_unix_nano'] = timing.finishedNano;
        usedCallIds.add(callId);
      }
    }

    for (const callId of usedCallIds) {
      const timing = timings.get(callId);
      const hasCallEntry = stepEntries.some(entry =>
        entry['event.name'] === 'tool.call' && entry['gen_ai.tool.call.id'] === callId
      );
      const hasResultEntry = stepEntries.some(entry =>
        entry['event.name'] === 'tool.result' && entry['gen_ai.tool.call.id'] === callId
      );
      if (hasCallEntry && hasResultEntry && timing?.requestedNano && timing.finishedNano) {
        timings.delete(callId);
      }
    }
    if (timings.size === 0) this.segmentToolTimings.delete(sessionId);
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

export interface QoderWorkTraceInputOptions extends InputOptions {
  logDir?: string;
  segmentsRoot?: string;
  sdkLogDir?: string;
}

interface HookJsonlBatch {
  entries: AgentActivityEntry[];
  isFirstRun: boolean;
  turnCount?: number;
}

interface SegmentEvent {
  ts?: string;
  type?: string;
  turn_id?: string;
  request_id?: string;
  tool_call_id?: string;
  data?: {
    model?: string;
    is_subagent?: boolean;
    tool_name?: string;
    [key: string]: unknown;
  };
}

interface InFlightPair {
  turnId: string;
  startNano: string;
  model: string;
  seenAtMs: number;
}

interface SegmentLlmPair {
  turnId: string;
  startNano: string;
  endNano: string;
  model: string;
  usage: TokenUsage;
  seenAtMs: number;
}

interface SegmentToolTiming {
  turnId: string;
  toolName?: string;
  requestedNano?: string;
  finishedNano?: string;
  seenAtMs: number;
}

interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface SdkTokenPair extends TokenUsage {
  startMs: number;
  seenAtMs: number;
}

interface SdkInFlightMessage {
  startMs: number;
  seenAtMs: number;
}

interface CachedSegmentDir {
  path: string;
  seenAtMs: number;
}

function isoToNano(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return String(BigInt(ms) * 1_000_000n);
}

function extractSegmentUsage(data: SegmentEvent['data']): TokenUsage {
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

function nanoToMillis(nano: string | undefined): number | undefined {
  if (!nano) return undefined;
  try {
    return Number(BigInt(nano) / NANO_PER_MILLI);
  } catch {
    return undefined;
  }
}

function resolveQoderWorkSdkLogDir(): string {
  return path.join(resolveQoderWorkRoot(), 'logs');
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function evictMapValues<T>(map: Map<string, T[]>, keep: (value: T) => boolean): void {
  for (const [key, values] of map) {
    const retained = values.filter(keep);
    if (retained.length === 0) map.delete(key);
    else map.set(key, retained);
  }
}

function evictNestedMapValues<T>(map: Map<string, Map<string, T>>, keep: (value: T) => boolean): void {
  for (const [sessionId, values] of map) {
    for (const [key, value] of values) {
      if (!keep(value)) values.delete(key);
    }
    if (values.size === 0) map.delete(sessionId);
  }
}

function isIgnoredSegmentTurn(turnId: string): boolean {
  return turnId.startsWith('qoderwork-memory-sink');
}

function isWithinTolerance(leftNano: string, rightNano: string, toleranceMs: number): boolean {
  try {
    const delta = BigInt(leftNano) - BigInt(rightNano);
    const abs = delta < 0n ? -delta : delta;
    return abs <= BigInt(toleranceMs) * NANO_PER_MILLI;
  } catch {
    return false;
  }
}

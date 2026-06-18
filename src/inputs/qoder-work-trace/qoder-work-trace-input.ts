import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { resolveHome, directoryExists, ensureDir } from '../../utils/fs-utils.js';
import { getTodayDateString } from '../../utils/fs-utils.js';

const NANO_PER_MILLI = 1_000_000n;
const SEGMENT_TIMING_TOLERANCE_MS = 5 * 60 * 1000;

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
  private readonly logPrefix = 'qoder-work';

  // Per-session in-memory state for segment enrichment
  // Key: sessionId. Value: FIFO of LLM pairs from main-turn segments.
  private readonly segmentPairs: Map<string, SegmentLlmPair[]> = new Map();
  // Per-session tool timing from segments, keyed by tool_call_id.
  private readonly segmentToolTimings: Map<string, Map<string, SegmentToolTiming>> = new Map();
  // Per-session set of turn_ids known to be subagent. We only filter LLM calls
  // whose turn_id is in this set. A turn_id absent from the set is treated as
  // main (covers the rare case where turn.started is split across files).
  private readonly subagentTurns: Map<string, Set<string>> = new Map();
  // Per-session in-flight LLM pairs (request seen, response not yet seen).
  private readonly inFlightPairs: Map<string, Map<string, InFlightPair>> = new Map();

  constructor(opts: QoderWorkTraceInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.logDir = opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder-work/history');
    this.segmentsRoot = opts.segmentsRoot ?? resolveHome('~/.qoderwork/logs/sessions');
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
    // 1. Hook JSONL — primary source of structure.
    const rawEntries = await this.readHookJsonl();
    if (rawEntries.length === 0) return [];

    // 2. Discover the (sessionId, cwd) pairs we have entries for, then read
    //    fresh segments for each. Lazily — sessions absent from hook batch
    //    don't trigger segment IO.
    const sessionCwd = this.collectSessionCwd(rawEntries);
    for (const [sessionId, cwd] of sessionCwd) {
      await this.readSegmentsForSession(sessionId, cwd);
    }

    // 3. Group → enrich → emit.
    const turnGroups = this.groupByTurn(rawEntries);
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

  /** Encode a workspace cwd into the qoderwork sessions directory name. */
  private encodeWorkspace(cwd: string): string {
    return cwd.replace(/\//g, '-').replace(/\./g, '-');
  }

  private async readSegmentsForSession(sessionId: string, cwd: string): Promise<void> {
    const ws = this.encodeWorkspace(cwd);
    const segDir = path.join(this.segmentsRoot, ws, sessionId, 'segments');

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
    switch (event.type) {
      case 'turn.started': {
        if (event.turn_id && (event.data?.is_subagent === true || isIgnoredSegmentTurn(event.turn_id))) {
          let set = this.subagentTurns.get(sessionId);
          if (!set) { set = new Set(); this.subagentTurns.set(sessionId, set); }
          set.add(event.turn_id);
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
        const existing = timings.get(event.tool_call_id) ?? { turnId: event.turn_id };
        existing.turnId = event.turn_id;
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
          }
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
}

interface SegmentLlmPair {
  turnId: string;
  startNano: string;
  endNano: string;
  model: string;
}

interface SegmentToolTiming {
  turnId: string;
  toolName?: string;
  requestedNano?: string;
  finishedNano?: string;
}

function isoToNano(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return String(BigInt(ms) * 1_000_000n);
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

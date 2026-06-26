import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { resolveHome, directoryExists, ensureDir } from '../../utils/fs-utils.js';
import { getTodayDateString } from '../../utils/fs-utils.js';
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { readSqliteTokensForSession } from './sqlite-token-reader.js';
import { enrichIdeTurn, injectTraceId } from '../qoder-trace/token-enricher.js';

export interface QoderCnTraceInputOptions extends InputOptions {
  logDir?: string;
}

/**
 * Multi-source merge input for QoderCN (IDE-only).
 * Reads hook JSONL (content+structure) and SQLite (IDE tokens),
 * merges per session, outputs enriched events for both event logs (SLS)
 * and trace conversion (ARMS).
 *
 * Pattern mirrors qoder-trace-input.ts: always emit immediately, never buffer.
 * The token enricher's timestamp fallback handles any unmatched entries
 * (sets token=0), which is safe for downstream consumers.
 */
export class QoderCnTraceInput extends BaseInput {
  readonly id = 'qoder-cn-trace';
  readonly agentType = ClientType.QoderCn;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  private readonly logDir: string;
  private readonly logPrefix = 'qoder-cn';

  // Persists across collect() cycles: tracks the last anchor turn.id and its
  // max step counter per session so orphan turns from later cycles can be
  // merged into the correct turn.
  private readonly sessionAnchor = new Map<string, { turnId: string; maxStep: number }>();

  constructor(opts: QoderCnTraceInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.logDir = opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder-cn/history');
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoder-cn'));
  }

  static getWatchPaths(): string[] {
    return [
      resolveHome('~/.loongsuite-pilot/logs/qoder-cn/history'),
    ];
  }

  protected override async onStart(): Promise<void> {
    await ensureDir(this.logDir);
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const rawEntries = await this.readHookJsonl();
    if (rawEntries.length === 0) return [];

    const turnGroups = this.groupByTurn(rawEntries);

    // Cross-cycle orphan turn merge: turns that have no user input (orphan)
    // are merged into the most recent anchor turn for that session.
    // Because the anchor turn was produced in a previous collect() cycle, we
    // keep its turn.id and step counter in sessionAnchor (instance-level).
    for (const [turnId, entries] of turnGroups) {
      const sessionId = this.extractSessionId(entries);
      if (!sessionId) continue;

      const hasUserInput = entries.some(e =>
        e['event.name'] === 'other' && e['gen_ai.input.messages_delta'],
      );

      if (hasUserInput) {
        // Anchor turn: record it and its max step number for future orphans.
        let maxStep = 0;
        for (const e of entries) {
          const m = ((e['gen_ai.step.id'] as string) || '').match(/:s(\d+)$/);
          if (m) { const n = parseInt(m[1]); if (n > maxStep) maxStep = n; }
        }
        this.sessionAnchor.set(sessionId, { turnId, maxStep });
      } else {
        // Orphan turn: reassign to the last anchor if one exists.
        const anchor = this.sessionAnchor.get(sessionId);
        if (!anchor) continue;

        // Collect orphan step.ids sorted so renumbering is deterministic.
        const orphanStepIds = [...new Set(
          entries.map(e => (e['gen_ai.step.id'] as string) || '').filter(Boolean),
        )].sort();

        const stepRemap = new Map<string, string>();
        for (const sid of orphanStepIds) {
          anchor.maxStep += 1;
          stepRemap.set(sid, `${anchor.turnId}:s${anchor.maxStep}`);
        }

        for (const e of entries) {
          e['gen_ai.turn.id'] = anchor.turnId;
          const sid = e['gen_ai.step.id'] as string | undefined;
          if (sid && stepRemap.has(sid)) {
            e['gen_ai.step.id'] = stepRemap.get(sid)!;
          }
        }
      }
    }

    // Re-group after orphan merge since turn.id may have been mutated.
    const mergedGroups = this.groupByTurn(rawEntries);

    // Deduplicate events within each turn BEFORE enrichment so that
    // enrichIdeTurn only sees canonical events. When the hook processor
    // writes the same turn multiple times (partial retry + complete Stop),
    // dedup keeps only the last event per (step_id, event_name, tool_call_id).
    for (const [, turnEntries] of mergedGroups) {
      dedupeEventsInTurn(turnEntries);
    }

    // Aggregate all turns in the same session so enrichIdeTurn can use
    // SQLite request ordering to match tokens correctly across turns.
    // Mirrors qoder-trace-input.ts ideSessionGroups pattern.
    const ideSessionGroups = new Map<string, AgentActivityEntry[]>();
    const noSessionEntries: AgentActivityEntry[] = [];
    for (const [, turnEntries] of mergedGroups) {
      const sessionId = this.extractSessionId(turnEntries);
      if (sessionId) {
        const sessionEntries = ideSessionGroups.get(sessionId) ?? [];
        sessionEntries.push(...turnEntries);
        ideSessionGroups.set(sessionId, sessionEntries);
      } else {
        noSessionEntries.push(...turnEntries);
      }
    }

    for (const [sessionId, sessionEntries] of ideSessionGroups) {
      const sqliteRows = await readSqliteTokensForSession(sessionId);
      enrichIdeTurn(sessionEntries, sqliteRows);
      // Post-processing after enrichIdeTurn:
      expandContainerTimes(sessionEntries);
      propagateModelToToolEvents(sessionEntries);
      computeToolCallDurations(sessionEntries);
      alignUserBoundaryToFirstLlmRequest(sessionEntries);
    }

    // Aggregate all session entries.
    const allSessionEntries: AgentActivityEntry[] = [];
    for (const sessionEntries of ideSessionGroups.values()) {
      allSessionEntries.push(...sessionEntries);
    }

    const allTurnGroups = this.groupByTurn(allSessionEntries);
    for (const [, turnEntries] of allTurnGroups) {
      injectTraceId(turnEntries);
    }

    // No-session entries also get dedup + trace_id injection.
    const noSessionTurnGroups = this.groupByTurn(noSessionEntries);
    for (const [, turnEntries] of noSessionTurnGroups) {
      dedupeEventsInTurn(turnEntries);
      injectTraceId(turnEntries);
    }

    // Return events grouped by turn so all events for the same turn are
    // contiguous. The OTLP flusher flushes a turn when it sees events from
    // a different turn, so interleaved turns cause synthetic events (tool.result,
    // llm.request) to be dropped as "late arrivals" for already-flushed turns.
    const ordered: AgentActivityEntry[] = [];
    for (const [, turnEntries] of allTurnGroups) {
      ordered.push(...turnEntries);
    }
    for (const [, turnEntries] of noSessionTurnGroups) {
      ordered.push(...turnEntries);
    }
    return ordered;
  }

  // ─── Hook JSONL reading ─────────────────────────────────────────────────────

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
      this.logger.info('file truncated, resetting offset', { file: logFile, recorded: offset, actual: stat.size });
      offset = 0;
    }
    if (stat.size <= offset) return [];

    const handle = await fs.open(logFile, 'r');
    const entries: AgentActivityEntry[] = [];
    try {
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');
      this.setState({ lastFile: logFileName, lastOffset: stat.size });

      const lines = text.split('\n').filter(l => l.trim().length > 0);

      for (const line of lines) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          const entry = await this.transformRecord(record);
          if (entry) entries.push(entry);
        } catch (err) {
          this.logger.warn('invalid JSONL line', { error: String(err) });
        }
      }
    } finally {
      await handle.close();
    }

    return entries;
  }

  // ─── Record transformation ──────────────────────────────────────────────────

  private async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    const canonicalEntry = buildCanonicalHookEntry(record, ClientType.QoderCn);
    if (canonicalEntry) {
      await enrichCanonicalEntryWithGit(canonicalEntry, record, 'qodercn');
      return canonicalEntry;
    }
    return null;
  }

  // ─── Grouping ───────────────────────────────────────────────────────────────

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

  private extractSessionId(entries: AgentActivityEntry[]): string | undefined {
    for (const entry of entries) {
      const sid = entry['gen_ai.session.id'] as string;
      if (sid) return sid;
    }
    return undefined;
  }
}

// Deduplicate events within a single turn by (step_id, event_name, tool_call_id).
// When the hook processor writes events for the same turn multiple times (e.g.,
// a partial turn from an earlier retry followed by a complete turn from the
// Stop retry), this keeps only the last event for each key — the complete
// version written last.
function dedupeEventsInTurn(entries: AgentActivityEntry[]): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const stepId = (e['gen_ai.step.id'] as string) || '';
    const eventName = e['event.name'] as string;
    const toolCallId = (e['gen_ai.tool.call.id'] as string) || '';
    const key = `${stepId}|${eventName}|${toolCallId}`;
    seen.set(key, i);
  }

  const keepIndices = new Set(seen.values());
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!keepIndices.has(i)) {
      entries.splice(i, 1);
    }
  }
}

// Align the 'other' (user-boundary) event to the step-1 llm.request within
//   1. Set time_unix_nano equal to the llm.request time (removes any 1ms gap
//      that would make the converter insert an empty STEP).
//   2. Set gen_ai.step.id to the step-1 step.id. Without a step.id the
//      converter creates a separate 0ms empty STEP container for step-less
//      events, resulting in a "STEP has 0 LLM children" validation error.
function alignUserBoundaryToFirstLlmRequest(entries: AgentActivityEntry[]): void {
  const byTurn = new Map<string, AgentActivityEntry[]>();
  for (const e of entries) {
    const tid = (e['gen_ai.turn.id'] as string) || '';
    if (!tid) continue;
    const list = byTurn.get(tid) ?? [];
    list.push(e);
    byTurn.set(tid, list);
  }
  for (const list of byTurn.values()) {
    const firstReq = list.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']);
    if (!firstReq || !firstReq.time_unix_nano) continue;
    for (const e of list) {
      if (e['event.name'] === 'other' && !e['gen_ai.step.id']) {
        e.time_unix_nano = firstReq.time_unix_nano;
        e['gen_ai.step.id'] = firstReq['gen_ai.step.id'];
        // Propagate model from the real LLM request so 'other' doesn't show 'unknown'
        if (firstReq['gen_ai.request.model'] && firstReq['gen_ai.request.model'] !== 'unknown') {
          e['gen_ai.request.model'] = firstReq['gen_ai.request.model'];
          e['gen_ai.response.model'] = firstReq['gen_ai.request.model'];
        }
        if (firstReq['gen_ai.provider.name'] && firstReq['gen_ai.provider.name'] !== 'unknown') {
          e['gen_ai.provider.name'] = firstReq['gen_ai.provider.name'];
        }
      }
    }
  }
}

// Propagate model from llm.response to tool.call/tool.result in the same step.
// The hook processor sets tool events' model to 'unknown' because it doesn't
// have visibility into the LLM call's model. Since tool.call/tool.result and
// llm.response are part of the same step (same step_id), they should share
// the same model.
function propagateModelToToolEvents(entries: AgentActivityEntry[]): void {
  const byStep = new Map<string, AgentActivityEntry[]>();
  for (const e of entries) {
    const sid = (e['gen_ai.step.id'] as string) || '';
    if (!sid) continue;
    const list = byStep.get(sid) ?? [];
    list.push(e);
    byStep.set(sid, list);
  }

  for (const list of byStep.values()) {
    const resp = list.find(e => e['event.name'] === 'llm.response');
    if (!resp) continue;
    const model = resp['gen_ai.request.model'] as string | undefined;
    const respModel = resp['gen_ai.response.model'] as string | undefined;
    const provider = resp['gen_ai.provider.name'] as string | undefined;
    if (!model || model === 'unknown') continue;

    for (const e of list) {
      if (e['event.name'] !== 'tool.call' && e['event.name'] !== 'tool.result') continue;
      const curModel = e['gen_ai.request.model'] as string | undefined;
      if (!curModel || curModel === 'unknown') {
        e['gen_ai.request.model'] = model;
        if (respModel && respModel !== 'unknown') e['gen_ai.response.model'] = respModel;
        if (provider && provider !== 'unknown') e['gen_ai.provider.name'] = provider;
      }
    }
  }
}

// Compute gen_ai.tool.call.duration on each tool.result event as
// tool.result.time - tool.call.time (in milliseconds).
// Matches tool.call and tool.result by (step_id, tool.call.id).
function computeToolCallDurations(entries: AgentActivityEntry[]): void {
  // Build a map of tool.call times keyed by (step_id, tool.call.id)
  const callTimes = new Map<string, bigint>();
  for (const e of entries) {
    if (e['event.name'] !== 'tool.call') continue;
    const sid = (e['gen_ai.step.id'] as string) || '';
    const callId = (e['gen_ai.tool.call.id'] as string) || '';
    const t = e.time_unix_nano;
    if (typeof t !== 'string') continue;
    try { callTimes.set(`${sid}|${callId}`, BigInt(t)); } catch { /* skip */ }
  }

  // For each tool.result, compute duration from matching tool.call
  for (const e of entries) {
    if (e['event.name'] !== 'tool.result') continue;
    const sid = (e['gen_ai.step.id'] as string) || '';
    const callId = (e['gen_ai.tool.call.id'] as string) || '';
    const resultTimeStr = e.time_unix_nano;
    if (typeof resultTimeStr !== 'string') continue;
    const callTime = callTimes.get(`${sid}|${callId}`);
    if (callTime === undefined) continue;
    let resultTime: bigint;
    try { resultTime = BigInt(resultTimeStr); } catch { continue; }
    const durationNs = resultTime - callTime;
    if (durationNs < 0n) continue;
    // Convert nanoseconds to milliseconds (integer)
    e['gen_ai.tool.call.duration'] = Number(durationNs / 1_000_000n);
  }
}

// Expand container span times so ENTRY/AGENT spans end at/after their last
// child STEP. The converter derives these spans from event log times; if the
// last event in a turn has an earlier time than earlier events, the generated
// ENTRY/AGENT span ends up with duration=0. We rewrite non-{llm.request,
// tool.call, tool.result} entries in each turn to the max time in that turn.
//
// Why we skip llm.request / tool.call / tool.result:
//   - llm.request  → used as LLM span startTime; bumping would change LLM duration
//   - tool.call    → used as TOOL span startTime; hook processor sets it to
//                    the llm.response time
//   - tool.result  → used as TOOL span endTime; hook processor writes real tool
//                    results with the tool's actual finish time
function expandContainerTimes(entries: AgentActivityEntry[]): void {
  const ms = (e: AgentActivityEntry): bigint => {
    const v = e.time_unix_nano;
    try { return typeof v === 'string' ? BigInt(v) : BigInt(0); } catch { return BigInt(0); }
  };

  const byTurn = new Map<string, AgentActivityEntry[]>();
  for (const e of entries) {
    const tid = (e['gen_ai.turn.id'] as string) || '';
    if (!tid) continue;
    const list = byTurn.get(tid) ?? [];
    list.push(e);
    byTurn.set(tid, list);
  }
  for (const list of byTurn.values()) {
    let max = BigInt(0);
    for (const e of list) {
      const t = ms(e);
      if (t > max) max = t;
    }
    for (const e of list) {
      // Keep these events at their post-enrich times:
      //   - llm.request  → used as LLM span startTime; bumping would change LLM duration
      //   - llm.response → used as LLM span endTime; hook processor sets it to the
      //                    actual PreToolUse/Stop timestamp for each step. Bumping to
      //                    turn max would overwrite step 1's time with step 2's end
      //                    time, causing STEP spans to overlap.
      //   - tool.call    → used as TOOL span startTime; hook processor sets it
      //   - tool.result  → used as TOOL span endTime; hook processor sets it
      //   - other        → user-boundary entry; enrichIdeTurn uses its time as
      //                    step-1 llm.request time; bumping it to turn max would set
      //                    request.time = response.time and collapse LLM duration to 0
      const name = e['event.name'] as string;
      if (name === 'llm.request' || name === 'llm.response' || name === 'tool.call' || name === 'tool.result' || name === 'other') continue;
      if (ms(e) < max) {
        e.time_unix_nano = max.toString();
      }
    }
  }
}



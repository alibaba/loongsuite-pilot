import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import {
  ClientType,
  CollectionMethod,
  multimodalUploadIncludesInput,
  multimodalUploadIncludesOutput,
  type AgentActivityEntry,
  type JsonValue,
  type MultimodalUploadMode,
} from '../../types/index.js';
import {
  attachMultimodalMetadataForEntry,
  convertPathsToUriParts,
  type MultimodalProcessor,
  type PathToUriFn,
  type UriPart,
} from '../../multimodal/index.js';
import { mergeAllowedRootPaths } from '../../multimodal/resolve.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { loadDatabaseSync } from '../../utils/node-sqlite.js';
import {
  readAntigravityConversationDb,
  type AntigravityConversationSnapshot,
  type AntigravityUsageEvent,
} from './sqlite-reader.js';
import {
  readAntigravityTranscript,
  type AntigravityTranscript,
  type AntigravityTranscriptStep,
} from './transcript-reader.js';
import {
  modelResolutionRank,
  normalizeAntigravityModel,
  resolveAntigravityProvider,
} from './model-normalizer.js';

export type AntigravityClientType =
  | ClientType.Antigravity
  | ClientType.AntigravityIde
  | ClientType.AntigravityCli;

const DEFAULT_ROOT_SEGMENTS: Readonly<Record<AntigravityClientType, string>> = {
  [ClientType.Antigravity]: '~/.gemini/antigravity',
  [ClientType.AntigravityIde]: '~/.gemini/antigravity-ide',
  [ClientType.AntigravityCli]: '~/.gemini/antigravity-cli',
};

const MAX_DBS_PER_CYCLE = 16;
const MAX_TRACKED_SESSIONS = 512;
const MAX_EMITTED_KEYS_PER_SESSION = 512;
const MAX_PENDING_TOOL_CALLS_PER_SESSION = 128;

const EVENT_ORDER_WEIGHT: Readonly<Record<string, number>> = {
  other: 0,
  'agent.input': 0,
  'llm.request': 1,
  'llm.response': 2,
  'tool.call': 3,
  'tool.result': 4,
};

interface PendingToolCall {
  plannerStepIndex: number;
  turnId: string;
  stepId: string;
  resultStepIndex: number;
  callId: string;
  toolName: string;
  model?: string;
  callTsMs?: number;
}

interface SessionCheckpoint {
  effectiveMtimeMs: number;
  effectiveSize: number;
  maxEmittedGenIdx: number;
  maxEmittedStepIdx: number;
  emittedUsageKeys: string[];
  lastTranscriptStepIndex: number;
  pendingToolCalls: PendingToolCall[];
}

interface AntigravityCheckpoint {
  schema: 1;
  seeded: boolean;
  evictedWatermarkMtimeMs: number;
  sessions: Record<string, SessionCheckpoint>;
}

export interface AntigravityMultimodalOptions {
  enabled: boolean;
  uploadMode: MultimodalUploadMode;
  allowedRootPaths?: string[];
  processor?: Pick<MultimodalProcessor, 'pathToUri'>;
  /** Optional direct override for unit tests. */
  pathToUri?: PathToUriFn;
}

export interface AntigravityInputOptions extends InputOptions {
  /** Which Antigravity product variant this input represents. */
  clientType: AntigravityClientType;
  /** Optional override for the product data root (defaults to ~/.gemini/antigravity*). */
  dataRoot?: string;
  /**
   * When false (default in production), a fresh start without prior checkpoint
   * seeds existing conversation files without replaying historical events.
   * Set true in tests or backfill runs to emit existing events immediately.
   */
  collectHistorical?: boolean;
  /** Optional opt-in multimodal upload configuration. */
  multimodal?: AntigravityMultimodalOptions;
}

function toUnixNanoString(ms: number): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : Date.now();
  return `${BigInt(safeMs) * 1_000_000n}`;
}

async function statFileInfo(filePath: string): Promise<{ mtimeMs: number; size: number }> {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : { mtimeMs: 0, size: 0 };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function isUsageAlreadyCovered(usage: AntigravityUsageEvent, cursor: SessionCheckpoint, seenKeys: Set<string>): boolean {
  if (seenKeys.has(usage.key)) return true;
  if (usage.identities.some((id) => seenKeys.has(id))) return true;
  // Monotonic index watermark protects long sessions (>512 events) against key eviction replay
  if (usage.genIdx !== undefined && cursor.maxEmittedGenIdx >= 0 && usage.genIdx <= cursor.maxEmittedGenIdx) {
    return true;
  }
  if (
    usage.genIdx === undefined &&
    usage.stepIndices.length > 0 &&
    cursor.maxEmittedStepIdx >= 0 &&
    Math.max(...usage.stepIndices) <= cursor.maxEmittedStepIdx
  ) {
    return true;
  }
  return false;
}

function binarySearchTurnNumber(userInputSteps: readonly number[], targetStep: number): number {
  let lo = 0;
  let hi = userInputSteps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (userInputSteps[mid]! <= targetStep) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}

export class AntigravityInput extends BaseInput {
  readonly id: string;
  readonly agentType: AntigravityClientType;
  readonly collectionMethod = CollectionMethod.SqlitePolling;

  private readonly dataRoot: string;
  private readonly conversationsDir: string;
  private readonly collectHistorical: boolean;
  private readonly multimodalUploadMode: MultimodalUploadMode;
  private readonly pathToUri?: PathToUriFn;
  private pendingCheckpoint: AntigravityCheckpoint | null = null;
  private warnedSqliteUnavailable = false;

  constructor(opts: AntigravityInputOptions) {
    super(opts);
    this.agentType = opts.clientType;
    this.id = opts.clientType;
    this.dataRoot = opts.dataRoot
      ? path.resolve(resolveHome(opts.dataRoot))
      : AntigravityInput.getDefaultDataRoot(opts.clientType);
    this.conversationsDir = path.join(this.dataRoot, 'conversations');
    this.collectHistorical = opts.collectHistorical ?? false;

    const mm = opts.multimodal;
    if (mm?.enabled && mm.uploadMode !== 'none') {
      this.multimodalUploadMode = mm.uploadMode;
      if (mm.pathToUri) {
        this.pathToUri = mm.pathToUri;
      } else if (mm.processor) {
        const processor = mm.processor;
        const allowedRootPaths = mergeAllowedRootPaths(
          [path.join(this.dataRoot, 'brain')],
          mm.allowedRootPaths,
        );
        this.pathToUri = (filePath, timeMs) =>
          processor.pathToUri(filePath, timeMs, { allowedRootPaths });
      }
    } else {
      this.multimodalUploadMode = 'none';
    }
  }

  static getDefaultDataRoot(clientType: AntigravityClientType): string {
    return resolveHome(DEFAULT_ROOT_SEGMENTS[clientType]);
  }

  static getWatchPaths(clientType: AntigravityClientType, dataRoot?: string): string[] {
    const root = dataRoot
      ? path.resolve(resolveHome(dataRoot))
      : AntigravityInput.getDefaultDataRoot(clientType);
    return [root, path.join(root, 'conversations')];
  }

  static async checkAvailability(
    clientType: AntigravityClientType,
    dataRoot?: string,
  ): Promise<boolean> {
    const root = dataRoot
      ? path.resolve(resolveHome(dataRoot))
      : AntigravityInput.getDefaultDataRoot(clientType);
    if (await directoryExists(path.join(root, 'conversations'))) return true;
    return directoryExists(root);
  }

  protected override onEntriesQueued(): void {
    if (!this.pendingCheckpoint) return;
    const cp = this.pendingCheckpoint;
    this.pendingCheckpoint = null;
    this.saveCheckpoint(cp);
  }

  private loadCheckpoint(): AntigravityCheckpoint {
    const state = this.stateStore.get(this.id);
    const raw = state?.extra?.antigravityCheckpoint;
    if (raw && typeof raw === 'object' && (raw as AntigravityCheckpoint).schema === 1) {
      const cp = raw as Partial<AntigravityCheckpoint>;
      const sessions: Record<string, SessionCheckpoint> = {};
      if (cp.sessions && typeof cp.sessions === 'object') {
        for (const [sid, cur] of Object.entries(cp.sessions)) {
          if (!cur || typeof cur !== 'object') continue;
          const pendingToolCalls: PendingToolCall[] = Array.isArray(cur.pendingToolCalls)
            ? cur.pendingToolCalls.filter(
                (p): p is PendingToolCall =>
                  Boolean(p) &&
                  typeof p === 'object' &&
                  typeof p.plannerStepIndex === 'number' &&
                  typeof p.resultStepIndex === 'number' &&
                  typeof p.callId === 'string' &&
                  typeof p.toolName === 'string' &&
                  typeof p.turnId === 'string' &&
                  typeof p.stepId === 'string',
              )
            : [];
          sessions[sid] = {
            effectiveMtimeMs: typeof cur.effectiveMtimeMs === 'number' ? cur.effectiveMtimeMs : 0,
            effectiveSize: typeof cur.effectiveSize === 'number' ? cur.effectiveSize : 0,
            maxEmittedGenIdx: typeof cur.maxEmittedGenIdx === 'number' ? cur.maxEmittedGenIdx : -1,
            maxEmittedStepIdx:
              typeof cur.maxEmittedStepIdx === 'number' ? cur.maxEmittedStepIdx : -1,
            emittedUsageKeys: Array.isArray(cur.emittedUsageKeys)
              ? cur.emittedUsageKeys.filter((k): k is string => typeof k === 'string')
              : [],
            lastTranscriptStepIndex:
              typeof cur.lastTranscriptStepIndex === 'number' ? cur.lastTranscriptStepIndex : -1,
            pendingToolCalls,
          };
        }
      }
      return {
        schema: 1,
        seeded: Boolean(cp.seeded),
        evictedWatermarkMtimeMs:
          typeof cp.evictedWatermarkMtimeMs === 'number' ? cp.evictedWatermarkMtimeMs : 0,
        sessions,
      };
    }
    return { schema: 1, seeded: false, evictedWatermarkMtimeMs: 0, sessions: {} };
  }

  private saveCheckpoint(cp: AntigravityCheckpoint): void {
    // Bound total tracked sessions while recording eviction watermark so evicted
    // old sessions are never treated as brand-new and replayed in an infinite loop.
    const entries = Object.entries(cp.sessions);
    if (entries.length > MAX_TRACKED_SESSIONS) {
      entries.sort((a, b) => b[1].effectiveMtimeMs - a[1].effectiveMtimeMs);
      const evicted = entries.slice(MAX_TRACKED_SESSIONS);
      for (const [, cur] of evicted) {
        if (cur.effectiveMtimeMs > cp.evictedWatermarkMtimeMs) {
          cp.evictedWatermarkMtimeMs = cur.effectiveMtimeMs;
        }
      }
      cp.sessions = Object.fromEntries(entries.slice(0, MAX_TRACKED_SESSIONS));
    }
    for (const cur of Object.values(cp.sessions)) {
      if (cur.emittedUsageKeys.length > MAX_EMITTED_KEYS_PER_SESSION) {
        cur.emittedUsageKeys = cur.emittedUsageKeys.slice(-MAX_EMITTED_KEYS_PER_SESSION);
      }
      if (cur.pendingToolCalls.length > MAX_PENDING_TOOL_CALLS_PER_SESSION) {
        cur.pendingToolCalls = cur.pendingToolCalls.slice(-MAX_PENDING_TOOL_CALLS_PER_SESSION);
      }
    }
    const prev = this.stateStore.get(this.id);
    this.stateStore.set(this.id, {
      ...prev,
      lastTimestamp: Date.now(),
      extra: {
        ...(prev?.extra ?? {}),
        antigravityCheckpoint: cp,
      },
    });
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    this.pendingCheckpoint = null;

    if (!loadDatabaseSync()) {
      if (!this.warnedSqliteUnavailable) {
        this.warnedSqliteUnavailable = true;
        this.logger.warn(
          'node:sqlite is unavailable; Antigravity collection disabled (requires Node.js >= 22.13 or >= 23.4)',
          { agentType: this.agentType },
        );
      }
      return [];
    }

    const checkpoint = this.loadCheckpoint();
    const isFreshSeed = !checkpoint.seeded && !this.collectHistorical;

    let dirEntries: string[];
    try {
      dirEntries = await fs.readdir(this.conversationsDir);
    } catch {
      if (isFreshSeed) {
        checkpoint.seeded = true;
        this.saveCheckpoint(checkpoint);
      }
      return [];
    }

    const dbFiles = dirEntries
      .filter((name) => name.endsWith('.db') && name !== 'conversation_summaries.db')
      .sort();
    if (dbFiles.length === 0) {
      if (isFreshSeed) {
        checkpoint.seeded = true;
        this.saveCheckpoint(checkpoint);
      }
      return [];
    }

    // Stat candidates and pick changed files (most recently modified first)
    const candidates: Array<{
      sessionId: string;
      dbPath: string;
      effectiveMtimeMs: number;
      effectiveSize: number;
    }> = [];

    for (const fileName of dbFiles) {
      if (!this.running) return [];
      const sessionId = fileName.slice(0, -3);
      if (!sessionId) continue;
      const dbPath = path.join(this.conversationsDir, fileName);
      const transcriptPath = path.join(
        this.dataRoot,
        'brain',
        sessionId,
        '.system_generated',
        'logs',
        'transcript.jsonl',
      );
      const [dbInfo, walInfo, transcriptInfo] = await Promise.all([
        statFileInfo(dbPath),
        statFileInfo(`${dbPath}-wal`),
        statFileInfo(transcriptPath),
      ]);
      const effectiveMtimeMs = Math.max(dbInfo.mtimeMs, walInfo.mtimeMs, transcriptInfo.mtimeMs);
      const effectiveSize = dbInfo.size + walInfo.size + transcriptInfo.size;
      if (effectiveMtimeMs <= 0) continue;

      const prev = checkpoint.sessions[sessionId];
      if (!isFreshSeed) {
        if (prev) {
          if (effectiveMtimeMs === prev.effectiveMtimeMs && effectiveSize === prev.effectiveSize) {
            continue;
          }
        } else if (
          checkpoint.seeded &&
          checkpoint.evictedWatermarkMtimeMs > 0 &&
          effectiveMtimeMs <= checkpoint.evictedWatermarkMtimeMs
        ) {
          // Previously evicted historical session that has not changed since eviction
          continue;
        }
      }
      candidates.push({ sessionId, dbPath, effectiveMtimeMs, effectiveSize });
    }

    if (isFreshSeed) {
      for (const candidate of candidates) {
        if (!this.running) return [];
        try {
          const snapshot = await readAntigravityConversationDb(candidate.dbPath);
          let transcript: AntigravityTranscript | null = null;
          try {
            transcript = await readAntigravityTranscript(this.dataRoot, candidate.sessionId);
          } catch (err) {
            this.logger.warn('failed to read Antigravity transcript during seed', {
              agentType: this.agentType,
              sessionId: candidate.sessionId,
              error: String(err),
            });
          }
          const maxStep = transcript
            ? transcript.steps.reduce((max, s) => Math.max(max, s.stepIndex), -1)
            : -1;
          checkpoint.sessions[candidate.sessionId] = {
            effectiveMtimeMs: candidate.effectiveMtimeMs,
            effectiveSize: candidate.effectiveSize,
            maxEmittedGenIdx: snapshot?.maxGenIdx ?? -1,
            maxEmittedStepIdx: snapshot?.maxStepIdx ?? -1,
            emittedUsageKeys: snapshot ? snapshot.events.map((e) => e.key) : [],
            lastTranscriptStepIndex: maxStep,
            pendingToolCalls: [],
          };
        } catch (err) {
          // Do not freeze effectiveMtimeMs on transient read errors (e.g. SQLITE_BUSY)
          this.logger.warn('failed to seed Antigravity conversation DB', {
            agentType: this.agentType,
            sessionId: candidate.sessionId,
            error: String(err),
          });
        }
      }
      checkpoint.seeded = true;
      this.saveCheckpoint(checkpoint);
      return [];
    }

    if (candidates.length === 0) return [];

    candidates.sort((a, b) => b.effectiveMtimeMs - a.effectiveMtimeMs);
    const hasBacklog = candidates.length > MAX_DBS_PER_CYCLE;
    const batch = candidates.slice(0, MAX_DBS_PER_CYCLE);

    const emitted: AgentActivityEntry[] = [];
    let checkpointDirty = false;

    for (const candidate of batch) {
      if (!this.running) break;

      let snapshot: AntigravityConversationSnapshot | null;
      try {
        snapshot = await readAntigravityConversationDb(candidate.dbPath);
      } catch (err) {
        this.logger.warn('failed to read Antigravity conversation DB', {
          agentType: this.agentType,
          sessionId: candidate.sessionId,
          error: String(err),
        });
        continue;
      }

      let transcript: AntigravityTranscript | null = null;
      try {
        transcript = await readAntigravityTranscript(this.dataRoot, candidate.sessionId);
      } catch (err) {
        this.logger.warn('failed to read Antigravity transcript', {
          agentType: this.agentType,
          sessionId: candidate.sessionId,
          error: String(err),
        });
      }

      const workspaceAllowed = this.workspacePolicy.allows(
        {
          'gen_ai.agent.type': this.agentType,
          'gen_ai.session.id': candidate.sessionId,
          ...(snapshot?.workspacePath ? { 'workspace.path': snapshot.workspacePath } : {}),
        },
        this.agentType,
      );
      if (!workspaceAllowed) {
        const maxStep = transcript
          ? transcript.steps.reduce((max, s) => Math.max(max, s.stepIndex), -1)
          : (checkpoint.sessions[candidate.sessionId]?.lastTranscriptStepIndex ?? -1);
        checkpoint.sessions[candidate.sessionId] = {
          effectiveMtimeMs: candidate.effectiveMtimeMs,
          effectiveSize: candidate.effectiveSize,
          maxEmittedGenIdx: snapshot?.maxGenIdx ?? -1,
          maxEmittedStepIdx: snapshot?.maxStepIdx ?? -1,
          emittedUsageKeys: snapshot ? snapshot.events.map((e) => e.key) : [],
          lastTranscriptStepIndex: maxStep,
          pendingToolCalls: [],
        };
        checkpointDirty = true;
        continue;
      }

      const prevCursor: SessionCheckpoint = checkpoint.sessions[candidate.sessionId] ?? {
        effectiveMtimeMs: 0,
        effectiveSize: 0,
        maxEmittedGenIdx: -1,
        maxEmittedStepIdx: -1,
        emittedUsageKeys: [],
        lastTranscriptStepIndex: -1,
        pendingToolCalls: [],
      };

      const sessionResult = await this.buildSessionEntries(
        candidate.sessionId,
        snapshot,
        transcript,
        prevCursor,
      );

      emitted.push(...sessionResult.entries);

      checkpoint.sessions[candidate.sessionId] = {
        effectiveMtimeMs: candidate.effectiveMtimeMs,
        effectiveSize: candidate.effectiveSize,
        maxEmittedGenIdx: sessionResult.maxEmittedGenIdx,
        maxEmittedStepIdx: sessionResult.maxEmittedStepIdx,
        emittedUsageKeys: sessionResult.emittedUsageKeys,
        lastTranscriptStepIndex: sessionResult.maxTranscriptStepIndex,
        pendingToolCalls: sessionResult.pendingToolCalls,
      };
      checkpointDirty = true;
    }

    if (checkpointDirty || !checkpoint.seeded) {
      checkpoint.seeded = true;
      if (emitted.length > 0) {
        // Defer StateStore commit until BaseInput invokes onEntriesQueued()
        this.pendingCheckpoint = checkpoint;
      } else {
        this.saveCheckpoint(checkpoint);
      }
    }

    if (hasBacklog && this.running) {
      setImmediate(() => this.requestCollection());
    }

    return emitted;
  }

  private async buildSessionEntries(
    sessionId: string,
    snapshot: AntigravityConversationSnapshot | null,
    transcript: AntigravityTranscript | null,
    prevCursor: SessionCheckpoint,
  ): Promise<{
    entries: AgentActivityEntry[];
    maxTranscriptStepIndex: number;
    maxEmittedGenIdx: number;
    maxEmittedStepIdx: number;
    emittedUsageKeys: string[];
    pendingToolCalls: PendingToolCall[];
  }> {
    const entries: AgentActivityEntry[] = [];
    const cwd = snapshot?.workspacePath;
    const seenKeys = new Set(prevCursor.emittedUsageKeys);
    let maxStepIndex = prevCursor.lastTranscriptStepIndex;
    let maxEmittedGenIdx = prevCursor.maxEmittedGenIdx;
    let maxEmittedStepIdx = prevCursor.maxEmittedStepIdx;

    const resolvedMediaCache = new Map<string, UriPart[]>();
    const getStepMedia = async (
      step: AntigravityTranscriptStep,
      timeMs: number,
      direction: 'input' | 'output',
    ): Promise<UriPart[]> => {
      const cacheKey = `${step.stepIndex}:${direction}`;
      const cached = resolvedMediaCache.get(cacheKey);
      if (cached) return cached;
      const parts = await this.resolveMediaParts(step, timeMs, direction);
      resolvedMediaCache.set(cacheKey, parts);
      return parts;
    };

    // Precompute O(1)/O(log S) turn mapping from deduplicated, sorted transcript steps
    const stepToTurn = new Map<number, string>();
    const userInputSteps: number[] = [];
    if (transcript) {
      let currentTurnIndex = 0;
      for (const step of transcript.steps) {
        if (step.type === 'USER_INPUT') {
          currentTurnIndex++;
          userInputSteps.push(step.stepIndex);
        }
        stepToTurn.set(step.stepIndex, `${sessionId}:turn:${Math.max(1, currentTurnIndex)}`);
      }
    }

    const resolveTurnForStep = (stepIdx: number | undefined): string => {
      if (stepIdx === undefined) return `${sessionId}:turn:1`;
      const exact = stepToTurn.get(stepIdx);
      if (exact) return exact;
      if (userInputSteps.length > 0) {
        return `${sessionId}:turn:${binarySearchTurnNumber(userInputSteps, stepIdx)}`;
      }
      return `${sessionId}:turn:1`;
    };

    // Precompute per-turn primary provider from SQLite usage events so USER_INPUT
    // uses the actual turn model's provider instead of hardcoding gcp.gemini.
    const turnProviderMap = new Map<string, string>();
    if (snapshot) {
      for (const usage of snapshot.events) {
        const linkedStep = this.findLinkedPlannerStep(usage, transcript);
        const turnId = resolveTurnForStep(linkedStep?.stepIndex ?? usage.stepIndices[0]);
        if (!turnProviderMap.has(turnId)) {
          const transcriptModel = normalizeAntigravityModel(linkedStep?.model);
          const model =
            transcriptModel && modelResolutionRank(transcriptModel) > modelResolutionRank(usage.model)
              ? transcriptModel
              : usage.model;
          turnProviderMap.set(turnId, resolveAntigravityProvider(model));
        }
      }
    }

    // 1) Drain any pending tool calls from previous poll cycles whose tool results have now landed
    const remainingPending: PendingToolCall[] = [];
    for (const pending of prevCursor.pendingToolCalls) {
      const resultStep = transcript?.byStepIndex.get(pending.resultStepIndex);
      if (
        resultStep &&
        resultStep.type !== 'PLANNER_RESPONSE' &&
        resultStep.type !== 'USER_INPUT'
      ) {
        const resultTsMs = resultStep.createdAtMs ?? pending.callTsMs ?? Date.now();
        const durationMs =
          resultStep.createdAtMs !== undefined && pending.callTsMs !== undefined
            ? resultStep.createdAtMs - pending.callTsMs
            : undefined;
        const resultMediaParts = await getStepMedia(resultStep, resultTsMs, 'input');
        let resultPayload: JsonValue = resultStep.content ?? null;
        if (resultMediaParts.length > 0) {
          const combined: JsonValue[] = [];
          if (resultStep.content) combined.push({ type: 'text', content: resultStep.content });
          for (const part of resultMediaParts) combined.push(part as unknown as JsonValue);
          resultPayload = combined;
        }
        const resultEntry = buildAgentActivityEntry({
          'event.name': 'tool.result',
          'gen_ai.session.id': sessionId,
          'gen_ai.turn.id': pending.turnId,
          // Keep tool.result in the same step group as its parent PLANNER_RESPONSE & tool.call
          'gen_ai.step.id': pending.stepId,
          'gen_ai.agent.type': this.agentType,
          'gen_ai.provider.name': resolveAntigravityProvider(
            normalizeAntigravityModel(pending.model),
          ),
          'gen_ai.tool.name': pending.toolName,
          'gen_ai.tool.call.id': pending.callId,
          'gen_ai.tool.call.result': resultPayload,
          'tool.result.status': resultStep.status === 'ERROR' ? 'error' : 'success',
          ...(durationMs !== undefined && durationMs > 0
            ? { 'gen_ai.tool.call.duration': durationMs }
            : {}),
          time_unix_nano: toUnixNanoString(resultTsMs),
        });
        if (resultMediaParts.length > 0) attachMultimodalMetadataForEntry(resultEntry);
        await this.attachWorkspaceContext(resultEntry, cwd);
        entries.push(resultEntry);
        if (resultStep.stepIndex > maxStepIndex) maxStepIndex = resultStep.stepIndex;
      } else {
        remainingPending.push(pending);
      }
    }

    // 2) Emit new USER_INPUT and tool.call / tool.result from transcript when available
    if (transcript) {
      const stepsByIndex = transcript.byStepIndex;
      for (const step of transcript.steps) {
        if (step.stepIndex <= prevCursor.lastTranscriptStepIndex) continue;
        if (step.stepIndex > maxStepIndex) maxStepIndex = step.stepIndex;

        const turnId = resolveTurnForStep(step.stepIndex);
        const stepId = `${sessionId}:step:${step.stepIndex}`;
        const tsMs = step.createdAtMs ?? snapshot?.trajectoryTimestampMs ?? Date.now();

        if (step.type === 'USER_INPUT') {
          const mediaParts = await getStepMedia(step, tsMs, 'input');
          if (!step.content && mediaParts.length === 0) continue;
          const parts: JsonValue[] = [];
          if (step.content) parts.push({ type: 'text', content: step.content });
          for (const part of mediaParts) parts.push(part as unknown as JsonValue);
          const userMessages: JsonValue = [{ role: 'user', parts }];
          const inputEntry = buildAgentActivityEntry({
            'event.name': 'other',
            'gen_ai.session.id': sessionId,
            'gen_ai.turn.id': turnId,
            'gen_ai.step.id': stepId,
            'gen_ai.turn.start': true,
            'gen_ai.agent.type': this.agentType,
            'gen_ai.provider.name': turnProviderMap.get(turnId) ?? 'gcp.gemini',
            'gen_ai.input.messages': userMessages,
            'gen_ai.input.messages_delta': userMessages,
            time_unix_nano: toUnixNanoString(tsMs),
          });
          if (mediaParts.length > 0) attachMultimodalMetadataForEntry(inputEntry);
          await this.attachWorkspaceContext(inputEntry, cwd);
          entries.push(inputEntry);
        } else if (step.type === 'PLANNER_RESPONSE' && step.toolCalls.length > 0) {
          const stepProvider = resolveAntigravityProvider(normalizeAntigravityModel(step.model));
          for (let i = 0; i < step.toolCalls.length; i++) {
            const tc = step.toolCalls[i]!;
            const callId = tc.id ?? `${sessionId}:step:${step.stepIndex}:tc:${i}`;
            const callEntry = buildAgentActivityEntry({
              'event.name': 'tool.call',
              'gen_ai.session.id': sessionId,
              'gen_ai.turn.id': turnId,
              'gen_ai.step.id': stepId,
              'gen_ai.agent.type': this.agentType,
              'gen_ai.provider.name': stepProvider,
              'gen_ai.tool.name': tc.name,
              'gen_ai.tool.call.id': callId,
              'gen_ai.tool.call.arguments': tc.args,
              time_unix_nano: toUnixNanoString(tsMs),
            });
            await this.attachWorkspaceContext(callEntry, cwd);
            entries.push(callEntry);

            const resultStepIndex = step.stepIndex + 1 + i;
            const resultStep = stepsByIndex.get(resultStepIndex);
            if (
              resultStep &&
              resultStep.type !== 'PLANNER_RESPONSE' &&
              resultStep.type !== 'USER_INPUT'
            ) {
              const resultTsMs = resultStep.createdAtMs ?? tsMs;
              const durationMs =
                resultStep.createdAtMs !== undefined && step.createdAtMs !== undefined
                  ? resultStep.createdAtMs - step.createdAtMs
                  : undefined;
              const resultMediaParts = await getStepMedia(resultStep, resultTsMs, 'input');
              let resultPayload: JsonValue = resultStep.content ?? null;
              if (resultMediaParts.length > 0) {
                const combined: JsonValue[] = [];
                if (resultStep.content) combined.push({ type: 'text', content: resultStep.content });
                for (const part of resultMediaParts) combined.push(part as unknown as JsonValue);
                resultPayload = combined;
              }
              const resultEntry = buildAgentActivityEntry({
                'event.name': 'tool.result',
                'gen_ai.session.id': sessionId,
                'gen_ai.turn.id': turnId,
                // Reuse parent PLANNER_RESPONSE stepId so planTurnStream keeps LLM + tool in one STEP
                'gen_ai.step.id': stepId,
                'gen_ai.agent.type': this.agentType,
                'gen_ai.provider.name': stepProvider,
                'gen_ai.tool.name': tc.name,
                'gen_ai.tool.call.id': callId,
                'gen_ai.tool.call.result': resultPayload,
                'tool.result.status': resultStep.status === 'ERROR' ? 'error' : 'success',
                ...(durationMs !== undefined && durationMs > 0
                  ? { 'gen_ai.tool.call.duration': durationMs }
                  : {}),
                time_unix_nano: toUnixNanoString(resultTsMs),
              });
              if (resultMediaParts.length > 0) attachMultimodalMetadataForEntry(resultEntry);
              await this.attachWorkspaceContext(resultEntry, cwd);
              entries.push(resultEntry);
            } else {
              // Tool result hasn't been written yet; persist pending entry for next poll cycle
              remainingPending.push({
                plannerStepIndex: step.stepIndex,
                turnId,
                stepId,
                resultStepIndex,
                callId,
                toolName: tc.name,
                model: step.model,
                callTsMs: step.createdAtMs ?? tsMs,
              });
            }
          }
        }
      }
    }

    // 3) Emit authoritative llm.request + llm.response pairs from SQLite usage events
    if (snapshot) {
      for (const usage of snapshot.events) {
        if (isUsageAlreadyCovered(usage, prevCursor, seenKeys)) continue;
        seenKeys.add(usage.key);
        if (usage.genIdx !== undefined && usage.genIdx > maxEmittedGenIdx) {
          maxEmittedGenIdx = usage.genIdx;
        }
        if (usage.genIdx === undefined && usage.stepIndices.length > 0) {
          const stepMax = Math.max(...usage.stepIndices);
          if (stepMax > maxEmittedStepIdx) maxEmittedStepIdx = stepMax;
        }

        const linkedStep = this.findLinkedPlannerStep(usage, transcript);
        const turnId = resolveTurnForStep(linkedStep?.stepIndex ?? usage.stepIndices[0]);
        const stepId = linkedStep
          ? `${sessionId}:step:${linkedStep.stepIndex}`
          : usage.stepIndices.length > 0
            ? `${sessionId}:step:${usage.stepIndices[0]}`
            : `${sessionId}:gen:${usage.genIdx ?? 0}`;

        const transcriptModel = normalizeAntigravityModel(linkedStep?.model);
        const model =
          transcriptModel && modelResolutionRank(transcriptModel) > modelResolutionRank(usage.model)
            ? transcriptModel
            : usage.model;
        const provider = resolveAntigravityProvider(model);

        const totalInputTokens =
          usage.freshInputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
        const totalOutputTokens = usage.totalOutputTokens;
        const totalTokens = totalInputTokens + totalOutputTokens;

        const reqTsMs = usage.timestampMs;
        const durationNs = (usage.ttftNs ?? 0) + (usage.streamDurationNs ?? 0);
        const respTsMs =
          durationNs > 0 ? reqTsMs + Math.max(1, Math.round(durationNs / 1_000_000)) : reqTsMs;

        const inputDelta = await this.buildInputMessagesDelta(
          sessionId,
          linkedStep,
          transcript,
          reqTsMs,
          getStepMedia,
        );
        const reqEntry = buildAgentActivityEntry({
          'event.name': 'llm.request',
          'gen_ai.session.id': sessionId,
          'gen_ai.turn.id': turnId,
          'gen_ai.step.id': stepId,
          'gen_ai.agent.type': this.agentType,
          'gen_ai.provider.name': provider,
          'gen_ai.request.model': model,
          ...(inputDelta.length > 0
            ? {
                'gen_ai.input.messages_delta': inputDelta,
                'gen_ai.input.messages_hash': createHash('sha256')
                  .update(JSON.stringify(inputDelta))
                  .digest('hex'),
              }
            : {}),
          time_unix_nano: toUnixNanoString(reqTsMs),
        });
        if (inputDelta.length > 0) attachMultimodalMetadataForEntry(reqEntry);
        await this.attachWorkspaceContext(reqEntry, cwd);
        entries.push(reqEntry);

        const outputMediaParts = linkedStep
          ? await getStepMedia(linkedStep, respTsMs, 'output')
          : [];
        const outputMessages = this.buildOutputMessages(linkedStep, outputMediaParts);
        const finishReasons =
          linkedStep && linkedStep.toolCalls.length > 0 ? ['tool_calls'] : ['stop'];

        const respEntry = buildAgentActivityEntry({
          'event.name': 'llm.response',
          'gen_ai.session.id': sessionId,
          'gen_ai.turn.id': turnId,
          'gen_ai.step.id': stepId,
          'gen_ai.response.id': usage.messageId,
          'gen_ai.agent.type': this.agentType,
          'gen_ai.provider.name': provider,
          'gen_ai.request.model': model,
          'gen_ai.response.model': model,
          'gen_ai.response.finish_reasons': finishReasons,
          ...(usage.ttftNs !== undefined && usage.ttftNs > 0
            ? { 'gen_ai.response.time_to_first_token': usage.ttftNs }
            : {}),
          'gen_ai.usage.input_tokens': totalInputTokens,
          'gen_ai.usage.output_tokens': totalOutputTokens,
          ...(usage.cacheReadTokens > 0
            ? { 'gen_ai.usage.cache_read.input_tokens': usage.cacheReadTokens }
            : {}),
          ...(usage.cacheCreationTokens > 0
            ? { 'gen_ai.usage.cache_creation.input_tokens': usage.cacheCreationTokens }
            : {}),
          'gen_ai.usage.total_tokens': totalTokens,
          ...(outputMessages ? { 'gen_ai.output.messages': outputMessages } : {}),
          time_unix_nano: toUnixNanoString(respTsMs),
        });
        if (outputMediaParts.length > 0) attachMultimodalMetadataForEntry(respEntry);
        await this.attachWorkspaceContext(respEntry, cwd);
        entries.push(respEntry);
      }
    }

    // Deterministic sort: timestamp ascending, then event type phase order
    entries.sort((a, b) => {
      const ta = BigInt(a.time_unix_nano);
      const tb = BigInt(b.time_unix_nano);
      if (ta !== tb) return ta < tb ? -1 : 1;
      const wa = EVENT_ORDER_WEIGHT[a['event.name']] ?? 5;
      const wb = EVENT_ORDER_WEIGHT[b['event.name']] ?? 5;
      return wa - wb;
    });

    return {
      entries,
      maxTranscriptStepIndex: maxStepIndex,
      maxEmittedGenIdx,
      maxEmittedStepIdx,
      emittedUsageKeys: [...seenKeys],
      pendingToolCalls: remainingPending,
    };
  }

  private findLinkedPlannerStep(
    usage: AntigravityUsageEvent,
    transcript: AntigravityTranscript | null,
  ): AntigravityTranscriptStep | undefined {
    if (!transcript) return undefined;
    for (const idx of usage.stepIndices) {
      const step = transcript.byStepIndex.get(idx);
      if (step && step.type === 'PLANNER_RESPONSE') return step;
    }
    return undefined;
  }

  private async buildInputMessagesDelta(
    sessionId: string,
    linkedStep: AntigravityTranscriptStep | undefined,
    transcript: AntigravityTranscript | null,
    reqTsMs: number,
    getStepMedia: (
      step: AntigravityTranscriptStep,
      timeMs: number,
      direction: 'input' | 'output',
    ) => Promise<UriPart[]>,
  ): Promise<JsonValue[]> {
    if (!linkedStep || !transcript) return [];

    let prevPlanner: AntigravityTranscriptStep | undefined;
    for (const step of transcript.steps) {
      if (step.stepIndex >= linkedStep.stepIndex) break;
      if (step.type === 'PLANNER_RESPONSE') prevPlanner = step;
    }
    const prevPlannerIdx = prevPlanner?.stepIndex ?? -1;

    const delta: JsonValue[] = [];
    const consumedStepIndices = new Set<number>();

    if (prevPlanner && prevPlanner.toolCalls.length > 0) {
      const assistantParts: JsonValue[] = [];
      const toolResponseParts: JsonValue[] = [];
      for (let i = 0; i < prevPlanner.toolCalls.length; i++) {
        const tc = prevPlanner.toolCalls[i]!;
        const callId = tc.id ?? `${sessionId}:step:${prevPlanner.stepIndex}:tc:${i}`;
        assistantParts.push({
          type: 'tool_call',
          id: callId,
          name: tc.name,
          arguments: tc.args ?? null,
        });
        const resultIdx = prevPlanner.stepIndex + 1 + i;
        if (resultIdx < linkedStep.stepIndex) {
          const resultStep = transcript.byStepIndex.get(resultIdx);
          if (resultStep && resultStep.type !== 'USER_INPUT' && resultStep.type !== 'PLANNER_RESPONSE') {
            consumedStepIndices.add(resultIdx);
            const resultMedia = await getStepMedia(resultStep, resultStep.createdAtMs ?? reqTsMs, 'input');
            let responsePayload: JsonValue = resultStep.content ?? null;
            if (resultMedia.length > 0) {
              const combined: JsonValue[] = [];
              if (resultStep.content) combined.push({ type: 'text', content: resultStep.content });
              for (const part of resultMedia) combined.push(part as unknown as JsonValue);
              responsePayload = combined;
            }
            toolResponseParts.push({
              type: 'tool_call_response',
              id: callId,
              response: responsePayload,
            });
          }
        }
      }
      if (assistantParts.length > 0) {
        delta.push({ role: 'assistant', parts: assistantParts });
      }
      if (toolResponseParts.length > 0) {
        delta.push({ role: 'tool', parts: toolResponseParts });
      }
    }

    for (const step of transcript.steps) {
      if (step.stepIndex <= prevPlannerIdx || step.stepIndex >= linkedStep.stepIndex) continue;
      if (consumedStepIndices.has(step.stepIndex)) continue;
      if (step.type !== 'USER_INPUT') continue;
      const mediaParts = await getStepMedia(step, step.createdAtMs ?? reqTsMs, 'input');
      const parts: JsonValue[] = [];
      if (step.content) parts.push({ type: 'text', content: step.content });
      for (const part of mediaParts) parts.push(part as unknown as JsonValue);
      if (parts.length > 0) {
        delta.push({ role: 'user', parts });
      }
    }

    return delta;
  }

  private async resolveMediaParts(
    step: AntigravityTranscriptStep,
    timeMs: number,
    direction: 'input' | 'output',
  ): Promise<UriPart[]> {
    if (!this.pathToUri || step.media.length === 0) return [];
    const allowed =
      direction === 'input'
        ? multimodalUploadIncludesInput(this.multimodalUploadMode)
        : multimodalUploadIncludesOutput(this.multimodalUploadMode);
    if (!allowed) return [];

    const stats = { skipped: 0 };
    return convertPathsToUriParts(
      step.media.map((m) => m.uri),
      this.pathToUri,
      timeMs,
      stats,
      this.logger,
    );
  }

  private buildOutputMessages(
    step: AntigravityTranscriptStep | undefined,
    mediaParts: readonly UriPart[] = [],
  ): JsonValue | undefined {
    if (!step && mediaParts.length === 0) return undefined;
    const parts: JsonValue[] = [];
    if (step?.thinking) {
      parts.push({ type: 'reasoning', content: step.thinking });
    }
    if (step?.content) {
      parts.push({ type: 'text', content: step.content });
    }
    for (const part of mediaParts) {
      parts.push(part as unknown as JsonValue);
    }
    for (let i = 0; i < (step?.toolCalls.length ?? 0); i++) {
      const tc = step!.toolCalls[i]!;
      parts.push({
        type: 'tool_call',
        name: tc.name,
        ...(tc.id ? { id: tc.id } : {}),
        ...(tc.args !== undefined ? { arguments: tc.args } : {}),
      });
    }
    if (parts.length === 0) return undefined;
    return [{ role: 'assistant', parts }];
  }

  private async attachWorkspaceContext(
    entry: AgentActivityEntry,
    cwd: string | undefined,
  ): Promise<void> {
    if (!cwd) return;
    entry['workspace.path'] = cwd;
    await enrichCanonicalEntryWithGit(entry, { 'agent.antigravity.cwd': cwd }, 'antigravity');
  }
}

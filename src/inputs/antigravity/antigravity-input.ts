import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
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
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
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
  [ClientType.Antigravity]: '.gemini/antigravity',
  [ClientType.AntigravityIde]: '.gemini/antigravity-ide',
  [ClientType.AntigravityCli]: '.gemini/antigravity-cli',
};

const MAX_DBS_PER_CYCLE = 16;
const MAX_TRACKED_SESSIONS = 512;
const MAX_EMITTED_KEYS_PER_SESSION = 512;

interface SessionCheckpoint {
  effectiveMtimeMs: number;
  emittedUsageKeys: string[];
  lastTranscriptStepIndex: number;
}

interface AntigravityCheckpoint {
  schema: 1;
  seeded: boolean;
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

async function statMtimeMs(filePath: string): Promise<number> {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() ? Math.floor(st.mtimeMs) : 0;
  } catch {
    return 0;
  }
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

  constructor(opts: AntigravityInputOptions) {
    super(opts);
    this.agentType = opts.clientType;
    this.id = opts.clientType;
    this.dataRoot = opts.dataRoot
      ? path.resolve(opts.dataRoot)
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
        const allowedRootPaths = [
          path.join(this.dataRoot, 'brain'),
          ...(mm.allowedRootPaths ?? []),
        ];
        this.pathToUri = (filePath, timeMs) =>
          processor.pathToUri(filePath, timeMs, { allowedRootPaths });
      }
    } else {
      this.multimodalUploadMode = 'none';
    }
  }

  static getDefaultDataRoot(clientType: AntigravityClientType): string {
    return path.join(os.homedir(), DEFAULT_ROOT_SEGMENTS[clientType]);
  }

  static getWatchPaths(clientType: AntigravityClientType, dataRoot?: string): string[] {
    const root = dataRoot ? path.resolve(dataRoot) : AntigravityInput.getDefaultDataRoot(clientType);
    return [root, path.join(root, 'conversations')];
  }

  static async checkAvailability(
    clientType: AntigravityClientType,
    dataRoot?: string,
  ): Promise<boolean> {
    const root = dataRoot ? path.resolve(dataRoot) : AntigravityInput.getDefaultDataRoot(clientType);
    const conversationsDir = path.join(root, 'conversations');
    try {
      const st = await fs.stat(conversationsDir);
      return st.isDirectory();
    } catch {
      try {
        const st = await fs.stat(root);
        return st.isDirectory();
      } catch {
        return false;
      }
    }
  }

  private loadCheckpoint(): AntigravityCheckpoint {
    const state = this.stateStore.get(this.id);
    const raw = state?.extra?.antigravityCheckpoint;
    if (raw && typeof raw === 'object' && (raw as AntigravityCheckpoint).schema === 1) {
      const cp = raw as AntigravityCheckpoint;
      const sessions: Record<string, SessionCheckpoint> = {};
      if (cp.sessions && typeof cp.sessions === 'object') {
        for (const [sid, cur] of Object.entries(cp.sessions)) {
          if (!cur || typeof cur !== 'object') continue;
          sessions[sid] = {
            effectiveMtimeMs: typeof cur.effectiveMtimeMs === 'number' ? cur.effectiveMtimeMs : 0,
            emittedUsageKeys: Array.isArray(cur.emittedUsageKeys)
              ? cur.emittedUsageKeys.filter((k): k is string => typeof k === 'string')
              : [],
            lastTranscriptStepIndex:
              typeof cur.lastTranscriptStepIndex === 'number' ? cur.lastTranscriptStepIndex : -1,
          };
        }
      }
      return { schema: 1, seeded: Boolean(cp.seeded), sessions };
    }
    return { schema: 1, seeded: false, sessions: {} };
  }

  private saveCheckpoint(cp: AntigravityCheckpoint): void {
    // Bound total tracked sessions to prevent unbounded state growth
    const entries = Object.entries(cp.sessions);
    if (entries.length > MAX_TRACKED_SESSIONS) {
      entries.sort((a, b) => b[1].effectiveMtimeMs - a[1].effectiveMtimeMs);
      cp.sessions = Object.fromEntries(entries.slice(0, MAX_TRACKED_SESSIONS));
    }
    for (const cur of Object.values(cp.sessions)) {
      if (cur.emittedUsageKeys.length > MAX_EMITTED_KEYS_PER_SESSION) {
        cur.emittedUsageKeys = cur.emittedUsageKeys.slice(-MAX_EMITTED_KEYS_PER_SESSION);
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
    let dirEntries: string[];
    try {
      dirEntries = await fs.readdir(this.conversationsDir);
    } catch {
      return [];
    }

    const dbFiles = dirEntries
      .filter((name) => name.endsWith('.db') && name !== 'conversation_summaries.db')
      .sort();
    if (dbFiles.length === 0) return [];

    const checkpoint = this.loadCheckpoint();
    const isFreshSeed = !checkpoint.seeded && !this.collectHistorical;

    // Stat candidates and pick changed files (most recently modified first)
    const candidates: Array<{
      sessionId: string;
      dbPath: string;
      effectiveMtimeMs: number;
    }> = [];

    for (const fileName of dbFiles) {
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
      const [dbMtime, walMtime, transcriptMtime] = await Promise.all([
        statMtimeMs(dbPath),
        statMtimeMs(`${dbPath}-wal`),
        statMtimeMs(transcriptPath),
      ]);
      const effectiveMtimeMs = Math.max(dbMtime, walMtime, transcriptMtime);
      if (effectiveMtimeMs <= 0) continue;

      const prev = checkpoint.sessions[sessionId];
      if (!isFreshSeed && prev && effectiveMtimeMs <= prev.effectiveMtimeMs) {
        continue;
      }
      candidates.push({ sessionId, dbPath, effectiveMtimeMs });
    }

    if (isFreshSeed) {
      for (const candidate of candidates) {
        try {
          const snapshot = await readAntigravityConversationDb(candidate.dbPath);
          const transcript = await readAntigravityTranscript(this.dataRoot, candidate.sessionId);
          const maxStep = transcript
            ? transcript.steps.reduce((max, s) => Math.max(max, s.stepIndex), -1)
            : -1;
          checkpoint.sessions[candidate.sessionId] = {
            effectiveMtimeMs: candidate.effectiveMtimeMs,
            emittedUsageKeys: snapshot ? snapshot.events.map((e) => e.key) : [],
            lastTranscriptStepIndex: maxStep,
          };
        } catch {
          checkpoint.sessions[candidate.sessionId] = {
            effectiveMtimeMs: candidate.effectiveMtimeMs,
            emittedUsageKeys: [],
            lastTranscriptStepIndex: -1,
          };
        }
      }
      checkpoint.seeded = true;
      this.saveCheckpoint(checkpoint);
      return [];
    }

    if (candidates.length === 0) return [];

    candidates.sort((a, b) => b.effectiveMtimeMs - a.effectiveMtimeMs);
    const batch = candidates.slice(0, MAX_DBS_PER_CYCLE);

    const emitted: AgentActivityEntry[] = [];
    let checkpointDirty = false;

    for (const candidate of batch) {
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

      if (snapshot?.workspacePath && this.workspacePolicy.excludes(snapshot.workspacePath)) {
        checkpoint.sessions[candidate.sessionId] = {
          effectiveMtimeMs: candidate.effectiveMtimeMs,
          emittedUsageKeys: snapshot.events.map((e) => e.key),
          lastTranscriptStepIndex: checkpoint.sessions[candidate.sessionId]?.lastTranscriptStepIndex ?? -1,
        };
        checkpointDirty = true;
        continue;
      }

      const transcript = await readAntigravityTranscript(this.dataRoot, candidate.sessionId);
      const prevCursor: SessionCheckpoint = checkpoint.sessions[candidate.sessionId] ?? {
        effectiveMtimeMs: 0,
        emittedUsageKeys: [],
        lastTranscriptStepIndex: -1,
      };
      const seenKeys = new Set(prevCursor.emittedUsageKeys);

      const sessionEntries = await this.buildSessionEntries(
        candidate.sessionId,
        snapshot,
        transcript,
        seenKeys,
        prevCursor.lastTranscriptStepIndex,
      );

      emitted.push(...sessionEntries.entries);

      checkpoint.sessions[candidate.sessionId] = {
        effectiveMtimeMs: candidate.effectiveMtimeMs,
        emittedUsageKeys: [...seenKeys],
        lastTranscriptStepIndex: sessionEntries.maxTranscriptStepIndex,
      };
      checkpointDirty = true;
    }

    if (checkpointDirty || !checkpoint.seeded) {
      checkpoint.seeded = true;
      this.saveCheckpoint(checkpoint);
    }

    return emitted;
  }

  private async buildSessionEntries(
    sessionId: string,
    snapshot: AntigravityConversationSnapshot | null,
    transcript: AntigravityTranscript | null,
    seenKeys: Set<string>,
    lastTranscriptStepIndex: number,
  ): Promise<{ entries: AgentActivityEntry[]; maxTranscriptStepIndex: number }> {
    const entries: AgentActivityEntry[] = [];
    const cwd = snapshot?.workspacePath;
    let maxStepIndex = lastTranscriptStepIndex;
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

    // 1) Emit USER_INPUT and tool.call / tool.result from transcript when available
    if (transcript) {
      let currentTurnIndex = 0;
      const stepToTurn = new Map<number, string>();
      for (const step of transcript.steps) {
        if (step.type === 'USER_INPUT') currentTurnIndex++;
        stepToTurn.set(step.stepIndex, `${sessionId}:turn:${Math.max(1, currentTurnIndex)}`);
      }

      const stepsByIndex = transcript.byStepIndex;
      for (const step of transcript.steps) {
        if (step.stepIndex <= lastTranscriptStepIndex) continue;
        if (step.stepIndex > maxStepIndex) maxStepIndex = step.stepIndex;

        const turnId = stepToTurn.get(step.stepIndex) ?? `${sessionId}:turn:1`;
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
            'gen_ai.provider.name': 'gcp.gemini',
            'gen_ai.input.messages': userMessages,
            'gen_ai.input.messages_delta': userMessages,
            time_unix_nano: toUnixNanoString(tsMs),
          });
          if (mediaParts.length > 0) attachMultimodalMetadataForEntry(inputEntry);
          await this.attachWorkspaceContext(inputEntry, cwd);
          entries.push(inputEntry);
        } else if (step.type === 'PLANNER_RESPONSE' && step.toolCalls.length > 0) {
          for (let i = 0; i < step.toolCalls.length; i++) {
            const tc = step.toolCalls[i]!;
            const callId = tc.id ?? `${sessionId}:step:${step.stepIndex}:tc:${i}`;
            const callEntry = buildAgentActivityEntry({
              'event.name': 'tool.call',
              'gen_ai.session.id': sessionId,
              'gen_ai.turn.id': turnId,
              'gen_ai.step.id': stepId,
              'gen_ai.agent.type': this.agentType,
              'gen_ai.provider.name': resolveAntigravityProvider(
                normalizeAntigravityModel(step.model),
              ),
              'gen_ai.tool.name': tc.name,
              'gen_ai.tool.call.id': callId,
              'gen_ai.tool.call.arguments': tc.args,
              time_unix_nano: toUnixNanoString(tsMs),
            });
            await this.attachWorkspaceContext(callEntry, cwd);
            entries.push(callEntry);

            // Antigravity writes tool result steps immediately after PLANNER_RESPONSE
            const resultStep = stepsByIndex.get(step.stepIndex + 1 + i);
            if (resultStep && resultStep.type !== 'PLANNER_RESPONSE' && resultStep.type !== 'USER_INPUT') {
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
                'gen_ai.step.id': `${sessionId}:step:${resultStep.stepIndex}`,
                'gen_ai.agent.type': this.agentType,
                'gen_ai.provider.name': resolveAntigravityProvider(
                  normalizeAntigravityModel(step.model),
                ),
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
            }
          }
        }
      }
    }

    // 2) Emit authoritative llm.request + llm.response pairs from SQLite usage events
    if (snapshot) {
      for (const usage of snapshot.events) {
        if (seenKeys.has(usage.key)) continue;
        seenKeys.add(usage.key);

        const linkedStep = this.findLinkedPlannerStep(usage, transcript);
        const turnId = this.resolveTurnId(sessionId, usage, transcript);
        const stepId =
          usage.stepIndices.length > 0
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

    entries.sort((a, b) => {
      const ta = BigInt(a.time_unix_nano);
      const tb = BigInt(b.time_unix_nano);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

    return { entries, maxTranscriptStepIndex: maxStepIndex };
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

  private resolveTurnId(
    sessionId: string,
    usage: AntigravityUsageEvent,
    transcript: AntigravityTranscript | null,
  ): string {
    if (!transcript || usage.stepIndices.length === 0) {
      return `${sessionId}:turn:1`;
    }
    const targetStep = usage.stepIndices[0]!;
    let turnNum = 0;
    for (const step of transcript.steps) {
      if (step.stepIndex > targetStep) break;
      if (step.type === 'USER_INPUT') turnNum++;
    }
    return `${sessionId}:turn:${Math.max(1, turnNum)}`;
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

    // Locate the immediately preceding PLANNER_RESPONSE step
    let prevPlanner: AntigravityTranscriptStep | undefined;
    for (const step of transcript.steps) {
      if (step.stepIndex >= linkedStep.stepIndex) break;
      if (step.type === 'PLANNER_RESPONSE') prevPlanner = step;
    }
    const prevPlannerIdx = prevPlanner?.stepIndex ?? -1;

    const delta: JsonValue[] = [];
    const consumedStepIndices = new Set<number>();

    // If the previous PLANNER_RESPONSE issued tool calls, include assistant tool_call + tool responses
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

    // Include any USER_INPUT steps that arrived between prevPlanner and linkedStep
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

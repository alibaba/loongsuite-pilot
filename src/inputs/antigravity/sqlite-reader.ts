import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDatabaseSync,
  SQLITE_SYNC_PAGE,
  type DatabaseSyncInstance,
} from '../../utils/node-sqlite.js';
import {
  decodePackedVarints,
  decodeProtoFields,
  fieldBytes,
  fieldBytesAll,
  fieldText,
  fieldVarint,
  parseDurationNs,
  parseTimestampMs,
  type ProtoField,
} from './protobuf.js';
import {
  DEFAULT_ANTIGRAVITY_MODEL,
  isResolvedModel,
  modelNameFromId,
  modelResolutionRank,
  normalizeAntigravityModel,
  resolveAntigravityProvider,
} from './model-normalizer.js';

const MAX_REASONABLE_TOKENS = 100_000_000;
const MAX_PROTO_WALK_DEPTH = 8;
const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true });

export interface AntigravityModelUsage {
  modelId?: number;
  inputTokens: number;
  totalOutputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  visibleOutputTokens: number;
  provider?: number;
  messageId?: string;
  responseId?: string;
  providerAssignedMessageId?: string;
}

export interface AntigravityUsageEvent {
  /** Stable dedup identity for this generation/step usage record. */
  key: string;
  sessionId: string;
  /** Source gen_metadata.idx when originated/merged from gen_metadata. */
  genIdx?: number;
  /** Linked steps.idx values (from gen_metadata.step_indices or steps.idx). */
  stepIndices: number[];
  /** Event timestamp in Unix milliseconds. */
  timestampMs: number;
  timestampRank: number;
  /** Time to first token in nanoseconds, if recorded in gen_metadata. */
  ttftNs?: number;
  /** Streaming duration from first token to completion in nanoseconds. */
  streamDurationNs?: number;
  model: string;
  provider: string;
  /** Fresh (non-cached) input tokens. */
  freshInputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Visible (non-reasoning) output tokens. */
  visibleOutputTokens: number;
  reasoningTokens: number;
  /** Total output tokens (visible + reasoning). */
  totalOutputTokens: number;
  messageId?: string;
  messageIdRank: number;
  identities: string[];
}

export interface AntigravityStepInfo {
  idx: number;
  /** Native turn UUID from steps.metadata field 12. */
  turnId?: string;
  /** Step created timestamp (field 1): prompt submit / llm.request start. */
  createdAtMs?: number;
  /** First token / viewable timestamp (field 6). */
  firstTokenAtMs?: number;
  /** Step completed timestamp (field 8): llm.response end / tool.result end. */
  completedAtMs?: number;
  /** Tool execution started timestamp (field 32): tool.call start. */
  executionStartedAtMs?: number;
  /** Native tool call ID from steps.metadata field 4.1. */
  toolCallId?: string;
  /** Native tool name from steps.metadata field 4.2. */
  toolName?: string;
}

export interface AntigravityConversationSnapshot {
  sessionId: string;
  dbPath: string;
  workspacePath?: string;
  trajectoryTimestampMs?: number;
  maxGenIdx: number;
  maxStepIdx: number;
  events: AntigravityUsageEvent[];
  /** Native per-step timing, turn UUID, and tool call identity from `steps.metadata`. */
  stepInfos: Map<number, AntigravityStepInfo>;
}

interface GeneratorMetadata {
  model?: string;
  modelId?: number;
  usage?: AntigravityModelUsage;
  retryUsages: AntigravityModelUsage[];
  timestampMs?: number;
  ttftNs?: number;
  streamDurationNs?: number;
  stepIndices: number[];
}

interface StepMetadata {
  model?: string;
  modelId?: number;
  provider?: number;
  usage?: AntigravityModelUsage;
  retryUsages: AntigravityModelUsage[];
  timestampMs?: number;
  turnId?: string;
  createdAtMs?: number;
  firstTokenAtMs?: number;
  completedAtMs?: number;
  executionStartedAtMs?: number;
  toolCallId?: string;
  toolName?: string;
}

function tryOptional<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isTokenBearing(u: AntigravityModelUsage): boolean {
  return (
    u.inputTokens > 0 ||
    u.totalOutputTokens > 0 ||
    u.cacheCreationTokens > 0 ||
    u.cacheReadTokens > 0 ||
    u.reasoningTokens > 0 ||
    u.visibleOutputTokens > 0
  );
}

function hasReasonableTokens(u: AntigravityModelUsage): boolean {
  return (
    u.inputTokens <= MAX_REASONABLE_TOKENS &&
    u.totalOutputTokens <= MAX_REASONABLE_TOKENS &&
    u.cacheCreationTokens <= MAX_REASONABLE_TOKENS &&
    u.cacheReadTokens <= MAX_REASONABLE_TOKENS &&
    u.reasoningTokens <= MAX_REASONABLE_TOKENS &&
    u.visibleOutputTokens <= MAX_REASONABLE_TOKENS
  );
}

function usageIdentityKeys(u: AntigravityModelUsage): string[] {
  const keys: string[] = [];
  if (u.responseId) keys.push(`response:${u.responseId}`);
  if (u.providerAssignedMessageId) keys.push(`provider:${u.providerAssignedMessageId}`);
  if (u.messageId) keys.push(`message:${u.messageId}`);
  return keys;
}

function preferredMessageId(u: AntigravityModelUsage): [string | undefined, number] {
  if (u.responseId) return [u.responseId, 3];
  if (u.providerAssignedMessageId) return [u.providerAssignedMessageId, 2];
  if (u.messageId) return [u.messageId, 1];
  return [undefined, 0];
}

function sameTokenCounts(a: AntigravityModelUsage, b: AntigravityModelUsage): boolean {
  return (
    a.modelId === b.modelId &&
    a.inputTokens === b.inputTokens &&
    a.totalOutputTokens === b.totalOutputTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.reasoningTokens === b.reasoningTokens &&
    a.visibleOutputTokens === b.visibleOutputTokens
  );
}

function isMirrorOf(retry: AntigravityModelUsage, primary: AntigravityModelUsage): boolean {
  if (!sameTokenCounts(retry, primary)) return false;
  const primaryIds = new Set(usageIdentityKeys(primary));
  return usageIdentityKeys(retry).every((id) => primaryIds.has(id));
}

function dropPrimaryMirror(
  primary: AntigravityModelUsage | undefined,
  retries: AntigravityModelUsage[],
): void {
  if (!primary) return;
  const idx = retries.findIndex((r) => isMirrorOf(r, primary));
  if (idx >= 0) retries.splice(idx, 1);
}

function toUint8Array(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function parseModelUsage(blob: Uint8Array): AntigravityModelUsage {
  const fields = decodeProtoFields(blob);
  const rawModelId = fieldVarint(fields, 1);
  const rawProvider = fieldVarint(fields, 6);
  return {
    modelId: rawModelId && rawModelId > 0 ? rawModelId : undefined,
    inputTokens: fieldVarint(fields, 2) ?? 0,
    totalOutputTokens: fieldVarint(fields, 3) ?? 0,
    cacheCreationTokens: fieldVarint(fields, 4) ?? 0,
    cacheReadTokens: fieldVarint(fields, 5) ?? 0,
    reasoningTokens: fieldVarint(fields, 9) ?? 0,
    visibleOutputTokens: fieldVarint(fields, 10) ?? 0,
    provider: rawProvider && rawProvider > 0 ? rawProvider : undefined,
    messageId: fieldText(fields, 7),
    responseId: fieldText(fields, 11),
    providerAssignedMessageId: fieldText(fields, 12),
  };
}

function parseRetryInfo(blob: Uint8Array): AntigravityModelUsage | undefined {
  const fields = decodeProtoFields(blob);
  const usageBlob = fieldBytes(fields, 2);
  return usageBlob ? parseModelUsage(usageBlob) : undefined;
}

function parseGenerationInfoTimestamp(blob: Uint8Array): number | undefined {
  const fields = decodeProtoFields(blob);
  const tsBlob = fieldBytes(fields, 4);
  return tsBlob ? parseTimestampMs(tsBlob) : undefined;
}

function parseStepIndices(root: readonly ProtoField[]): number[] {
  const indices: number[] = [];
  for (const f of root) {
    if (f.number !== 2) continue;
    if (f.wire === 0) {
      const big = f.value as bigint;
      if (big <= BigInt(Number.MAX_SAFE_INTEGER)) indices.push(Number(big));
    } else if (f.wire === 2) {
      try {
        indices.push(...decodePackedVarints(f.value as Uint8Array));
      } catch {
        // Ignore malformed packed varint tail
      }
    }
  }
  return indices;
}

export function parseGeneratorMetadata(blob: Uint8Array): GeneratorMetadata | undefined {
  const root = decodeProtoFields(blob);
  const chatModelBlob = fieldBytes(root, 1);
  if (!chatModelBlob) return undefined;
  const chatFields = decodeProtoFields(chatModelBlob);

  const usageBlob = fieldBytes(chatFields, 4);
  const usage = usageBlob ? tryOptional(() => parseModelUsage(usageBlob)) : undefined;

  const retryUsages: AntigravityModelUsage[] = [];
  for (const retryBlob of fieldBytesAll(chatFields, 17)) {
    const parsed = tryOptional(() => parseRetryInfo(retryBlob));
    if (parsed) retryUsages.push(parsed);
  }
  dropPrimaryMirror(usage, retryUsages);

  const genInfoBlob = fieldBytes(chatFields, 9);
  const timestampMs = genInfoBlob
    ? tryOptional(() => parseGenerationInfoTimestamp(genInfoBlob))
    : undefined;

  const ttftBlob = fieldBytes(chatFields, 11);
  const ttftNs = ttftBlob ? tryOptional(() => parseDurationNs(ttftBlob)) : undefined;
  const streamBlob = fieldBytes(chatFields, 12);
  const streamDurationNs = streamBlob ? tryOptional(() => parseDurationNs(streamBlob)) : undefined;

  const model = fieldText(chatFields, 19) ?? fieldText(chatFields, 21);
  const rawModelId = fieldVarint(chatFields, 3);
  const modelId = rawModelId && rawModelId > 0 ? rawModelId : undefined;
  const stepIndices = parseStepIndices(root);

  return {
    model,
    modelId,
    usage,
    retryUsages,
    timestampMs,
    ttftNs,
    streamDurationNs,
    stepIndices,
  };
}

export function parseStepMetadata(blob: Uint8Array): StepMetadata {
  const fields = decodeProtoFields(blob);
  const usageBlob = fieldBytes(fields, 9);
  const usage = usageBlob ? tryOptional(() => parseModelUsage(usageBlob)) : undefined;

  const retryUsages: AntigravityModelUsage[] = [];
  for (const retryBlob of fieldBytesAll(fields, 28)) {
    const parsed = tryOptional(() => parseRetryInfo(retryBlob));
    if (parsed) retryUsages.push(parsed);
  }
  dropPrimaryMirror(usage, retryUsages);

  let model: string | undefined;
  let modelId: number | undefined;
  let provider: number | undefined;
  const modelInfoBlob = fieldBytes(fields, 24);
  if (modelInfoBlob) {
    const infoFields = tryOptional(() => decodeProtoFields(modelInfoBlob));
    if (infoFields) {
      model = fieldText(infoFields, 12) ?? fieldText(infoFields, 8);
      const rawId = fieldVarint(infoFields, 1);
      modelId = rawId && rawId > 0 ? rawId : undefined;
      const rawProv = fieldVarint(infoFields, 7);
      provider = rawProv && rawProv > 0 ? rawProv : undefined;
    }
  }

  const createdBlob = fieldBytes(fields, 1);
  const createdAtMs = createdBlob ? tryOptional(() => parseTimestampMs(createdBlob)) : undefined;
  const firstTokenBlob = fieldBytes(fields, 6);
  const firstTokenAtMs = firstTokenBlob
    ? tryOptional(() => parseTimestampMs(firstTokenBlob))
    : undefined;
  const completedBlob = fieldBytes(fields, 8);
  const completedAtMs = completedBlob
    ? tryOptional(() => parseTimestampMs(completedBlob))
    : undefined;
  const execStartBlob = fieldBytes(fields, 32);
  const executionStartedAtMs = execStartBlob
    ? tryOptional(() => parseTimestampMs(execStartBlob))
    : undefined;

  const rawTurnId = fieldText(fields, 12);
  const turnId = rawTurnId && !/[\x00-\x1f\x7f]/.test(rawTurnId) ? rawTurnId : undefined;

  let toolCallId: string | undefined;
  let toolName: string | undefined;
  const toolInfoBlob = fieldBytes(fields, 4);
  if (toolInfoBlob) {
    const toolFields = tryOptional(() => decodeProtoFields(toolInfoBlob));
    if (toolFields) {
      const rawCallId = fieldText(toolFields, 1);
      const rawToolName = fieldText(toolFields, 2);
      if (rawCallId && !/[\x00-\x1f\x7f]/.test(rawCallId)) toolCallId = rawCallId;
      if (rawToolName && !/[\x00-\x1f\x7f]/.test(rawToolName)) toolName = rawToolName;
    }
  }

  const timestampMs = completedAtMs ?? createdAtMs;

  return {
    model,
    modelId,
    provider,
    usage,
    retryUsages,
    timestampMs,
    turnId,
    createdAtMs,
    firstTokenAtMs,
    completedAtMs,
    executionStartedAtMs,
    toolCallId,
    toolName,
  };
}

/**
 * Recursively walk decoded wire-2 protobuf fields to locate a `file://` URI
 * and convert it cleanly via `fileURLToPath` (preserving UTF-8, `%20`, and
 * Windows drive letters without tag-byte adhesion).
 */
export function extractWorkspacePathFromBlob(blob: Uint8Array): string | undefined {
  return walkProtoForFileUri(blob, 0);
}

function walkProtoForFileUri(blob: Uint8Array, depth: number): string | undefined {
  if (depth > MAX_PROTO_WALK_DEPTH || blob.length === 0) return undefined;
  const fields = tryOptional(() => decodeProtoFields(blob));
  if (!fields) return undefined;

  for (const field of fields) {
    if (field.wire !== 2) continue;
    const bytes = field.value as Uint8Array;
    if (bytes.length === 0) continue;

    // Check if this field itself is a UTF-8 `file://` URI
    const text = tryOptional(() => utf8StrictDecoder.decode(bytes));
    if (text && text.startsWith('file://') && !/[\x00-\x1f\x7f]/.test(text)) {
      const converted = tryOptional(() => fileURLToPath(new URL(text)));
      if (converted) return converted;
    }

    // Otherwise recurse into nested protobuf sub-messages
    const nested = walkProtoForFileUri(bytes, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function tableExists(db: DatabaseSyncInstance, tableName: string): boolean {
  const rows = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .all(tableName);
  return rows.length > 0;
}

function isDatabaseEmpty(db: DatabaseSyncInstance): boolean {
  const rows = db.prepare('PRAGMA page_count').all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return true;
  const count = Number(Object.values(rows[0]!)[0] ?? 0);
  return !Number.isFinite(count) || count === 0;
}

function resolveModel(
  usageModelId: number | undefined,
  contextModel: string | undefined,
  contextModelId: number | undefined,
): string {
  const idModel =
    usageModelId !== undefined
      ? normalizeAntigravityModel(modelNameFromId(usageModelId))
      : undefined;
  const normalizedContext = normalizeAntigravityModel(contextModel);
  const sameModelRow = contextModelId === usageModelId ? normalizedContext : undefined;

  if (idModel && isResolvedModel(idModel)) return idModel;
  if (sameModelRow && isResolvedModel(sameModelRow)) return sameModelRow;
  // Allow an explicit resolved native model string to override an unmapped placeholder ID
  if (normalizedContext && isResolvedModel(normalizedContext)) return normalizedContext;
  if (idModel) return idModel;
  if (normalizedContext) return normalizedContext;
  return DEFAULT_ANTIGRAVITY_MODEL;
}

function mergeUsageEvent(target: AntigravityUsageEvent, dup: AntigravityUsageEvent): void {
  target.freshInputTokens = Math.max(target.freshInputTokens, dup.freshInputTokens);
  target.cacheCreationTokens = Math.max(target.cacheCreationTokens, dup.cacheCreationTokens);
  target.cacheReadTokens = Math.max(target.cacheReadTokens, dup.cacheReadTokens);
  target.visibleOutputTokens = Math.max(target.visibleOutputTokens, dup.visibleOutputTokens);
  target.reasoningTokens = Math.max(target.reasoningTokens, dup.reasoningTokens);
  target.totalOutputTokens = Math.max(
    target.totalOutputTokens,
    dup.totalOutputTokens,
    target.visibleOutputTokens + target.reasoningTokens,
  );
  if (modelResolutionRank(dup.model) > modelResolutionRank(target.model)) {
    target.model = dup.model;
    target.provider = dup.provider;
  }
  const useDupTs =
    dup.timestampRank > target.timestampRank ||
    (dup.timestampRank === target.timestampRank && dup.timestampMs < target.timestampMs);
  if (useDupTs) {
    target.timestampMs = dup.timestampMs;
    target.timestampRank = dup.timestampRank;
  }
  if (dup.messageIdRank > target.messageIdRank) {
    target.messageId = dup.messageId;
    target.messageIdRank = dup.messageIdRank;
  }
  if (target.genIdx === undefined && dup.genIdx !== undefined) {
    target.genIdx = dup.genIdx;
  }
  if (target.ttftNs === undefined && dup.ttftNs !== undefined) {
    target.ttftNs = dup.ttftNs;
  }
  if (target.streamDurationNs === undefined && dup.streamDurationNs !== undefined) {
    target.streamDurationNs = dup.streamDurationNs;
  }
  for (const s of dup.stepIndices) {
    if (!target.stepIndices.includes(s)) target.stepIndices.push(s);
  }
  for (const id of dup.identities) {
    if (!target.identities.includes(id)) target.identities.push(id);
  }
}

function deduplicateEvents(events: AntigravityUsageEvent[]): AntigravityUsageEvent[] {
  const slots: Array<AntigravityUsageEvent | undefined> = [];
  const identityIndexes = new Map<string, number>();

  for (const event of events) {
    const matching = new Set<number>();
    for (const id of event.identities) {
      const idx = identityIndexes.get(id);
      if (idx !== undefined) matching.add(idx);
    }
    const sortedMatches = [...matching].sort((a, b) => a - b);
    if (sortedMatches.length === 0) {
      const targetIdx = slots.length;
      slots.push(event);
      for (const id of event.identities) identityIndexes.set(id, targetIdx);
      continue;
    }

    const targetIdx = sortedMatches[0]!;
    const target = slots[targetIdx]!;
    for (let i = 1; i < sortedMatches.length; i++) {
      const dupIdx = sortedMatches[i]!;
      const dup = slots[dupIdx];
      if (dup) {
        slots[dupIdx] = undefined;
        mergeUsageEvent(target, dup);
      }
    }
    mergeUsageEvent(target, event);
    for (const id of target.identities) identityIndexes.set(id, targetIdx);
  }

  return slots.filter((e): e is AntigravityUsageEvent => e !== undefined);
}

/**
 * Read one Antigravity conversation SQLite database read-only in bounded pages.
 * Returns null if the DB is empty/uninitialized or missing gen_metadata.
 */
export async function readAntigravityConversationDb(
  dbPath: string,
): Promise<AntigravityConversationSnapshot | null> {
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) {
    throw new Error(
      'node:sqlite is unavailable; Antigravity collection requires Node.js >= 22.13 or >= 23.4',
    );
  }

  const stat = await fs.stat(dbPath);
  const fallbackTimestampMs = Math.floor(stat.mtimeMs);
  const sessionId = path.basename(dbPath, '.db');

  let db: DatabaseSyncInstance | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    if (isDatabaseEmpty(db) || !tableExists(db, 'gen_metadata')) {
      return null;
    }

    let trajectoryTimestampMs: number | undefined;
    let workspacePath: string | undefined;
    if (tableExists(db, 'trajectory_metadata_blob')) {
      const rows = db
        .prepare('SELECT data FROM trajectory_metadata_blob ORDER BY rowid ASC LIMIT 32')
        .all() as Array<{ data?: unknown }>;
      for (const row of rows) {
        const blob = toUint8Array(row.data);
        if (!blob) continue;
        if (trajectoryTimestampMs === undefined) {
          trajectoryTimestampMs = tryOptional(() => {
            const fields = decodeProtoFields(blob);
            const tsBlob = fieldBytes(fields, 2);
            return tsBlob ? parseTimestampMs(tsBlob) : undefined;
          });
        }
        if (workspacePath === undefined) {
          workspacePath = extractWorkspacePathFromBlob(blob);
        }
      }
    }

    const stepRows: Array<{ idx: number; metadata: StepMetadata }> = [];
    let maxStepIdx = -1;
    if (tableExists(db, 'steps')) {
      const stmt = db.prepare(
        'SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL AND idx > ? ORDER BY idx ASC LIMIT ?',
      );
      let cursor = -1;
      for (;;) {
        const page = stmt.all(cursor, SQLITE_SYNC_PAGE) as Array<{ idx: number; metadata: unknown }>;
        if (page.length === 0) break;
        for (const row of page) {
          const idx = Number(row.idx);
          if (idx > maxStepIdx) maxStepIdx = idx;
          cursor = idx;
          const blob = toUint8Array(row.metadata);
          if (!blob || blob.length === 0) continue;
          const parsed = tryOptional(() => parseStepMetadata(blob));
          if (parsed) stepRows.push({ idx, metadata: parsed });
        }
        if (page.length < SQLITE_SYNC_PAGE) break;
        await yieldEventLoop();
      }
    }

    const genRows: Array<{ idx: number; metadata: GeneratorMetadata }> = [];
    let maxGenIdx = -1;
    {
      const stmt = db.prepare(
        'SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC LIMIT ?',
      );
      let cursor = -1;
      for (;;) {
        const page = stmt.all(cursor, SQLITE_SYNC_PAGE) as Array<{ idx: number; data: unknown }>;
        if (page.length === 0) break;
        for (const row of page) {
          const idx = Number(row.idx);
          if (idx > maxGenIdx) maxGenIdx = idx;
          cursor = idx;
          const blob = toUint8Array(row.data);
          if (!blob || blob.length === 0) continue;
          const parsed = tryOptional(() => parseGeneratorMetadata(blob));
          if (parsed) genRows.push({ idx, metadata: parsed });
        }
        if (page.length < SQLITE_SYNC_PAGE) break;
        await yieldEventLoop();
      }
    }

    // Build fallback model from last generation row that carries a model
    // (only applied AFTER deduplication so it never overrides row-level models)
    let generationModel: string | undefined;
    for (let i = genRows.length - 1; i >= 0; i--) {
      const m = genRows[i]!.metadata;
      const candidate =
        normalizeAntigravityModel(m.model) ??
        (m.modelId !== undefined ? normalizeAntigravityModel(modelNameFromId(m.modelId)) : undefined);
      if (candidate) {
        generationModel = candidate;
        break;
      }
    }

    const stepTimestamps = new Map<number, number>();
    const stepInfos = new Map<number, AntigravityStepInfo>();
    for (const { idx, metadata } of stepRows) {
      if (metadata.timestampMs !== undefined) {
        stepTimestamps.set(idx, metadata.timestampMs);
      }
      stepInfos.set(idx, {
        idx,
        turnId: metadata.turnId,
        createdAtMs: metadata.createdAtMs,
        firstTokenAtMs: metadata.firstTokenAtMs,
        completedAtMs: metadata.completedAtMs,
        executionStartedAtMs: metadata.executionStartedAtMs,
        toolCallId: metadata.toolCallId,
        toolName: metadata.toolName,
      });
    }

    const rawEvents: AntigravityUsageEvent[] = [];
    const identityTimestamps = new Map<string, [number, number]>();

    const appendUsage = (
      usage: AntigravityModelUsage,
      opts: {
        model?: string;
        modelId?: number;
        provider?: number;
        timestampMs?: number;
        timestampRank?: number;
        fallbackIdentities: string[];
        genIdx?: number;
        stepIndices: number[];
        ttftNs?: number;
        streamDurationNs?: number;
      },
    ): void => {
      if (!isTokenBearing(usage) || !hasReasonableTokens(usage)) return;

      const identities = usageIdentityKeys(usage);
      if (identities.length === 0) {
        identities.push(...opts.fallbackIdentities);
      }

      let timestampMs: number;
      let timestampRank: number;
      if (opts.timestampMs !== undefined) {
        timestampMs = opts.timestampMs;
        timestampRank = opts.timestampRank ?? 3;
      } else {
        const matched = identities
          .map((id) => identityTimestamps.get(id))
          .find((v): v is [number, number] => v !== undefined);
        if (matched) {
          [timestampMs, timestampRank] = matched;
        } else if (trajectoryTimestampMs !== undefined) {
          timestampMs = trajectoryTimestampMs;
          timestampRank = 1;
        } else {
          timestampMs = fallbackTimestampMs;
          timestampRank = 0;
        }
      }

      for (const id of identities) {
        const prev = identityTimestamps.get(id);
        if (
          !prev ||
          timestampRank > prev[1] ||
          (timestampRank === prev[1] && timestampMs < prev[0])
        ) {
          identityTimestamps.set(id, [timestampMs, timestampRank]);
        }
      }

      const totalOutputTokens = Math.max(
        usage.totalOutputTokens,
        usage.visibleOutputTokens + usage.reasoningTokens,
      );
      const visibleOutputTokens = Math.max(
        usage.visibleOutputTokens,
        Math.max(0, totalOutputTokens - usage.reasoningTokens),
      );
      const reasoningTokens = Math.max(
        usage.reasoningTokens,
        Math.max(0, totalOutputTokens - visibleOutputTokens),
      );

      const model = resolveModel(usage.modelId, opts.model, opts.modelId);
      const provider = resolveAntigravityProvider(model, usage.provider ?? opts.provider);
      const [messageId, messageIdRank] = preferredMessageId(usage);
      const key = identities[0] ?? `anon:${sessionId}:${rawEvents.length}`;

      rawEvents.push({
        key,
        sessionId,
        genIdx: opts.genIdx,
        stepIndices: [...opts.stepIndices],
        timestampMs,
        timestampRank,
        ttftNs: opts.ttftNs,
        streamDurationNs: opts.streamDurationNs,
        model,
        provider,
        freshInputTokens: usage.inputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        visibleOutputTokens,
        reasoningTokens,
        totalOutputTokens,
        messageId,
        messageIdRank,
        identities,
      });
    };

    // 1) Process steps first (without session-level generationModel fallback)
    for (const { idx, metadata } of stepRows) {
      const rowModel =
        normalizeAntigravityModel(metadata.model) ??
        (metadata.modelId !== undefined
          ? normalizeAntigravityModel(modelNameFromId(metadata.modelId))
          : undefined);
      if (metadata.usage) {
        appendUsage(metadata.usage, {
          model: rowModel,
          modelId: metadata.modelId,
          provider: metadata.provider,
          timestampMs: metadata.timestampMs,
          timestampRank: 3,
          fallbackIdentities: [`step:${sessionId}:${idx}`],
          stepIndices: [idx],
        });
      }
      for (let r = 0; r < metadata.retryUsages.length; r++) {
        appendUsage(metadata.retryUsages[r]!, {
          model: rowModel,
          modelId: metadata.modelId,
          provider: metadata.provider,
          timestampMs: metadata.timestampMs,
          timestampRank: 3,
          fallbackIdentities: [`step-retry:${sessionId}:${idx}:${r}`],
          stepIndices: [idx],
        });
      }
    }

    // 2) Process gen_metadata in ascending idx order (continuations inherit currentModel)
    let currentModel: string | undefined;
    for (const { idx, metadata } of genRows) {
      const rowModel =
        normalizeAntigravityModel(metadata.model) ??
        (metadata.modelId !== undefined
          ? normalizeAntigravityModel(modelNameFromId(metadata.modelId))
          : undefined) ??
        (metadata.usage?.modelId !== undefined
          ? normalizeAntigravityModel(modelNameFromId(metadata.usage.modelId))
          : undefined);
      if (rowModel) currentModel = rowModel;

      const linkedStepTs = metadata.stepIndices
        .map((s) => stepTimestamps.get(s))
        .find((ts): ts is number => ts !== undefined);
      const ts = metadata.timestampMs ?? linkedStepTs;
      const tsRank = metadata.timestampMs !== undefined ? 3 : linkedStepTs !== undefined ? 2 : undefined;

      const fallbackIdentities =
        metadata.stepIndices.length > 0
          ? metadata.stepIndices.map((s) => `step:${sessionId}:${s}`)
          : [`gen:${sessionId}:${idx}`];

      if (metadata.usage) {
        appendUsage(metadata.usage, {
          model: currentModel,
          modelId: metadata.modelId,
          timestampMs: ts,
          timestampRank: tsRank,
          fallbackIdentities,
          genIdx: idx,
          stepIndices: metadata.stepIndices,
          ttftNs: metadata.ttftNs,
          streamDurationNs: metadata.streamDurationNs,
        });
      }
      for (let r = 0; r < metadata.retryUsages.length; r++) {
        appendUsage(metadata.retryUsages[r]!, {
          model: currentModel,
          modelId: metadata.modelId,
          timestampMs: ts,
          timestampRank: tsRank,
          fallbackIdentities: [`gen-retry:${sessionId}:${idx}:${r}`],
          genIdx: idx,
          stepIndices: metadata.stepIndices,
        });
      }
    }

    const deduped = deduplicateEvents(rawEvents);
    // Apply session-level fallback model only to events still unresolved after merge
    if (generationModel) {
      for (const event of deduped) {
        if (modelResolutionRank(event.model) === 0) {
          event.model = generationModel;
          event.provider = resolveAntigravityProvider(generationModel);
        }
      }
    }

    deduped.sort((a, b) => {
      if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
      return (a.genIdx ?? Number.MAX_SAFE_INTEGER) - (b.genIdx ?? Number.MAX_SAFE_INTEGER);
    });

    return {
      sessionId,
      dbPath,
      workspacePath,
      trajectoryTimestampMs,
      maxGenIdx,
      maxStepIdx,
      events: deduped,
      stepInfos,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors
    }
  }
}

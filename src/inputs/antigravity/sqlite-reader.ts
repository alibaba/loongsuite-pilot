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
  /** Concrete source slot used when no native response ID is available. */
  key: string;
  /** Concrete primary or retry slots that describe this same attempt. */
  sourceKeys: string[];
  isRetry: boolean;
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
  /** Native response/message IDs with their respective namespaces. */
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
  /** All explicit workspace roots, including secondary folders and Git roots. */
  workspacePaths?: string[];
  trajectoryTimestampMs?: number;
  events: AntigravityUsageEvent[];
  /** Native per-step timing, turn UUID, and tool call identity from `steps.metadata`. */
  stepInfos: Map<number, AntigravityStepInfo>;
}

interface GeneratorMetadata {
  model?: string;
  modelId?: number;
  usage?: AntigravityModelUsage;
  retryUsages: Array<AntigravityModelUsage | undefined>;
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
  retryUsages: Array<AntigravityModelUsage | undefined>;
  timestampMs?: number;
  turnId?: string;
  createdAtMs?: number;
  firstTokenAtMs?: number;
  completedAtMs?: number;
  executionStartedAtMs?: number;
  toolCallId?: string;
  toolName?: string;
}

interface WorkspaceMetadata {
  paths: string[];
  fallbackPath?: string;
  timestampMs?: number;
}

interface MetadataRows<T> {
  maxIdx: number;
  rows: Map<number, T | undefined>;
  pending: Set<number>;
}

interface ConversationDbState {
  fileIdentity: string;
  schemaVersion: number;
  workspace: WorkspaceMetadata;
  steps: MetadataRows<StepMetadata>;
  generations: MetadataRows<GeneratorMetadata>;
}

/** In-memory decoded rows for one conversation. Keep it separate from the delivery checkpoint. */
export class AntigravityDbReadCache {
  /** @internal Committed by the reader only after a successful snapshot. */
  state?: ConversationDbState;

  get rowCount(): number {
    return (this.state?.steps.rows.size ?? 0) + (this.state?.generations.rows.size ?? 0);
  }

  get pendingRowCount(): number {
    return (this.state?.steps.pending.size ?? 0) + (this.state?.generations.pending.size ?? 0);
  }
}

export interface AntigravityDbReadOptions {
  cache: AntigravityDbReadCache;
  /** Reconcile older rows that may have changed without moving the database's index frontier. */
  forceFull?: boolean;
  /** Steps changed in the companion transcript or still waiting for native metadata. */
  stepIndices?: readonly number[];
  /** Reevaluate all roots when a workspace exclusion policy is active. */
  refreshWorkspace?: boolean;
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

  const retryUsages = fieldBytesAll(chatFields, 17).map(
    (retryBlob) => tryOptional(() => parseRetryInfo(retryBlob)),
  );

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

  const retryUsages = fieldBytesAll(fields, 28).map(
    (retryBlob) => tryOptional(() => parseRetryInfo(retryBlob)),
  );

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

function parseLocalFileUri(text: string | undefined): string | undefined {
  if (!text || !text.startsWith('file://') || text.length <= 'file:///'.length || /[\x00-\x1f\x7f]/.test(text)) {
    return undefined;
  }
  const url = tryOptional(() => new URL(text));
  if (!url || url.protocol !== 'file:') return undefined;
  // Reject remote UNC hosts (e.g. file://server/share) to avoid SMB access via git -C on Windows
  if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return undefined;
  const converted = tryOptional(() => fileURLToPath(url));
  if (!converted || /^[\\/]{2}/.test(converted) || /[\x00-\x1f\x7f]/.test(converted)) {
    return undefined;
  }
  // Reject bare POSIX/Windows root paths, multi-slash roots (//), and drive roots (/, \, C:\, /C:/)
  if (
    /^\/+$/.test(converted) ||
    /^\\+$/.test(converted) ||
    /^[A-Za-z]:[\\/]?$/.test(converted) ||
    /^\/[A-Za-z]:\/?$/.test(converted)
  ) {
    return undefined;
  }
  return converted;
}

/**
 * Extract the workspace directory from `trajectory_metadata_blob`.
 * Checks Antigravity's native workspace fields first (`1.1`, `1.2`, `7`), then falls back
 * to a bounded DFS over wire-2 protobuf fields for resilience across schema changes.
 * Always rejects remote UNC hosts and bare POSIX/Windows drive roots.
 */
export function extractWorkspacePathFromBlob(blob: Uint8Array): string | undefined {
  const fields = tryOptional(() => decodeProtoFields(blob));
  if (!fields) return undefined;
  return extractNativeWorkspacePaths(fields)[0] ?? walkProtoForFileUri(blob, 0);
}

function extractNativeWorkspacePaths(fields: readonly ProtoField[]): string[] {
  const roots: string[] = [];
  // Native repeated workspace messages: field 1 -> sub-field 1 (folder URI) / 2 (Git root URI).
  for (const wsBlob of fieldBytesAll(fields, 1)) {
    const wsFields = tryOptional(() => decodeProtoFields(wsBlob));
    if (!wsFields) continue;
    const folder = parseLocalFileUri(fieldText(wsFields, 1));
    const gitRoot = parseLocalFileUri(fieldText(wsFields, 2));
    if (folder) roots.push(folder);
    if (gitRoot) roots.push(gitRoot);
  }
  // Native top-level repeated workspace_uris: field 7.
  for (const uriBlob of fieldBytesAll(fields, 7)) {
    const text = tryOptional(() => utf8StrictDecoder.decode(uriBlob));
    const root = parseLocalFileUri(text);
    if (root) roots.push(root);
  }
  return roots;
}

function walkProtoForFileUri(blob: Uint8Array, depth: number): string | undefined {
  if (depth > MAX_PROTO_WALK_DEPTH || blob.length === 0) return undefined;
  const fields = tryOptional(() => decodeProtoFields(blob));
  if (!fields) return undefined;

  for (const field of fields) {
    if (field.wire !== 2) continue;
    const bytes = field.value as Uint8Array;
    if (bytes.length === 0) continue;

    const text = tryOptional(() => utf8StrictDecoder.decode(bytes));
    const parsed = parseLocalFileUri(text);
    if (parsed) return parsed;

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
  target.isRetry = target.isRetry && dup.isRetry;
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
  for (const key of dup.sourceKeys) {
    if (!target.sourceKeys.includes(key)) target.sourceKeys.push(key);
  }
}

const NATIVE_ID_PREFIXES = ['response:', 'provider:', 'message:'] as const;

function usageFingerprint(event: AntigravityUsageEvent, stepIdx: number): string {
  return [
    stepIdx,
    Number(event.isRetry),
    event.freshInputTokens,
    event.cacheCreationTokens,
    event.cacheReadTokens,
    event.visibleOutputTokens,
    event.reasoningTokens,
    event.totalOutputTokens,
  ].join(':');
}

function deduplicateEvents(events: AntigravityUsageEvent[]): AntigravityUsageEvent[] {
  const remaining = new Set(events);

  // A weaker alias can be shared by multiple distinct responses. Resolve native
  // IDs in priority order and leave an entire weaker group separate when its
  // stronger IDs disagree, including members with no stronger ID of their own.
  for (const [rank, prefix] of NATIVE_ID_PREFIXES.entries()) {
    const groups = new Map<string, AntigravityUsageEvent[]>();
    for (const event of remaining) {
      const matches = event.identities.filter((id) => id.startsWith(prefix));
      if (matches.length !== 1) continue;
      const id = matches[0]!;
      const group = groups.get(id);
      if (group) group.push(event);
      else groups.set(id, [event]);
    }

    const higherPrefixes = NATIVE_ID_PREFIXES.slice(0, rank);
    for (const [groupId, group] of groups) {
      if (group.length < 2) continue;
      const hasConflict = higherPrefixes.some((higher) => {
        const ids = new Set(group.flatMap((event) =>
          event.identities.filter((id) => id.startsWith(higher)),
        ));
        return ids.size > 1;
      });
      if (hasConflict) {
        // The alias is known to be shared. Never use it as a checkpoint key.
        for (const event of group) event.identities = event.identities.filter((id) => id !== groupId);
        continue;
      }
      const target = group[0]!;
      for (const duplicate of group.slice(1)) {
        mergeUsageEvent(target, duplicate);
        remaining.delete(duplicate);
      }
    }
  }

  // A referenced step is context, not an attempt identity. It can connect a
  // steps row to a generation row only when both sides have a unique match.
  const genByFingerprint = new Map<string, Set<AntigravityUsageEvent>>();
  const stepEvents: AntigravityUsageEvent[] = [];
  for (const event of remaining) {
    if (event.genIdx === undefined) {
      stepEvents.push(event);
    } else if (!event.sourceKeys.some((key) => key.startsWith('step:') || key.startsWith('step-retry:'))) {
      for (const stepIdx of event.stepIndices) {
        const fingerprint = usageFingerprint(event, stepIdx);
        const group = genByFingerprint.get(fingerprint);
        if (group) group.add(event);
        else genByFingerprint.set(fingerprint, new Set([event]));
      }
    }
  }

  const generationMatchCounts = new Map<AntigravityUsageEvent, number>();
  const uniqueStepMatches = new Map<AntigravityUsageEvent, AntigravityUsageEvent>();
  for (const step of stepEvents) {
    const candidates = new Set<AntigravityUsageEvent>();
    for (const stepIdx of step.stepIndices) {
      for (const generation of genByFingerprint.get(usageFingerprint(step, stepIdx)) ?? []) {
        // Both sides carry different native IDs, so matching token counts
        // alone do not establish a mirror.
        if (step.messageId !== undefined && generation.messageId !== undefined) continue;
        candidates.add(generation);
      }
    }
    for (const generation of candidates) {
      generationMatchCounts.set(generation, (generationMatchCounts.get(generation) ?? 0) + 1);
    }
    if (candidates.size === 1) uniqueStepMatches.set(step, [...candidates][0]!);
  }

  for (const [step, generation] of uniqueStepMatches) {
    if (generationMatchCounts.get(generation) === 1) {
      mergeUsageEvent(step, generation);
      remaining.delete(generation);
    }
  }
  return [...remaining];
}

function maxMetadataIndex(db: DatabaseSyncInstance, table: 'steps' | 'gen_metadata'): number {
  const [row] = db.prepare(`SELECT MAX(idx) AS idx FROM ${table}`).all() as Array<{ idx: number | null }>;
  return row?.idx ?? -1;
}

function isPendingAttempt(usage: AntigravityModelUsage | undefined): boolean {
  return usage === undefined || !isTokenBearing(usage);
}

// Full audits recover older unfinished rows. Bound repeated reads of large BLOBs
// in the ordinary collector path and yield between the smaller point-read pages.
const MAX_POINT_READS_PER_TABLE = 64;
const MAX_PENDING_POINT_READS = 32;
const POINT_READ_PAGE_ROWS = 16;

interface MetadataReadOptions<T> {
  previous?: MetadataRows<T>;
  pointIndices?: ReadonlySet<number>;
  parse: (blob: Uint8Array) => T | undefined;
  isPending: (metadata: T) => boolean;
  isRunning?: () => boolean;
}

async function readMetadataRows<T>(
  db: DatabaseSyncInstance,
  table: 'steps' | 'gen_metadata',
  tableExists: boolean,
  options: MetadataReadOptions<T>,
): Promise<{ cache: MetadataRows<T>; touched: ReadonlySet<number> } | null> {
  const { previous, pointIndices, parse, isPending, isRunning } = options;
  const touched = new Set<number>();
  if (!tableExists) return { cache: { maxIdx: -1, rows: new Map(), pending: new Set() }, touched };

  const rows = new Map(previous?.rows);
  const pending = new Set(previous?.pending);
  const column = table === 'steps' ? 'metadata' : 'data';
  type MetadataRow = { idx: number; blob: unknown };
  const update = (row: MetadataRow): void => {
    const blob = toUint8Array(row.blob);
    const metadata = blob?.length ? tryOptional(() => parse(blob)) : undefined;
    rows.set(row.idx, metadata);
    touched.add(row.idx);
    if (metadata === undefined || isPending(metadata)) pending.add(row.idx);
    else pending.delete(row.idx);
  };

  // NULL/empty rows advance the append cursor and remain eligible for point reads.
  const append = db.prepare(
    `SELECT idx, ${column} AS blob FROM ${table} WHERE idx > ? ORDER BY idx ASC LIMIT ?`,
  );
  let maxIdx = previous?.maxIdx ?? -1;
  for (;;) {
    if (isRunning && !isRunning()) return null;
    const page = append.all(maxIdx, SQLITE_SYNC_PAGE) as MetadataRow[];
    for (const row of page) update(row);
    maxIdx = page.at(-1)?.idx ?? maxIdx;
    if (page.length < SQLITE_SYNC_PAGE) break;
    await yieldEventLoop();
  }

  if (previous) {
    const points = new Set<number>();
    for (const idx of pointIndices ?? []) {
      if (Number.isSafeInteger(idx) && idx >= 0 && idx <= previous.maxIdx) points.add(idx);
      if (points.size === MAX_POINT_READS_PER_TABLE) break;
    }
    if (points.size < MAX_POINT_READS_PER_TABLE) {
      for (const idx of [...previous.pending].slice(-MAX_PENDING_POINT_READS).reverse()) {
        points.add(idx);
        if (points.size === MAX_POINT_READS_PER_TABLE) break;
      }
    }

    const indices = [...points];
    for (let start = 0; start < indices.length; start += POINT_READ_PAGE_ROWS) {
      if (isRunning && !isRunning()) return null;
      const page = indices.slice(start, start + POINT_READ_PAGE_ROWS);
      const sql = `SELECT idx, ${column} AS blob FROM ${table} WHERE idx IN (${page.map(() => '?').join(',')})`;
      for (const idx of page) {
        // A previously read row may have been removed in-place. Keep a missing point pending
        // so a companion row inserted below the frontier can be discovered next time.
        rows.delete(idx);
        pending.add(idx);
      }
      for (const row of db.prepare(sql).all(...page) as MetadataRow[]) update(row);
      if (start + POINT_READ_PAGE_ROWS < indices.length) await yieldEventLoop();
    }
  }
  return { cache: { maxIdx, rows, pending }, touched };
}

function orderedMetadataRows<T>(data: MetadataRows<T>): Array<{ idx: number; metadata: T }> {
  const rows: Array<{ idx: number; metadata: T }> = [];
  for (const [idx, metadata] of data.rows) {
    if (metadata !== undefined) rows.push({ idx, metadata });
  }
  return rows.sort((a, b) => a.idx - b.idx);
}

/**
 * Read one Antigravity conversation SQLite database read-only in bounded pages.
 * Returns null if the DB is empty or a caller cancels collection.
 */
export async function readAntigravityConversationDb(
  dbPath: string,
  isRunning?: () => boolean,
  incremental?: AntigravityDbReadOptions,
): Promise<AntigravityConversationSnapshot | null> {
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) {
    throw new Error(
      'node:sqlite is unavailable; Antigravity collection requires Node.js >= 22.13 or >= 23.4',
    );
  }

  const stat = await fs.stat(dbPath, { bigint: true });
  if (isRunning && !isRunning()) return null;
  const fallbackTimestampMs = Number(stat.mtimeNs / 1_000_000n);
  const fileIdentity = `${stat.dev}:${stat.ino}`;
  const sessionId = path.basename(dbPath, '.db');

  let db: DatabaseSyncInstance | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // Keep workspace, step, and generation rows on the same SQLite snapshot across yields.
    db.exec('BEGIN');
    if (isDatabaseEmpty(db)) {
      if (incremental) incremental.cache.state = undefined;
      return null;
    }

    const stepsExist = tableExists(db, 'steps');
    const generationsExist = tableExists(db, 'gen_metadata');
    const [schema] = incremental
      ? db.prepare('PRAGMA schema_version').all() as Array<{ schema_version: number }>
      : [];
    const schemaVersion = schema?.schema_version ?? 0;
    const cached = incremental?.cache.state;
    const previous = (
      cached && !incremental?.forceFull &&
      cached.fileIdentity === fileIdentity && cached.schemaVersion === schemaVersion &&
      (stepsExist ? maxMetadataIndex(db, 'steps') : -1) >= cached.steps.maxIdx &&
      (generationsExist ? maxMetadataIndex(db, 'gen_metadata') : -1) >= cached.generations.maxIdx
    ) ? cached : undefined;

    let workspace = previous?.workspace;
    if (!workspace?.paths.length || incremental?.refreshWorkspace) {
      let trajectoryTimestampMs: number | undefined;
      let fallbackWorkspacePath: string | undefined;
      const nativeWorkspacePaths = new Set<string>();
      if (tableExists(db, 'trajectory_metadata_blob')) {
        const stmt = db.prepare(
          'SELECT rowid, data FROM trajectory_metadata_blob WHERE rowid > ? ORDER BY rowid ASC LIMIT ?',
        );
        let cursor = Number.MIN_SAFE_INTEGER;
        for (;;) {
          if (isRunning && !isRunning()) return null;
          const rows = stmt.all(cursor, SQLITE_SYNC_PAGE) as Array<{ rowid: number; data?: unknown }>;
          for (const row of rows) {
            cursor = row.rowid;
            const blob = toUint8Array(row.data);
            if (!blob) continue;
            const fields = tryOptional(() => decodeProtoFields(blob));
            if (!fields) continue;
            if (trajectoryTimestampMs === undefined) {
              const tsBlob = fieldBytes(fields, 2);
              trajectoryTimestampMs = tsBlob ? tryOptional(() => parseTimestampMs(tsBlob)) : undefined;
            }
            for (const root of extractNativeWorkspacePaths(fields)) nativeWorkspacePaths.add(root);
            if (nativeWorkspacePaths.size === 0 && fallbackWorkspacePath === undefined) {
              fallbackWorkspacePath = walkProtoForFileUri(blob, 0);
            }
          }
          if (rows.length < SQLITE_SYNC_PAGE) break;
          await yieldEventLoop();
        }
      }
      workspace = { paths: [...nativeWorkspacePaths], fallbackPath: fallbackWorkspacePath, timestampMs: trajectoryTimestampMs };
    }
    const { paths: workspacePaths, timestampMs: trajectoryTimestampMs } = workspace;
    const workspacePath = workspacePaths[0] ?? workspace.fallbackPath;

    const stepPoints = new Set(incremental?.stepIndices);
    const generationPoints = new Set<number>();
    if (previous && stepPoints.size > 0) {
      for (const [idx, metadata] of previous.generations.rows) {
        if (metadata?.stepIndices.some((stepIdx) => stepPoints.has(stepIdx))) generationPoints.add(idx);
      }
    }
    const readSteps = () => readMetadataRows(db!, 'steps', stepsExist, {
      previous: previous?.steps,
      pointIndices: stepPoints,
      parse: parseStepMetadata,
      isPending: (metadata) => (
        (metadata.usage !== undefined && isPendingAttempt(metadata.usage)) ||
        (metadata.executionStartedAtMs !== undefined && metadata.completedAtMs === undefined) ||
        metadata.retryUsages.some(isPendingAttempt)
      ),
      isRunning,
    });

    // A full read can look at steps first. For an incremental read, include any
    // older native steps just associated with a changed generation row.
    let stepRead = previous ? undefined : await readSteps();
    if (stepRead === null) return null;
    const genRead = await readMetadataRows(db, 'gen_metadata', generationsExist, {
      previous: previous?.generations,
      pointIndices: generationPoints,
      parse: parseGeneratorMetadata,
      isPending: (metadata) => isPendingAttempt(metadata.usage) || metadata.retryUsages.some(isPendingAttempt),
      isRunning,
    });
    if (!genRead) return null;
    if (!stepRead) {
      for (const idx of genRead.touched) {
        for (const stepIdx of genRead.cache.rows.get(idx)?.stepIndices ?? []) stepPoints.add(stepIdx);
      }
      stepRead = await readSteps();
      if (!stepRead) return null;
    }
    db.exec('COMMIT');

    const stepRows = orderedMetadataRows(stepRead.cache);
    const genRows = orderedMetadataRows(genRead.cache);

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

    const appendUsage = (
      usage: AntigravityModelUsage | undefined,
      opts: {
        model?: string;
        modelId?: number;
        provider?: number;
        timestampMs?: number;
        timestampRank?: number;
        sourceKey: string;
        isRetry?: boolean;
        genIdx?: number;
        stepIndices: number[];
        ttftNs?: number;
        streamDurationNs?: number;
      },
    ): void => {
      if (!usage || !isTokenBearing(usage) || !hasReasonableTokens(usage)) return;

      const identities = usageIdentityKeys(usage);
      const timestampMs = opts.timestampMs ?? trajectoryTimestampMs ?? fallbackTimestampMs;
      const timestampRank = opts.timestampRank ?? (trajectoryTimestampMs === undefined ? 0 : 1);

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

      rawEvents.push({
        key: opts.sourceKey,
        sourceKeys: [opts.sourceKey],
        isRetry: opts.isRetry ?? false,
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
          timestampRank: metadata.timestampMs === undefined ? undefined : 3,
          sourceKey: `step:${sessionId}:${idx}`,
          stepIndices: [idx],
        });
      }
      for (let r = 0; r < metadata.retryUsages.length; r++) {
        appendUsage(metadata.retryUsages[r], {
          model: rowModel,
          modelId: metadata.modelId,
          provider: metadata.provider,
          timestampMs: metadata.timestampMs,
          timestampRank: metadata.timestampMs === undefined ? undefined : 3,
          sourceKey: `step-retry:${sessionId}:${idx}:${r}`,
          isRetry: true,
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
      const tsRank = metadata.timestampMs !== undefined ? 4 : linkedStepTs !== undefined ? 2 : undefined;

      if (metadata.usage) {
        appendUsage(metadata.usage, {
          model: currentModel,
          modelId: metadata.modelId,
          timestampMs: ts,
          timestampRank: tsRank,
          sourceKey: `gen:${sessionId}:${idx}`,
          genIdx: idx,
          stepIndices: metadata.stepIndices,
          ttftNs: metadata.ttftNs,
          streamDurationNs: metadata.streamDurationNs,
        });
      }
      for (let r = 0; r < metadata.retryUsages.length; r++) {
        appendUsage(metadata.retryUsages[r], {
          model: currentModel,
          modelId: metadata.modelId,
          timestampMs: ts,
          timestampRank: tsRank,
          sourceKey: `gen-retry:${sessionId}:${idx}:${r}`,
          isRetry: true,
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

    if (incremental) {
      incremental.cache.state = {
        fileIdentity,
        schemaVersion,
        workspace,
        steps: stepRead.cache,
        generations: genRead.cache,
      };
    }
    return {
      sessionId,
      dbPath,
      workspacePath,
      ...(workspacePaths.length > 0 ? { workspacePaths } : {}),
      trajectoryTimestampMs,
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

import type { CodexSubagentLink } from './codex-subagent-linker.js';
import type { JsonValue } from '../../types/index.js';

export type CodexTerminalStatus = 'completed' | 'interrupted';

export interface CodexTranscriptInputContext {
  /** Chain hash for the complete request context represented by this state. */
  hash: string;
  /** Incremental messages required by the next LLM request. */
  delta?: JsonValue[];
  /** Full context is retained only while it remains below the configured limit. */
  fullMessages?: JsonValue[];
  /** Transcript range used to rebuild an oversized delta without bloating input-state.json. */
  deltaRange?: {
    startOffset: number;
    endOffset: number;
  };
}

export interface CodexActiveTranscriptTurn {
  turnId: string;
  startOffset: number;
  startedAtMs: number;
  /** Start-time proxy for the first LLM wave reconstructed by the next incremental scan. */
  nextStepStartedAtMs?: number;
  /** Session-cumulative token total at the last committed incremental boundary. */
  lastCumulativeTokenTotal?: number;
  /** Turn-scoped context is needed after incremental recovery advances past turn_context. */
  model?: string;
  cwd?: string;
  developerInstructions?: string;
  emittedPrompt?: boolean;
  emittedStepCount?: number;
  emittedStepRequestIds?: string[];
  emittedStepResponseIds?: string[];
  emittedToolCallIds?: string[];
  emittedToolResultIds?: string[];
  inputContext?: CodexTranscriptInputContext;
  /** Incoming work is bound by evidence, independently of creation lineage. */
  delegation?: CodexSubagentLink;
  /** New unbound work invalidated the old incoming context for this turn. */
  delegationUnbound?: boolean;
  /** Fixed at first emission; late links must not re-export an existing trace. */
  emittedTraceId?: string;
  emittedAuditEventIds?: string[];
  /** Legacy fusion checkpoint only: previously observed direct spawn calls. */
  subagentSpawns?: CodexPendingFusionChild[];
}

/** Legacy fusion descriptor retained only for checkpoint migration. */
export interface CodexPendingFusionChild {
  parentToolCallId: string;
  parentTraceId: string;
  spawnedAtMs: number;
  taskName?: string;
  agentPath?: string;
  childThreadId?: string;
}

/** Legacy parent terminal barrier retained only for checkpoint migration. */
export interface CodexPendingFusionTurn {
  turnId: string;
  parentThreadId: string;
  parentTraceId: string;
  terminalEndOffset: number;
  children: CodexPendingFusionChild[];
}

/**
 * Legacy captured child turn consumed but not independently emitted.
 * New collection never creates this state; it is retained for migration only.
 * The active-turn snapshot lets fusion reconstruct it after the child scan
 * offset advances or the collector restarts.
 */
export interface CodexPendingSubagentTurn {
  turnId: string;
  parentThreadId: string;
  parentTurnId: string;
  parentTraceId: string;
  parentToolCallId: string;
  confidence: 'explicit_id' | 'agent_path';
  terminalEndOffset: number;
  activeTurn: CodexActiveTranscriptTurn;
}

/**
 * A terminal record that was fully persisted but could not yet be converted.
 * Keep the exact range so the next collection cycle can retry without
 * depending on the transcript offset being revisited.
 */
export interface CodexPendingTerminalTurn {
  turnId: string;
  terminalEndOffset: number;
  retryCount?: number;
  firstPendingAtMs?: number;
  lastAttemptAtMs?: number;
  sourceRecordCount?: number;
  nextRetryAtMs?: number;
  backoffCount?: number;
  failureKey?: string;
  sourceRef?: CodexTranscriptSourceRef;
}

interface CodexForkBootstrapBase {
  /** Hook-provided first turn owned by this rollout. */
  initialTurnId?: string;
  /** Terminal Hook evidence for an owned turn; it may not be the first one. */
  recoveryTurnId?: string;
  /** How far the append-only rollout has been searched for an owned turn. */
  searchOffset: number;
  /** 独立完整行探测证据；未提交的半行正文只保留在内存中。 */
  readProbe?: CodexJsonlProbeState;
}

/** First-owned-turn bootstrap for a fork/subagent rollout. */
export type CodexForkBootstrap = CodexForkBootstrapBase & (
  /** A file discovered while Pilot is running; retain until owned bytes advance. */
  | { state: 'live-pending' }
  /** A startup no-replay file whose first owned turn has not been located yet. */
  | { state: 'baseline-search' }
  /** A bounded no-output rebuild below the startup baseline. */
  | {
      state: 'baseline-tail';
      /** Last unfinished owned candidate reconstructed below the baseline scanOffset. */
      tailCandidate?: CodexActiveTranscriptTurn;
    }
);

export interface CodexOwnerMetaProbe {
  inode: number;
  sourceGeneration: number;
  targetSize: number;
  nextCompleteOffset: number;
  candidateOwnerOffset: number | null;
  sawSessionMeta: boolean;
  headerClosed: boolean;
}

export type CodexOwnerResolution =
  | { kind: 'searching'; probe: CodexOwnerMetaProbe }
  | { kind: 'resolved'; ownerOffset: number; verifiedThroughOffset: number }
  | { kind: 'absent-at-watermark'; verifiedThroughOffset: number };

export interface CodexOwnerProbeState {
  kind: 'searching' | 'resolved' | 'absent-at-watermark';
  probe: CodexOwnerMetaProbe;
  snapshot: CodexTranscriptSourceSnapshot;
  anchors: CodexTranscriptContentAnchor[];
  ownerRef?: CodexTranscriptSourceRef;
  conflict?: {
    reason: 'identity' | 'truncated' | 'fingerprint' | 'short-read';
    retryCount: number;
    nextRetryAtMs: number;
  };
}

export interface CodexJsonlProbeState {
  sourceGeneration: number;
  snapshot: CodexTranscriptSourceSnapshot;
  targetSize: number;
  nextCompleteOffset: number;
  incompleteTail: boolean;
  anchors: CodexTranscriptContentAnchor[];
  conflict?: CodexOwnerProbeState['conflict'];
}

export interface CodexRecordReadState extends CodexTranscriptSourceRange {
  reason: 'recovery' | 'hydrate';
  probe: CodexJsonlProbeState;
  expectedRef?: CodexTranscriptSourceRef;
}

export interface CodexDeferredTranscriptScan {
  endOffset: number;
  terminalTurnId: string | null;
  activeTurn: CodexActiveTranscriptTurn | null;
  ownerSessionMetaOffset: number | null;
  records: number;
  parseSuccessRecords: number;
  parseFailedRecords: number;
  maxRecordBytes: number;
}

export interface CodexBaselineReadState {
  mode: 'normal' | 'fork';
  probe: CodexJsonlProbeState;
  activeTurn: CodexActiveTranscriptTurn | null;
  ownerSessionMetaOffset: number | null;
}

export interface CodexTranscriptCheckpoint {
  inode: number;
  baselineRead?: CodexBaselineReadState;
  ownerProbe?: CodexOwnerProbeState;
  startupBaselineTarget?: { inode: number; size: number };
  /** 独立读取事务不携带正文，也不代表业务消费。 */
  recordReads?: CodexRecordReadState[];
  deferredScan?: CodexDeferredTranscriptScan;
  /** 普通扫描的固定观察前沿；半行及校验证据不提升业务消费水位。 */
  scanProbe?: CodexJsonlProbeState;
  /** No-replay floor and next byte for normal event collection. Never rewound by fork probing. */
  scanOffset: number;
  activeTurn: CodexActiveTranscriptTurn | null;
  pendingTerminal: CodexPendingTerminalTurn | null;
  /** Legacy terminal barriers; new collection writes null. */
  pendingFusion: CodexPendingFusionTurn | null;
  pendingSubagent: CodexPendingSubagentTurn | null;
  /**
   * Offset of the session_meta that describes this rollout file itself.
   *
   * Forked Codex rollouts can contain multiple session_meta records: the
   * child's own meta followed by copied parent history. Keeping the latest
   * meta therefore misattributes child turns to the parent session.
   */
  ownerSessionMetaOffset: number | null;
  firstOwnedTurnId?: string;
  /** Independent ownership probe; searchOffset never acts as the normal collection cursor. */
  forkBootstrap?: CodexForkBootstrap;
}

export interface CodexTranscriptMeta {
  /** The Codex thread/rollout described by this session_meta record. */
  threadId: string;
  /** Root user session shared by a subagent tree when Codex supplies it. */
  rootSessionId: string;
  threadSource: 'user' | 'subagent' | 'unknown';
  parentThreadId?: string;
  /** Top-level session_meta.forked_from_id — fork/resume lineage marker. */
  forkedFromId?: string;
  depth: number;
  createdAtMs?: number;
  agentPath?: string;
  agentNickname?: string;
  agentRole?: string;
  provider: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
}

export interface CodexTranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
}

export interface CodexTranscriptTool {
  callId: string;
  name: string;
  input?: JsonValue;
  startedAtMs: number;
  output?: JsonValue;
  completedAtMs?: number;
}

export interface CodexTranscriptStep {
  startedAtMs: number;
  responseAtMs: number;
  hasResponseEvidence: boolean;
  completedAtMs: number;
  responseId?: string;
  inputMessages?: JsonValue[];
  reasoning: string[];
  tools: CodexTranscriptTool[];
  tokenUsage?: CodexTranscriptUsage;
  finalText?: string;
}

export interface CodexTranscriptSourceRecord {
  startOffset: number;
  endOffset: number;
  sha256?: string;
  record: Record<string, unknown>;
}

export interface CodexTranscriptSourceRange {
  startOffset: number;
  endOffset: number;
}

/** Stat fields choose the validation path; they never prove prefix immutability. */
export interface CodexTranscriptSourceSnapshot {
  inode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/** SHA-256 of the exact raw byte range, including any JSONL newline bytes. */
export interface CodexTranscriptContentAnchor extends CodexTranscriptSourceRange {
  sha256: string;
}

export interface CodexTranscriptSourceRef extends CodexTranscriptContentAnchor {
  inode: number;
  sourceGeneration: number;
}

/**
 * Partial extraction keeps semantic LLM-wave boundaries and byte-consumption
 * boundaries together so the input cannot advance by a different unit than it
 * emits.
 */
export interface CodexPartialTurnExtraction {
  turn: CodexExtractedTranscriptTurn;
  committedStepCount: number;
  committedStepRanges: CodexTranscriptSourceRange[];
  consumedEndOffset: number;
  /** Continuation state aligned with consumedEndOffset, never with an uncommitted suffix. */
  nextStepStartedAtMs?: number;
  lastCumulativeTokenTotal?: number;
}

export interface CodexExtractedTranscriptTurn {
  sessionId: string;
  transcriptTurnId: string;
  provider: string;
  model: string;
  status: CodexTerminalStatus;
  startedAtMs: number;
  terminalAtMs: number;
  prompt?: string;
  /**
   * True once the transcript proves that the submitted prompt is complete.
   * A user response_item alone may only be Codex control context while the
   * UserPromptSubmit wakeup races the persisted user message.
   */
  promptReady: boolean;
  inputMessages: JsonValue[];
  cwd?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
  steps: CodexTranscriptStep[];
  /** Token samples that could not be tied to a completed response wave. */
  unmatchedTokenUsages: CodexTranscriptUsage[];
}

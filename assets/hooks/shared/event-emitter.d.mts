// Type declarations for event-emitter.mjs — consumed by src TypeScript
// (ZCodeRolloutInput) so the cross-source span_id derivation contract is
// type-checked instead of imported with @ts-expect-error (review P3).
//
// The .mjs and this .d.mts must stay in sync manually: the shared
// deriveSpanId/toW3CTraceId formulas are the cross-process stitching
// contract between the hook-processor and the rollout input.

/** Chain-hash initial value: SHA-256('') truncated to 32 chars. */
export const INITIAL_HASH: string;

/** Single chain-hash step: sha256(prevHash + stableSerialize(msg))[0:32]. */
export function hashStep(prevHash: string, msg: unknown): string;

/** Accumulate hashStep over a delta-messages array. */
export function computeHash(prevHash: string, deltaMessages: unknown[] | null | undefined): string;

/** True when re-hashing the delta produces a different full-message hash. */
export function shouldLogFullMessages(
  prevHash: string,
  delta: unknown[],
  currentFullHash: string,
): boolean;

/** Random W3C trace id — 32 lowercase hex chars. */
export function generateTraceId(): string;

/** Random W3C span id — 16 lowercase hex chars. */
export function generateSpanId(): string;

/** JSONL output path: <logDir>/<agentId>-YYYY-MM-DD.jsonl. */
export function getJsonlFilePath(logDir: string, agentId: string): string;

/** Append records as JSONL lines to today's file (creates dirs as needed). */
export function writeJsonlRecords(
  logDir: string,
  agentId: string,
  records: Record<string, unknown>[],
): void;

/**
 * Convert a UUID (or 32+ hex-with-dashes string) into a W3C-compatible
 * 32-char lowercase hex trace id. Non-hex inputs pass through lowercased.
 * Returns '' for empty/invalid input.
 */
export function toW3CTraceId(value: string | undefined | null): string;

/**
 * Deterministically derive a 16-hex span id from a namespace + key
 * material. Shared by the zcode hook-processor (AGENT envelope span_id)
 * and ZCodeRolloutInput (STEP parent_span_id) — identical inputs MUST
 * produce identical span ids across processes.
 */
export function deriveSpanId(namespace: string, ...keys: (string | number | null | undefined)[]): string;

import crypto from 'node:crypto';
import { compressionFields, compressionIdentity } from '../../plugins/shared/context-compression.mjs';

/** A native compact_boundary is a confirmed rewrite. Progress alone does not
 * establish completion. The caller supplies its normal source ownership. */
export function qoderCompressionRecord(row, common) {
  if (row?.type !== 'system' || row.subtype !== 'compact_boundary') return null;
  const completedAt = Date.parse(row.timestamp);
  if (!Number.isFinite(completedAt)) return null;
  const metadata = row.compactMetadata ?? {};
  const sourceId = row.uuid || row.id || `${row.timestamp}:${JSON.stringify(metadata)}`;
  const identity = compressionIdentity(common['gen_ai.session.id'], sourceId);
  const id = identity['event.id'];
  return { ...common, ...identity, time_unix_nano: String(BigInt(completedAt) * 1_000_000n),
    ...compressionFields({ id, status: 'success', durationMs: metadata.durationMs,
      tokensBefore: metadata.preTokens, tokensAfter: metadata.postTokens,
      windowSize: metadata.contextWindow, countingMethod: 'qoder_native',
      countingScope: 'active_context', comparable: true, trigger: metadata.trigger }),
    ...(!common['gen_ai.turn.id'] ? { 'gen_ai.turn.id': `compression:${id}`,
      trace_id: crypto.createHash('sha256').update(id).digest('hex').slice(0, 32),
      'gen_ai.context.compress.standalone': true } : {}),
  };
}

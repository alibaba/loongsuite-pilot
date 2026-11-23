import crypto from 'node:crypto';

/** Source adapters supply counts and their counting scope. No content or model
 * usage is copied into a compression operation. All durations are seconds. */
export function compressionFields({ id, phase = 'end', status, startedAt, endedAt,
  durationMs, tokensBefore, tokensAfter, windowSize, countingMethod, countingScope,
  comparable = false, trigger, messagesBefore, messagesAfter }) {
  const fields = {
    'event.name': phase === 'start' ? 'gen_ai.context.compress.start' : 'gen_ai.context.compress',
    'gen_ai.context.compress.id': id,
  };
  if (status) fields['gen_ai.context.compress.status'] = status;
  if (trigger) fields['gen_ai.context.compress.trigger'] = trigger;
  if (countingMethod) fields['gen_ai.context.counting.method'] = countingMethod;
  if (countingScope) fields['gen_ai.context.counting.scope'] = countingScope;
  for (const [key, value] of [
    ['tokens_before', tokensBefore], ['tokens_after', tokensAfter], ['window_size', windowSize],
    ['messages_before', messagesBefore], ['messages_after', messagesAfter],
  ]) {
    if (Number.isFinite(value) && value >= 0) fields[`gen_ai.context.${key}`] = value;
  }
  if (comparable && tokensBefore > 0 && Number.isFinite(tokensAfter) && tokensAfter >= 0) {
    fields['gen_ai.context.compression_ratio'] = tokensAfter / tokensBefore;
  }
  if (Number.isFinite(startedAt)) fields['gen_ai.context.compress.start_time_unix_nano'] = String(BigInt(Math.trunc(startedAt)) * 1_000_000n);
  const elapsed = Number.isFinite(durationMs) ? durationMs : endedAt - startedAt;
  if (phase !== 'start' && Number.isFinite(elapsed) && elapsed >= 0) {
    fields['gen_ai.context.compress.duration'] = elapsed / 1000;
  }
  return fields;
}

export function compressionIdentity(sessionId, sourceId) {
  const digest = crypto.createHash('sha256').update(`${sessionId}:compression:${sourceId}`).digest('hex');
  return { 'event.id': digest, span_id: digest.slice(0, 16) };
}

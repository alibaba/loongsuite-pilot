// Segment records carry Anthropic's native stop_reason, but
// gen_ai.response.finish_reasons is the normalized OTel GenAI enum — the same
// one the transcript hook emits, so both collection paths must agree, including
// on which values are dropped. The raw value stays reachable through
// attributes.stop_reason, which entry-builder prefixes to agent.stop_reason.
// Duplicated rather than imported from scripts/validate-trace.mjs: that is a dev
// validator, not a runtime dependency of the collector. A unit test asserts the
// two sets stay equal, so the copy cannot drift the way `cancelled` did.
//
// Lives here rather than next to one collection path because every producer that
// stamps finish_reasons has to agree on the enum: the transcript hook, the
// segment token enricher on the qoder-trace path, and any future input. A
// per-input copy is how token-enricher ended up writing the raw stop_reason
// straight through while the neighbouring path normalized it.
export const VALID_FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_call',
  'tool_calls',
  'error',
  'end_turn',
  'max_tokens',
  // Terminal in otlp-trace-flusher's TERMINAL_FINISH_REASONS and already emitted
  // by the Codex and WorkBuddy paths, so it belongs in the enum.
  'cancelled',
]);

const FINISH_REASON_ALIASES: Record<string, string> = {
  tool_use: 'tool_call',
  stop_sequence: 'stop',
  refusal: 'stop',
  model_context_window_exceeded: 'length',
};

export function normalizeFinishReason(reason: string): string | undefined {
  const mapped = FINISH_REASON_ALIASES[reason] ?? reason;
  // Unknown values are dropped, never coerced to `stop`: a mid-turn value such
  // as pause_turn would then read as terminal and Signal A would flush the turn
  // buffer early, trading a validator error for a fragmented trace.
  return VALID_FINISH_REASONS.has(mapped) ? mapped : undefined;
}

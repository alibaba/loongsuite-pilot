import { describe, expect, it } from 'vitest';
import { normalizeFinishReason, VALID_FINISH_REASONS as HOOK_FINISH_REASONS } from '../../../assets/hooks/qoder-hook-processor.mjs';
import { VALID_FINISH_REASONS } from '../../../scripts/validate-trace.mjs';

// gen_ai.response.finish_reasons must stay inside the OTel GenAI enum that
// validate-trace.mjs enforces, while the transcript carries Anthropic's wider
// native stop_reason set. These cases exercise normalizeFinishReason directly
// because the record path forces `end_turn` on a turn's last boundary, so a
// transcript fixture cannot reach the drop branch there.
describe('qoder hook normalizeFinishReason', () => {
  it('maps vendor spellings onto the enum', () => {
    expect(normalizeFinishReason('tool_use')).toBe('tool_call');
    expect(normalizeFinishReason('stop_sequence')).toBe('stop');
    expect(normalizeFinishReason('refusal')).toBe('stop');
    expect(normalizeFinishReason('model_context_window_exceeded')).toBe('length');
  });

  it('passes through values that are already canonical', () => {
    for (const reason of ['stop', 'end_turn', 'max_tokens', 'tool_call', 'cancelled', 'error']) {
      expect(normalizeFinishReason(reason)).toBe(reason);
    }
  });

  it('drops unknown values instead of coercing them to stop', () => {
    // `stop` is terminal in otlp-trace-flusher's TERMINAL_FINISH_REASONS, so
    // coercing a mid-turn value would make Signal A flush the turn buffer early.
    // Absent finish_reasons is only a validator warning; a wrong one is an error.
    expect(normalizeFinishReason('pause_turn')).toBeUndefined();
    expect(normalizeFinishReason('some_future_reason')).toBeUndefined();
    expect(normalizeFinishReason('')).toBeUndefined();
  });

  it('never returns a value the trace validator rejects', () => {
    // Asserted against the validator's own exported set rather than a copy:
    // hand-copied allowlists are how `cancelled` drifted out of sync.
    const vendorValues = [
      'tool_use', 'stop_sequence', 'refusal', 'model_context_window_exceeded',
      'pause_turn', 'end_turn', 'max_tokens', 'stop', 'cancelled', 'error',
      'unexpected',
    ];
    for (const reason of vendorValues) {
      const normalized = normalizeFinishReason(reason);
      if (normalized !== undefined) expect(VALID_FINISH_REASONS).toContain(normalized);
    }
  });

  it('keeps its allowlist equal to the trace validator\'s', () => {
    // The hook is deployed standalone into ~/.loongsuite-pilot/hooks and cannot
    // import the validator, so the set is duplicated. Pinning it here is what
    // catches the next `cancelled`-style divergence between producer and gate.
    expect([...HOOK_FINISH_REASONS].sort()).toEqual([...VALID_FINISH_REASONS].sort());
  });
});

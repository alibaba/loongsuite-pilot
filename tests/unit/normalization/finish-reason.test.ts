import { describe, expect, it } from 'vitest';
import { VALID_FINISH_REASONS, normalizeFinishReason } from '../../../src/normalization/finish-reason.js';
import { VALID_FINISH_REASONS as VALIDATOR_FINISH_REASONS } from '../../../scripts/validate-trace.mjs';

describe('normalizeFinishReason', () => {
  it('keeps its finish-reason allowlist equal to the trace validator\'s', () => {
    // The collector must not depend on scripts/validate-trace.mjs at runtime, so
    // the set is duplicated. This asserts the duplicate cannot drift: an allowlist
    // narrower than the validator's silently drops valid finish reasons, and a
    // wider one emits values the validator rejects.
    expect([...VALID_FINISH_REASONS].sort()).toEqual([...VALIDATOR_FINISH_REASONS].sort());
  });

  it('maps vendor spellings onto the OTel GenAI enum', () => {
    expect(normalizeFinishReason('tool_use')).toBe('tool_call');
    expect(normalizeFinishReason('stop_sequence')).toBe('stop');
    expect(normalizeFinishReason('refusal')).toBe('stop');
    expect(normalizeFinishReason('model_context_window_exceeded')).toBe('length');
  });

  it('passes through values already in the enum', () => {
    for (const reason of VALID_FINISH_REASONS) {
      expect(normalizeFinishReason(reason as string)).toBe(reason);
    }
  });

  it('drops unknown values instead of coercing them to a terminal reason', () => {
    // pause_turn is mid-turn. Coercing it to `stop` would read as terminal and
    // flush the turn buffer early, trading a validator error for a split trace.
    expect(normalizeFinishReason('pause_turn')).toBeUndefined();
    expect(normalizeFinishReason('some_future_reason')).toBeUndefined();
    expect(normalizeFinishReason('')).toBeUndefined();
  });
});

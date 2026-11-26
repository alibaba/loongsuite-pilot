import { describe, expect, it } from 'vitest';
import { compressionFields } from '../../../assets/plugins/shared/context-compression.mjs';
import { qoderCompressionRecord } from '../../../assets/hooks/qoder/context-compression.mjs';
import { parseTokenInfo as parseQoderTokens } from '../../../src/inputs/qoder-trace/sqlite-token-reader.ts';

describe('source compression metadata', () => {
  it('retains the matched Qoder row context window and omits unavailable windows', () => {
    expect(parseQoderTokens(JSON.stringify({ prompt_tokens: 100, completion_tokens: 20, max_input_tokens: 2000 })))
      .toMatchObject({ promptTokens: 100, contextWindow: 2000 });
    expect(parseQoderTokens(JSON.stringify({ prompt_tokens: 100, max_input_tokens: 0 })))
      .not.toHaveProperty('contextWindow');
    expect(parseQoderTokens(JSON.stringify({ prompt_tokens: 100 })))
      .not.toHaveProperty('contextWindow');
  });

  it.each(['qoder-cli', 'qoder-cn'])('preserves %s completion and deterministic identity across replay', agent => {
    const row = { type: 'system', subtype: 'compact_boundary', uuid: 'native-id',
      timestamp: '2026-11-23T02:00:00.000Z', compactMetadata: { preTokens: 160000, postTokens: 40000, durationMs: 1234 } };
    const common = { 'gen_ai.session.id': 's1', 'gen_ai.agent.type': agent };
    const record = qoderCompressionRecord(row, common);
    expect(record).toEqual(qoderCompressionRecord(row, common));
    expect(record).toMatchObject({ 'event.name': 'gen_ai.context.compress',
      'gen_ai.context.compression_ratio': 0.25, 'gen_ai.context.compress.duration': 1.234,
      'gen_ai.context.compress.standalone': true });
    expect(qoderCompressionRecord({ ...row, compactMetadata: {} }, common)['event.name']).toBe('gen_ai.context.compress');
    expect(qoderCompressionRecord({ type: 'progress', data: { type: 'compression.progress' } }, common)).toBeNull();
  });
  it('omits unavailable counts and ratios for incompatible scopes', () => {
    expect(compressionFields({ id: 'x', tokensBefore: 100, tokensAfter: 50 })).not.toHaveProperty('gen_ai.context.compression_ratio');
    expect(compressionFields({ id: 'x', tokensBefore: 0, tokensAfter: 0, comparable: true })).not.toHaveProperty('gen_ai.context.compression_ratio');
    expect(compressionFields({ id: 'x', messagesBefore: -1 })).not.toHaveProperty('gen_ai.context.messages_before');
  });
});

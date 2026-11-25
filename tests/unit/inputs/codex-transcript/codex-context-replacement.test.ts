import { describe, expect, it } from 'vitest';
import { codexContextReplacement } from '../../../../src/inputs/codex-transcript/codex-context-replacement.js';
import { transcriptInputMessage } from '../../../../src/inputs/codex-transcript/codex-transcript-extractor.js';
import { buildCodexTranscriptSegment, continueCodexInputContext, nextInputMessagesForStep } from '../../../../src/inputs/codex-transcript/codex-transcript-builder.js';
import { maskAgentActivityEntry } from '../../../../src/mask/entry-masker.js';
import { buildAgentActivityEntry } from '../../../../src/normalization/entry-builder.js';

describe('installed Codex context snapshots', () => {
  it('preserves replacement order and labels the source-backed plaintext checkpoint', () => {
    const result = codexContextReplacement({ window_id: 'v2', previous_window_id: 'v1',
      compaction_response_id: 'summary-response', replacement_history: [
        { type: 'message', id: 'user', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Facts from old tools' }] },
      ], replacement_history_metadata: [
        { retained_source: { id: { message_id: 'original-user' } }, sampled_through_sequence: 0 },
        { compaction_without_file_error_sources: true, sampled_through_sequence: 15 },
      ] }, 'fallback', transcriptInputMessage);
    expect(result).toEqual({ version: 'v2', previousVersion: 'v1', contentAvailability: 'plaintext',
      retainedMessageIds: ['original-user'], sampledThroughSequence: 15, messages: [
        { id: 'user', role: 'user', parts: [{ type: 'text', content: 'continue' }] },
        { role: 'user', parts: [{ type: 'compaction', id: 'summary-response', content: 'Facts from old tools' }] },
      ] });
  });

  it('preserves encrypted block identity while omitting provider bytes', () => {
    const result = codexContextReplacement({ window_id: 'v1', replacement_history: [
      { type: 'compaction', id: 'block', encrypted_content: 'secret-ciphertext' },
    ] }, 'fallback', transcriptInputMessage);
    expect(result.contentAvailability).toBe('opaque');
    expect(result.messages).toEqual([{ role: 'user', parts: [{ type: 'compaction', id: 'block' }] }]);
    expect(JSON.stringify(result)).not.toContain('secret-ciphertext');
  });

  it('marks unsupported native items as partial and bounds oversized snapshots', () => {
    const result = codexContextReplacement({ replacement_history: [
      { type: 'compaction', id: 'block' }, { type: 'reasoning', encrypted_content: 'secret' },
    ] }, 'fallback', transcriptInputMessage);
    expect(result.contentAvailability).toBe('partial');
    const oversized = codexContextReplacement({ replacement_history: [
      { type: 'message', role: 'user', content: 'x'.repeat(1024 * 1024) },
    ] }, 'fallback', transcriptInputMessage);
    expect(oversized.messages).toBeUndefined();
    expect(oversized.contentAvailability).toBe('unavailable');
  });

  it('marks malformed additional tools as partial without changing the replacement order', () => {
    const result = codexContextReplacement({ replacement_history: [
      { type: 'additional_tools', role: 'developer', tools: ['not a tool definition'] },
      { type: 'additional_tools', role: 'developer', tools: [] },
      { type: 'compaction', id: 'block' },
    ] }, 'fallback', transcriptInputMessage);
    expect(result.contentAvailability).toBe('partial');
    expect(result.messages).toEqual([
      { role: 'developer', parts: [{ type: 'openai.additional_tools', tools: [] }] },
      { role: 'user', parts: [{ type: 'compaction', id: 'block' }] },
    ]);
  });

  it('carries installed context across turns and appends new input once', () => {
    const turn = { sessionId: 'session', transcriptTurnId: 'next', provider: 'openai', model: 'model',
      status: 'completed' as const, startedAtMs: 1000, terminalAtMs: 2000, promptReady: true,
      inputMessages: [{ role: 'user', parts: [{ type: 'text', content: 'next question' }] }],
      unmatchedTokenUsages: [], steps: [{ startedAtMs: 1000, completedAtMs: 2000,
        responseAtMs: 2000, hasResponseEvidence: true, reasoning: [], tools: [], finalText: 'answer',
        additionalInputMessages: [{ role: 'user', parts: [{ type: 'text', content: 'steering message' }] }] }] };
    const snapshot = [{ role: 'user', parts: [{ type: 'compaction', id: 'summary', content: 'old facts' }] }];
    const context = continueCodexInputContext({ hash: 'hash', version: 'v1', compacted: true,
      fullMessages: snapshot, sourceSpanIds: ['old-trace-span'] }, turn);
    const request = buildCodexTranscriptSegment(turn, { inputContext: context }).entries.find(entry => entry['event.name'] === 'llm.request')!;
    expect(request['gen_ai.context.version']).toBe('v1');
    expect(request['gen_ai.input.messages']).toEqual([...snapshot, ...turn.inputMessages, ...turn.steps[0].additionalInputMessages]);
    expect(request['gen_ai.input.messages_delta']).toEqual([...turn.inputMessages, ...turn.steps[0].additionalInputMessages]);
    expect(context.sourceSpanIds).toEqual([]);
  });

  it('applies existing message masking to compaction parts and nested tool schemas', () => {
    const entry = buildAgentActivityEntry({ 'event.name': 'llm.request', 'gen_ai.input.messages': [
      { role: 'developer', parts: [{ type: 'openai.additional_tools', tools: [
        { type: 'function', name: 'example', parameters: { properties: { value: { default: 'AKIAIOSFODNN7EXAMPLE' } } } },
      ] }] },
      { role: 'user', parts: [{ type: 'compaction', id: 'block', content: 'AKIAIOSFODNN7EXAMPLE' }] },
    ] });
    const masked = maskAgentActivityEntry(entry, { mode: 'all', types: [] });
    expect(JSON.stringify(masked['gen_ai.input.messages'])).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.stringify(masked['gen_ai.input.messages'])).toContain('block');
    expect(JSON.stringify(masked['gen_ai.input.messages'])).toContain('openai.additional_tools');
  });

  it('preserves native tool arguments when appending to installed context', () => {
    const step = { startedAtMs: 0, completedAtMs: 2, responseAtMs: 1, hasResponseEvidence: true,
      reasoning: [], tools: [{ name: 'exec_command', callId: 'call', startedAtMs: 1, completedAtMs: 2,
        input: { command: 'cat file' }, nativeInput: { cmd: 'cat file', max_output_tokens: 12345 }, output: 'result' }] };
    expect(nextInputMessagesForStep(step, true)[0]).toEqual({ role: 'assistant', parts: [
      { type: 'tool_call', id: 'call', name: 'exec_command', arguments: { cmd: 'cat file', max_output_tokens: 12345 } },
    ] });
  });
});

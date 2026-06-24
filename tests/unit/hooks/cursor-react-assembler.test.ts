import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleTurn } from '../../../assets/hooks/cursor/react-assembler.mjs';

function iso(ms: number): string {
  return new Date(Date.UTC(2026, 5, 8, 10, 0, 0, ms)).toISOString();
}

function ns(ms: number): string {
  return `${Date.UTC(2026, 5, 8, 10, 0, 0, ms)}000000`;
}

describe('Cursor react assembler', () => {
  it('derives LLM and tool span timing from hook captured time and duration', () => {
    const { records } = assembleTurn([
      {
        _journal_ts: iso(0),
        hook_event: 'beforeSubmitPrompt',
        conversation_id: 'conv-1',
        generation_id: 'turn-1',
        model: 'gpt-5.4',
        prompt: 'inspect the workspace',
      },
      {
        _journal_ts: iso(500),
        hook_event: 'afterAgentThought',
        conversation_id: 'conv-1',
        generation_id: 'turn-1',
        model: 'gpt-5.4',
        text: 'I need to inspect a couple of files.',
        duration_ms: 300,
      },
      {
        _journal_ts: iso(600),
        hook_event: 'preToolUse',
        conversation_id: 'conv-1',
        generation_id: 'turn-1',
        tool_name: 'Read',
        tool_use_id: 'call-read',
        tool_input: { path: 'a.ts' },
      },
      {
        _journal_ts: iso(700),
        hook_event: 'preToolUse',
        conversation_id: 'conv-1',
        generation_id: 'turn-1',
        tool_name: 'Grep',
        tool_use_id: 'call-grep',
        tool_input: { pattern: 'foo' },
      },
      {
        _journal_ts: iso(900),
        hook_event: 'postToolUse',
        conversation_id: 'conv-1',
        generation_id: 'turn-1',
        tool_name: 'Read',
        tool_use_id: 'call-read',
        tool_output: 'read result',
        duration_ms: 250,
      },
      {
        _journal_ts: iso(1000),
        hook_event: 'postToolUse',
        conversation_id: 'conv-1',
        generation_id: 'turn-1',
        tool_name: 'Grep',
        tool_use_id: 'call-grep',
        tool_output: 'grep result',
        duration_ms: 200,
      },
      {
        _journal_ts: iso(1300),
        hook_event: 'afterAgentThought',
        conversation_id: 'conv-1',
        generation_id: 'turn-1',
        model: 'gpt-5.4',
        text: 'Now I have enough context.',
        duration_ms: 150,
      },
      {
        _journal_ts: iso(1500),
        hook_event: 'afterAgentResponse',
        conversation_id: 'conv-1',
        generation_id: 'turn-1',
        model: 'gpt-5.4',
        text: 'done',
        input_tokens: 10,
        output_tokens: 2,
      },
      {
        _journal_ts: iso(1600),
        hook_event: 'stop',
        conversation_id: 'conv-1',
        generation_id: 'turn-1',
        status: 'completed',
      },
    ], { stopConversationId: 'conv-1' });

    const firstStepRequest = records.find(record =>
      record['event.name'] === 'llm.request' &&
      record['gen_ai.step.id'] === 'turn-1:s1'
    );
    const firstStepResponse = records.find(record =>
      record['event.name'] === 'llm.response' &&
      record['gen_ai.step.id'] === 'turn-1:s1'
    );
    const readCall = records.find(record =>
      record['event.name'] === 'tool.call' &&
      record['gen_ai.tool.call.id'] === 'call-read'
    );
    const readResult = records.find(record =>
      record['event.name'] === 'tool.result' &&
      record['gen_ai.tool.call.id'] === 'call-read'
    );
    const grepCall = records.find(record =>
      record['event.name'] === 'tool.call' &&
      record['gen_ai.tool.call.id'] === 'call-grep'
    );
    const grepResult = records.find(record =>
      record['event.name'] === 'tool.result' &&
      record['gen_ai.tool.call.id'] === 'call-grep'
    );

    expect(firstStepRequest).toMatchObject({
      time_unix_nano: ns(200),
      observed_time_unix_nano: ns(200),
      'agent.cursor.llm_request_time_source': 'thought_duration',
    });
    expect(firstStepResponse).toMatchObject({
      time_unix_nano: ns(600),
      observed_time_unix_nano: ns(500),
      'agent.cursor.llm_response_time_source': 'after_agent_thought',
      'agent.cursor.reasoning_observed_at': iso(500),
      'agent.cursor.first_tool_call_observed_at': iso(600),
      'agent.cursor.last_tool_call_observed_at': iso(700),
      'agent.cursor.thought_to_first_tool_ms': 100,
      'agent.cursor.tool_call_emission_ms': 200,
      'agent.cursor.tool_call_count': 2,
    });
    expect(readCall).toMatchObject({
      time_unix_nano: ns(600),
      observed_time_unix_nano: ns(600),
      'gen_ai.tool.call.duration': 250,
    });
    expect(readResult).toMatchObject({
      time_unix_nano: ns(900),
      observed_time_unix_nano: ns(900),
    });
    expect(grepCall).toMatchObject({
      time_unix_nano: ns(700),
      observed_time_unix_nano: ns(700),
      'gen_ai.tool.call.duration': 200,
    });
    expect(grepResult).toMatchObject({
      time_unix_nano: ns(1000),
      observed_time_unix_nano: ns(1000),
    });
  });

  it('guards LLM spans by moving start before the earliest buffered tool call', () => {
    const { records } = assembleTurn([
      {
        _journal_ts: iso(0),
        hook_event: 'beforeSubmitPrompt',
        conversation_id: 'conv-buffered',
        generation_id: 'turn-buffered',
        model: 'gpt-5.4',
        prompt: 'inspect with a delayed thought',
      },
      {
        _journal_ts: iso(100),
        hook_event: 'preToolUse',
        conversation_id: 'conv-buffered',
        generation_id: 'turn-buffered',
        tool_name: 'Read',
        tool_use_id: 'call-buffered-read',
        tool_input: { path: 'a.ts' },
      },
      {
        _journal_ts: iso(200),
        hook_event: 'postToolUse',
        conversation_id: 'conv-buffered',
        generation_id: 'turn-buffered',
        tool_name: 'Read',
        tool_use_id: 'call-buffered-read',
        tool_output: 'read result',
        duration_ms: 50,
      },
      {
        _journal_ts: iso(500),
        hook_event: 'afterAgentThought',
        conversation_id: 'conv-buffered',
        generation_id: 'turn-buffered',
        model: 'gpt-5.4',
        text: 'The tool call was decided before the reasoning text arrived.',
        duration_ms: 100,
      },
      {
        _journal_ts: iso(600),
        hook_event: 'stop',
        conversation_id: 'conv-buffered',
        generation_id: 'turn-buffered',
        status: 'completed',
      },
    ], { stopConversationId: 'conv-buffered' });

    const firstStepRequest = records.find(record =>
      record['event.name'] === 'llm.request' &&
      record['gen_ai.step.id'] === 'turn-buffered:s1'
    );
    const firstStepResponse = records.find(record =>
      record['event.name'] === 'llm.response' &&
      record['gen_ai.step.id'] === 'turn-buffered:s1'
    );

    expect(firstStepRequest).toMatchObject({
      time_unix_nano: ns(99),
      observed_time_unix_nano: ns(99),
      'agent.cursor.llm_request_time_source': 'thought_duration',
      'agent.cursor.llm_request_time_guard': 'earliest_tool_call_start_minus_1ms',
    });
    expect(firstStepResponse).toMatchObject({
      time_unix_nano: ns(500),
      observed_time_unix_nano: ns(500),
    });
  });

  it('marks the final tool step response as stop when the turn ends without another LLM step', () => {
    const { records } = assembleTurn([
      {
        _journal_ts: iso(0),
        hook_event: 'beforeSubmitPrompt',
        conversation_id: 'conv-final-tool',
        generation_id: 'turn-final-tool',
        model: 'gpt-5.4',
        prompt: 'inspect and finish',
      },
      {
        _journal_ts: iso(100),
        hook_event: 'afterAgentThought',
        conversation_id: 'conv-final-tool',
        generation_id: 'turn-final-tool',
        model: 'gpt-5.4',
        text: 'I need one tool call.',
        duration_ms: 80,
      },
      {
        _journal_ts: iso(200),
        hook_event: 'preToolUse',
        conversation_id: 'conv-final-tool',
        generation_id: 'turn-final-tool',
        tool_name: 'Read',
        tool_use_id: 'call-final-read',
        tool_input: { path: 'a.ts' },
      },
      {
        _journal_ts: iso(400),
        hook_event: 'postToolUse',
        conversation_id: 'conv-final-tool',
        generation_id: 'turn-final-tool',
        tool_name: 'Read',
        tool_use_id: 'call-final-read',
        tool_output: 'read result',
        duration_ms: 200,
      },
      {
        _journal_ts: iso(500),
        hook_event: 'stop',
        conversation_id: 'conv-final-tool',
        generation_id: 'turn-final-tool',
        status: 'completed',
      },
    ], { stopConversationId: 'conv-final-tool' });

    const finalResponse = records.find(record =>
      record['event.name'] === 'llm.response' &&
      record['gen_ai.step.id'] === 'turn-final-tool:s1'
    );

    expect(finalResponse?.['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(finalResponse?.['gen_ai.output.messages']?.[0]?.finish_reason).toBe('stop');
  });

  it('prefers synthesized Subagent result over duplicate Cursor postToolUse result', () => {
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-subagent-transcript-'));
    try {
      const parentTranscriptPath = path.join(transcriptDir, 'parent.jsonl');
      const subagentDir = path.join(transcriptDir, 'subagents');
      const childConvId = 'child-conv';
      fs.mkdirSync(subagentDir, { recursive: true });
      fs.writeFileSync(path.join(subagentDir, `${childConvId}.jsonl`), '', 'utf-8');

      const { records } = assembleTurn([
        {
          _journal_ts: iso(0),
          hook_event: 'beforeSubmitPrompt',
          conversation_id: 'parent-conv',
          generation_id: 'turn-subagent',
          model: 'gpt-5.4',
          prompt: 'delegate this',
        },
        {
          _journal_ts: iso(100),
          hook_event: 'afterAgentThought',
          conversation_id: 'parent-conv',
          generation_id: 'turn-subagent',
          model: 'gpt-5.4',
          text: 'I will delegate this to a subagent.',
          duration_ms: 80,
        },
        {
          _journal_ts: iso(200),
          hook_event: 'preToolUse',
          conversation_id: 'parent-conv',
          generation_id: 'turn-subagent',
          tool_name: 'Subagent',
          tool_use_id: 'call-subagent',
          tool_input: { prompt: 'inspect details' },
        },
        {
          _journal_ts: iso(300),
          hook_event: 'afterAgentThought',
          conversation_id: childConvId,
          generation_id: 'child-turn',
          model: 'gpt-5.4',
          text: 'Child is inspecting.',
          duration_ms: 50,
        },
        {
          _journal_ts: iso(500),
          hook_event: 'afterAgentResponse',
          conversation_id: childConvId,
          generation_id: 'child-turn',
          model: 'gpt-5.4',
          text: 'child final result',
        },
        {
          _journal_ts: iso(650),
          hook_event: 'postToolUse',
          conversation_id: 'parent-conv',
          generation_id: 'turn-subagent',
          tool_name: 'Subagent',
          tool_use_id: 'call-subagent',
          tool_output: 'cursor postToolUse result',
          duration_ms: 450,
        },
        {
          _journal_ts: iso(900),
          hook_event: 'afterAgentThought',
          conversation_id: 'parent-conv',
          generation_id: 'turn-subagent',
          model: 'gpt-5.4',
          text: 'Now I can summarize.',
          duration_ms: 120,
        },
        {
          _journal_ts: iso(1000),
          hook_event: 'stop',
          conversation_id: 'parent-conv',
          generation_id: 'turn-subagent',
          transcript_path: parentTranscriptPath,
          status: 'completed',
        },
      ], { stopConversationId: 'parent-conv', transcriptPath: parentTranscriptPath });

      const parentSubagentResults = records.filter(record =>
        record['event.name'] === 'tool.result' &&
        record['gen_ai.tool.call.id'] === 'call-subagent' &&
        record['gen_ai.agent.scope'] !== 'subagent'
      );
      const secondStepRequest = records.find(record =>
        record['event.name'] === 'llm.request' &&
        record['gen_ai.step.id'] === 'turn-subagent:s2'
      );
      const secondStepDelta = secondStepRequest?.['gen_ai.input.messages_delta'] ?? [];
      const secondStepFull = secondStepRequest?.['gen_ai.input.messages'] ?? [];

      expect(parentSubagentResults).toHaveLength(1);
      expect(parentSubagentResults[0]).toMatchObject({
        'agent.cursor.hook_event_name': 'subagent_result_synthesized',
        'gen_ai.tool.call.result': { summary: 'child final result' },
      });
      // Delta on s2 = the tool result that arrived since s1
      expect(secondStepDelta).toHaveLength(1);
      expect(secondStepDelta[0]).toMatchObject({ role: 'tool' });
      expect(secondStepDelta[0]?.parts).toHaveLength(1);
      expect(secondStepDelta[0]?.parts?.[0]).toMatchObject({
        type: 'tool_call_response',
        id: 'call-subagent',
        response: 'child final result',
      });
      // Full = cumulative user prompt + tool result
      expect(secondStepFull).toHaveLength(2);
      expect(secondStepFull[0]).toMatchObject({
        role: 'user',
        parts: [{ type: 'text', content: 'delegate this' }],
      });
      expect(secondStepFull[1]).toMatchObject({ role: 'tool' });
    } finally {
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  it('uses Cursor postToolUse as Subagent result fallback when no child result exists', () => {
    const { records } = assembleTurn([
      {
        _journal_ts: iso(0),
        hook_event: 'beforeSubmitPrompt',
        conversation_id: 'parent-fallback',
        generation_id: 'turn-subagent-fallback',
        model: 'gpt-5.4',
        prompt: 'delegate without child transcript',
      },
      {
        _journal_ts: iso(100),
        hook_event: 'afterAgentThought',
        conversation_id: 'parent-fallback',
        generation_id: 'turn-subagent-fallback',
        model: 'gpt-5.4',
        text: 'I will delegate this.',
        duration_ms: 80,
      },
      {
        _journal_ts: iso(200),
        hook_event: 'preToolUse',
        conversation_id: 'parent-fallback',
        generation_id: 'turn-subagent-fallback',
        tool_name: 'Subagent',
        tool_use_id: 'call-subagent-fallback',
        tool_input: { prompt: 'inspect details' },
      },
      {
        _journal_ts: iso(500),
        hook_event: 'postToolUse',
        conversation_id: 'parent-fallback',
        generation_id: 'turn-subagent-fallback',
        tool_name: 'Subagent',
        tool_use_id: 'call-subagent-fallback',
        tool_output: 'cursor fallback result',
        duration_ms: 300,
      },
      {
        _journal_ts: iso(900),
        hook_event: 'afterAgentThought',
        conversation_id: 'parent-fallback',
        generation_id: 'turn-subagent-fallback',
        model: 'gpt-5.4',
        text: 'Now summarize.',
        duration_ms: 120,
      },
      {
        _journal_ts: iso(1000),
        hook_event: 'stop',
        conversation_id: 'parent-fallback',
        generation_id: 'turn-subagent-fallback',
        status: 'completed',
      },
    ], { stopConversationId: 'parent-fallback' });

    const parentSubagentResults = records.filter(record =>
      record['event.name'] === 'tool.result' &&
      record['gen_ai.tool.call.id'] === 'call-subagent-fallback'
    );
    const secondStepRequest = records.find(record =>
      record['event.name'] === 'llm.request' &&
      record['gen_ai.step.id'] === 'turn-subagent-fallback:s2'
    );
    const secondStepDelta = secondStepRequest?.['gen_ai.input.messages_delta'] ?? [];
    const secondStepFull = secondStepRequest?.['gen_ai.input.messages'] ?? [];

    expect(parentSubagentResults).toHaveLength(1);
    expect(parentSubagentResults[0]).toMatchObject({
      'agent.cursor.hook_event_name': 'postToolUse',
      'gen_ai.tool.call.result': 'cursor fallback result',
    });
    // Delta on s2 = only the new tool result added since s1's llm.request.
    expect(secondStepDelta).toHaveLength(1);
    expect(secondStepDelta[0]).toMatchObject({ role: 'tool' });
    expect(secondStepDelta[0]?.parts).toHaveLength(1);
    expect(secondStepDelta[0]?.parts?.[0]).toMatchObject({
      type: 'tool_call_response',
      id: 'call-subagent-fallback',
      response: 'cursor fallback result',
    });
    // Full = cumulative user prompt + tool result.
    expect(secondStepFull).toHaveLength(2);
    expect(secondStepFull[0]).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', content: 'delegate without child transcript' }],
    });
    expect(secondStepFull[1]).toMatchObject({ role: 'tool' });
  });

  // Skip: requires stopGenerationId generation-level isolation (not in this branch)
  it.skip('isolates assembly to the stopping generation when two generations share a conversation', () => {
    // Scenario: GPT quota exhaustion → Cursor auto-switches mid-prompt and
    // re-emits beforeSubmitPrompt with a new generation_id under the SAME
    // conversation_id. The aborted generation's events must not leak into
    // the live (completed) generation's assembled turn.
    const journalEvents = [
      // Gen A — aborted GPT attempt (no actual model output yet)
      {
        _journal_ts: iso(0),
        hook_event: 'beforeSubmitPrompt',
        conversation_id: 'conv-shared',
        generation_id: 'gen-a',
        model: 'gpt-5.4',
        prompt: 'do the task (gpt)',
      },
      // Gen B — auto-switched composer attempt with the same prompt text
      {
        _journal_ts: iso(50),
        hook_event: 'beforeSubmitPrompt',
        conversation_id: 'conv-shared',
        generation_id: 'gen-b',
        model: 'composer-2.5-fast',
        prompt: 'do the task (composer)',
      },
      // Gen A stop arrives later (aborted) — but here we exercise the
      // assembler's generation-scoped filtering directly.
      {
        _journal_ts: iso(60),
        hook_event: 'stop',
        conversation_id: 'conv-shared',
        generation_id: 'gen-a',
        status: 'aborted',
      },
      // Gen B normal flow
      {
        _journal_ts: iso(200),
        hook_event: 'afterAgentThought',
        conversation_id: 'conv-shared',
        generation_id: 'gen-b',
        model: 'composer-2.5-fast',
        text: 'composer thinking',
        duration_ms: 100,
      },
      {
        _journal_ts: iso(400),
        hook_event: 'preToolUse',
        conversation_id: 'conv-shared',
        generation_id: 'gen-b',
        tool_name: 'Write',
        tool_use_id: 'call-b-write',
        tool_input: { path: 'a.md' },
      },
      {
        _journal_ts: iso(600),
        hook_event: 'postToolUse',
        conversation_id: 'conv-shared',
        generation_id: 'gen-b',
        tool_name: 'Write',
        tool_use_id: 'call-b-write',
        tool_output: 'ok',
        duration_ms: 150,
      },
      {
        _journal_ts: iso(700),
        hook_event: 'afterAgentResponse',
        conversation_id: 'conv-shared',
        generation_id: 'gen-b',
        model: 'composer-2.5-fast',
        text: 'composer done',
        input_tokens: 5,
        output_tokens: 1,
      },
      {
        _journal_ts: iso(800),
        hook_event: 'stop',
        conversation_id: 'conv-shared',
        generation_id: 'gen-b',
        status: 'completed',
      },
    ];

    const { records, consumedConversationIds, consumedGenerationIds } = assembleTurn(journalEvents, {
      stopConversationId: 'conv-shared',
      stopGenerationId: 'gen-b',
    });

    // ENTRY user-prompt record must come from gen-b, not gen-a
    const entryRecord = records.find(r => r['event.name'] === 'other');
    expect(entryRecord?.['gen_ai.input.messages_delta']?.[0]?.parts?.[0]?.content)
      .toBe('do the task (composer)');
    expect(entryRecord?.['gen_ai.turn.id']).toBe('gen-b');

    // No record should reference gen-a as turn id
    for (const r of records) {
      expect(r['gen_ai.turn.id']).toBe('gen-b');
    }

    // gen-b owns a tool.call/tool.result pair; gen-a's events must not appear
    const toolCalls = records.filter(r => r['event.name'] === 'tool.call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.['gen_ai.tool.call.id']).toBe('call-b-write');

    // Cleanup contract: parent conversation must NOT be globally consumed,
    // so gen-a's lingering events stay in the journal until the aborted
    // stop path cleans them by generation_id.
    expect(consumedGenerationIds.has('gen-b')).toBe(true);
    expect(consumedGenerationIds.has('gen-a')).toBe(false);
    expect(consumedConversationIds.has('conv-shared')).toBe(false);
  });

  // Skip: requires stopGenerationId generation-level isolation (not in this branch)
  it.skip('starts s2 LLM request at the last buffered tool result (composer ReAct split)', () => {
    // Scenario: composer-2.5-fast emits no afterAgentThought; tool calls and
    // results stream before any LLM event arrives. When afterAgentResponse
    // finally fires, the assembler splits into:
    //   s1 = tools + implicit response (finish=tool_calls)
    //   s2 = the final LLM answer
    // Bug guarded here: previously lastStepEndTs stayed at promptEventTs
    // because flushPendingTools never advanced it, so s2's LLM request
    // started at time 0 and the s2 span covered the entire turn.
    const { records } = assembleTurn([
      {
        _journal_ts: iso(0),
        hook_event: 'beforeSubmitPrompt',
        conversation_id: 'conv-composer-split',
        generation_id: 'turn-composer-split',
        model: 'composer-2.5-fast',
        prompt: 'do many things',
      },
      {
        _journal_ts: iso(100),
        hook_event: 'preToolUse',
        conversation_id: 'conv-composer-split',
        generation_id: 'turn-composer-split',
        tool_name: 'Read',
        tool_use_id: 'call-c-1',
        tool_input: { path: 'a.ts' },
      },
      {
        _journal_ts: iso(200),
        hook_event: 'postToolUse',
        conversation_id: 'conv-composer-split',
        generation_id: 'turn-composer-split',
        tool_name: 'Read',
        tool_use_id: 'call-c-1',
        tool_output: 'r1',
        duration_ms: 100,
      },
      {
        _journal_ts: iso(300),
        hook_event: 'preToolUse',
        conversation_id: 'conv-composer-split',
        generation_id: 'turn-composer-split',
        tool_name: 'Grep',
        tool_use_id: 'call-c-2',
        tool_input: { pattern: 'foo' },
      },
      {
        _journal_ts: iso(450),
        hook_event: 'postToolUse',
        conversation_id: 'conv-composer-split',
        generation_id: 'turn-composer-split',
        tool_name: 'Grep',
        tool_use_id: 'call-c-2',
        tool_output: 'r2',
        duration_ms: 150,
      },
      {
        _journal_ts: iso(800),
        hook_event: 'afterAgentResponse',
        conversation_id: 'conv-composer-split',
        generation_id: 'turn-composer-split',
        model: 'composer-2.5-fast',
        text: 'final answer',
        input_tokens: 10,
        output_tokens: 3,
      },
      {
        _journal_ts: iso(900),
        hook_event: 'stop',
        conversation_id: 'conv-composer-split',
        generation_id: 'turn-composer-split',
        status: 'completed',
      },
    ], { stopConversationId: 'conv-composer-split', stopGenerationId: 'turn-composer-split' });

    const s1Request = records.find(r =>
      r['event.name'] === 'llm.request' && r['gen_ai.step.id'] === 'turn-composer-split:s1'
    );
    const s2Request = records.find(r =>
      r['event.name'] === 'llm.request' && r['gen_ai.step.id'] === 'turn-composer-split:s2'
    );
    const s2Response = records.find(r =>
      r['event.name'] === 'llm.response' && r['gen_ai.step.id'] === 'turn-composer-split:s2'
    );

    // s1 still anchors to prompt time (the LLM that decided to call tools)
    // — the timing-guard may pull it slightly back; we just want it not
    // exceeding the first tool's start.
    expect(BigInt(s1Request!.time_unix_nano as string))
      .toBeLessThanOrEqual(BigInt(ns(100)));

    // s2 must start AT or AFTER the last buffered tool.result (iso(450)).
    // Critically it must NOT fall back to prompt time (ns(0)).
    expect(s2Request).toBeDefined();
    expect(BigInt(s2Request!.time_unix_nano as string))
      .toBeGreaterThanOrEqual(BigInt(ns(450)));
    expect(s2Response?.time_unix_nano).toBe(ns(800));
  });

  it('emits delta + full messages on llm.request: s1 has user prompt, s2 has tool result + cumulative', () => {
    const { records } = assembleTurn([
      {
        _journal_ts: iso(0),
        hook_event: 'beforeSubmitPrompt',
        conversation_id: 'conv-msg',
        generation_id: 'turn-msg',
        model: 'gpt-5.4',
        prompt: 'list files',
      },
      {
        _journal_ts: iso(100),
        hook_event: 'afterAgentThought',
        conversation_id: 'conv-msg',
        generation_id: 'turn-msg',
        model: 'gpt-5.4',
        text: 'will use ls',
        duration_ms: 50,
      },
      {
        _journal_ts: iso(200),
        hook_event: 'preToolUse',
        conversation_id: 'conv-msg',
        generation_id: 'turn-msg',
        tool_name: 'ls',
        tool_use_id: 'call-1',
        tool_input: { path: '.' },
      },
      {
        _journal_ts: iso(300),
        hook_event: 'postToolUse',
        conversation_id: 'conv-msg',
        generation_id: 'turn-msg',
        tool_name: 'ls',
        tool_use_id: 'call-1',
        tool_output: 'a.txt b.txt',
        duration_ms: 80,
      },
      {
        _journal_ts: iso(400),
        hook_event: 'afterAgentResponse',
        conversation_id: 'conv-msg',
        generation_id: 'turn-msg',
        model: 'gpt-5.4',
        text: 'done',
        duration_ms: 60,
      },
      {
        _journal_ts: iso(500),
        hook_event: 'stop',
        conversation_id: 'conv-msg',
        generation_id: 'turn-msg',
        status: 'completed',
      },
    ], { stopConversationId: 'conv-msg' });

    const llmRequests = records.filter(r => r['event.name'] === 'llm.request');
    expect(llmRequests).toHaveLength(2);

    // s1: delta = full = [user prompt]
    expect(llmRequests[0]!['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'list files' }] },
    ]);
    expect(llmRequests[0]!['gen_ai.input.messages']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'list files' }] },
    ]);

    // s2: delta = [tool result], full = [user prompt, tool result]
    const s2Delta = llmRequests[1]!['gen_ai.input.messages_delta'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(s2Delta).toHaveLength(1);
    expect(s2Delta[0]).toMatchObject({ role: 'tool' });
    expect(s2Delta[0]?.parts?.[0]).toMatchObject({
      type: 'tool_call_response',
      id: 'call-1',
      response: 'a.txt b.txt',
    });

    const s2Full = llmRequests[1]!['gen_ai.input.messages'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(s2Full).toHaveLength(2);
    expect(s2Full[0]).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', content: 'list files' }],
    });
    expect(s2Full[1]).toMatchObject({ role: 'tool' });
    expect(s2Full[1]?.parts?.[0]).toMatchObject({
      type: 'tool_call_response',
      id: 'call-1',
      response: 'a.txt b.txt',
    });

    // Deep-clone isolation: mutating s2's full messages should not affect s1's full.
    s2Full[0]!.role = 'mutated';
    expect(llmRequests[0]!['gen_ai.input.messages']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'list files' }] },
    ]);
  });

  it('opens a final s2 for afterAgentResponse when no afterAgentThought is emitted (composer-2.5-fast)', () => {
    // composer-2.5-fast does not emit afterAgentThought: a turn may look like
    //   beforeSubmitPrompt → preToolUse×N → postToolUse×N → afterAgentResponse → stop
    // We still expect s1 = buffered tools, s2 = final afterAgentResponse text.
    const { records } = assembleTurn([
      {
        _journal_ts: iso(0),
        hook_event: 'beforeSubmitPrompt',
        conversation_id: 'conv-fast',
        generation_id: 'turn-fast',
        model: 'composer-2.5-fast',
        prompt: 'solve leetcode 1',
      },
      {
        _journal_ts: iso(50),
        hook_event: 'preToolUse',
        conversation_id: 'conv-fast',
        generation_id: 'turn-fast',
        model: 'composer-2.5-fast',
        tool_name: 'Read',
        tool_use_id: 'tool-aaa',
        tool_input: { file_path: '/tmp/foo.py' },
      },
      {
        _journal_ts: iso(120),
        hook_event: 'postToolUse',
        conversation_id: 'conv-fast',
        generation_id: 'turn-fast',
        model: 'composer-2.5-fast',
        tool_name: 'Read',
        tool_use_id: 'tool-aaa',
        tool_output: 'class Solution: ...',
        duration_ms: 70,
      },
      {
        _journal_ts: iso(200),
        hook_event: 'preToolUse',
        conversation_id: 'conv-fast',
        generation_id: 'turn-fast',
        model: 'composer-2.5-fast',
        tool_name: 'Write',
        tool_use_id: 'tool-bbb',
        tool_input: { file_path: '/tmp/foo.py', content: '...' },
      },
      {
        _journal_ts: iso(260),
        hook_event: 'postToolUse',
        conversation_id: 'conv-fast',
        generation_id: 'turn-fast',
        model: 'composer-2.5-fast',
        tool_name: 'Write',
        tool_use_id: 'tool-bbb',
        tool_output: '{"success":true}',
        duration_ms: 60,
      },
      {
        _journal_ts: iso(320),
        hook_event: 'afterAgentResponse',
        conversation_id: 'conv-fast',
        generation_id: 'turn-fast',
        model: 'composer-2.5-fast',
        text: 'Done, both files updated.',
        duration_ms: 40,
        input_tokens: 50000,
        output_tokens: 120,
      },
      {
        _journal_ts: iso(400),
        hook_event: 'stop',
        conversation_id: 'conv-fast',
        generation_id: 'turn-fast',
        status: 'completed',
      },
    ], { stopConversationId: 'conv-fast' });

    const s1Request = records.find(r =>
      r['event.name'] === 'llm.request' && r['gen_ai.step.id'] === 'turn-fast:s1'
    );
    const s1Response = records.find(r =>
      r['event.name'] === 'llm.response' && r['gen_ai.step.id'] === 'turn-fast:s1'
    );
    const s2Request = records.find(r =>
      r['event.name'] === 'llm.request' && r['gen_ai.step.id'] === 'turn-fast:s2'
    );
    const s2Response = records.find(r =>
      r['event.name'] === 'llm.response' && r['gen_ai.step.id'] === 'turn-fast:s2'
    );

    // s1 = buffered tools, s2 = final afterAgentResponse. Both must exist.
    expect(s1Request).toBeDefined();
    expect(s2Request).toBeDefined();
    expect(s1Response).toBeDefined();
    expect(s2Response).toBeDefined();

    // s1 input: delta = [user prompt]; full = [user prompt].
    expect(s1Request!['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'solve leetcode 1' }] },
    ]);
    expect(s1Request!['gen_ai.input.messages']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'solve leetcode 1' }] },
    ]);

    // s1's llm.response should carry the tool_call parts for both buffered tools.
    const s1Output = s1Response!['gen_ai.output.messages'] as Array<{ parts: Array<Record<string, unknown>> }>;
    const s1ToolParts = s1Output[0]!.parts!.filter(p => p.type === 'tool_call') as Array<Record<string, unknown>>;
    expect(s1ToolParts).toHaveLength(2);
    expect(s1ToolParts[0]).toMatchObject({ type: 'tool_call', id: 'tool-aaa', name: 'Read' });
    expect(s1ToolParts[1]).toMatchObject({ type: 'tool_call', id: 'tool-bbb', name: 'Write' });

    // s1 should contain both tool.call and tool.result records.
    const s1ToolCalls = records.filter(r =>
      r['event.name'] === 'tool.call' && r['gen_ai.step.id'] === 'turn-fast:s1'
    );
    const s1ToolResults = records.filter(r =>
      r['event.name'] === 'tool.result' && r['gen_ai.step.id'] === 'turn-fast:s1'
    );
    expect(s1ToolCalls).toHaveLength(2);
    expect(s1ToolResults).toHaveLength(2);

    // s2 input: delta = [tool results for Read+Write], full = [user prompt, tool results].
    const s2Delta = s2Request!['gen_ai.input.messages_delta'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(s2Delta).toHaveLength(1);
    expect(s2Delta[0]).toMatchObject({ role: 'tool' });
    expect(s2Delta[0]!.parts).toHaveLength(2);

    const s2Full = s2Request!['gen_ai.input.messages'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(s2Full).toHaveLength(2);
    expect(s2Full[0]).toMatchObject({ role: 'user' });
    expect(s2Full[1]).toMatchObject({ role: 'tool' });

    // s2 llm.response should carry the final text but NO tool_call parts.
    const s2Output = s2Response!['gen_ai.output.messages'] as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(s2Output[0]!.parts![0]).toMatchObject({ type: 'text', content: 'Done, both files updated.' });
    const s2ToolParts = s2Output[0]!.parts!.filter(p => p.type === 'tool_call');
    expect(s2ToolParts).toHaveLength(0);
  });
});

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
      const secondStepToolResponses = secondStepRequest?.['gen_ai.input.messages']?.[0]?.parts ?? [];

      expect(parentSubagentResults).toHaveLength(1);
      expect(parentSubagentResults[0]).toMatchObject({
        'agent.cursor.hook_event_name': 'subagent_result_synthesized',
        'gen_ai.tool.call.result': { summary: 'child final result' },
      });
      expect(secondStepToolResponses).toHaveLength(1);
      expect(secondStepToolResponses[0]).toMatchObject({
        type: 'tool_call_response',
        id: 'call-subagent',
        response: 'child final result',
      });
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
    const secondStepToolResponses = secondStepRequest?.['gen_ai.input.messages']?.[0]?.parts ?? [];

    expect(parentSubagentResults).toHaveLength(1);
    expect(parentSubagentResults[0]).toMatchObject({
      'agent.cursor.hook_event_name': 'postToolUse',
      'gen_ai.tool.call.result': 'cursor fallback result',
    });
    expect(secondStepToolResponses).toHaveLength(1);
    expect(secondStepToolResponses[0]).toMatchObject({
      type: 'tool_call_response',
      id: 'call-subagent-fallback',
      response: 'cursor fallback result',
    });
  });
});

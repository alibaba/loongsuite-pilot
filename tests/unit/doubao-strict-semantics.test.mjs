import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildTraces, validateStructure, validateTime } from '../../scripts/validate-trace.mjs';

const rules = JSON.parse(readFileSync(new URL('../../docs/trace-validation-rules.json', import.meta.url), 'utf8'));
const epoch = 1_793_000_000_000_000_000n;
const sid = n => String(n).padStart(16, '0');

function span(id, kind, parent, start = 0, end = 100, extra = {}) {
  return {
    traceId: 'd'.repeat(32), spanId: sid(id), ...(parent ? { parentSpanId: sid(parent) } : {}),
    name: `${kind} synthetic`,
    startTimeUnixNano: String(epoch + BigInt(start) * 1_000_000n),
    endTimeUnixNano: String(epoch + BigInt(end) * 1_000_000n),
    attributes: {
      'gen_ai.span.kind': kind, 'gen_ai.framework': 'doubao-work',
      'gen_ai.session.id': 'synthetic-session', 'gen_ai.turn.id': 'synthetic-invocation',
      ...extra,
    },
  };
}

function checks(rows, validate = validateStructure) {
  return validate([...buildTraces(rows).values()][0], rules);
}

describe('Doubao spans obey the shared invocation and ReAct contract', () => {
  test('local receipt metadata cannot exempt a TOOL from STEP ownership', () => {
    const rows = [span(1, 'ENTRY'), span(2, 'AGENT', 1), span(3, 'TOOL', 2, 10, 20, {
      'gen_ai.tool.call.id': 'synthetic-call',
      'loongsuite.doubao_work.tool_boundary': 'client_received_to_execution_settled',
    })];
    expect(checks(rows)).toContainEqual(expect.objectContaining({
      id: 'structure.tool_under_step', status: 'error', spanId: sid(3),
    }));
  });

  test.each(['native_local_tool_fragment', 'native_sandbox_execution'])(
    '%s is not a delegation or an Agent invocation boundary', scope => {
      const rows = [span(1, 'ENTRY'), span(2, 'AGENT', 1, 0, 100, {
        'gen_ai.agent.id': 'm_native', 'loongsuite.doubao_work.observation_scope': 'client_message',
      }), span(3, 'AGENT', 2, 10, 30, {
        'gen_ai.agent.id': 'o_native', 'gen_ai.agent.parent.id': 'm_native',
        'loongsuite.doubao_work.root_agent_id': 'm_native',
        'loongsuite.doubao_work.root_turn_id': 'synthetic-invocation',
        'loongsuite.doubao_work.observation_scope': scope,
        'loongsuite.doubao_work.agent_boundary': 'native_local_tool_interval',
        'loongsuite.doubao_work.relation_basis': 'native_create_agent_ancestry',
        'loongsuite.doubao_work.timing_basis': 'own_local_tool',
        'loongsuite.doubao_work.native_creation_call_id': 'synthetic-create',
        'loongsuite.doubao_work.fragment_id': 'f'.repeat(64),
        ...(scope === 'native_sandbox_execution' ? {
          'loongsuite.doubao_work.agent_boundary': 'native_sandbox_get_or_create_to_release',
          'loongsuite.doubao_work.timing_basis': 'native_execution_startedAtMs_endedAtMs',
          'loongsuite.doubao_work.native_execution_id': '00000000-0000-4000-8000-000000000001',
          'loongsuite.doubao_work.native_query_message_id': '00000000-0000-4000-8000-000000000002',
          'loongsuite.doubao_work.native_sandbox_id': 'synthetic-sandbox',
          'loongsuite.doubao_work.native_thread_id': '102',
          'loongsuite.doubao_work.native_ancestor_ids': ['m_native'],
          'loongsuite.doubao_work.parent_resolution': 'root_request_ancestor',
        } : {}),
      })];
      expect(checks(rows)).toContainEqual(expect.objectContaining({
        id: 'structure.agent_under_entry', status: 'error', spanId: sid(3),
      }));
    },
  );

  test('a tool fragment cannot relax asynchronous lifetime checks', () => {
    const rows = [span(1, 'ENTRY'), span(2, 'AGENT', 1, 0, 100, {
      'gen_ai.agent.id': 'm_native', 'loongsuite.doubao_work.observation_scope': 'client_message',
    }), span(3, 'AGENT', 2, 110, 130, {
      'gen_ai.agent.id': 'o_native', 'gen_ai.agent.parent.id': 'm_native',
      'loongsuite.doubao_work.root_agent_id': 'm_native',
      'loongsuite.doubao_work.root_turn_id': 'synthetic-invocation',
      'loongsuite.doubao_work.observation_scope': 'native_local_tool_fragment',
      'loongsuite.doubao_work.agent_boundary': 'native_local_tool_interval',
      'loongsuite.doubao_work.relation_basis': 'native_create_agent_ancestry',
      'loongsuite.doubao_work.timing_basis': 'own_local_tool',
      'loongsuite.doubao_work.native_creation_call_id': 'synthetic-create',
      'loongsuite.doubao_work.fragment_id': 'f'.repeat(64),
    })];
    expect(checks(rows, validateTime)).toContainEqual(expect.objectContaining({
      id: 'time.parent_contains_children', status: 'error', spanId: sid(3),
    }));
  });

  test('a real ReAct round and a delegated background Agent remain supported', () => {
    const rows = [span(1, 'ENTRY'), span(2, 'AGENT', 1), span(3, 'STEP', 2, 0, 90),
      span(4, 'LLM', 3, 0, 10), span(5, 'TOOL', 3, 10, 20),
      span(6, 'AGENT', 5, 15, 130, { 'gen_ai.agent.scope': 'subagent' })];
    expect(checks(rows).filter(c => c.status === 'error')).toEqual([]);
    expect(checks(rows, validateTime).filter(c => c.status === 'error')).toEqual([]);
  });
});

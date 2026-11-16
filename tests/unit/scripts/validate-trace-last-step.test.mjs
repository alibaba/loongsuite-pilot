import { describe, expect, test } from 'vitest';
import { checkLastStepNoToolCall } from '../../../scripts/validate-trace.mjs';

// Minimal trace shape consumed by checkLastStepNoToolCall:
//   spans: array of { spanId, startTimeUnixNano, attributes, _kind }
//   childrenMap: Map<spanId, childSpan[]>
// The helper walks STEP spans by startTime, takes the last STEP, finds its
// LLM child, and inspects gen_ai.output.messages on that LLM.
function buildTrace(outputMessages, { stepStart = '1000', llmStart = '1100' } = {}) {
  const stepSpan = {
    spanId: 'step1',
    startTimeUnixNano: stepStart,
    attributes: { 'gen_ai.span.kind': 'STEP' },
    _kind: 'STEP',
  };
  const llmSpan = {
    spanId: 'llm1',
    startTimeUnixNano: llmStart,
    attributes: {
      'gen_ai.span.kind': 'LLM',
      'gen_ai.output.messages': outputMessages,
    },
    _kind: 'LLM',
    name: 'chat test-model',
  };
  const childrenMap = new Map([
    ['step1', [llmSpan]],
    ['llm1', []],
  ]);
  return { spans: [stepSpan, llmSpan], childrenMap };
}

function statusOf(trace) {
  const checks = checkLastStepNoToolCall(trace.spans, trace.childrenMap);
  // The helper emits exactly one check when an LLM is found under the last
  // STEP, zero checks when there is no STEP/LLM. Test cases all have a
  // STEP+LLM, so we expect exactly one check.
  expect(checks.length).toBe(1);
  return checks[0].status;
}

describe('semantic.last_step_no_tool_call — last assistant message scope', () => {
  test('case 1: 2-message output (tool_call-only first + text-only last) → PASS', () => {
    // trae-cn single-LLM-per-turn shape after hook-processor split:
    // tool_call assistant message precedes the final text-only answer.
    const trace = buildTrace([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'tu1', name: 'Write' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'done' }] },
    ]);
    expect(statusOf(trace)).toBe('pass');
  });

  test('case 2: 1-message output containing tool_call → ERROR (single-message behavior unchanged)', () => {
    const trace = buildTrace([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'tu1', name: 'Write' }] },
    ]);
    expect(statusOf(trace)).toBe('error');
  });

  test('case 3: 1-message output text-only → PASS', () => {
    const trace = buildTrace([
      { role: 'assistant', parts: [{ type: 'text', content: 'done' }] },
    ]);
    expect(statusOf(trace)).toBe('pass');
  });

  test('case 4: empty msgs array → PASS', () => {
    const trace = buildTrace([]);
    expect(statusOf(trace)).toBe('pass');
  });

  test('case 5: 0 assistant messages + last message is user role → fallback to last message (no crash)', () => {
    // No assistant messages; fallback walks to the last message in the
    // array (a user text message). parts has no tool_call → PASS. The
    // case primarily guards against empty-assistant-list crashes.
    const trace = buildTrace([
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
    ]);
    expect(statusOf(trace)).toBe('pass');
  });

  test('case 6: 3-message output (text + tool_call + text) → PASS', () => {
    // Last assistant message is text-only; an earlier assistant message
    // carries the tool_call. Pre-fix this would have been ERROR (any
    // tool_call in any message); post-fix it is PASS.
    const trace = buildTrace([
      { role: 'assistant', parts: [{ type: 'text', content: 'thinking' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'tu1', name: 'Write' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'final answer' }] },
    ]);
    expect(statusOf(trace)).toBe('pass');
  });

  test('case 7 (extra): last assistant message contains tool_call even with earlier text → ERROR', () => {
    // Negative case: terminal assistant message carries tool_call → ERROR.
    // Guards against the rule becoming too lenient.
    const trace = buildTrace([
      { role: 'assistant', parts: [{ type: 'text', content: 'thinking' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'tu_last', name: 'Write' }] },
    ]);
    expect(statusOf(trace)).toBe('error');
  });

  test('case 8 (extra): gen_ai.output.messages as JSON string is parsed correctly', () => {
    // validate-trace reads the attribute either as object or JSON string;
    // ensure string form is parsed for the last-assistant-message check.
    const stepSpan = {
      spanId: 'step1',
      startTimeUnixNano: '1000',
      attributes: { 'gen_ai.span.kind': 'STEP' },
      _kind: 'STEP',
    };
    const llmSpan = {
      spanId: 'llm1',
      startTimeUnixNano: '1100',
      attributes: {
        'gen_ai.span.kind': 'LLM',
        'gen_ai.output.messages': JSON.stringify([
          { role: 'assistant', parts: [{ type: 'tool_call', id: 'tu1', name: 'Write' }] },
          { role: 'assistant', parts: [{ type: 'text', content: 'done' }] },
        ]),
      },
      _kind: 'LLM',
      name: 'chat test-model',
    };
    const childrenMap = new Map([
      ['step1', [llmSpan]],
      ['llm1', []],
    ]);
    const checks = checkLastStepNoToolCall([stepSpan, llmSpan], childrenMap);
    expect(checks.length).toBe(1);
    expect(checks[0].status).toBe('pass');
  });
});

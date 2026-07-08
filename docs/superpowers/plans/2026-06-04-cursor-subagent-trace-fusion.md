# Cursor Subagent Trace Fusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Cursor parent/subagent trace fusion so a parent `Subagent` tool call contains nested subagent LLM/tool steps instead of leaking child sessions as fake top-level turns.

**Architecture:** Keep the existing Cursor hook processor fail-open and mostly reusable: it continues writing raw JSONL and legacy history JSONL. Add a Cursor source-event adapter and ReAct assembler in the Input layer, because `CursorHookInput` is long-lived and can buffer complete turns, associate child conversations, and emit fused canonical records. Add converter/debug validation for nested agent metadata so the final trace can render `Parent STEP -> TOOL Subagent -> Subagent -> child STEP`.

**Tech Stack:** TypeScript input pipeline, Node hook processor, Vitest unit tests, existing `AgentActivityEntry` schema, existing OTLP trace flusher/converter.

---

## Target Trace Shape

```text
ENTRY
  AGENT
    父 STEP 1
      LLM
        input: user prompt
        output: reasoning/text + tool_call Subagent
      TOOL Subagent
        AGENT
          子 STEP 1
            LLM input/output
            TOOL call/result
          子 STEP 2
            LLM input/output
            TOOL call/result
    父 STEP 2
      LLM
        input: Subagent final result/status
        output: final summary
```

## Implementation Principles

1. Do not throw away the current probe.
   - `assets/hooks/cursor-hook-processor.mjs` already writes raw and history. Keep it lightweight.
   - Old history records still carry enough fields to support fallback assembly.

2. Raw source wins, history remains fallback.
   - Prefer `~/.loongsuite-pilot/logs/cursor/raw/cursor-raw-trace.jsonl` when present.
   - If raw is unavailable, assemble from `logs/cursor/history/cursor-YYYY-MM-DD.jsonl`.
   - If records already contain valid `gen_ai.step.id` and no child-session leak, pass through.

3. Top-level turns are only user turns.
   - A top-level Cursor turn must start with `beforeSubmitPrompt`.
   - A conversation that has no `beforeSubmitPrompt` and starts with `preToolUse` is a child/session-internal run, not a fake user turn.

4. Subagent is dual-level.
   - Parent view: `Subagent` is a tool call/result.
   - Child view: the child conversation is a nested agent run under the `Subagent` tool span.

5. Child association must be confidence-aware.
   - Strong link: explicit `parent_conversation_id`, `tool_call_id`, `agent_transcript_path`, or future Cursor field.
   - Medium link: child conversation appears inside `subagentStart`/`subagentStop` window.
   - Weak but useful link: child conversation has no `beforeSubmitPrompt` and is the next unclaimed child conversation after a pending `preToolUse(Subagent)`.
   - Ambiguous child sessions should remain marked `agent.cursor.subagent.link_confidence="orphan"` rather than corrupting parent trace.

---

## File Structure

### Create

- `src/inputs/cursor-hook/cursor-source-event.ts`
  - Convert raw Cursor hook payloads and old history/canonical records into one internal `CursorSourceEvent`.
  - Sanitize `tool_use_id` consistently.
  - Preserve raw line/file/order metadata for deterministic grouping.

- `src/inputs/cursor-hook/cursor-trace-assembler.ts`
  - Segment parent turns.
  - Detect child conversations.
  - Link `preToolUse(Subagent)` with `subagentStart/subagentStop`.
  - Build parent and nested child ReAct steps.
  - Emit canonical `AgentActivityEntry` records with `trace_id`, `gen_ai.turn.id`, `gen_ai.step.id`, tool ids, and subagent attributes.

- `tests/unit/inputs/cursor-trace-assembler.test.ts`
  - Pure assembler tests using small synthetic payloads.
  - Tests must not depend on polling or filesystem offsets.

- `tests/fixtures/cursor-hook/raw-cursor-subagent-2026-06-04.redacted.jsonl`
  - Redacted fixture based on the current raw shape.
  - Keep event order, ids, timestamps, hook names, tool names, statuses.
  - Replace prompts/text/tool contents/user email/absolute private content with short placeholders.

### Modify

- `src/inputs/cursor-hook/cursor-hook-input.ts`
  - Add `rawLogDir` option.
  - Override `collect()` for Cursor only.
  - Use raw assembler when raw exists and has new bytes.
  - Fall back to current per-record `transformRecord()` path for legacy/no-raw cases.

- `tests/unit/inputs/cursor-hook-input.test.ts`
  - Keep current tests.
  - Add integration test proving raw subagent fixture emits one parent trace, not three top-level turns.

- `docs/EVENT_LOG_TO_TRACE_SPEC.md`
  - Document nested agent fields and subagent semantics.

- `docs/cursor-trace-fix-experience.md`
  - Replace “模式 B = Cursor 链路异常” language with “模式 B = child session leaked as top-level turn”.

- `src/flushers/otlp-trace-flusher.ts`
  - Only modify if verification shows the converter ignores nested parent fields.
  - Expected change: preserve explicit nested `parent_span_id` / `gen_ai.agent.parent_tool_call.id` semantics, or add a preprocessing step that groups child agent spans under the parent Subagent tool span.

---

## Data Contract

### CursorSourceEvent

```ts
export interface CursorSourceEvent {
  order: number;
  source: 'raw' | 'history';
  capturedAtMs: number;
  hookEvent: string;
  conversationId: string;
  sessionId: string;
  generationId?: string;
  model?: string;
  prompt?: string;
  text?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  errorMessage?: string;
  failureType?: string;
  durationMs?: number;
  status?: string;
  subagentId?: string;
  subagentType?: string;
  parentConversationId?: string;
  toolCallId?: string;
  subagentModel?: string;
  messageCount?: number;
  toolCallCount?: number;
  loopCount?: number;
  raw: Record<string, unknown>;
}
```

### Emitted Subagent Attributes

Use stable fields for future queries and `agent.cursor.*` for Cursor-specific debug:

```ts
{
  'gen_ai.agent.type': 'cursor',
  'gen_ai.agent.id': '<conversation_id>',
  'gen_ai.agent.parent.id': '<parent_conversation_id>',
  'gen_ai.agent.depth': 1,
  'gen_ai.agent.scope': 'subagent',
  'gen_ai.subagent.id': '<subagent_id or tool_call_id>',
  'gen_ai.subagent.parent_tool_call.id': '<parent Subagent tool_use_id>',
  'agent.cursor.subagent.link_confidence': 'explicit' | 'time_window' | 'pending_order' | 'orphan'
}
```

---

## Task 1: Add Source Event Adapter

**Files:**
- Create: `src/inputs/cursor-hook/cursor-source-event.ts`
- Test: `tests/unit/inputs/cursor-trace-assembler.test.ts`

- [ ] **Step 1: Write adapter tests**

Add tests for raw payload and legacy history payload:

```ts
import { describe, expect, it } from 'vitest';
import { toCursorSourceEvent, sanitizeCursorToolId } from '../../../src/inputs/cursor-hook/cursor-source-event.js';

describe('cursor source event adapter', () => {
  it('normalizes raw preToolUse payload', () => {
    const event = toCursorSourceEvent({
      order: 1,
      source: 'raw',
      record: {
        _captured_at: '2026-06-04T06:21:28.838Z',
        hook_event_name: 'preToolUse',
        conversation_id: 'parent-conv',
        session_id: 'parent-conv',
        generation_id: 'parent-gen',
        tool_name: 'Subagent',
        tool_use_id: 'call_parent\nfc_hidden',
        tool_input: { description: 'Research', prompt: 'redacted' },
      },
    });

    expect(event).toMatchObject({
      order: 1,
      source: 'raw',
      hookEvent: 'preToolUse',
      conversationId: 'parent-conv',
      sessionId: 'parent-conv',
      generationId: 'parent-gen',
      toolName: 'Subagent',
      toolUseId: 'call_parent',
    });
  });

  it('normalizes canonical history tool.call payload', () => {
    const event = toCursorSourceEvent({
      order: 2,
      source: 'history',
      record: {
        'event.name': 'tool.call',
        'gen_ai.session.id': 'child-conv',
        'gen_ai.turn.id': 'child-gen',
        'gen_ai.tool.name': 'WebSearch',
        'gen_ai.tool.call.id': 'call_web',
        'agent.cursor.hook_event_name': 'preToolUse',
        time_unix_nano: '1780554890000000000',
      },
    });

    expect(event).toMatchObject({
      hookEvent: 'preToolUse',
      conversationId: 'child-conv',
      generationId: 'child-gen',
      toolName: 'WebSearch',
      toolUseId: 'call_web',
    });
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm test -- tests/unit/inputs/cursor-trace-assembler.test.ts
```

Expected: import/function missing.

- [ ] **Step 3: Implement adapter**

Implement:

```ts
export function sanitizeCursorToolId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.split('\n')[0]!.trim() || undefined;
}
```

Then implement `toCursorSourceEvent()` with these mappings:

| Internal field | Raw source | History source |
|---|---|---|
| `hookEvent` | `hook_event_name` | `agent.cursor.hook_event_name` |
| `conversationId` | `conversation_id/session_id` | `gen_ai.session.id` |
| `generationId` | `generation_id` | `gen_ai.turn.id` |
| `toolName` | `tool_name` | `gen_ai.tool.name` |
| `toolUseId` | `tool_use_id` | `gen_ai.tool.call.id` |
| `toolInput` | `tool_input` | `gen_ai.tool.call.arguments` |
| `toolOutput` | `tool_output` | `gen_ai.tool.call.result` |
| `prompt` | `prompt` | `gen_ai.input.messages_delta` first user text |
| `text` | `text` | `gen_ai.output.messages` first text/reasoning part |

- [ ] **Step 4: Run adapter test**

Run:

```bash
npm test -- tests/unit/inputs/cursor-trace-assembler.test.ts
```

Expected: adapter tests pass.

---

## Task 2: Build Parent Turn Segmentation

**Files:**
- Create: `src/inputs/cursor-hook/cursor-trace-assembler.ts`
- Test: `tests/unit/inputs/cursor-trace-assembler.test.ts`

- [ ] **Step 1: Write segmentation test**

Add:

```ts
import { assembleCursorTrace } from '../../../src/inputs/cursor-hook/cursor-trace-assembler.js';

it('treats only beforeSubmitPrompt segments as top-level turns', () => {
  const entries = assembleCursorTrace([
    ev(1, 'beforeSubmitPrompt', 'parent', 'parent-gen', { prompt: 'user prompt' }),
    ev(2, 'afterAgentThought', 'parent', 'parent-gen', { text: 'thinking' }),
    ev(3, 'preToolUse', 'child', 'child-gen', { tool_name: 'WebSearch', tool_use_id: 'call_web' }),
    ev(4, 'afterAgentThought', 'child', 'child-gen', { text: 'child thought' }),
    ev(5, 'afterAgentResponse', 'parent', 'parent-gen', { text: 'done' }),
    ev(6, 'stop', 'parent', 'stop-gen', { status: 'completed' }),
  ]);

  const topTurnIds = new Set(entries.map((e) => e['gen_ai.turn.id']));
  expect([...topTurnIds]).toContain('parent-gen');
  expect([...topTurnIds]).not.toContain('child-gen');
});
```

Use a local `ev()` test helper that calls `toCursorSourceEvent()`.

- [ ] **Step 2: Implement segmentation**

Implement:

```ts
export function splitCursorParentTurns(events: CursorSourceEvent[]): CursorParentTurn[] {
  const turns: CursorParentTurn[] = [];
  let current: CursorParentTurn | null = null;

  for (const event of events.sort((a, b) => a.order - b.order)) {
    if (event.hookEvent === 'beforeSubmitPrompt') {
      if (current) turns.push(current);
      current = {
        parentConversationId: event.conversationId,
        turnId: event.generationId ?? `${event.conversationId}:turn:${event.order}`,
        events: [event],
        childEvents: [],
        completed: false,
      };
      continue;
    }

    if (!current) continue;

    if (event.conversationId === current.parentConversationId) {
      current.events.push(event);
      if (event.hookEvent === 'stop') {
        current.completed = true;
        turns.push(current);
        current = null;
      }
    } else {
      current.childEvents.push(event);
    }
  }

  return turns;
}
```

The actual implementation should include type definitions and should not emit incomplete parent turns until `stop` or idle timeout.

- [ ] **Step 3: Run segmentation tests**

Run:

```bash
npm test -- tests/unit/inputs/cursor-trace-assembler.test.ts
```

Expected: segmentation tests pass.

---

## Task 3: Link Parent Subagent Calls

**Files:**
- Modify: `src/inputs/cursor-hook/cursor-trace-assembler.ts`
- Test: `tests/unit/inputs/cursor-trace-assembler.test.ts`

- [ ] **Step 1: Write linking tests**

Add tests for these exact cases:

1. `preToolUse(Subagent)` + `subagentStart(tool_call_id)` + `subagentStop(subagent_id)` link by sanitized call id.
2. `Subagent` has no `postToolUse(Subagent)` but still emits a parent `tool.result` synthesized from `subagentStop`.
3. Child conversation with no `beforeSubmitPrompt` is linked to pending subagent by `pending_order` when no explicit child id exists.
4. Ambiguous child conversation remains `orphan`.

Expected assertions:

```ts
const subagentTool = entries.find((e) =>
  e['event.name'] === 'tool.call' &&
  e['gen_ai.tool.name'] === 'Subagent'
);
expect(subagentTool?.['gen_ai.tool.call.id']).toBe('call_parent');

const subagentResult = entries.find((e) =>
  e['event.name'] === 'tool.result' &&
  e['gen_ai.tool.name'] === 'Subagent'
);
expect(subagentResult?.['tool.result.status']).toBe('completed');
expect(subagentResult?.['gen_ai.subagent.id']).toBe('call_parent');
```

- [ ] **Step 2: Implement `buildSubagentLinks()`**

Rules:

```text
preToolUse(Subagent) creates pending parent call.
subagentStart links to pending call by tool_call_id/subagent_id.
subagentStop updates same link by subagent_id.
child conversations are grouped by conversationId.
explicit child link wins if future fields exist.
otherwise assign first unclaimed child conversation to first pending parent Subagent call after that call order.
if multiple possible calls have overlapping order and no clear winner, keep child as orphan.
```

Store:

```ts
interface SubagentLink {
  parentToolCallId: string;
  parentPreEvent: CursorSourceEvent;
  startEvent?: CursorSourceEvent;
  stopEvent?: CursorSourceEvent;
  childConversationId?: string;
  childEvents: CursorSourceEvent[];
  confidence: 'explicit' | 'time_window' | 'pending_order' | 'orphan';
}
```

- [ ] **Step 3: Run linking tests**

Run:

```bash
npm test -- tests/unit/inputs/cursor-trace-assembler.test.ts
```

Expected: all subagent linking tests pass.

---

## Task 4: Build Parent ReAct Steps

**Files:**
- Modify: `src/inputs/cursor-hook/cursor-trace-assembler.ts`
- Test: `tests/unit/inputs/cursor-trace-assembler.test.ts`

- [ ] **Step 1: Write parent step tests**

Use this synthetic chain:

```text
beforeSubmitPrompt
afterAgentThought
preToolUse(Subagent)
subagentStart
subagentStop
afterAgentThought
afterAgentResponse
stop
```

Assert:

```ts
const llmResponses = entries.filter((e) => e['event.name'] === 'llm.response');
expect(llmResponses[0]?.['gen_ai.output.messages']).toEqual([
  {
    role: 'assistant',
    parts: [
      { type: 'reasoning', content: 'parent thought' },
      {
        type: 'tool_call',
        id: 'call_parent',
        name: 'Subagent',
        arguments: { description: 'Research' },
      },
    ],
  },
]);

const parentStepIds = new Set(entries
  .filter((e) => e['gen_ai.agent.depth'] !== 1)
  .map((e) => e['gen_ai.step.id'])
  .filter(Boolean));
expect([...parentStepIds]).toEqual(['parent-gen:s1', 'parent-gen:s2']);
```

- [ ] **Step 2: Implement parent step assembler**

Rules:

```text
beforeSubmitPrompt is user input only; do not emit a real step LLM.
afterAgentThought starts a parent step if no current LLM anchor exists.
afterAgentResponse starts final parent step if previous step ended in tool/subagent result.
tools after a thought belong to current parent step.
Subagent tool_call part is added to current LLM output.
Subagent result from subagentStop goes to next LLM input as tool_call_response.
stop closes turn and does not emit token fields if afterAgentResponse already has them.
```

Use deterministic ids:

```text
trace_id = sha256('cursor:' + parent_turn_id)[:32]
parent step id = `${turnId}:s${round}`
response id = `${turnId}:r${round}`
```

- [ ] **Step 3: Run parent step tests**

Run:

```bash
npm test -- tests/unit/inputs/cursor-trace-assembler.test.ts
```

Expected: parent step tests pass.

---

## Task 5: Build Child Subagent Steps

**Files:**
- Modify: `src/inputs/cursor-hook/cursor-trace-assembler.ts`
- Test: `tests/unit/inputs/cursor-trace-assembler.test.ts`

- [ ] **Step 1: Write child step tests**

Use child events that start with a tool before first thought:

```text
child preToolUse(WebSearch)
child postToolUse(WebSearch)
child afterAgentThought
child preToolUse(Read)
child postToolUse(Read)
```

Assert:

```ts
const childEntries = entries.filter((e) => e['gen_ai.agent.depth'] === 1);
expect(childEntries.length).toBeGreaterThan(0);
expect(new Set(childEntries.map((e) => e['gen_ai.turn.id']))).toEqual(new Set(['parent-gen']));
expect(childEntries.every((e) => e['gen_ai.subagent.parent_tool_call.id'] === 'call_parent')).toBe(true);
expect(childEntries.some((e) => e['event.name'] === 'llm.response')).toBe(true);
expect(childEntries.some((e) => e['event.name'] === 'tool.call' && e['gen_ai.tool.name'] === 'WebSearch')).toBe(true);
```

- [ ] **Step 2: Implement child step assembler**

Rules:

```text
Child conversation does not need beforeSubmitPrompt.
If child starts with preToolUse before first afterAgentThought:
  synthesize child STEP 1 LLM output containing tool_call parts.
If child later has afterAgentThought:
  create next child step, input contains previous child tool_result.
Child tool spans stay under the nested Subagent run.
All child entries keep parent trace_id and parent gen_ai.turn.id.
Child entries carry:
  gen_ai.agent.scope = 'subagent'
  gen_ai.agent.depth = 1
  gen_ai.agent.id = child conversation id
  gen_ai.agent.parent.id = parent conversation id
  gen_ai.subagent.parent_tool_call.id = parent Subagent tool id
```

Important: child entries should not create a second top-level `gen_ai.turn.id`.

- [ ] **Step 3: Run child step tests**

Run:

```bash
npm test -- tests/unit/inputs/cursor-trace-assembler.test.ts
```

Expected: child step tests pass.

---

## Task 6: Integrate Assembler into CursorHookInput

**Files:**
- Modify: `src/inputs/cursor-hook/cursor-hook-input.ts`
- Test: `tests/unit/inputs/cursor-hook-input.test.ts`

- [ ] **Step 1: Add raw input constructor option**

Add:

```ts
interface CursorHookInputOptions extends Partial<HookInputOptions> {
  stateStore: HookInputOptions['stateStore'];
  rawLogDir?: string;
}
```

Default:

```ts
rawLogDir: resolveHome('~/.loongsuite-pilot/logs/cursor/raw')
```

- [ ] **Step 2: Override `collect()`**

Read raw first:

```text
if raw file exists:
  read new bytes from cursor-raw-trace.jsonl using state.extra.cursorRawOffset
  adapt new records
  merge with pending state.extra.cursorPendingRawEvents
  assemble complete parent turns
  persist remaining incomplete events
  emit fused canonical entries
else:
  call current BaseHookInput collect fallback
```

Keep `transformRecord()` intact for fallback and existing tests.

- [ ] **Step 3: Add integration test**

Create temp raw log:

```ts
const input = new CursorHookInput({
  stateStore: stateStore as any,
  logDir: historyDir,
  rawLogDir,
  logPrefix: 'cursor',
  pollIntervalMs: 60_000,
});
```

Assert:

```ts
expect(entries.some((e) => e['gen_ai.tool.name'] === 'Subagent')).toBe(true);
expect(entries.every((e) => e['gen_ai.turn.id'] !== 'child-gen')).toBe(true);
expect(entries.some((e) => e['gen_ai.agent.scope'] === 'subagent')).toBe(true);
```

- [ ] **Step 4: Run Cursor input tests**

Run:

```bash
npm test -- tests/unit/inputs/cursor-hook-input.test.ts tests/unit/inputs/cursor-trace-assembler.test.ts
```

Expected: all Cursor input tests pass.

---

## Task 7: Redacted Real Fixture

**Files:**
- Create: `tests/fixtures/cursor-hook/raw-cursor-subagent-2026-06-04.redacted.jsonl`
- Test: `tests/unit/inputs/cursor-trace-assembler.test.ts`

- [ ] **Step 1: Create redacted fixture**

Use the current raw shape with these transformations:

```text
prompt/text/tool_output -> short placeholder text
user_email -> redacted@example.com
workspace_roots -> /workspace
absolute file content -> content_length only
ids/order/timestamps/hook names/tool names/status/duration stay intact
```

The fixture must preserve:

```text
parent conv 0d58979b
child conv 77130c94
child conv 3fa41b26
preToolUse(Subagent) count = 4
postToolUse(Subagent) count = 0
child conversations have no beforeSubmitPrompt
```

- [ ] **Step 2: Add fixture regression test**

Assert:

```ts
const entries = assembleCursorTrace(loadFixture(...));
expect(entries.filter((e) => e['gen_ai.tool.name'] === 'Subagent' && e['event.name'] === 'tool.call')).toHaveLength(4);
expect(entries.filter((e) => e['gen_ai.tool.name'] === 'Subagent' && e['event.name'] === 'tool.result')).toHaveLength(4);
expect(new Set(entries.map((e) => e['gen_ai.turn.id']))).toEqual(new Set(['ba77160c-4a83-4b8c-8747-8f081405b28c']));
expect(entries.some((e) => e['gen_ai.agent.scope'] === 'subagent')).toBe(true);
```

- [ ] **Step 3: Run fixture regression**

Run:

```bash
npm test -- tests/unit/inputs/cursor-trace-assembler.test.ts
```

Expected: redacted real-shape fixture passes.

---

## Task 8: Converter/Nested Trace Verification

**Files:**
- Modify if needed: `src/flushers/otlp-trace-flusher.ts`
- Test: add or extend OTLP trace flusher tests under `tests/unit/flushers/` if a test file exists; otherwise create `tests/unit/flushers/otlp-trace-flusher-nested-agent.test.ts`.

- [ ] **Step 1: Verify existing converter behavior**

Build a small event log with:

```text
parent LLM response
parent Subagent tool.call/tool.result
child subagent LLM response
child subagent tool.call/tool.result
```

Run it through `OtlpTraceFlusher` with debug output enabled.

Expected tree:

```text
Agent
  STEP parent
    LLM
    TOOL Subagent
      Subagent
        STEP child
```

- [ ] **Step 2: If converter flattens child spans, add preprocessing**

Add a local preprocessing function before `convertEventLogToTrace()`:

```ts
function prepareNestedAgentRecords(records: AgentActivityEntry[]): AgentActivityEntry[] {
  return records.map((record) => {
    if (record['gen_ai.agent.scope'] !== 'subagent') return record;
    return {
      ...record,
      'gen_ai.trace.parent_tool_call.id': record['gen_ai.subagent.parent_tool_call.id'],
    };
  });
}
```

Then update the converter call:

```ts
const prepared = prepareNestedAgentRecords(records);
const result = convertEventLogToTrace(prepared as unknown as EventLogRecord[], {
  handler,
  strict: false,
});
```

If the external converter still cannot nest, keep the event log fields correct and document the limitation in `docs/EVENT_LOG_TO_TRACE_SPEC.md`. Do not fake parentage by changing `gen_ai.turn.id` into child turn ids.

- [ ] **Step 3: Run OTLP tests**

Run:

```bash
npm test -- tests/unit/flushers
```

Expected: existing flusher tests pass; nested-agent test either passes or asserts documented flattening with correct metadata.

---

## Task 9: Documentation and Rollout Guardrails

**Files:**
- Modify: `docs/EVENT_LOG_TO_TRACE_SPEC.md`
- Modify: `docs/cursor-trace-fix-experience.md`
- Modify if useful: `docs/modules/inputs.md`

- [ ] **Step 1: Document source-level finding**

Add:

```text
Cursor main turn sequence remains PROMPT -> LLM -> TOOL -> LLM.
Mode B appears when child subagent conversations without beforeSubmitPrompt are treated as top-level turns.
```

- [ ] **Step 2: Document Subagent semantics**

Add:

```text
Subagent is a parent tool call and a nested agent run.
Parent Subagent tool.result may be synthesized from subagentStop because Cursor does not emit postToolUse(Subagent).
Child conversations without beforeSubmitPrompt must not become top-level user turns.
```

- [ ] **Step 3: Document legacy compatibility**

Add:

```text
Raw Cursor hook JSONL is preferred.
Legacy history JSONL is still accepted through CursorSourceEvent adapter.
Already-step-tagged records are passed through unless child-session leakage is detected.
```

---

## Task 10: End-to-End Validation

**Files:**
- No code files unless failures expose bugs.

- [ ] **Step 1: Unit verification**

Run:

```bash
npm test -- tests/unit/inputs/cursor-trace-assembler.test.ts tests/unit/inputs/cursor-hook-input.test.ts
```

Expected: all pass.

- [ ] **Step 2: Build verification**

Run:

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Local reinstall smoke**

Run:

```bash
bash scripts/local-reinstall.sh
```

Expected: build succeeds, hook files installed, config restored.

- [ ] **Step 4: Manual Cursor raw trace**

Prompt:

```text
请完成三件事：
1. 创建两个小文件并统计行数；
2. 同时启动一个子 Agent 做一次联网调研；
3. 最后把主任务和子 Agent 结论汇总成一个文件。
```

Expected raw:

```text
parent beforeSubmitPrompt exists
parent afterAgentThought before parent tools
parent preToolUse(Subagent) exists
no postToolUse(Subagent)
subagentStart/subagentStop exist
at least one child conversation has no beforeSubmitPrompt
```

Expected output:

```text
only parent gen_ai.turn.id is exported as top-level turn
Subagent appears as parent tool.call/tool.result
child entries carry gen_ai.agent.scope=subagent
child entries carry gen_ai.subagent.parent_tool_call.id
no child generation id appears as top-level turn
```

---

## Risks and Decisions

| Risk | Decision |
|---|---|
| Child conversation lacks explicit parent id | Use confidence-aware inference; do not corrupt trace on ambiguity |
| `subagentStop` does not enclose child events | Do not rely only on start/stop window; use pending-order fallback |
| Existing processor is stateless | Keep it stateless; move fusion to Input |
| Old probes only have history | Adapter accepts history records |
| Converter may not render nested agent yet | Preserve correct metadata first; add converter support only after verification |
| Duplicate raw/history output | Raw source takes priority; history is fallback |
| Stop has different generation_id | Parent turn id comes from `beforeSubmitPrompt.generation_id`, not stop |
| Tokens duplicated on stop | Keep current behavior: strip stop token fields, use `afterAgentResponse` |

## Completion Criteria

- Mode B child sessions no longer create top-level fake turns.
- Parent turn renders as ReAct steps with `Subagent` as a tool.
- Child conversations are nested under the matching Subagent call when confidence is explicit/time-window/pending-order.
- Ambiguous child conversations are marked as orphan, not silently attached to the wrong parent.
- Existing Cursor legacy history tests still pass.
- Raw capture remains best-effort and never blocks Cursor.

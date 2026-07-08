# Codex Aborted Turn Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to execute tasks one by one.

**Goal:** Export a transcript-backed Codex trace for a post-baseline user-interrupted turn and end it with `cancelled`.

**Architecture:** A Codex-specific `BaseInput` tails transcript JSONL with per-file checkpoints and rebuilds only complete `turn_aborted` ranges. Existing Hook output remains the normal-turn path. The Hook parser skips aborted turn ids, while the OTLP flusher treats `cancelled` as terminal.

**Tech Stack:** TypeScript, Node.js JSONL polling, Vitest, Codex Hook ESM modules, OpenTelemetry.

---

### Task 1: Define and test recovery behavior

**Files:**
- Create: `tests/unit/inputs/codex-aborted-turn/codex-aborted-turn-input.test.ts`
- Create: `tests/unit/inputs/codex-aborted-turn/fixtures/aborted-turn.jsonl`
- Create: `src/inputs/codex-aborted-turn/codex-aborted-turn-types.ts`

- [ ] Write a failing input test with a user prompt, one completed Bash call, one pending function call, `last_token_usage`, and `turn_aborted`.
- [ ] Assert the final response has `['cancelled']`, `agent.codex.turn_status = interrupted`, no `error.type`, and no invented assistant message.
- [ ] Assert the pending tool has `tool.result.status = cancelled`, no result payload, and no duration.
- [ ] Run: `npx vitest run tests/unit/inputs/codex-aborted-turn/codex-aborted-turn-input.test.ts`.
- [ ] Verify the test fails because the recovery input does not yet exist.
- [ ] Add only the shared checkpoint and extracted-turn TypeScript interfaces.

### Task 2: Tail and reconstruct aborted turns

**Files:**
- Create: `src/inputs/codex-aborted-turn/codex-aborted-turn-input.ts`
- Create: `src/inputs/codex-aborted-turn/codex-aborted-turn-extractor.ts`
- Create: `src/inputs/codex-aborted-turn/codex-aborted-turn-builder.ts`
- Modify: `src/inputs/base/base-input.ts`
- Modify: `tests/unit/inputs/codex-aborted-turn/codex-aborted-turn-input.test.ts`

- [ ] Serialize `BaseInput` polling cycles so a slow collection cannot duplicate entries or race state persistence, and wait for its active cycle during shutdown; implement the Codex per-file, complete-line JSONL tailer on that lifecycle.
- [ ] Persist inode, `scanOffset`, active turn id/start offset, latest metadata offset, and a newest-first emitted id ledger capped at 100.
- [ ] On first enable baseline existing files without output. Scan only enough to locate the latest `session_meta` offset.
- [ ] For files created after startup, start at zero. For a restart-discovered file, baseline it according to the confirmed no-history policy.
- [ ] On `task_started` or `turn_context`, persist the current turn start offset. On a complete matching `turn_aborted`, reread exactly from that start through the terminal line.
- [ ] Pair `function_call`, `custom_tool_call`, and `tool_search_call` with output by `call_id`. Treat unmatched calls as pending and a `web_search_call` as complete in its own record.
- [ ] Build deterministic trace, span, and event ids from session id, transcript turn id, event kind, and index.
- [ ] Emit real input, tool, agent-message, and `last_token_usage` data. Emit the synthetic terminal LLM response only with `cancelled` and interruption status.
- [ ] Run the Task 1 test and verify it passes.
- [ ] Add tests for partial final lines, baseline behavior, restart with active turn, duplicate abort reads, the 100-entry ledger, and metadata updated mid-session.
- [ ] Re-run the focused input test and verify all cases pass.

### Task 3: Prevent normal Hook duplication and register the input

**Files:**
- Modify: `assets/hooks/codex/transcript-parser.mjs`
- Modify: `assets/hooks/codex-hook-processor.mjs`
- Modify: `tests/unit/hooks/codex/transcript-parser.test.mjs`
- Modify: `tests/unit/hooks/codex/hook-processor.test.mjs`
- Modify: `src/core/orchestrator.ts`
- Modify: `src/core/config-loader.ts`
- Modify: `src/index.ts`

- [ ] Write a failing Hook test where a transcript has `turn_aborted` before a synthetic Stop and assert normal Hook export excludes that turn.
- [ ] Run: `npx vitest run tests/unit/hooks/codex/transcript-parser.test.mjs tests/unit/hooks/codex/hook-processor.test.mjs`.
- [ ] Verify failure occurs because the parser does not report `abortedTurnIds`.
- [ ] Return `abortedTurnIds` from the parser and exclude them in `resolveTurns`, preserving the existing first-run guard.
- [ ] Import and register `CodexAbortedTurnInput` beside `CodexLogInput`, map it to Codex gating, default it to 30,000 milliseconds, and export it from `src/index.ts`.
- [ ] Re-run the two Hook tests plus the focused recovery input test and verify they pass.

### Task 4: End cancelled turns in OTLP

**Files:**
- Modify: `src/flushers/otlp-trace-flusher.ts`
- Modify: `tests/unit/flushers/otlp-trace-flusher/turn-boundary.test.ts`
- Modify: `docs/ai_event_schema.md`

- [ ] Add a failing boundary test: a request plus `finish_reasons = ['cancelled']` flushes exactly one turn.
- [ ] Run: `npx vitest run tests/unit/flushers/otlp-trace-flusher/turn-boundary.test.ts`.
- [ ] Verify it fails because only `stop` and `end_turn` are terminal.
- [ ] Replace the inline completion condition with one terminal-reason predicate containing `stop`, `end_turn`, and `cancelled`.
- [ ] Add `cancelled` to the schema as a user-interruption terminal, not a provider error.
- [ ] Re-run the focused flusher test and verify it passes.

### Task 5: Verify converter compatibility and the complete change

**Files:**
- Create: `tests/integration/codex-aborted-turn-converter.test.ts`
- Modify: `docs/superpowers/specs/2026-06-22-codex-aborted-turn-recovery-design.md`

- [ ] Add a non-mocked converter test that converts a cancelled event batch and asserts a finished span retains the interruption attribute.
- [ ] Run: `npx vitest run tests/integration/codex-aborted-turn-converter.test.ts`.
- [ ] If the installed converter rejects `cancelled`, stop and use the documented upstream `opentelemetry-util-genai` release path; do not rewrite it as `stop`.
- [ ] Run the focused input, Hook, flusher, and converter tests; then run `npm run typecheck` and `git diff --check`.

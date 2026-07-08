# Codex Transcript-Only Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit Codex completed and interrupted turns exclusively from rollout transcripts, using Stop only as a wake-up signal.

**Architecture:** A single session-file input owns transcript checkpoints and trace emission. It opens a turn at `task_started` or `turn_context`, emits it only at `task_complete` or `turn_aborted`, and rebuilds ordered ReAct steps from the transcript's own events. The Stop Hook writes a marker only; it never parses tool events or writes telemetry.

**Tech Stack:** TypeScript, Node.js JSONL files, Vitest, existing `BaseInput` and `StateStore`.

---

### Task 1: Define transcript-only turn behavior with tests

**Files:**
- Create: `tests/unit/inputs/codex-transcript/codex-transcript-input.test.ts`
- Create: `tests/unit/inputs/codex-transcript/fixtures/completed-turn.jsonl`

- [x] Add a completed three-wave transcript fixture with `task_started`, reasoning, tool call/output, token counts, and `task_complete`.
- [x] Assert that every wave emits its own LLM request/response and carries its own token usage.
- [x] Add an interrupted fixture case and assert the final response has `cancelled` plus `agent.codex.turn_status=interrupted`.
- [x] Add an incomplete-at-Stop case and assert no entry is emitted until a later `task_complete` line is appended.

### Task 2: Implement one terminal transcript collector

**Files:**
- Create: `src/inputs/codex-transcript/codex-transcript-input.ts`
- Create: `src/inputs/codex-transcript/codex-transcript-extractor.ts`
- Create: `src/inputs/codex-transcript/codex-transcript-builder.ts`
- Create: `src/inputs/codex-transcript/codex-transcript-types.ts`

- [x] Tail complete JSONL lines per rollout file and persist inode, scan offset, session metadata offset, active turn start offset, and emitted terminal turn IDs.
- [x] Recover an entire terminal turn from its original transcript range and build ordered tool waves without Hook state.
- [x] Associate token counts with the transcript response wave that completed immediately before them; retain unmatched samples as diagnostics rather than shifting later usage.
- [x] Reuse the same collector for `task_complete` and `turn_aborted`.

### Task 3: Make Stop a stateless wake-up

**Files:**
- Modify: `assets/hooks/codex-hook-processor.mjs`
- Modify: `agents.d/codex.json`
- Modify: `src/inputs/base/base-input.ts`

- [x] Replace Hook event accumulation and JSONL emission with an atomic per-session wake-up marker written only for Stop.
- [x] Restrict the Codex deployment definition to Stop.
- [x] Add a protected immediate-collection trigger and let the transcript input watch the wake-up directory; the 30-second timer remains the fallback.

### Task 4: Replace runtime registration and validate migration

**Files:**
- Modify: `src/core/orchestrator.ts`
- Modify: `src/core/config-loader.ts`
- Modify: `src/index.ts`
- Test: `tests/unit/core/config-loader.test.ts`

- [x] Register the transcript input instead of the Hook JSONL and aborted-only inputs.
- [x] Keep `codex-log` listener configuration as a compatibility fallback while making `codex-transcript` the new default listener.
- [x] Run focused unit tests, `npm run typecheck`, and `git diff --check`.

---
name: openspec-review-latest
description: Review the latest code changes against OpenSpec artifacts and baseline specs, then produce a consistency report. Use when the user asks to check whether recent changes, git diff, current branch work, or latest implementation follows specs, design, tasks, or OpenSpec requirements.
license: MIT
compatibility: Requires git and the repository's OpenSpec/specs artifacts.
metadata:
  author: openspec
  version: "1.0"
---

# OpenSpec Review Latest

Review the latest code changes against the intended design in `openspec/` and `specs/`, then produce a concise report.

## Scope

This is a review workflow. Do not modify application code or spec files unless the user explicitly asks for fixes after the report.

Review against:

- active OpenSpec change artifacts under `openspec/changes/<change>/`
- baseline architecture documents under `docs/`
- feature or testing documents under `specs/`
- task lists and design notes when present

## Workflow

1. Identify the change set:
   ```bash
   git status --short
   git diff --stat
   git diff
   ```

   If the user asks for committed changes instead of the working tree, inspect the relevant commit range.

2. Identify relevant specs:
   ```bash
   openspec list --json
   ```

   Prefer the active change named by the user. If no change is specified, infer from touched files and active OpenSpec changes. If ambiguous, ask the user which change to review.

3. Read review context:
   - relevant `proposal.md`, `design.md`, `tasks.md`, and spec deltas from the active change
   - relevant `docs/` module documents for touched code areas
   - any local guide or contract document referenced by the change

4. Compare implementation to design:
   - Does the code implement the intended behavior and scope?
   - Does it preserve module responsibilities and boundaries?
   - Does it follow documented data formats, lifecycle rules, and persistence expectations?
   - Are there missing tasks, incomplete acceptance criteria, or behavior not covered by specs?
   - Are tests or local verification steps appropriate for the risk?

5. Produce a report. Lead with findings, ordered by severity.

## Report Format

Use this structure:

```markdown
## Review Result

<Pass / Pass with concerns / Needs changes>

## Findings

- **Severity:** Critical | High | Medium | Low
  **Area:** <module or file>
  **Issue:** <what diverges from spec/design>
  **Evidence:** <short code/spec references>
  **Recommendation:** <what should change>

## Spec Alignment

- <brief notes on what matches the design>
- <brief notes on any intentional deviations>

## Verification

- Commands inspected or run
- Tests present/missing
- Remaining risks
```

If there are no issues, say so clearly and still mention any residual test or verification gaps.

## Guardrails

- Do not treat specs as automatically correct; call out stale or contradictory spec text when discovered.
- Do not over-report implementation details that do not affect design compliance.
- Do not request broad rewrites when a narrow spec or code adjustment would resolve the mismatch.
- Do not run destructive commands.
- If the diff includes unrelated user changes, separate them from the OpenSpec review instead of reverting or modifying them.

---
name: openspec-local-e2e
description: Run local end-to-end verification for OpenSpec changes in this repository. Use when the user asks to start local e2e, end2end, end-to-end, 端到端测试, 本地验收, or local integration verification after implementation.
license: MIT
compatibility: Requires npm, Node.js >= 18, and the repository's local E2E guide.
metadata:
  author: openspec
  version: "1.0"
---

# OpenSpec Local E2E

Start a local end-to-end verification run for the current OpenSpec change or recently implemented work.

## Reference

Before running commands, read the project guide:

- [specs/local-e2e-testing-guide.md](../../../specs/local-e2e-testing-guide.md)

Treat that guide as the source of truth for commands, expected outputs, and troubleshooting.

## Workflow

1. Clarify the intended scope if the user did not specify it:
   - development-mode run from `dist/`
   - simulated install/package verification
   - hook-only verification
   - output contract verification

2. Inspect the current repository state:
   - identify the active OpenSpec change if relevant
   - check for uncommitted changes before running commands that may generate files
   - avoid deleting user data unless the user explicitly asks for a reset

3. Run the safe baseline first:
   ```bash
   npm install
   npm run build
   npm run typecheck
   npm test
   ```

4. Run the selected local E2E path from the guide:
   - For development mode, start `node dist/index.js` with local test env vars.
   - For package verification, use the deploy package and installer flow.
   - For hook verification, prefer the manual hook simulation path when a real Agent is unavailable.

5. Verify results:
   - service started successfully
   - expected logs were written under `~/.loongsuite-pilot/logs/`
   - JSONL output exists when activity was triggered
   - output entries match the expected `AgentActivityEntry` shape
   - no unexpected duplicate collection after restart checks, if restart behavior is in scope

6. Report back with:
   - commands run
   - pass/fail status for each phase
   - important log or output snippets
   - any skipped checks and why
   - cleanup performed or still needed

## Guardrails

- Do not run destructive cleanup such as deleting `~/.loongsuite-pilot/` or purging installs without explicit user approval.
- Do not leave long-running services in the background unless the user asked for ongoing observation.
- Prefer local JSONL verification before involving SLS or other remote integrations.
- If a command fails, stop, summarize the failure, and diagnose before continuing to later E2E steps.

#!/usr/bin/env bash
set -euo pipefail

# Cursor hook generic entrypoint.
# This script can be reused across multiple Cursor hook event types.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$SCRIPT_DIR/cursor-hook-processor.mjs"
EMPTY_RESULT='{}'

PAYLOAD="$(cat || true)"
if [[ -z "${PAYLOAD//[[:space:]]/}" ]]; then
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if [[ ! -f "$PROCESSOR" ]]; then
  echo "[ai-agent-collector] cursor processor not found: $PROCESSOR" >&2
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[ai-agent-collector] node runtime not found" >&2
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

# Fail-open behavior: do not block Cursor workflows on telemetry issues.
if ! printf '%s' "$PAYLOAD" | node "$PROCESSOR"; then
  echo "[ai-agent-collector] cursor hook processor failed" >&2
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0

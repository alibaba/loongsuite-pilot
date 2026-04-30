#!/usr/bin/env bash
set -euo pipefail

# Cursor hook entrypoint — delegates to cursor-hook-processor.mjs.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$SCRIPT_DIR/cursor-hook-processor.mjs"
EMPTY_RESULT='{}'

PAYLOAD="$(cat || true)"
if [[ -z "${PAYLOAD//[[:space:]]/}" ]]; then
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if [[ ! -f "$PROCESSOR" ]]; then
  echo "[ai-agent-collector] hook processor not found: $PROCESSOR" >&2
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  for candidate in \
    "$HOME/.nvm/versions/node"/*/bin/node \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    "$HOME/.local/bin/node" \
    "$HOME/.volta/bin/node" \
    "$HOME/.fnm/aliases/default/bin/node"; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "[ai-agent-collector] node runtime not found" >&2
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if ! printf '%s' "$PAYLOAD" | "$NODE_BIN" "$PROCESSOR"; then
  echo "[ai-agent-collector] hook processor failed" >&2
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0

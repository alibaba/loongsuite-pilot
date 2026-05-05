#!/usr/bin/env bash
set -euo pipefail

# Cursor hook entrypoint — delegates to cursor-hook-processor.mjs.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$SCRIPT_DIR/cursor-hook-processor.mjs"
EMPTY_RESULT='{}'

log_error() {
  local stage="$1"
  local message="$2"
  local data_dir="${LOONGSUITE_PILOT_DATA_DIR:-${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}}"
  local day
  day="$(date -u +%Y-%m-%d 2>/dev/null || true)"
  [[ -n "$day" ]] || day="unknown"
  local dir="$data_dir/logs/cursor-hook/errors"
  local file="$dir/cursor-error-$day.jsonl"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"time":"%s","clientType":"CursorHook","stage":"%s","error.type":"shell_%s","error.message":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
    "$stage" \
    "$stage" \
    "$(printf '%s' "$message" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""')" \
    >> "$file" 2>/dev/null || true
}

if [[ -t 0 ]]; then
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if [[ ! -f "$PROCESSOR" ]]; then
  echo "[loongsuite-pilot] hook processor not found: $PROCESSOR" >&2
  log_error "missing_processor" "hook processor not found: $PROCESSOR"
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
  echo "[loongsuite-pilot] node runtime not found" >&2
  log_error "missing_node" "node runtime not found"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if ! "$NODE_BIN" "$PROCESSOR"; then
  echo "[loongsuite-pilot] hook processor failed" >&2
  log_error "processor_failed" "hook processor exited with non-zero status"
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0

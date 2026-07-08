#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Kiro CLI Hook Script — delegates to kiro-cli-hook-processor.mjs
# ============================================================================
# Usage (registered in ~/.kiro/agents/<pilot-agent>.json by pilot deploy):
#   kiro-cli-loongsuite-pilot-hook.sh <event>
#
#   event  camelCase hook trigger (userPromptSubmit / preToolUse /
#          postToolUse / stop). Kiro passes the event JSON via stdin.
#
# The deploy prepends the event name to the hook command:
#   command: "<PILOT_HOOKS>/kiro-cli-loongsuite-pilot-hook.sh postToolUse"
# so $1 carries the event; the processor dispatches by argv.
#
# Fail-open: any error prints "{}" and exits 0, never blocks the host agent.
# ============================================================================

EMPTY_RESULT='{}'

# stdin is a TTY → manual run, no payload; return fast.
[[ -t 0 ]] && { printf '%s\n' "$EMPTY_RESULT"; exit 0; }

EVENT="${1:-unknown}"

log_error() {
  local stage="$1"
  local message="$2"
  local data_dir="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
  local day
  day="$(date -u +%Y-%m-%d 2>/dev/null || true)"
  [[ -n "$day" ]] || day="unknown"
  local dir="$data_dir/logs/kiro-cli/errors"
  local file="$dir/kiro-cli-error-$day.jsonl"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"time":"%s","gen_ai.agent.type":"kiro-cli","stage":"%s","error.type":"shell_%s","error.message":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
    "$stage" \
    "$stage" \
    "$(printf '%s' "$message" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""')" \
    >> "$file" 2>/dev/null || true
}

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$HOOKS_DIR/kiro-cli-hook-processor.mjs"

[[ -f "$PROCESSOR" ]] || {
  log_error "missing_processor" "hook processor not found: $PROCESSOR"
  printf '%s\n' "$EMPTY_RESULT"; exit 0
}

MIN_NODE_MAJOR=18

node_is_app_bundle() {
  local resolved
  resolved="$(realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$resolved" in
    /Applications/*.app/Contents/*|/System/Applications/*.app/Contents/*|"$HOME"/Applications/*.app/Contents/*)
      return 0 ;;
  esac
  return 1
}

node_is_suitable() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  node_is_app_bundle "$bin" && return 1
  local ver
  ver="$("$bin" --version 2>/dev/null)" || return 1
  local major="${ver#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= MIN_NODE_MAJOR )) || return 1
  return 0
}

NODE_PIN_FILE="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}/node-bin"
NODE_BIN=""

if [[ -f "$NODE_PIN_FILE" ]]; then
  pinned="$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$pinned" ]] && node_is_suitable "$pinned"; then
    NODE_BIN="$pinned"
  fi
fi

if [[ -z "$NODE_BIN" ]]; then
  nvm_candidates=("$HOME/.nvm/versions/node"/*/bin/node)
  candidates=()
  for (( i=${#nvm_candidates[@]}-1; i>=0; i-- )); do
    candidates+=("${nvm_candidates[i]}")
  done
  candidates+=(
    "$HOME/.volta/bin/node"
    "$HOME/.fnm/aliases/default/bin/node"
    /opt/homebrew/bin/node
    /usr/local/bin/node
    "$HOME/.local/bin/node"
  )
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  for candidate in "${candidates[@]}"; do
    if node_is_suitable "$candidate"; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

[[ -n "$NODE_BIN" ]] || {
  log_error "missing_node" "node >= $MIN_NODE_MAJOR not found"
  printf '%s\n' "$EMPTY_RESULT"; exit 0
}

# Hook stdin payload piped through to the processor.
if ! "$NODE_BIN" "$PROCESSOR" "$EVENT"; then
  log_error "processor_failed" "hook processor exited non-zero (event=$EVENT)"
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0

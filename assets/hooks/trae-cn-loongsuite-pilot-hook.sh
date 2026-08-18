#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# TRAE CN Hook Script — delegates to trae-cn-hook-processor.mjs
# ============================================================================
# Usage (registered in <workspace>/.trae/hooks.json by pilot deploy):
#   trae-cn-loongsuite-pilot-hook.sh <event>
#
#   event  TRAE hook trigger name (SessionStart / UserPromptSubmit / PreToolUse /
#          PostToolUse / Stop / Notification). TRAE passes the event JSON
#          via stdin; the event name arrives as $1 so the processor can
#          dispatch by argv.
#
# Fail-open: any error prints "{}" and exits 0, never blocks TRAE.
# An empty object means "no decision". Per the official docs only exit code 2
# is blocking (for PreToolUse it is equivalent to permissionDecision=deny),
# so a fail-open hook must never surface a non-zero status or a block decision.
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
  local dir="$data_dir/logs/trae-cn/errors"
  local file="$dir/trae-cn-error-$day.jsonl"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"time":"%s","gen_ai.agent.type":"trae-cn","stage":"%s","error.type":"shell_%s","error.message":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
    "$stage" \
    "$stage" \
    "$(printf '%s' "$message" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""')" \
    >> "$file" 2>/dev/null || true
}

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$HOOKS_DIR/trae-cn-hook-processor.mjs"
NODE_RUNTIME_LIB="$HOOKS_DIR/shared/node-runtime.sh"

[[ -f "$PROCESSOR" ]] || {
  log_error "missing_processor" "hook processor not found: $PROCESSOR"
  printf '%s\n' "$EMPTY_RESULT"; exit 0
}

[[ -f "$NODE_RUNTIME_LIB" ]] || {
  log_error "missing_node_runtime_lib" "node runtime helper not found: $NODE_RUNTIME_LIB"
  printf '%s\n' "$EMPTY_RESULT"; exit 0
}

# shellcheck source=shared/node-runtime.sh
source "$NODE_RUNTIME_LIB"

NODE_BIN="$(resolve_pilot_node_bin 2>/dev/null || true)"

[[ -n "$NODE_BIN" ]] || {
  log_error "missing_node" "node >= 18 not found"
  printf '%s\n' "$EMPTY_RESULT"; exit 0
}

# Hook stdin payload is piped straight through to the processor.
if ! "$NODE_BIN" "$PROCESSOR" "$EVENT"; then
  log_error "processor_failed" "hook processor exited non-zero (event=$EVENT)"
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0

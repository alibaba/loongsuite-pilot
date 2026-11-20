#!/usr/bin/env bash
set -euo pipefail

# ZCode hook entrypoint — delegates to zcode-hook-processor.mjs.
#
# Usage (registered in ~/.zcode/cli/config.json by pilot HookStrategy):
#   $PILOT_DATA/hooks/zcode-loongsuite-pilot-hook.sh <subcommand>
#
# Subcommand:
#   stop  → read stdin, emit ENTRY/AGENT envelope (no messages)
#
# Fail-open 原则: 任何错误都输出 "{}" 并 exit 0, 不阻塞 zcode。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$SCRIPT_DIR/zcode-hook-processor.mjs"
RUNTIME_RESOLVER="$SCRIPT_DIR/shared/node-runtime.sh"
export LOONGSUITE_PILOT_DATA_DIR="$(dirname "$SCRIPT_DIR")"
EMPTY_RESULT='{}'
SUBCOMMAND="${1:-unknown}"

case "$SUBCOMMAND" in
  stop) ;;
  *)
    printf '%s\n' "$EMPTY_RESULT"
    exit 0
    ;;
esac

log_error() {
  local stage="$1"
  local message="$2"
  local data_dir="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
  local day
  day="$(date -u +%Y-%m-%d 2>/dev/null || true)"
  [[ -n "$day" ]] || day="unknown"
  local dir="$data_dir/logs/zcode/errors"
  local file="$dir/zcode-error-$day.jsonl"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"time":"%s","gen_ai.agent.type":"zcode","stage":"%s","error.type":"shell_%s","error.message":%s}\n' \
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
  echo "[zcode-hook] processor not found: $PROCESSOR" >&2
  log_error "missing_processor" "hook processor not found: $PROCESSOR"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if [[ ! -f "$RUNTIME_RESOLVER" ]]; then
  log_error "missing_runtime_resolver" "hook runtime resolver not found: $RUNTIME_RESOLVER"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

# shellcheck source=shared/node-runtime.sh
source "$RUNTIME_RESOLVER"
if ! NODE_BIN="$(resolve_pilot_node_bin 2>/dev/null)"; then
  log_error "missing_node" "node >= $PILOT_MIN_NODE_MAJOR not found"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if ! "$NODE_BIN" "$PROCESSOR" "$SUBCOMMAND"; then
  echo "[zcode-hook] processor failed (subcommand=$SUBCOMMAND)" >&2
  log_error "processor_failed" "hook processor exited non-zero (subcommand=$SUBCOMMAND)"
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0

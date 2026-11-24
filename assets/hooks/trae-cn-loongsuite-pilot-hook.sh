#!/usr/bin/env bash
set -euo pipefail

# TRAE-CN hook entrypoint — delegates to trae-cn-hook-processor.mjs.
#
# Usage (registered in ~/.trae-cn/hooks.json or $PROJECT/.trae/hooks.json by
# pilot HookStrategy):
#   $PILOT_DATA/hooks/trae-cn-loongsuite-pilot-hook.sh <subcommand>
#
# Subcommand (TRAE-CN official hook event → kebab-case):
#   session-start | user-prompt-submit | pre-tool-use | post-tool-use | stop | notification
#
# Fail-open 原则: 任何错误都输出 "{}" 并 exit 0, 不阻塞 TRAE-CN 工具执行.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$SCRIPT_DIR/trae-cn-hook-processor.mjs"
NODE_RUNTIME="$SCRIPT_DIR/shared/node-runtime.sh"
export LOONGSUITE_PILOT_DATA_DIR="${LOONGSUITE_PILOT_DATA_DIR:-$(dirname "$SCRIPT_DIR")}"
EMPTY_RESULT='{}'
SUBCOMMAND="${1:-unknown}"

case "$SUBCOMMAND" in
  session-start|user-prompt-submit|pre-tool-use|post-tool-use|stop|notification)
    ;;
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

# stdin 是 tty 说明被人手工执行(无 hook payload); 快返回.
if [[ -t 0 ]]; then
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if [[ ! -f "$PROCESSOR" ]]; then
  echo "[trae-cn-hook] processor not found: $PROCESSOR" >&2
  log_error "missing_processor" "hook processor not found: $PROCESSOR"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

NODE_BIN=""
if [[ -f "$NODE_RUNTIME" ]]; then
  # shellcheck source=shared/node-runtime.sh
  source "$NODE_RUNTIME"
  NODE_BIN="$(resolve_pilot_node_bin || true)"
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "[trae-cn-hook] node >= 18 not found" >&2
  log_error "missing_node" "node >= 18 not found"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

# Hook stdin payload 通过管道转发给 processor
if ! "$NODE_BIN" "$PROCESSOR" "$SUBCOMMAND"; then
  echo "[trae-cn-hook] processor failed (subcommand=$SUBCOMMAND)" >&2
  log_error "processor_failed" "hook processor exited non-zero (subcommand=$SUBCOMMAND)"
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0

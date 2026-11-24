#!/usr/bin/env bash
set -euo pipefail

# Kimi CLI hook entrypoint — delegates to kimi-cli-hook-processor.mjs.
#
# Usage (registered in ~/.kimi/config.toml [[hooks]] by pilot HookStrategy):
#   $PILOT_DATA/hooks/kimi-cli-loongsuite-pilot-hook.sh
#
# Kimi 的 hook 协议：stdin 携带 JSON event payload（含 hook_event_name 字段），
# exit 0=allow / exit 2=block。本脚本无 subcommand 参数——processor 通过 stdin
# payload 的 hook_event_name 字段分派 Stop / StopFailure 路径。
#
# Fail-open 原则: 任何错误都输出 "{}" 并 exit 0,不阻塞宿主 agent。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$SCRIPT_DIR/kimi-cli-hook-processor.mjs"
EMPTY_RESULT='{}'

log_error() {
  local stage="$1"
  local message="$2"
  local data_dir="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
  local day
  day="$(date -u +%Y-%m-%d 2>/dev/null || true)"
  [[ -n "$day" ]] || day="unknown"
  local dir="$data_dir/logs/kimi/errors"
  local file="$dir/kimi-error-$day.jsonl"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"time":"%s","gen_ai.agent.type":"kimi","stage":"%s","error.type":"shell_%s","error.message":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
    "$stage" \
    "$stage" \
    "$(printf '%s' "$message" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""')" \
    >> "$file" 2>/dev/null || true
}

# stdin 是 tty 说明被人手工执行(无 hook payload);快返回。
if [[ -t 0 ]]; then
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

if [[ ! -f "$PROCESSOR" ]]; then
  echo "[kimi-hook] processor not found: $PROCESSOR" >&2
  log_error "missing_processor" "hook processor not found: $PROCESSOR"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

MIN_NODE_MAJOR=18

node_is_app_bundle() {
  local resolved
  resolved="$(realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$resolved" in
    /Applications/*.app/Contents/*|/System/Applications/*.app/Contents/*|"$HOME"/Applications/*.app/Contents/*)
      return 0
      ;;
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

NODE_PIN_FILE="$HOME/.loongsuite-pilot/node-bin"
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

if [[ -z "$NODE_BIN" ]]; then
  echo "[kimi-hook] node >= $MIN_NODE_MAJOR not found" >&2
  log_error "missing_node" "node >= $MIN_NODE_MAJOR not found"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

# Hook stdin payload 通过管道转发给 processor
if ! "$NODE_BIN" "$PROCESSOR"; then
  echo "[kimi-hook] processor failed" >&2
  log_error "processor_failed" "hook processor exited non-zero"
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0

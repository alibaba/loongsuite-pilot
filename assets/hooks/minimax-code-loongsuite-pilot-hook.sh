#!/usr/bin/env bash
set -euo pipefail

# MiniMax Code hook entrypoint — delegates to minimax-code-hook-processor.mjs.
#
# Usage (registered in ~/.minimax-code/settings.json by pilot HookStrategy):
#   $PILOT_DATA/hooks/minimax-code-loongsuite-pilot-hook.sh <subcommand>
#
# Subcommand (kebab-case, per AgentHookConfig.eventSubcommand='kebab-case'):
#   session-start / user-prompt-submit / pre-tool-use / post-tool-use / stop
#
# Fail-open 原则: 任何错误都输出 "{}" 并 exit 0,不阻塞宿主 agent。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$SCRIPT_DIR/minimax-code-hook-processor.mjs"
EMPTY_RESULT='{}'
SUBCOMMAND="${1:-unknown}"

# Only process registered subcommands; early-return for legacy/unregistered ones.
case "$SUBCOMMAND" in
  session-start|user-prompt-submit|pre-tool-use|post-tool-use|stop)
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
  local dir="$data_dir/logs/minimax-code/errors"
  local file="$dir/minimax-code-error-$day.jsonl"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"time":"%s","gen_ai.agent.type":"minimax-code","stage":"%s","error.type":"shell_%s","error.message":%s}\n' \
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
  echo "[minimax-code-hook] processor not found: $PROCESSOR" >&2
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

NODE_BIN=""
# Round 19 fix (PR #233, copilot suppressed comment): the previous
# implementation hard-coded the pin file path to
# "$HOME/.loongsuite-pilot/node-bin" and ignored
# LOONGSUITE_PILOT_DATA_DIR. If Pilot is installed/used with a
# non-default data dir, the hook would fail to find the pinned
# Node binary even though one exists under the configured data
# dir (and every other part of the script already honors
# LOONGSUITE_PILOT_DATA_DIR — the dataDir resolution at line 27
# uses it). Fall back to the default only when
# LOONGSUITE_PILOT_DATA_DIR is unset, matching the dataDir
# resolution pattern.
PILOT_DATA_DIR="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
NODE_PIN_FILE="$PILOT_DATA_DIR/node-bin"

# 1. pinned node
if [[ -f "$NODE_PIN_FILE" ]]; then
  pinned="$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$pinned" ]] && node_is_suitable "$pinned"; then
    NODE_BIN="$pinned"
  fi
fi

# 2. fallback search (read-only)
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
  echo "[minimax-code-hook] node >= $MIN_NODE_MAJOR not found" >&2
  log_error "missing_node" "node >= $MIN_NODE_MAJOR not found"
  printf '%s\n' "$EMPTY_RESULT"
  exit 0
fi

# Hook stdin payload 通过管道转发给 processor
if ! "$NODE_BIN" "$PROCESSOR" "$SUBCOMMAND"; then
  echo "[minimax-code-hook] processor failed (subcommand=$SUBCOMMAND)" >&2
  log_error "processor_failed" "hook processor exited non-zero (subcommand=$SUBCOMMAND)"
  printf '%s\n' "$EMPTY_RESULT"
fi

exit 0

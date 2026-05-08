#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Qoder Hook Script — delegates to shared hook-processor.mjs
# ============================================================================
# Usage:
#   qoder-loongsuite-pilot-hook.sh [agent-id]
#
#   agent-id  Optional. Defaults to "qoder-cli".
#             Controls the log subdirectory and history file prefix.
#             e.g. "qoder-work" → logs/qoder-work/history/qoder-work-*.jsonl
#
# Installation:
#   HookManager copies this script + hook-processor.mjs to
#   ~/.loongsuite-pilot/hooks/ and injects the command into
#   the tool's settings.json (e.g. ~/.qoder/settings.json,
#   ~/.qoderwork/settings.json)
# ============================================================================

# Skip immediately when stdin is a terminal (no payload)
[[ -t 0 ]] && exit 0

AGENT_ID="${1:-qoder-cli}"

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$HOOKS_DIR/hook-processor.mjs"

# Fail silently if the processor is missing
[[ -f "$PROCESSOR" ]] || exit 0

MIN_NODE_MAJOR=18

node_is_suitable() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  local ver
  ver="$("$bin" --version 2>/dev/null)" || return 1
  local major="${ver#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= MIN_NODE_MAJOR )) || return 1
  return 0
}

NODE_PIN_FILE="$HOME/.loongsuite-pilot/node-bin"

NODE_BIN=""

# 1. Try pinned node
if [[ -f "$NODE_PIN_FILE" ]]; then
  pinned="$(cat "$NODE_PIN_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$pinned" ]] && node_is_suitable "$pinned"; then
    NODE_BIN="$pinned"
  fi
fi

# 2. Fallback search (unified order, read-only — does NOT update pin)
if [[ -z "$NODE_BIN" ]]; then
  if command -v node >/dev/null 2>&1 && node_is_suitable "$(command -v node)"; then
    NODE_BIN="$(command -v node)"
  else
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
    for candidate in "${candidates[@]}"; do
      if node_is_suitable "$candidate"; then
        NODE_BIN="$candidate"
        break
      fi
    done
  fi
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "[loongsuite-pilot] node >= $MIN_NODE_MAJOR not found" >&2
  exit 0
fi

exec "$NODE_BIN" "$PROCESSOR" --agent-id "$AGENT_ID"

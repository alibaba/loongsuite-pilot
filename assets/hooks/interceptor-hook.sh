#!/usr/bin/env bash
set -euo pipefail

# Independent interceptor hook: fail-open on any infrastructure error.
[[ -t 0 ]] && exit 0

# Hooks are installed under <data-dir>/hooks. The CLI and current pointer live
# in the cache dir, which stays ~/.loongsuite-pilot unless the cache env is set.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(cd "$HOOK_DIR/.." && pwd)"
if [[ -z "${LOONGSUITE_PILOT_DATA_DIR:-}" ]]; then
  export LOONGSUITE_PILOT_DATA_DIR="$DATA_DIR"
fi
if [[ -n "${LOONGSUITE_PILOT_CACHE_DIR:-}" ]]; then
  CACHE_DIR="$LOONGSUITE_PILOT_CACHE_DIR"
elif [[ -e "$DATA_DIR/current" ]]; then
  CACHE_DIR="$DATA_DIR"
else
  CACHE_DIR="${HOME:-}/.loongsuite-pilot"
fi
CURRENT_FILE="$CACHE_DIR/current"

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

NODE_PIN_FILE="$CACHE_DIR/node-bin"
NODE_BIN=""
if [[ -f "$NODE_PIN_FILE" ]]; then
  pinned="$(tr -d '[:space:]' <"$NODE_PIN_FILE" 2>/dev/null || true)"
  if [[ -n "$pinned" ]] && node_is_suitable "$pinned"; then
    NODE_BIN="$pinned"
  fi
fi
if [[ -z "$NODE_BIN" ]] && command -v node >/dev/null 2>&1; then
  candidate="$(command -v node)"
  if node_is_suitable "$candidate"; then
    NODE_BIN="$candidate"
  fi
fi
[[ -n "$NODE_BIN" ]] || exit 0

CLI="${INTERCEPTOR_CLI:-}"
if [[ -z "$CLI" && -f "$CURRENT_FILE" ]]; then
  version_name="$(tr -d '[:space:]' <"$CURRENT_FILE" 2>/dev/null || true)"
  if [[ -n "$version_name" ]]; then
    CLI="$CACHE_DIR/versions/$version_name/dist/interceptor/cli.cjs"
  fi
fi
[[ -n "$CLI" && -f "$CLI" ]] || exit 0

"$NODE_BIN" "$CLI" hook --agent qoder-auto "$@" || true

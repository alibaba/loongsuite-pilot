#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Qoder Hook Script — thin wrapper
# ============================================================================
# Resolves the cache directory, then delegates all processing to
# aac-qoder-hook.py (same directory).  Payload is passed through stdin.
#
# Usage:
#   aac-qoder-hook.sh [agent-id]
#
#   agent-id  Optional. Defaults to "qoder-cli".
#             Controls the log subdirectory and aac_client_type tag.
#             e.g. "qoder-work" → logs/qoder-work/history/
#
# Installation:
#   HookManager copies this script + the .py file to
#   ~/.ai-agent-collector/hooks/ and injects the command into
#   the tool's settings.json (e.g. ~/.qoder/settings.json,
#   ~/.qoderwork/settings.json)
# ============================================================================

# Skip immediately when stdin is a terminal (no payload)
[[ -t 0 ]] && exit 0

AGENT_ID="${1:-qoder-cli}"

resolve_cache_dir() {
  if [[ -n "${AAC_CACHE_DIR:-}" ]]; then
    printf '%s' "$AAC_CACHE_DIR"
    return
  fi

  local target="${HOME:-$PWD}/.ai-agent-collector"
  if mkdir -p "$target" 2>/dev/null; then
    printf '%s' "$target"
    return
  fi

  local fallback="${PWD:-.}/.ai-agent-collector"
  mkdir -p "$fallback"
  printf '%s' "$fallback"
}

CACHE_DIR="$(resolve_cache_dir)"
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_HANDLER="$HOOKS_DIR/aac-qoder-hook.py"

# Fail silently if the Python handler is missing
[[ -f "$PY_HANDLER" ]] || exit 0

exec python3 "$PY_HANDLER" "$CACHE_DIR" "$AGENT_ID"

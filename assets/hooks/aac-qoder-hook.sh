#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Qoder Hook Script — delegates to shared hook-processor.mjs
# ============================================================================
# Usage:
#   aac-qoder-hook.sh [agent-id]
#
#   agent-id  Optional. Defaults to "qoder-cli".
#             Controls the log subdirectory and history file prefix.
#             e.g. "qoder-work" → logs/qoder-work/history/qoder-work-*.jsonl
#
# Installation:
#   HookManager copies this script + hook-processor.mjs to
#   ~/.ai-agent-collector/hooks/ and injects the command into
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
  echo "[ai-agent-collector] node runtime not found" >&2
  exit 0
fi

exec "$NODE_BIN" "$PROCESSOR" --agent-id "$AGENT_ID"

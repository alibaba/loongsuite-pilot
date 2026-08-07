#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Qoder Work Hook Script — delegates to shared hook-processor.mjs
# ============================================================================
# Usage:
#   qoderwork-loongsuite-pilot-hook.sh
#
#   Writes to logs/qoder-work/history/qoder-work-*.jsonl.
#
# Installation:
#   HookManager copies this script + hook-processor.mjs to
#   ~/.loongsuite-pilot/hooks/ and injects the command into
#   ~/.qoderwork/settings.json.
# ============================================================================

# Skip immediately when stdin is a terminal (no payload)
[[ -t 0 ]] && exit 0

AGENT_ID="${1:-qoder-work}"

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$HOOKS_DIR/qoderwork-hook-processor.mjs"
PILOT_DATA_DIR="$(cd "$HOOKS_DIR/.." && pwd)"
export LOONGSUITE_PILOT_DATA_DIR="$PILOT_DATA_DIR"

# Fail silently if the processor is missing
[[ -f "$PROCESSOR" ]] || exit 0
RUNTIME_RESOLVER="$HOOKS_DIR/shared/node-runtime.sh"
[[ -f "$RUNTIME_RESOLVER" ]] || exit 0
# shellcheck source=shared/node-runtime.sh
source "$RUNTIME_RESOLVER"
NODE_BIN="$(resolve_pilot_node_bin 2>/dev/null)" || exit 0

exec "$NODE_BIN" "$PROCESSOR" --agent-id "$AGENT_ID"

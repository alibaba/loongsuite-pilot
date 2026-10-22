#!/usr/bin/env bash

# Some agents invoke hooks with sh, bypassing the Bash shebang. Re-exec before
# Bash options/syntax; exec preserves stdin, arguments, and the exit status.
# Disable inherited POSIX mode as shared helpers require full Bash syntax.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash -- "$0" "$@"
fi
set +o posix
set -euo pipefail

[[ -t 0 ]] && exit 0
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$HOOKS_DIR/qwen-work-cn-hook-processor.mjs"
PILOT_DATA_DIR="$(cd "$HOOKS_DIR/.." && pwd)"
export LOONGSUITE_PILOT_DATA_DIR="$PILOT_DATA_DIR"
[[ -f "$PROCESSOR" ]] || exit 0
RUNTIME_RESOLVER="$HOOKS_DIR/shared/node-runtime.sh"
[[ -f "$RUNTIME_RESOLVER" ]] || exit 0
# shellcheck source=shared/node-runtime.sh
source "$RUNTIME_RESOLVER"
NODE_BIN="$(resolve_pilot_node_bin 2>/dev/null)" || exit 0
exec "$NODE_BIN" "$PROCESSOR" --agent-id qwen-work-cn --log-prefix qwen-work-cn

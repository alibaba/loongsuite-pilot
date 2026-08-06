#!/usr/bin/env bash
set -euo pipefail

[[ -t 0 ]] && exit 0
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR="$HOOKS_DIR/qwen-work-cn-hook-processor.mjs"
[[ -f "$PROCESSOR" ]] || exit 0

NODE_BIN=""
for candidate in "$HOME/.loongsuite-pilot/node-bin" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
  if [[ "$candidate" == */node-bin && -f "$candidate" ]]; then candidate="$(tr -d '[:space:]' < "$candidate")"; fi
  if [[ -x "$candidate" ]] && "$candidate" --version >/dev/null 2>&1; then NODE_BIN="$candidate"; break; fi
done
if [[ -z "$NODE_BIN" ]] && command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"; fi
[[ -n "$NODE_BIN" ]] || exit 0
exec "$NODE_BIN" "$PROCESSOR" --agent-id qwen-work-cn --log-prefix qwen-work-cn

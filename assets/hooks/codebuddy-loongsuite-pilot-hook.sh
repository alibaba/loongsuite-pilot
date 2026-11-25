#!/usr/bin/env bash
# CodeBuddy hook wrapper — mirrors workbuddy-loongsuite-pilot-hook.sh but
# points at codebuddy-hook-event-writer.mjs so events land under
# state/codebuddy/hook-events (kept separate from workbuddy sessions).
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
PROCESSOR="$SCRIPT_DIR/codebuddy-hook-event-writer.mjs"
SUBCOMMAND="${1:-unknown}"
NODE_BIN=""

# Prefer the shared resolver: the installer writes the node pin under the
# configured data/cache directory, not necessarily $HOME/.loongsuite-pilot —
# a custom data dir with no system node must still find the managed runtime.
NODE_RUNTIME="$SCRIPT_DIR/shared/node-runtime.sh"
if [[ -f "$NODE_RUNTIME" ]]; then
  # shellcheck source=shared/node-runtime.sh
  source "$NODE_RUNTIME"
  NODE_BIN="$(resolve_pilot_node_bin || true)"
fi

for candidate in \
  "$HOME/.loongsuite-pilot/node-bin" \
  "$HOME/.volta/bin/node" \
  "$HOME/.fnm/aliases/default/bin/node" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  "$HOME/.local/bin/node"
do
  if [[ "$candidate" == *.loongsuite-pilot/node-bin && -f "$candidate" ]]; then
    candidate="$(tr -d '[:space:]' < "$candidate" 2>/dev/null)"
  fi
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [[ -z "$NODE_BIN" ]] && command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [[ -n "$NODE_BIN" && -f "$PROCESSOR" ]]; then
  "$NODE_BIN" "$PROCESSOR" "$SUBCOMMAND" 2>/dev/null || true
else
  printf '{}\n'
fi
exit 0
